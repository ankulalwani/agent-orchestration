import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, newSecretToken, repositoryKey, runCommand, type WorkerSnapshot } from '@ao/core';
import { defaultAgentManager, type AgentManager } from '@ao/agents';
import { ProviderManager } from '@ao/providers';
import { ConfigStore, HOSTED_CONTROL_PLANE_URL } from './config.js';
import { LOCAL_UI_TOKEN, WORKER_CREDENTIAL, createCredentialStore, type CredentialStore } from './credentials.js';
import { ControlPlaneClient, pollPairing, sleep, startPairing } from './control-client.js';
import { EventBuffer } from './event-buffer.js';
import { TaskExecutor } from './executor.js';
import { detectTools, platformOs, systemMetrics } from './system.js';
import { collectRepoFacts } from './repo-facts.js';
import { UpdateManager } from './update-manager.js';
import { McpMonitor } from './mcp-monitor.js';
import { PluginRunner } from './plugins.js';
import { detectSandbox } from '@ao/agents';
import type { RepositoryMapping } from '@ao/contracts';
import { defaultRoots, describeRepository, scanForRepositories, type ScanResult } from './discovery.js';
import { tokenAuthEnv } from '@ao/git';
import { ModelGateway } from './gateway/server.js';

import { WORKER_VERSION } from './version.js';

const log = createLogger('worker');
export { WORKER_VERSION };

export interface PairingState {
  status: 'idle' | 'waiting' | 'approved' | 'denied' | 'expired' | 'error';
  userCode?: string;
  verificationUrl?: string;
  expiresAt?: string;
  error?: string;
}

/**
 * The worker process (spec §10, §11). Startup order follows spec §11:
 * config → credentials → local API/UI (by main.ts) → agents → providers → control plane → heartbeat → ready.
 */
export class WorkerRuntime {
  readonly config: ConfigStore;
  credentials!: CredentialStore;
  agents!: AgentManager;
  providers!: ProviderManager;
  buffer!: EventBuffer;
  executor!: TaskExecutor;
  client: ControlPlaneClient | null = null;
  tools: Awaited<ReturnType<typeof detectTools>> = { tags: [], details: [] };
  pairing: PairingState = { status: 'idle' };
  startedAt = new Date().toISOString();
  lastHeartbeatAt: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private offerPollTimer: NodeJS.Timeout | null = null;
  private heartbeatMs = 15_000;
  private stopped = false;
  private activeFile: string;
  /** Repository discovery: the last scan (kept on disk) and the running one. */
  discovery: { last: ScanResult | null; running: boolean; error: string | null } = { last: null, running: false, error: null };
  private discoveryTimer: NodeJS.Timeout | null = null;
  private discoveryAbort: AbortController | null = null;
  private discoveryFile: string;

  readonly updates: UpdateManager;
  /** Health of MCP servers on this worker; only healthy ones are advertised (CAP-011). */
  readonly mcp: McpMonitor;
  /** Lets harnesses use add-on models (loopback only; one token per agent session). */
  readonly gateway = new ModelGateway({
    isLimited: (id) => this.providers?.isLimited(id) ?? false,
    onLimit: (t, retryAt) => this.providers?.markLimited(t.providerId, retryAt),
  });

  constructor(dataDir?: string, private opts: { timeScale?: number } = {}) {
    this.config = new ConfigStore(dataDir);
    this.activeFile = path.join(this.config.dataDir, 'active-tasks.json');
    this.discoveryFile = path.join(this.config.dataDir, 'discovery.json');
    try {
      this.discovery.last = JSON.parse(fs.readFileSync(this.discoveryFile, 'utf8'));
    } catch {
      /* no scan yet */
    }
    this.updates = new UpdateManager(this, WORKER_VERSION);
    this.mcp = new McpMonitor(path.join(this.config.dataDir, 'mcp-servers.json'), () => {
      if (this.client) void this.heartbeat(true);
    });
  }

  get dataDir() {
    return this.config.dataDir;
  }

