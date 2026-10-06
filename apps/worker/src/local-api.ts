import fs from 'node:fs';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { PROJECT_RELEASE_KEYS, isAppError, maskSecret, policyLayerSchema, safeEqual } from '@ao/core';
import { providerConfigSchema } from '@ao/providers';
import { HOSTED_CONTROL_PLANE_URL } from './config.js';
import type { WorkerRuntime } from './runtime.js';
import { WORKER_VERSION } from './runtime.js';
import { runDiagnostics } from './diagnostics.js';
import { systemMetrics } from './system.js';
import { ProviderOAuth, supportsProviderOAuth } from './provider-oauth.js';

/**
 * Worker local API + UI (spec §12). Security:
 *  - binds to 127.0.0.1 by default;
 *  - rejects requests whose Host header is not the loopback address (DNS-rebinding defence);
 *  - every /api call needs the per-worker local token (Authorization: Bearer …). Browsers cannot send
 *    that header cross-origin without a CORS preflight, and preflights are refused (no CORS).
 */
export async function buildLocalApi(rt: WorkerRuntime, opts: { uiDir?: string; providerOAuth?: ProviderOAuth; onShutdown?: () => void } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  const token = await rt.localUiToken();
  const port = () => rt.config.get().localPort;

  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host ?? '').toLowerCase();
    const allowedHosts = ['127.0.0.1', 'localhost', '[::1]'].flatMap((h) => [h, `${h}:${port()}`]);
    if (rt.config.get().localHost === '127.0.0.1' && !allowedHosts.includes(host) && !host.startsWith('127.0.0.1:')) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Invalid Host header' } });
    }
    if (req.method === 'OPTIONS') return reply.code(403).send();
    if (req.url.startsWith('/api/')) {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || !safeEqual(auth.slice(7), token)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Local token required' } });
    }
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: { code: 'VALIDATION_FAILED', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    if (isAppError(err)) return reply.code(err.httpStatus).send({ error: err.toJSON() });
    return reply.code(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } });
  });

  // ── Status / dashboard ───────────────────────────────────────────────────
  app.get('/api/status', async () => {
    const c = rt.config.get();
    return {
      version: WORKER_VERSION,
      name: c.name,
      workerId: c.workerId,
      organizationId: c.organizationId,
      connectionMode: c.connectionMode,
      controlPlaneUrl: rt.controlPlaneUrl(),
      /** The build's hosted service, if any; the UI offers it as a choice only then. */
      hostedUrl: HOSTED_CONTROL_PLANE_URL,
      connection: rt.client ? { state: rt.client.state, lastConnectedAt: rt.client.lastConnectedAt, lastError: rt.client.lastError } : { state: 'not-configured' },
      lastHeartbeatAt: rt.lastHeartbeatAt,
      pairing: rt.pairing,
      metrics: systemMetrics(rt.dataDir),
      activeTasks: [...rt.executor.running.values()].map((r) => ({ taskId: r.taskId, status: r.status })),
      maxConcurrentTasks: c.maxConcurrentTasks,
      unsentEvents: rt.buffer.size,
      credentialBackend: rt.credentials.backend,
      startedAt: rt.startedAt,
      tools: rt.tools.details,
    };
  });
  app.get('/api/events/recent', async () => rt.buffer.recent());
  // The desktop app stops its worker through this (Windows has no signal a console-less process can receive).
  if (opts.onShutdown) {
    app.post('/api/shutdown', async () => {
      setImmediate(opts.onShutdown!);
      return { ok: true };
    });
  }

  // ── Connection (spec §13) ────────────────────────────────────────────────
  app.post('/api/connect', async (req) => {
    const body = z.object({ mode: z.enum(['hosted', 'self-hosted']), url: z.string().url().nullable().optional(), name: z.string().min(1).max(120).optional() }).parse(req.body);
    if (body.mode === 'self-hosted' && !body.url) throw new ZodError([{ code: 'custom', path: ['url'], message: 'Control plane URL is required for self-hosted mode' }]);
    if (body.mode === 'hosted' && !HOSTED_CONTROL_PLANE_URL) throw new ZodError([{ code: 'custom', path: ['mode'], message: 'This worker build has no hosted service; enter your control plane URL' }]);
    return rt.beginPairing(body.mode, body.url ?? null, body.name);
  });
  app.post('/api/disconnect', async () => {
    await rt.disconnect();
    return { ok: true };
  });

  // ── Agents (spec §52) ────────────────────────────────────────────────────
  app.get('/api/agents', async () => rt.agentInventory());
  app.put('/api/agents/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    if (!rt.agents.get(id)) return { error: 'unknown agent' };
    const body = z.object({ enabled: z.boolean().optional(), settings: z.record(z.unknown()).optional() }).parse(req.body);
    rt.config.update((c) => ({ ...c, agents: { ...c.agents, [id]: { enabled: body.enabled ?? c.agents[id]?.enabled ?? true, settings: body.settings ?? c.agents[id]?.settings ?? {} } } }));
    return rt.agentInventory();
  });

  // ── Providers (spec §51) — secrets only ever returned masked ─────────────
  // The harnesses' own logins (kind "native") come first, then the add-on providers in their order.
  app.get('/api/providers', async () => rt.providerInventory());
  app.get('/api/addons', async () => rt.config.get().addons);
  app.put('/api/addons', async (req) => {
    const body = z.object({ onHarnessLimit: z.enum(['ask', 'switch']) }).parse(req.body);
    rt.config.update({ addons: body });
    return rt.config.get().addons;
  });
  /** Order of the add-on providers: earlier ones are tried first. */
  app.put('/api/providers-order', async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()) }).parse(req.body);
    rt.config.update((c) => ({ ...c, providers: [...c.providers].sort((a, b) => (ids.indexOf(a.id) + 1 || 1e9) - (ids.indexOf(b.id) + 1 || 1e9)) }));
    await rt.providers.configure(rt.config.get().providers);
    void rt.heartbeat(true);
    return rt.providerInventory();
  });
  app.put('/api/providers/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = providerConfigSchema.omit({ id: true }).parse(req.body);
    rt.config.update((c) => ({ ...c, providers: [...c.providers.filter((p) => p.id !== id), { ...body, id, credentialRef: body.credentialRef ?? (body.kind === 'ollama' ? null : `provider:${id}`) }] }));
    await rt.providers.configure(rt.config.get().providers);
    return rt.providers.inventory();
  });
  app.post('/api/providers/:id/credential', async (req) => {
    const id = (req.params as { id: string }).id;
    const { value } = z.object({ value: z.string().min(4).max(10_000) }).parse(req.body);
    const p = rt.config.get().providers.find((x) => x.id === id);
    if (!p) return { error: 'unknown provider' };
    const ref = p.credentialRef ?? `provider:${id}`;
    await rt.credentials.set(ref, value);
    if (!p.credentialRef) rt.config.update((c) => ({ ...c, providers: c.providers.map((x) => (x.id === id ? { ...x, credentialRef: ref } : x)) }));
    await rt.providers.configure(rt.config.get().providers);
    await rt.providers.refresh(true);
    return { masked: maskSecret(value) };
  });
  // Provider sign-in instead of an API key (PROV-006). The callback is a browser redirect to this
  // loopback server, so it carries no local token: the single-use, expiring state authorizes it.
  const providerOAuth = opts.providerOAuth ?? new ProviderOAuth();
  const storeKey = async (id: string, value: string) => {
    const p = rt.config.get().providers.find((x) => x.id === id)!;
    const ref = p.credentialRef ?? `provider:${id}`;
    await rt.credentials.set(ref, value);
    if (!p.credentialRef) rt.config.update((c) => ({ ...c, providers: c.providers.map((x) => (x.id === id ? { ...x, credentialRef: ref } : x)) }));
    await rt.providers.configure(rt.config.get().providers);
    await rt.providers.refresh(true);
  };
  app.post('/api/providers/:id/oauth/start', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = rt.config.get().providers.find((x) => x.id === id);
    if (!p) return { error: 'unknown provider' };
    return providerOAuth.start(p, `http://127.0.0.1:${port()}`);
  });
  app.get('/oauth/provider/callback/:state', async (req, reply) => {
    const { state } = req.params as { state: string };
    const { code } = req.query as { code?: string };
    const page = (title: string, text: string) =>
      reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:560px;margin:4rem auto"><h1>${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">Back to the worker</a></p></body>`);
    try {
      if (!code) throw new Error('The provider did not return a code');
      const r = await providerOAuth.complete(state, code, rt.config.get().providers);
      await storeKey(r.providerId, r.key);
      return page('Signed in', `The key for ${r.providerId} is stored in this computer's credential store. You can close this tab.`);
    } catch (e) {
      reply.code(400);
      return page('Sign-in failed', (e as Error).message);
    }
  });
  app.get('/api/providers/oauth', async () => ({ kinds: ['openrouter'].filter(supportsProviderOAuth) }));
  app.post('/api/providers/:id/check', async () => {
    await rt.providers.refresh(true);
    return rt.providers.inventory();
  });
  app.delete('/api/providers/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const p = rt.config.get().providers.find((x) => x.id === id);
    if (p?.credentialRef) await rt.credentials.delete(p.credentialRef);
    rt.config.update((c) => ({ ...c, providers: c.providers.filter((x) => x.id !== id) }));
    await rt.providers.configure(rt.config.get().providers);
    return { ok: true };
  });

  // ── Projects (spec §19, §115) ────────────────────────────────────────────
  app.get('/api/projects', async () =>
    rt.config.get().projects.map((p) => ({ ...p, exists: fs.existsSync(p.localPath), isGit: fs.existsSync(path.join(p.localPath, '.git')) })),
  );
  app.put('/api/projects', async (req) => {
    const list = z.array(z.object({ projectId: z.string().regex(/^[a-f0-9]{24}$/), repositoryId: z.string().regex(/^[a-f0-9]{24}$/).optional(), localPath: z.string().min(1), name: z.string().optional() })).parse(req.body);
    for (const p of list) if (!path.isAbsolute(p.localPath) || !fs.existsSync(p.localPath)) throw new ZodError([{ code: 'custom', path: ['localPath'], message: `${p.localPath} must be an existing absolute path` }]);
    rt.config.update({ projects: list.map((p) => ({ ...p, localPath: path.resolve(p.localPath) })) });
    void rt.heartbeat(true);
    return rt.config.get().projects;
  });

  // ── Repository discovery and the projects folder ────────────────────────
  const discoveryView = () => {
    const cfg = rt.config.get();
    const norm = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const mapped = new Map(cfg.projects.map((p) => [norm(p.localPath), p]));
    const last = rt.discovery.last;
    return {
      settings: cfg.discovery,
      projectsRoot: cfg.projectsRoot,
      running: rt.discovery.running,
      error: rt.discovery.error,
      clones: rt.clones,
      last: last && {
        scannedAt: last.scannedAt,
        roots: last.roots,
        durationMs: last.durationMs,
        directories: last.directories,
        truncated: last.truncated,
        repos: last.repos.map((r) => ({ ...r, mapped: mapped.has(norm(r.localPath)) ? { projectId: mapped.get(norm(r.localPath))!.projectId } : null })),
      },
    };
  };
  app.get('/api/discovery', async () => discoveryView());
  app.post('/api/discovery/scan', async () => {
    void rt.scanRepositories();
    return discoveryView();
  });
  app.put('/api/discovery/settings', async (req) => {
    const body = z
      .object({
        enabled: z.boolean(),
        roots: z.array(z.string().min(1).max(1000)).max(50),
        exclude: z.array(z.string().min(1).max(1000)).max(200),
        intervalHours: z.number().min(1).max(168),
        maxDepth: z.number().int().min(1).max(20),
        projectsRoot: z.string().max(1000).nullable(),
      })
      .parse(req.body);
    for (const r of body.roots) if (!path.isAbsolute(r) || !fs.existsSync(r)) throw new ZodError([{ code: 'custom', path: ['roots'], message: `${r} must be an existing absolute path` }]);
    if (body.projectsRoot && !path.isAbsolute(body.projectsRoot)) throw new ZodError([{ code: 'custom', path: ['projectsRoot'], message: 'The projects folder must be an absolute path' }]);
    if (body.projectsRoot) fs.mkdirSync(body.projectsRoot, { recursive: true });
    const { projectsRoot, ...discovery } = body;
    rt.config.update({ discovery, projectsRoot: projectsRoot ? path.resolve(projectsRoot) : null });
    void rt.heartbeat(true);
    return discoveryView();
  });

  // ── MCP servers available on this worker (advertised as mcp:<id> tags) ──
  // Each server is advertised only while its MCP handshake health check passes (CAP-011).
  const withHealth = () => rt.mcp.servers().map((s) => ({ ...s, health: rt.mcp.healthOf(s.id) }));
  app.get('/api/mcp', async () => withHealth());
  app.put('/api/mcp', async (req) => {
    const list = z.array(z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/), name: z.string(), transport: z.enum(['stdio', 'http', 'sse']), command: z.array(z.string()).optional(), url: z.string().url().optional() })).parse(req.body);
    rt.mcp.save(list);
    await rt.mcp.checkAll();
    void rt.heartbeat(true);
    return withHealth();
  });
  app.post('/api/mcp/:id/check', async (req, reply) => {
    const h = await rt.mcp.checkOne((req.params as { id: string }).id);
    if (!h) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Unknown MCP server' } });
    return h;
  });

  // ── Settings ─────────────────────────────────────────────────────────────
  app.get('/api/settings', async () => {
    const { providers: _p, projects: _j, ...rest } = rt.config.get();
    return rest;
  });
  app.patch('/api/settings', async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(120).optional(),
        labels: z.array(z.string().max(64)).optional(),
        maxConcurrentTasks: z.number().int().min(1).max(32).optional(),
        policy: policyLayerSchema.optional(),
        enableMockAgent: z.boolean().optional(),
        git: z.object({ authorName: z.string().optional(), authorEmail: z.string().optional() }).optional(),
        updates: z
          .object({ policy: z.enum(['manual', 'automatic']), channel: z.enum(['stable', 'beta']), manifestUrl: z.string().url().nullable(), trustedKeys: z.record(z.string()) })
          .partial()
          .optional(),
        telemetry: z.boolean().optional(),
        plugins: z.object({ enabled: z.boolean() }).optional(),
      })
      .parse(req.body);
    rt.config.update((c) => ({ ...c, ...body, git: { ...c.git, ...(body.git ?? {}) }, updates: { ...c.updates, ...(body.updates ?? {}) } }));
    return rt.config.get();
  });

  // ── Git hosting accounts for pull/merge requests (GIT-004); tokens only ever returned masked ──
  const hostingView = async () =>
    Promise.all(rt.config.get().git.hosting.map(async (h) => ({ ...h, tokenMasked: maskSecret((await rt.credentials.get(`git-hosting:${h.host.toLowerCase()}`)) ?? '') || null })));
  app.get('/api/git-hosting', hostingView);
  app.put('/api/git-hosting/:host', async (req) => {
    const host = (req.params as { host: string }).host.toLowerCase();
    const body = z.object({ kind: z.enum(['github', 'gitlab']), apiBaseUrl: z.string().url().optional(), token: z.string().min(8).max(500) }).parse(req.body);
    const apiBaseUrl = body.apiBaseUrl ?? (host === 'github.com' ? 'https://api.github.com' : host === 'gitlab.com' ? 'https://gitlab.com' : null);
    if (!apiBaseUrl) throw new ZodError([{ code: 'custom', path: ['apiBaseUrl'], message: 'The API URL is required for this host (e.g. https://github.example.com/api/v3 or https://gitlab.example.com)' }]);
    await rt.credentials.set(`git-hosting:${host}`, body.token);
    rt.config.update((c) => ({ ...c, git: { ...c.git, hosting: [...c.git.hosting.filter((h) => h.host.toLowerCase() !== host), { host, kind: body.kind, apiBaseUrl }] } }));
    return hostingView();
  });
  app.delete('/api/git-hosting/:host', async (req) => {
    const host = (req.params as { host: string }).host.toLowerCase();
    await rt.credentials.delete(`git-hosting:${host}`);
    rt.config.update((c) => ({ ...c, git: { ...c.git, hosting: c.git.hosting.filter((h) => h.host.toLowerCase() !== host) } }));
    return hostingView();
  });

  app.get('/api/diagnostics', async () => runDiagnostics(rt));
  const updater = () => rt.updates.updater();
  app.get('/api/updates', async () => {
    const u = rt.config.get().updates;
    const installed = rt.updates.installState();
    const base = {
      currentVersion: WORKER_VERSION,
      policy: { policy: u.policy, channel: u.channel },
      manifestUrl: rt.updates.manifestUrl(),
      manifestUrlFromControlPlane: !u.manifestUrl,
      trustedKeyIds: Object.keys(rt.updates.trustedKeys()),
      projectKeyIds: Object.keys(PROJECT_RELEASE_KEYS),
      canInstall: !rt.updates.unsupportedReason(),
      installed: installed && { current: installed.current, previous: installed.previous, pending: installed.pending?.version ?? null, rolledBack: installed.bad },
    };
    if (!rt.updates.manifestUrl()) {
      return { ...base, supported: false, reason: rt.updates.unsupportedReason() };
    }
    try {
      return { ...base, supported: true, ...(await updater().check()) };
    } catch (e) {
      return { ...base, supported: true, error: (e as Error).message };
    }
  });
  // Trusted release signing keys: the only source of trust for updates (never the control plane).
  app.put('/api/updates/trusted-keys/:keyId', async (req) => {
    const keyId = (req.params as { keyId: string }).keyId;
    const { publicKeyPem } = z.object({ publicKeyPem: z.string().min(40).max(2000) }).parse(req.body);
    try {
      const key = createPublicKey(publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    } catch (e) {
      throw new ZodError([{ code: 'custom', path: ['publicKeyPem'], message: `Not an Ed25519 public key in PEM format (${(e as Error).message})` }]);
    }
    rt.config.update((c) => ({ ...c, updates: { ...c.updates, trustedKeys: { ...c.updates.trustedKeys, [keyId]: publicKeyPem.trim() + '\n' } } }));
    return { trustedKeyIds: Object.keys(rt.config.get().updates.trustedKeys) };
  });
  app.delete('/api/updates/trusted-keys/:keyId', async (req) => {
    const keyId = (req.params as { keyId: string }).keyId;
    rt.config.update((c) => ({ ...c, updates: { ...c.updates, trustedKeys: Object.fromEntries(Object.entries(c.updates.trustedKeys).filter(([k]) => k !== keyId)) } }));
    return { trustedKeyIds: Object.keys(rt.config.get().updates.trustedKeys) };
  });
  app.post('/api/updates/stage', async () => {
    const u = updater();
    const c = await u.check();
    if (!c.updateAvailable || !c.latest) return { staged: false, reason: 'Already up to date' };
    const file = await u.stage(c.latest);
    return { staged: true, version: c.latest.version, file };
  });
  /** Download, verify and install the update, then restart into it once running tasks have finished. */
  app.post('/api/updates/apply', async () => rt.updates.applyAvailable());

  if (opts.uiDir && fs.existsSync(path.join(opts.uiDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: path.resolve(opts.uiDir) });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }) : reply.sendFile('index.html')));
  } else {
    app.get('/', async (_req, reply) => reply.type('text/html').send('<!doctype html><title>Worker</title><p>The worker UI has not been built. Run <code>pnpm --filter @ao/worker-ui build</code>. The local API is available under /api.</p>'));
  }
  return app;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