  async init() {
    this.credentials = await createCredentialStore(this.dataDir);
    if (!(await this.credentials.get(LOCAL_UI_TOKEN))) await this.credentials.set(LOCAL_UI_TOKEN, newSecretToken(24));
    this.agents = defaultAgentManager({ enableMock: this.config.get().enableMockAgent });
    this.providers = new ProviderManager(this.credentials, { minCheckIntervalMs: 5 * 60_000 });
    await this.providers.configure(this.config.get().providers);
    this.buffer = new EventBuffer(path.join(this.dataDir, 'buffer'), () => this.config.get().workerId);
    this.executor = new TaskExecutor({
      client: () => this.client,
      buffer: this.buffer,
      agents: this.agents,
      providers: this.providers,
      config: () => this.config.get(),
      inventory: () => this.selectionInventory(),
      mcp: this.mcp,
      plugins: new PluginRunner(path.join(this.dataDir, 'plugins')),
      dataDir: this.dataDir,
      flushEvents: () => this.flush(),
      credentials: { get: (name) => this.credentials.get(name) },
      gateway: this.gateway,
      timeScale: this.opts.timeScale,
    });
    this.mcp.start();
    this.config.onChange(async (c) => {
      await this.providers.configure(c.providers);
    });
    // Detection runs in the background so the local UI is available immediately.
    void (async () => {
      this.tools = await detectTools();
      await this.agents.inventory();
      await this.providers.refresh(true).catch(() => undefined);
    })();
  }

  async localUiToken() {
    return (await this.credentials.get(LOCAL_UI_TOKEN))!;
  }

  // ── Inventory ────────────────────────────────────────────────────────────
  async agentInventory() {
    const enabled = this.config.get().agents;
    const inv = await this.agents.inventory();
    return inv.map((a) => ({ ...a, enabled: enabled[a.id]?.enabled ?? true }));
  }

  async selectionInventory(): Promise<Pick<WorkerSnapshot, 'agents' | 'providers'>> {
    const agents = (await this.agentInventory())
      .filter((a) => a.enabled)
      .map((a) => ({ id: a.id, installed: a.installed, authenticated: a.authenticated ?? undefined, supportedProviders: a.supportedProviders, capabilities: a.capabilities }));
    const providers = (await this.providerInventory()).map((p) => ({
      id: p.id,
      kind: p.kind,
      healthy: p.healthy,
      limited: p.limited,
      limitedUntil: p.limitedUntil ? Date.parse(p.limitedUntil) : null,
      models: p.models,
      order: p.order,
    }));
    return { agents, providers };
  }

  /**
   * Providers as the control plane and the local UI see them: the harnesses' own logins (one per
   * installed, enabled harness that can run on its own) first, then the add-on providers.
   */
  async providerInventory() {
    const own = (await this.agentInventory()).filter((a) => a.enabled && a.installed && a.authenticated !== false && a.capabilities.includes('nativeLogin'));
    return [...this.providers.nativeInventory(own), ...this.providers.inventory()];
  }

  // ── Connection & pairing (spec §13) ──────────────────────────────────────
  controlPlaneUrl(): string | null {
    const c = this.config.get();
    if (c.connectionMode === 'hosted') return HOSTED_CONTROL_PLANE_URL;
    return c.controlPlaneUrl;
  }

  async beginPairing(mode: 'hosted' | 'self-hosted', url: string | null, name?: string) {
    this.config.update({ connectionMode: mode, controlPlaneUrl: mode === 'self-hosted' ? url : null, ...(name ? { name } : {}) });
    const base = this.controlPlaneUrl();
    if (!base) throw new Error(mode === 'hosted' ? 'This worker build has no hosted service; enter your control plane URL' : 'Control plane URL is required for self-hosted mode');
    const start = await startPairing(base, { name: this.config.get().name, hostname: os.hostname(), os: platformOs(), arch: process.arch, version: WORKER_VERSION });
    this.pairing = { status: 'waiting', userCode: start.userCode, verificationUrl: start.verificationUrl, expiresAt: start.expiresAt };
    void (async () => {
      while (this.pairing.status === 'waiting' && !this.stopped) {
        await sleep(start.intervalSec * 1000);
        try {
          const r = await pollPairing(base, start.pairingId, start.pollSecret);
          if (r.status === 'APPROVED') {
            await this.credentials.set(WORKER_CREDENTIAL, r.credential);
            this.config.update({ workerId: r.workerId, organizationId: r.organizationId });
            this.pairing = { status: 'approved' };
            await this.connect();
          } else if (r.status !== 'PENDING') this.pairing = { status: r.status === 'DENIED' ? 'denied' : 'expired' };
        } catch (e) {
          this.pairing = { ...this.pairing, error: String((e as Error).message) };
        }
      }
    })();
    return this.pairing;
  }

  async disconnect() {
    this.client?.close();
    this.client = null;
    await this.credentials.delete(WORKER_CREDENTIAL);
    this.config.update({ workerId: null, organizationId: null });
  }

  async connect() {
    const base = this.controlPlaneUrl();
    const cred = await this.credentials.get(WORKER_CREDENTIAL);
    if (!base || !cred) {
      log.info('worker not paired yet; open the local UI to connect');
      return false;
    }
    this.client?.close();
    const client = new ControlPlaneClient(base, cred);
    this.client = client;
    client.onMessage((m) => {
      switch (m.type) {
        case 'welcome':
          this.heartbeatMs = m.heartbeatMs;
          void this.heartbeat(true);
          break;
        case 'task.offer':
          void this.executor.handleOffer(m.taskId).then(() => this.saveActive());
          break;
        case 'task.control':
          this.executor.control(m.taskId, { action: m.action, input: m.input });
          break;
        case 'project.analyze':
          void this.analyzeProject(m.projectId, m.requestId);
          break;
        case 'repositories.map':
          this.applyMappings(m.mappings);
          break;
        case 'repository.clone':
          void this.cloneRepository(m);
          break;
        case 'heartbeat.ack':
          this.lastHeartbeatAt = m.serverTime;
          if (m.revokedTaskIds.length) this.executor.revoke(m.revokedTaskIds);
          break;
      }
    });
    client.onState((s) => {
      if (s === 'connected') {
        void this.flush();
        // The control plane may know new repositories since the last report: match the last scan again.
        void this.reportDiscovery();
      }
    });
    client.connect();
    this.startLoops();
    // Continue tasks this worker was running before a restart.
    const previous = this.loadActive();
    if (previous.length) void this.executor.reattach(previous);
    return true;
  }

  private startLoops() {
    if (this.heartbeatTimer) return;
    this.startDiscoveryLoop();
    const hb = () => {
      this.heartbeatTimer = setTimeout(async () => {
        await this.heartbeat();
        if (!this.stopped) hb();
      }, this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    };
    hb();
    this.flushTimer = setInterval(() => void this.flush(), 1000);
    this.flushTimer.unref?.();
    // Polling fallback for offers when the socket is down (spec §54).
    this.offerPollTimer = setInterval(async () => {
      if (!this.client || this.client.state === 'connected' || this.executor.capacity() <= 0) return;
      try {
        for (const id of (await this.client.offers()).taskIds) await this.executor.handleOffer(id);
      } catch {
        /* offline */
      }
    }, 30_000);
    this.offerPollTimer.unref?.();
  }

  private inventoryCounter = 0;
  async heartbeat(withInventory = false) {
    if (!this.client) return;
    const cfg = this.config.get();
    const includeInventory = withInventory || this.inventoryCounter++ % 4 === 0;
    const payload = {
      metrics: systemMetrics(this.dataDir),
      activeTasks: this.executor.activeTasks(),
      sentAt: new Date().toISOString(),
      ...(includeInventory
        ? {
            inventory: {
              agents: (await this.agentInventory()).filter((a) => a.enabled) as Array<Record<string, unknown>>,
              providers: (await this.providerInventory()) as Array<Record<string, unknown>>,
              // `os-sandbox`: tasks can require a worker that isolates agents (SEC-014).
              // `clone`: a projects folder is set, so repositories can be cloned here from the dashboard.
              tools: [...this.tools.tags, ...this.mcpTags(), ...(detectSandbox().backend ? ['os-sandbox'] : []), ...(cfg.projectsRoot ? ['clone'] : [])],
              projects: cfg.projects.map((p) => ({ projectId: p.projectId, ...(p.repositoryId ? { repositoryId: p.repositoryId } : {}), localPath: p.localPath })),
            },
          }
        : {}),
    };
    this.saveActive();
    if (!this.client.sendHeartbeat(payload)) {
      try {
        const ack = await this.client.httpHeartbeat(payload);
        this.lastHeartbeatAt = new Date().toISOString();
        if (ack.revokedTaskIds?.length) this.executor.revoke(ack.revokedTaskIds);
      } catch {
        /* offline: tasks continue locally; lease renewal resumes on reconnect (spec §85) */
      }
    }
  }

  /** Collect repository facts for a readiness request; only mapped projects are ever read (spec §115). */
  private async analyzeProject(projectId: string, requestId: string) {
    const mapping = this.config.get().projects.find((p) => p.projectId === projectId);
    let facts: Awaited<ReturnType<typeof collectRepoFacts>> | null = null;
    let error: string | null = null;
    try {
      if (!mapping) throw new Error('Project is not mapped on this worker');
      facts = await collectRepoFacts(mapping.localPath);
    } catch (e) {
      error = (e as Error).message;
    }
    await this.client?.request('POST', `/worker/projects/${projectId}/readiness`, { requestId, facts, error }).catch((e) => log.warn({ err: String(e) }, 'readiness submit failed'));
  }

  /** MCP servers configured locally advertise as "mcp:<id>" tool tags, but only while healthy. */
  private mcpTags(): string[] {
    return this.mcp.healthyTags();
  }

  async flush() {
    if (!this.client || !this.config.get().workerId) return;
    try {
      await this.buffer.flush(async (batch) => {
        await this.client!.sendEvents(batch);
      });
    } catch {
      /* stays buffered */
    }
  }

  private saveActive() {
    const ids = this.executor.activeTasks().map((t) => t.taskId);
    fs.writeFileSync(this.activeFile, JSON.stringify(ids));
  }

  private loadActive(): string[] {
    try {
      return JSON.parse(fs.readFileSync(this.activeFile, 'utf8'));
    } catch {
      return [];
    }
  }

  // ── Repository discovery ─────────────────────────────────────────────────
  /**
   * Scans on start when the last scan is older than the interval, then checks hourly.
   * AO_DISCOVERY_AUTOSTART=0 leaves scanning to "Scan now" (and the test suite).
   */
  private startDiscoveryLoop() {
    if (process.env.AO_DISCOVERY_AUTOSTART === '0') return;
    const due = () => {
      const d = this.config.get().discovery;
      const last = this.discovery.last ? Date.parse(this.discovery.last.scannedAt) : 0;
      return d.enabled && !this.discovery.running && Date.now() - last > d.intervalHours * 3_600_000;
    };
    const first = setTimeout(() => void (due() && this.scanRepositories()), 15_000);
    first.unref?.();
    this.discoveryTimer = setInterval(() => void (due() && this.scanRepositories()), 3_600_000);
    this.discoveryTimer.unref?.();
  }

  /** Scans the configured folders (or every fixed drive) for Git repositories and reports them. */
  async scanRepositories() {
    if (this.discovery.running) return this.discovery;
    const cfg = this.config.get().discovery;
    this.discovery = { ...this.discovery, running: true, error: null };
    this.discoveryAbort = new AbortController();
    try {
      const roots = cfg.roots.length ? cfg.roots : await defaultRoots();
      // The worker's own data folder holds worktrees and credentials, never user repositories.
      const result = await scanForRepositories({ roots, exclude: [...cfg.exclude, this.dataDir], maxDepth: cfg.maxDepth, signal: this.discoveryAbort.signal });
      this.discovery.last = result;
      fs.writeFileSync(this.discoveryFile, JSON.stringify(result));
      await this.reportDiscovery();
    } catch (e) {
      this.discovery.error = (e as Error).message;
      log.warn({ err: String(e) }, 'repository scan failed');
    } finally {
      this.discovery.running = false;
      this.discoveryAbort = null;
    }
    return this.discovery;
  }

  /** Sends the last scan to the control plane and maps the folders it recognises. */
  async reportDiscovery() {
    const last = this.discovery.last;
    if (!this.client || !last || !this.config.get().discovery.enabled) return;
    try {
      const r = await this.client.request<{ mappings: RepositoryMapping[] }>('POST', '/worker/discovery', { scannedAt: last.scannedAt, repos: last.repos });
      this.applyMappings(r.mappings);
    } catch (e) {
      log.warn({ err: String(e) }, 'discovery report failed');
    }
  }

  /**
   * Adds checkouts the control plane asks for, but only folders this worker found itself: the control
   * plane can never make agents work in an arbitrary folder. A repository already mapped stays as it is.
   */
  applyMappings(mappings: RepositoryMapping[]) {
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const found = new Set((this.discovery.last?.repos ?? []).map((r) => norm(r.localPath)));
    const cfg = this.config.get();
    const added: typeof cfg.projects = [];
    for (const m of mappings) {
      if (!found.has(norm(m.localPath))) {
        log.warn({ localPath: m.localPath }, 'ignoring a mapping for a folder this worker did not find');
        continue;
      }
      if ([...cfg.projects, ...added].some((p) => p.repositoryId === m.repositoryId || norm(p.localPath) === norm(m.localPath))) continue;
      added.push({ projectId: m.projectId, repositoryId: m.repositoryId, localPath: path.resolve(m.localPath) });
    }
    if (!added.length) return 0;
    this.config.update((c) => ({ ...c, projects: [...c.projects, ...added] }));
    log.info({ count: added.length }, 'repositories mapped from discovery');
    void this.heartbeat(true);
    return added.length;
  }

  /** Recent clones, for the local UI. */
  clones: Array<{ name: string; url: string; status: 'cloning' | 'done' | 'failed'; localPath: string | null; error: string | null; at: string }> = [];

  /**
   * Clones a project repository into the projects folder (as `<name>`, or `<name>-2`… if taken by
   * something else) and maps it. A folder that already is a clone of it is mapped as it is.
   */
  async cloneRepository(m: { requestId: string; projectId: string; repositoryId: string; name: string; url: string; defaultBranch: string; viaGithubApp: boolean }) {
    const entry = { name: m.name, url: m.url, status: 'cloning' as 'cloning' | 'done' | 'failed', localPath: null as string | null, error: null as string | null, at: new Date().toISOString() };
    this.clones = [entry, ...this.clones].slice(0, 20);
    const report = (ok: boolean) => this.client?.request('POST', `/worker/clones/${m.requestId}/result`, { ok, localPath: entry.localPath, error: entry.error }).catch(() => undefined);
    try {
      const root = this.config.get().projectsRoot;
      if (!root) throw new Error('No projects folder is set on this worker');
      fs.mkdirSync(root, { recursive: true });
      const safe = m.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '') || 'repository';
      const wanted = repositoryKey(m.url);
      let dest = '';
      for (let i = 1; i < 100 && !dest; i++) {
        const candidate = path.join(root, i === 1 ? safe : `${safe}-${i}`);
        if (!fs.existsSync(candidate) || !fs.readdirSync(candidate).length) dest = candidate;
        else {
          const existing = await describeRepository(candidate);
          if (existing && wanted && existing.remotes.some((r) => repositoryKey(r.url) === wanted)) {
            entry.localPath = candidate; // already cloned here
            break;
          }
        }
      }
      if (!entry.localPath) {
        if (!dest) throw new Error(`No free folder for ${safe} in ${root}`);
        // GitHub App repositories: a token for this clone only, passed to Git as a header (not stored).
        let env: Record<string, string> = {};
        if (m.viaGithubApp && this.client) {
          const t = await this.client.request<{ token: string | null; host?: string }>('POST', `/worker/clones/${m.requestId}/token`);
          if (t.token && t.host) env = tokenAuthEnv(t.host, t.token);
        }
        const r = await runCommand('git', ['clone', '--quiet', '--', m.url, dest], { timeoutMs: 30 * 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env } });
        if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr.trim().slice(0, 500)}`);
        entry.localPath = dest;
      }
      const localPath = entry.localPath!;
      this.config.update((c) => ({ ...c, projects: [...c.projects.filter((p) => p.repositoryId !== m.repositoryId), { projectId: m.projectId, repositoryId: m.repositoryId, localPath }] }));
      entry.status = 'done';
      log.info({ repository: m.name, localPath }, 'repository cloned');
      void this.heartbeat(true);
      await report(true);
    } catch (e) {
      entry.status = 'failed';
      entry.error = (e as Error).message;
      log.warn({ repository: m.name, err: entry.error }, 'clone failed');
      await report(false);
    }
  }

  async stop() {
    this.stopped = true;
    this.discoveryAbort?.abort();
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.mcp.stop();
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.offerPollTimer) clearInterval(this.offerPollTimer);
    this.saveActive();
    await this.executor.shutdown();
    await this.flush();
    this.client?.close();
  }
}
