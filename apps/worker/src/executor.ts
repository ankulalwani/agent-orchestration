import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  captureError,
  backoffDelay,
  buildExecutionPrompt,
  candidateTargets,
  createLogger,
  decideFallback,
  findCycle,
  isInside,
  isNativeProvider,
  providerRoute,
  resolvePolicy,
  type AgentState,
  type Checkpoint,
  type ExecutionPolicy,
  type ExecutionTarget,
  type TaskEventType,
  type TaskRequirements,
  type TaskStatus,
  type WorkerSnapshot,
} from '@ao/core';
import { planResult, reviewResult, type PlanResult, type ReviewResult, type TaskDto, type TransitionRequest } from '@ao/contracts';
import { GATEWAY_KIND, detectSandbox, startAgentSession, wrapInvocation, type AgentManager, type AgentSession, type AgentStartRequest, type McpServerSpec } from '@ao/agents';
import { chatCompletionsBaseUrl, type ProviderManager } from '@ao/providers';
import type { ModelGateway } from './gateway/server.js';
import type { GatewayTarget } from './gateway/upstream.js';
import { GitManager, tokenAuthEnv, type Baseline } from '@ao/git';
import { VerificationEngine, failureSummary, type VerificationRun } from '@ao/verification';
import type { ClaimResult, ControlPlaneClient } from './control-client.js';
import { LeaseLostError, sleep } from './control-client.js';
import type { EventBuffer } from './event-buffer.js';
import type { WorkerConfig } from './config.js';
import type { McpMonitor } from './mcp-monitor.js';
import type { HookOutcome, PluginRunner, PluginSpec } from './plugins.js';
import { STATE_DIR, buildCheckpoint, ensureStateDir, loadTaskState, readAgentReport, saveTaskState, type LocalTaskState } from './checkpoints.js';

const log = createLogger('executor');
/** Transitions after which the timeline should already show the work that led to them. */
const FLUSH_BEFORE = new Set<TaskStatus>(['VERIFYING', 'COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL']);

export interface ExecutorDeps {
  client: () => ControlPlaneClient | null;
  /** Sends buffered events now, so they come before the next status change in the timeline. */
  flushEvents?: () => Promise<void>;
  buffer: EventBuffer;
  agents: AgentManager;
  providers: ProviderManager;
  config: () => WorkerConfig;
  /** Checks MCP servers from task capabilities before an agent gets them. */
  mcp?: Pick<McpMonitor, 'checkForTask'>;
  /** Credentials, e.g. Git hosting tokens for pull requests. */
  credentials?: { get(name: string): Promise<string | null> };
  /** The worker's data folder: hidden from sandboxed agents (it can hold credentials). */
  dataDir?: string;
  /** Runs plugin hooks (CAP-012). */
  plugins?: PluginRunner;
  /** The model gateway that lets harnesses use add-on models. */
  gateway?: Pick<ModelGateway, 'open'>;
  /** Current agent/provider inventory in the shape the core selection functions expect. */
  inventory: () => Promise<Pick<WorkerSnapshot, 'agents' | 'providers'>>;
  /** For tests: shorten waits. */
  timeScale?: number;
}

type Control = { action: 'pause' | 'resume' | 'cancel' | 'input' | 'approve' | 'deny' | 'restart'; input?: string };

class Aborted extends Error {
  constructor(readonly reason: 'cancelled' | 'lease_lost' | 'shutdown') {
    super(reason);
  }
}

/** Manages all tasks running on this worker. */
export class TaskExecutor {
  readonly running = new Map<string, TaskRun>();
  private claiming = new Set<string>();

  constructor(private deps: ExecutorDeps) {}

  /** While draining (before an update restart) no new tasks are claimed; running ones finish. */
  draining = false;

  capacity() {
    if (this.draining) return 0;
    return this.deps.config().maxConcurrentTasks - this.running.size - this.claiming.size;
  }

  activeTasks(): Array<{ taskId: string; status: TaskStatus }> {
    return [...this.running.values()].map((r) => ({ taskId: r.taskId, status: r.status }));
  }

  async handleOffer(taskId: string) {
    const client = this.deps.client();
    if (!client || this.running.has(taskId) || this.claiming.has(taskId) || this.capacity() <= 0) return;
    this.claiming.add(taskId);
    try {
      const claim = await client.claim(taskId);
      if (!claim.claimed || !claim.task) {
        log.info({ taskId, reason: claim.reason }, 'claim declined');
        return;
      }
      this.start(claim);
    } catch (e) {
      log.warn({ taskId, err: String(e) }, 'claim failed');
    } finally {
      this.claiming.delete(taskId);
    }
  }

  /** After a worker restart: continue tasks this worker still owns (spec §90 "computer restarts"). */
  async reattach(taskIds: string[]) {
    const client = this.deps.client();
    if (!client) return;
    for (const id of taskIds) {
      try {
        const info = await client.getTask(id);
        if (info.claimed && info.task) {
          log.info({ taskId: id }, 'reattaching to task after restart');
          this.start(info, true);
        }
      } catch (e) {
        log.warn({ taskId: id, err: String(e) }, 'reattach failed; lease expiry will recover the task');
      }
    }
  }

  private start(claim: ClaimResult, reattached = false) {
    const run = new TaskRun(this.deps, claim, reattached);
    this.running.set(run.taskId, run);
    void run
      .execute()
      .catch((e) => {
        log.error({ taskId: run.taskId, err: String(e) }, 'task run crashed');
        captureError(e, { tags: { component: 'worker.task', taskId: run.taskId } });
      })
      .finally(() => this.running.delete(run.taskId));
  }

  control(taskId: string, c: Control) {
    this.running.get(taskId)?.control(c);
  }

  revoke(taskIds: string[]) {
    for (const id of taskIds) this.running.get(id)?.control({ action: 'cancel' });
  }

  async shutdown() {
    await Promise.all([...this.running.values()].map((r) => r.shutdown()));
  }
}

interface SessionOutcome {
  state: AgentState;
  detail?: string;
  retryAt: number | null;
  inputQuestion: string | null;
  durationMs: number;
  stoppedFor: Control['action'] | 'hang' | null;
}

/** One task's execution on this worker, including the recovery engine (spec §27–§31, §44). */
export class TaskRun {
  readonly taskId: string;
  status: TaskStatus;
  private task: TaskDto;
  private policy!: ExecutionPolicy;
  private cwd!: string;
  private stateRoot!: string;
  private git: GitManager | null = null;
  private baseline: Baseline | null = null;
  private local!: LocalTaskState;
  private session: AgentSession | null = null;
  private target: ExecutionTarget | null = null;
  /** Agents/providers the control plane reported at their organization-wide concurrency limit. */
  private saturated = { agents: new Set<string>(), providers: new Set<string>() };
  private checkpoint: Checkpoint | null;
  private controls: Control[] = [];
  private controlWaiter: (() => void) | null = null;
  private aborted: Aborted | null = null;
  private pendingActiveMs = 0;
  private fallbackStep: number;
  private lastVerification: VerificationRun | null = null;
  /** Where the agent works: the project, or for reviews a detached worktree of the reviewed commit. */
  private agentCwd!: string;
  /**
   * Multi-repository projects: the other repositories (the primary one is `cwd`), each with its own Git
   * state. The agent works in all of them; each is verified and committed on its own.
   */
  private others: Array<{ name: string; path: string; git: GitManager | null; baseline: Baseline | null }> = [];
  private primaryName = 'project';
  /** Review tasks (FUT-003): the changes under review, and the validated review once written. */
  private review: { base: string; head: string; baseCommit: string; headCommit: string; stat: string; diff: string; truncated: boolean; worktree: string } | null = null;
  private reviewOutcome: ReviewResult | null = null;
  /** Plan tasks (FUT-001): the worktree the planner reads (null without Git), and the validated plan. */
  private planning: { worktree: string | null; headCommit: string | null } | null = null;
  private planOutcome: PlanResult | null = null;
  private waitedInStepMs = 0;
  private startedAt = Date.now();
  /** Instructions from plugins' task.prepare hooks, added to the agent prompt. */
  private pluginInstructions: Array<{ name: string; instructions: string }> = [];
  private pluginsSkippedReported = false;
  private sandboxWarned = false;

  constructor(
    private deps: ExecutorDeps,
    private claim: ClaimResult,
    private reattached: boolean,
  ) {
    this.task = claim.task!;
    this.taskId = this.task.id;
    this.status = this.task.status;
    this.checkpoint = (this.task.lastCheckpoint as Checkpoint | null) ?? null;
    this.fallbackStep = this.task.fallbackStep ?? -1;
  }

  private get client() {
    const c = this.deps.client();
    if (!c) throw new AppError('INTERNAL', 'Worker is not connected to a control plane');
    return c;
  }

  private ev(type: TaskEventType, payload: Record<string, unknown> = {}) {
    this.deps.buffer.push(this.taskId, type, payload, this.task.correlationId);
  }

  private recovery(msg: string) {
    this.local.recoveryEvents.push(`${new Date().toISOString()} ${msg}`);
    this.persist();
  }

  private persist() {
    if (this.stateRoot) saveTaskState(this.stateRoot, { ...this.local, baseline: this.baseline, branch: this.local.branch });
  }

  private scaled(ms: number) {
    return Math.max(1, Math.round(ms * (this.deps.timeScale ?? 1)));
  }

  // ── Control plane transitions (idempotent, retried while the network is down) ──
  private async tr(to: TaskStatus, patch: TransitionRequest['patch'] = {}, reason?: string) {
    this.throwIfAborted();
    // What the agent and the worker did so far (tools, verification steps, commits) belongs before the
    // outcome in the timeline, and before a question to a person. Only for those transitions, and best
    // effort: a slow or offline control plane doesn't hold the task up.
    if (this.deps.flushEvents && FLUSH_BEFORE.has(to)) await Promise.race([this.deps.flushEvents().catch(() => undefined), sleep(2000)]);
    const transitionId = randomUUID();
    const body = { to, reason, transitionId, patch: { ...patch, ...(this.pendingActiveMs ? { activeMsDelta: this.pendingActiveMs } : {}) } };
    for (let attempt = 0; ; attempt++) {
      try {
        const t = await this.client.transition(this.taskId, body);
        this.pendingActiveMs = 0;
        this.status = t.status;
        this.task = t;
        return t;
      } catch (e) {
        if (e instanceof LeaseLostError) throw this.abort('lease_lost');
        const retryable = e instanceof AppError ? e.retryable : true;
        if (!retryable) throw e;
        // Control plane unreachable: keep local state, keep retrying with the same transitionId (spec §85).
        log.warn({ taskId: this.taskId, to, attempt, err: String(e) }, 'transition deferred; retrying');
        await sleep(this.scaled(backoffDelay(attempt, 2000, 60_000)));
        this.throwIfAborted();
      }
    }
  }

  /** Best-effort progress update that never blocks execution. */
  private progress(patch: TransitionRequest['patch']) {
    const c = this.deps.client();
    if (!c || this.aborted) return;
    void c.transition(this.taskId, { to: this.status, patch }, 0).catch((e) => {
      if (e instanceof LeaseLostError) this.abort('lease_lost');
    });
  }

  private abort(reason: Aborted['reason']) {
    if (!this.aborted) {
      this.aborted = new Aborted(reason);
      void this.session?.stop();
      this.controlWaiter?.();
    }
    return this.aborted;
  }

  private throwIfAborted() {
    if (this.aborted) throw this.aborted;
  }

  control(c: Control) {
    if (c.action === 'cancel') {
      this.abort('cancelled');
      return;
    }
    this.controls.push(c);
    if (['pause', 'restart'].includes(c.action)) void this.session?.stop();
    this.controlWaiter?.();
  }

  async shutdown() {
    this.abort('shutdown');
    await this.session?.done;
  }

  private async waitForControl(accept: Array<Control['action']>, timeoutMs?: number): Promise<Control | null> {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity;
    for (;;) {
      this.throwIfAborted();
      const idx = this.controls.findIndex((c) => accept.includes(c.action));
      if (idx >= 0) return this.controls.splice(idx, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(remaining, 60_000));
        this.controlWaiter = () => {
          clearTimeout(t);
          resolve();
        };
      });
      this.controlWaiter = null;
    }
  }

  // ── Main flow ──────────────────────────────────────────────────────────────
  async execute() {
    try {
      await this.prepare();
      this.pluginInstructions = (await this.runPlugins('task.prepare', {}))
        .filter((o) => o.ok && (o.result as { instructions?: string })?.instructions)
        .map((o) => ({ name: `Plugin ${o.pluginId}`, instructions: (o.result as { instructions: string }).instructions }));
      let verificationFailures: string | null = null;
      let userInput: string | null = null;
      for (;;) {
        const result = await this.executeAgent(verificationFailures, userInput);
        userInput = null;
        if (result === 'stop') return;
        const v = await this.verify();
        if (v === 'passed') {
          await this.finish();
          return;
        }
        if (v === 'stop') return;
        verificationFailures = v;
      }
    } catch (e) {
      if (e instanceof Aborted) {
        log.info({ taskId: this.taskId, reason: e.reason }, 'task run aborted');
        if (this.stateRoot) this.persist();
        return;
      }
      log.error({ taskId: this.taskId, err: String(e) }, 'unexpected executor error');
      captureError(e, { correlationId: this.task.correlationId ?? null, tags: { component: 'worker.executor', taskId: this.taskId, agentId: this.target?.agentId } });
      try {
        this.checkpoint = this.stateRoot ? buildCheckpoint(this.stateRoot, this.taskId, this.checkpoint, { reason: 'crash' }) : this.checkpoint;
        await this.tr('RECOVERY_REQUIRED', { lastCheckpoint: this.checkpoint as never }, `Worker error: ${(e as Error).message}`);
      } catch {
        /* lease expiry will recover it */
      }
    }
  }

  private async prepare() {
    const cfg = this.deps.config();
    const layers = this.claim.policyLayers ?? { platform: {}, organization: {}, project: {}, task: {} };
    this.policy = resolvePolicy(layers.platform as object, layers.organization as object, layers.project as object, cfg.policy, layers.task as object);

    // Project isolation (spec §115): every claimed path must be one this worker has mapped.
    const repos = this.claim.repositories?.length
      ? this.claim.repositories
      : this.claim.localPath
        ? [{ repositoryId: '', name: 'project', localPath: this.claim.localPath, primary: true, defaultBranch: 'main' }]
        : [];
    const primary = repos.find((r) => r.primary) ?? repos[0];
    if (!primary || repos.some((r) => !this.isMapped(r))) throw new AppError('PATH_OUTSIDE_PROJECT', 'Project path is not mapped on this worker or does not exist');
    this.cwd = path.resolve(primary.localPath);
    this.primaryName = primary.name;
    this.agentCwd = this.cwd;
    this.stateRoot = ensureStateDir(this.cwd);
    if (!isInside(this.cwd, this.stateRoot)) throw new AppError('PATH_OUTSIDE_PROJECT', 'State directory escaped project');
    this.local = loadTaskState(this.stateRoot, this.taskId) ?? { taskId: this.taskId, baseline: null, branch: null, recoveryEvents: [], consecutiveFailures: [], updatedAt: '' };

    if (this.status === 'CLAIMING') await this.tr('PREPARING');
    if (this.reattached) this.recovery('Worker restarted; continuing from last checkpoint');

    const isCode = (this.task.kind ?? 'code') === 'code';
    const branch = this.policy.git.policy !== 'NONE' && this.policy.git.workOnBranch && isCode ? (this.local.branch ?? `${this.policy.git.branchPrefix}${slug(this.task.title)}-${this.taskId.slice(-6)}`) : null;
    const git = this.newGit(this.cwd, primary.name);
    if (await git.isRepo()) {
      this.git = git;
      await git.excludeStateDir(`${STATE_DIR}/`);
      this.baseline = (this.local.baseline as Baseline | null) ?? (await git.baseline());
      if (branch) {
        await git.ensureBranch(branch);
        this.local.branch = branch;
      }
      this.persist();
    } else {
      this.ev('GitOperationBlocked', { reason: 'Project directory is not a Git repository; Git policy skipped' });
    }
    // The project's other repositories: the same task branch in each, and a baseline of each so only the
    // task's own changes are committed. Reviews and plans look at the primary repository only.
    if (isCode) {
      for (const r of repos.filter((x) => x !== primary)) {
        const dir = path.resolve(r.localPath);
        const g = this.newGit(dir, r.name);
        const other = { name: r.name, path: dir, git: null as GitManager | null, baseline: null as Baseline | null };
        if (await g.isRepo()) {
          other.git = g;
          other.baseline = (this.local.repoBaselines?.[r.name] as Baseline | undefined) ?? (await g.baseline());
          if (branch) {
            await g.ensureBranch(branch);
            this.local.branch = branch;
          }
        } else this.ev('GitOperationBlocked', { reason: `${r.name} is not a Git repository; Git policy skipped for it` });
        this.others.push(other);
      }
      this.local.repoBaselines = Object.fromEntries(this.others.filter((o) => o.baseline).map((o) => [o.name, o.baseline]));
      this.persist();
    }
    if (this.task.kind === 'plan') await this.preparePlan();

    if (this.task.kind === 'review') await this.prepareReview();

    // Environment profile (spec §78): every referenced secret must exist.
    const envProfile = this.claim.environment;
    if (envProfile?.missingSecrets.length) {
      await this.tr('RECOVERY_REQUIRED', {}, `Environment "${envProfile.name}" references secrets that do not exist: ${envProfile.missingSecrets.join(', ')}. Add them under Settings → Secrets and retry.`);
      throw new Aborted('cancelled');
    }
    const needsApproval = this.policy.requireApprovalFor.plan || Boolean(envProfile?.requiresApproval) || (this.task.environment === 'production' && this.policy.requireApprovalFor.production);
    if (needsApproval && !this.reattached && ['PREPARING'].includes(this.status)) {
      const question = this.task.environment === 'production' ? 'This task targets PRODUCTION. Approve execution?' : envProfile?.requiresApproval ? `This task targets the ${envProfile.name} environment. Approve execution?` : 'Approve execution of this task?';
      await this.tr('WAITING_FOR_APPROVAL', { pendingInteraction: { kind: 'approval', question } }, 'Waiting for approval');
      this.ev('ApprovalRequested', { question });
      const c = await this.waitForControl(['approve', 'deny']);
      if (c?.action === 'deny') {
        await this.tr('CANCELLED', {}, 'Execution denied by approver');
        throw new Aborted('cancelled');
      }
      await this.tr('PREPARING', { pendingInteraction: null }, 'Approved');
    }
  }

  /**
   * A claimed checkout is one this worker has mapped: by repository id (wherever the repository is now),
   * or by project for mappings without one (older configuration: the primary repository).
   */
  private isMapped(r: { repositoryId: string; localPath: string; primary: boolean }) {
    const target = path.resolve(r.localPath);
    const mapped = this.deps.config().projects.some(
      (p) => path.resolve(p.localPath) === target && (r.repositoryId && p.repositoryId ? p.repositoryId === r.repositoryId : p.projectId === this.task.projectId && (r.primary || !r.repositoryId)),
    );
    return mapped && fs.existsSync(target);
  }

  private newGit(dir: string, repository: string) {
    const cfg = this.deps.config();
    const local = async (host: string) => {
      const account = this.deps.config().git.hosting.find((h) => h.host.toLowerCase() === host);
      const token = account ? await this.deps.credentials?.get(`git-hosting:${account.host.toLowerCase()}`) : null;
      return account && token ? { kind: account.kind, apiBaseUrl: account.apiBaseUrl, token } : null;
    };
    return new GitManager(dir, {
      authorName: cfg.git.authorName,
      authorEmail: cfg.git.authorEmail,
      // A token set up on this worker wins; otherwise the organization's GitHub App (for its repositories).
      hosting: async (host) => (await local(host)) ?? (await this.appCredential(repository, host)),
      pushAuth: async (host) => {
        if (await local(host)) return null; // the user's own Git credentials, as before
        const c = await this.appCredential(repository, host);
        return c ? tokenAuthEnv(host, c.token) : null;
      },
    });
  }

  /** Short-lived GitHub App tokens for this task's repositories, fetched once per run (they last about an hour). */
  private appCredentials: { at: number; list: Promise<Array<{ name: string; token: string; apiBaseUrl: string; host: string }>> } | null = null;
  private async appCredential(repository: string, host: string) {
    if (!this.appCredentials || Date.now() - this.appCredentials.at > 45 * 60_000) {
      const client = this.deps.client();
      const list = client
        ? client
            .request<{ repositories: Array<{ name: string; token: string; apiBaseUrl: string; host: string }> }>('POST', `/worker/tasks/${this.taskId}/git-credentials`, undefined, { retries: 1 })
            .then((r) => r.repositories)
            .catch(() => {
              this.appCredentials = null; // ask again next time
              return [];
            })
        : Promise.resolve([]);
      this.appCredentials = { at: Date.now(), list };
    }
    const c = (await this.appCredentials.list).find((x) => x.name === repository && x.host === host);
    return c ? { kind: 'github' as const, apiBaseUrl: c.apiBaseUrl, token: c.token } : null;
  }

  /** The repositories as the agent is told about them (only for projects with more than one). */
  private promptRepositories() {
    return this.others.length ? [{ name: this.primaryName, path: this.cwd, primary: true }, ...this.others.map((o) => ({ name: o.name, path: o.path, primary: false }))] : null;
  }

  private requirements(): TaskRequirements {
    return { projectId: this.task.projectId, repositoryCount: 1 + this.others.length, ...(this.task.requirements as object) };
  }

  /**
   * Capability plan (spec §36): MCP servers and skills from effective capabilities, filtered by agent
   * compatibility. MCP servers that fail the health check are left out (and recorded) rather than
   * handed to the agent broken (CAP-011).
   */
  private async capabilityPlan(agentId: string) {
    const caps = this.claim.capabilities ?? [];
    const compatible = caps.filter((c) => !c.manifest.compatibleAgents?.length || c.manifest.compatibleAgents.includes(agentId));
    const mcpServers: McpServerSpec[] = compatible
      .filter((c) => c.manifest.type === 'mcp' && c.manifest.mcp)
      .map((c) => ({ name: c.manifest.id, transport: c.manifest.mcp.transport, command: c.manifest.mcp.command, url: c.manifest.mcp.url, env: c.manifest.mcp.env }));
    const skills = compatible.filter((c) => c.manifest.type === 'skill' && c.manifest.skill).map((c) => ({ name: c.manifest.name, instructions: c.manifest.skill.instructions as string }));
    const incompatible = caps.filter((c) => !compatible.includes(c)).map((c) => c.manifest.id);
    const unhealthy: Array<{ id: string; error?: string }> = [];
    if (this.deps.mcp) {
      const checks = await Promise.all(mcpServers.map(async (m) => ({ m, h: await this.deps.mcp!.checkForTask({ id: m.name, transport: m.transport, command: m.command, url: m.url, env: m.env, cwd: this.cwd }) })));
      for (const { m, h } of checks) if (!h.ok) unhealthy.push({ id: m.name, error: h.error });
    }
    return { mcpServers: mcpServers.filter((m) => !unhealthy.some((u) => u.id === m.name)), skills, incompatible, unhealthy };
  }

  private async pickTarget(exclude: ExecutionTarget[] = []): Promise<ExecutionTarget | null> {
    const inv = await this.deps.inventory();
    const excluded = (t: ExecutionTarget) =>
      this.saturated.agents.has(t.agentId) ||
      this.saturated.providers.has(t.providerId) ||
      exclude.some((x) => x.agentId === t.agentId && x.providerId === t.providerId && x.modelId === t.modelId);
    const cands = candidateTargets(inv, this.requirements(), this.policy, { exclude: excluded });
    const cur = this.task.agentId && this.task.providerId && this.task.modelId ? { agentId: this.task.agentId, providerId: this.task.providerId, modelId: this.task.modelId } : null;
    // Keep the current target if it's still viable (continuity, resumable session), except that a task
    // running on add-on models goes back to the harness's own login once that is available again.
    if (cur && cands.some((c) => c.agentId === cur.agentId && c.providerId === cur.providerId && c.modelId === cur.modelId)) {
      const back = cands[0] && isNativeProvider(cands[0].providerId) && !isNativeProvider(cur.providerId) ? cands[0] : null;
      if (back) this.recovery(`${back.agentId}'s own login is available again; continuing on it`);
      return back ?? cur;
    }
    return cands[0] ?? null;
  }

  /**
   * How the session reaches its model: the harness's own login (nothing injected), a provider it
   * supports directly (key and endpoint), or add-on models through the worker's model gateway.
   */
  private async providerBinding(target: ExecutionTarget): Promise<{ provider: AgentStartRequest['provider']; close?: () => void }> {
    if (isNativeProvider(target.providerId)) return { provider: { providerId: target.providerId, kind: 'native', modelId: target.modelId, apiKey: null } };
    const provState = this.deps.providers.get(target.providerId);
    const inv = await this.deps.inventory();
    const agent = inv.agents.find((a) => a.id === target.agentId);
    const prov = inv.providers.find((p) => p.id === target.providerId);
    if (agent && prov && providerRoute(agent, prov) === 'gateway' && this.deps.gateway) {
      const chain = await this.gatewayChain(target);
      const session = await this.deps.gateway.open({
        chain,
        onServed: (served, skipped) => {
          if (!skipped.length) return;
          // Fallback inside a turn: the next add-on model answered.
          this.ev('FallbackStarted', { fromAgentId: target.agentId, fromProviderId: skipped[0]!.target.providerId, fromModelId: skipped[0]!.target.model, agentId: target.agentId, providerId: served.providerId, modelId: served.model, reason: `GATEWAY: ${skipped.map((s) => `${s.target.name}/${s.target.model} ${s.reason}`).join('; ')}`.slice(0, 500) });
        },
      });
      return { provider: { providerId: target.providerId, kind: GATEWAY_KIND, modelId: session.alias, apiKey: session.token, baseUrl: session.baseUrl }, close: session.close };
    }
    const apiKey = provState?.config.useAgentLogin ? null : await this.deps.providers.credentialFor(target.providerId);
    return { provider: { providerId: target.providerId, kind: provState?.config.kind ?? target.providerId, modelId: target.modelId, apiKey, baseUrl: provState?.config.baseUrl ?? null, extra: provState?.config.extra } };
  }

  /** The add-on models a gateway session may use: the chosen one first, then the others this task may use, best first. */
  private async gatewayChain(target: ExecutionTarget): Promise<GatewayTarget[]> {
    const inv = await this.deps.inventory();
    const others = candidateTargets(inv, { ...this.requirements(), agentId: target.agentId }, this.policy).filter((t) => !isNativeProvider(t.providerId));
    const ordered = [target, ...others.filter((t) => !(t.providerId === target.providerId && t.modelId === target.modelId))];
    const chain: GatewayTarget[] = [];
    for (const t of ordered) {
      const p = this.deps.providers.get(t.providerId);
      const baseUrl = p ? chatCompletionsBaseUrl(p.config) : null;
      if (!p || !baseUrl) continue;
      chain.push({ providerId: t.providerId, name: p.config.name, baseUrl, apiKey: await this.deps.providers.credentialFor(t.providerId), model: t.modelId, kind: p.config.kind });
    }
    return chain;
  }

  /**
   * The harness's own login reached its limit. With add-on models (or another harness) available, the
   * worker's setting decides: switch automatically, or ask. Without any, the fallback policy applies
   * (by default: wait for the reset).
   */
  private async onHarnessLimit(retryAt: number | null, cpPatch: TransitionRequest['patch']): Promise<'continue' | 'stop'> {
    const current = this.target!;
    const alt = await this.pickTarget([current]);
    if (!alt) return this.applyFallback(retryAt, cpPatch);
    const agentName = this.deps.agents.get(current.agentId)?.name ?? current.agentId;
    const until = retryAt ? ` until ${new Date(retryAt).toLocaleString()}` : '';
    const altName = isNativeProvider(alt.providerId) ? `${this.deps.agents.get(alt.agentId)?.name ?? alt.agentId} (its own login)` : `${this.deps.providers.get(alt.providerId)?.config.name ?? alt.providerId} / ${alt.modelId}`;
    if (this.deps.config().addons.onHarnessLimit === 'ask') {
      const answer = await this.askUser(`${agentName}'s own login reached its usage limit${until}. Reply "switch" to continue now with ${altName}, or "wait" to wait for the limit to reset.`, cpPatch);
      if (answer === null) return 'stop';
      if (!/\b(switch|yes|continue|add-?on|go)\b/i.test(answer)) {
        // WAITING_FOR_INPUT can't go straight to WAITING_FOR_LIMIT.
        await this.tr('RUNNING', { pendingInteraction: null }, 'User chose to wait for the limit');
        return (await this.waitForLimit(retryAt, `Waiting for ${agentName}'s limit to reset (chosen by user)`)) ? 'continue' : 'stop';
      }
    }
    this.ev('FallbackStarted', { fromAgentId: current.agentId, fromProviderId: current.providerId, fromModelId: current.modelId, ...alt, reason: 'HARNESS_LIMIT' });
    this.recovery(`${agentName}'s own login reached its limit${until}; continuing with ${altName}`);
    this.target = alt;
    await this.tr('RUNNING', this.deps.config().addons.onHarnessLimit === 'ask' ? {} : cpPatch, `Continuing with ${altName}`);
    return 'continue';
  }

  /** Runs agent sessions until the agent reports completion (→ 'verify') or the task ends (→ 'stop'). */
  private async executeAgent(verificationFailures: string | null, initialInput: string | null): Promise<'verify' | 'stop'> {
    let userInput = initialInput;
    let resumeAllowed = !verificationFailures; // after verification failure give full context again
    let networkRetries = 0;
    if (this.policy.sandbox.mode === 'required') {
      const sb = detectSandbox();
      if (!sb.backend) {
        await this.tr('RECOVERY_REQUIRED', { lastCheckpoint: this.checkpoint as never }, `The task policy requires an OS sandbox for agents, but this worker has none: ${sb.reason} Run it on a worker with the os-sandbox tool, or change the sandbox policy.`);
        return 'stop';
      }
    }
    this.target = await this.pickTarget();

    for (;;) {
      this.throwIfAborted();
      if (!this.target) {
        const inv = await this.deps.inventory();
        const anyLimited = inv.providers.some((p) => p.limited || (p.limitedUntil && p.limitedUntil > Date.now()));
        if (anyLimited) {
          const cont = await this.waitForLimit(null, 'All compatible providers are limited');
          if (!cont) return 'stop';
          this.target = await this.pickTarget();
          continue;
        }
        await this.tr('RECOVERY_REQUIRED', { lastCheckpoint: this.checkpoint as never }, 'No compatible agent/provider/model is available on this worker for this task');
        return 'stop';
      }
      if (this.policy.maxExecutionMs > 0 && this.task.activeMs + this.pendingActiveMs > this.policy.maxExecutionMs) {
        await this.tr('RECOVERY_REQUIRED', { lastCheckpoint: this.checkpoint as never }, `Execution time limit (${this.policy.maxExecutionMs} ms) exceeded`);
        return 'stop';
      }

      const adapter = this.deps.agents.get(this.target.agentId)!;
      const inst = await this.deps.agents.detect(this.target.agentId);
      const caps = adapter.capabilities(inst);
      // Caches/histories the CLI leaves in the project must never end up in a task commit.
      for (const pattern of caps.gitExcludes ?? []) for (const g of [this.git, ...this.others.map((o) => o.git)]) await g?.excludeStateDir(pattern);
      const sameAgentAsBefore = this.task.agentId === this.target.agentId && this.task.providerId === this.target.providerId;
      const resumeId = resumeAllowed && caps.resume && sameAgentAsBefore && this.task.sessionId ? this.task.sessionId : null;
      const plan = await this.capabilityPlan(this.target.agentId);
      if (plan.unhealthy.length) {
        this.ev('CapabilityPlanCreated', { skipped: plan.unhealthy.map((u) => u.id), reason: 'MCP server failed its health check', details: plan.unhealthy });
        this.recovery(`MCP server(s) not used because they failed the health check: ${plan.unhealthy.map((u) => `${u.id} (${u.error ?? 'unhealthy'})`).join('; ')}`);
      }
      if (plan.incompatible.length) this.ev('CapabilityPlanCreated', { skipped: plan.incompatible, reason: `Not compatible with ${this.target.agentId}` });

      const ourSessionId = randomUUID();
      const prompt = resumeId && !this.review && !this.planning
        ? buildExecutionPrompt({ taskId: this.taskId, title: 'Continue the task', prompt: 'Continue the task from where you stopped. Re-read the progress file first.', stateDir: STATE_DIR, checkpoint: this.checkpoint, userInput, repositories: this.promptRepositories() })
        : buildExecutionPrompt({
            taskId: this.taskId,
            title: this.task.title,
            prompt: this.task.normalizedPrompt ?? this.task.originalPrompt,
            plan: this.task.generatedPlan,
            stateDir: STATE_DIR,
            checkpoint: this.checkpoint,
            verificationFailures,
            remediationAttempt: this.task.remediationCount,
            knowledge: this.claim.knowledge,
            skills: [...plan.skills, ...this.pluginInstructions],
            review: this.review,
            planning: this.planning ? { maxTasks: 30 } : null,
            userInput,
            repositories: this.promptRepositories(),
          });
      try {
        await this.tr(
          'RUNNING',
          { agentId: this.target.agentId, providerId: this.target.providerId, modelId: this.target.modelId, sessionId: resumeId ?? ourSessionId, fallbackStep: this.fallbackStep, pendingInteraction: null },
          resumeId ? 'Resuming agent session' : 'Agent session started',
        );
      } catch (e) {
        // Organization-wide agent/provider limit (spec §46): try another target, else give the task back.
        if (!(e instanceof AppError && e.code === 'CONCURRENCY_LIMIT')) throw e;
        const { scope, key } = e.context as { scope?: string; key?: string };
        (scope === 'provider' ? this.saturated.providers : this.saturated.agents).add(key ?? (scope === 'provider' ? this.target.providerId : this.target.agentId));
        const alt = await this.pickTarget();
        if (alt) {
          this.ev('FallbackStarted', { fromAgentId: this.target.agentId, fromProviderId: this.target.providerId, ...alt, reason: 'CONCURRENCY_LIMIT' });
          this.target = alt;
          resumeAllowed = false;
          continue;
        }
        await this.tr('QUEUED', { lastCheckpoint: this.checkpoint as never }, `Waiting for a free agent/provider slot — ${e.message}`);
        return 'stop';
      }
      this.ev(resumeId ? 'SessionResumed' : 'AgentStarted', { ...this.target, resumed: Boolean(resumeId), agentVersion: inst.version });

      const binding = await this.providerBinding(this.target);
      let outcome: SessionOutcome;
      try {
        outcome = await this.runSession(adapter, inst, {
          taskId: this.taskId,
          cwd: this.agentCwd,
          prompt,
          provider: binding.provider,
          sessionId: ourSessionId,
          resumeSessionId: resumeId,
          mcpServers: plan.mcpServers,
          stateDir: this.stateRoot,
          settings: this.deps.config().agents[this.target.agentId]?.settings ?? {},
          ...(this.others.length ? { additionalDirs: this.others.map((o) => o.path) } : {}),
        });
      } finally {
        binding.close?.();
      }
      userInput = null;
      verificationFailures = null;
      resumeAllowed = true;

      // Checkpoint after every session, whatever happened (spec §26, §27).
      const reason = outcome.state === 'CONTEXT_EXHAUSTED' ? 'context' : ['RATE_LIMITED', 'CAPACITY_LIMITED'].includes(outcome.state) ? 'limit' : outcome.state === 'COMPLETED' ? 'periodic' : outcome.stoppedFor === 'pause' ? 'pause' : 'crash';
      this.checkpoint = buildCheckpoint(this.stateRoot, this.taskId, this.checkpoint, { reason, sessionId: this.session?.agentSessionId ?? undefined, ...this.target });
      this.ev('CheckpointCreated', { reason, nextAction: this.checkpoint.nextAction, remaining: this.checkpoint.remainingSteps.length });
      const cpPatch = { lastCheckpoint: this.checkpoint as never, sessionId: this.session?.agentSessionId ?? resumeId ?? ourSessionId };

      // Control-initiated stops.
      if (outcome.stoppedFor === 'pause') {
        await this.tr('PAUSED', cpPatch, 'Paused by user');
        this.ev('TaskPaused', {});
        await this.waitForControl(['resume']);
        this.ev('TaskResumed', {});
        continue;
      }
      if (outcome.stoppedFor === 'restart') {
        this.recovery('Restarted by user');
        resumeAllowed = false;
        await this.tr('RUNNING', { ...cpPatch, incRestart: true }, 'Restarting agent session');
        continue;
      }

      // An agent that asked a question and then ended its turn is waiting for input, not crashed
      // (spec §84) — unless the session ended for a limit/context/auth reason, which takes priority.
      const questionEndsSession = outcome.inputQuestion && ['COMPLETED', 'CRASHED', 'FAILED'].includes(outcome.state) && outcome.stoppedFor === null;
      switch (questionEndsSession ? 'COMPLETED' : outcome.state) {
        case 'COMPLETED': {
          this.local.consecutiveFailures = [];
          if (outcome.inputQuestion) {
            const answer = await this.askUser(outcome.inputQuestion, cpPatch);
            if (answer === null) return 'stop';
            userInput = answer;
            continue;
          }
          await this.tr('RUNNING', cpPatch, 'Agent reported completion; verifying');
          return 'verify';
        }
        case 'RATE_LIMITED':
        case 'CAPACITY_LIMITED': {
          this.deps.providers.markLimited(this.target.providerId, outcome.retryAt);
          this.ev('ProviderLimitDetected', { ...this.target, state: outcome.state, retryAt: outcome.retryAt ? new Date(outcome.retryAt).toISOString() : null, detail: outcome.detail });
          this.recovery(`${outcome.state} on ${this.target.providerId}${outcome.retryAt ? ` until ${new Date(outcome.retryAt).toISOString()}` : ' (reset time unknown)'}`);
          const next = isNativeProvider(this.target.providerId) ? await this.onHarnessLimit(outcome.retryAt, { ...cpPatch, incLimitHit: true }) : await this.applyFallback(outcome.retryAt, { ...cpPatch, incLimitHit: true });
          if (next === 'stop') return 'stop';
          continue;
        }
        case 'CONTEXT_EXHAUSTED': {
          const resets = this.task.contextResetCount + 1;
          this.ev('ContextExhausted', { resets });
          this.recovery(`Context exhausted (reset ${resets}); continuing in a new session from checkpoint`);
          if (resets > this.policy.maxContextResets) {
            await this.tr('RECOVERY_REQUIRED', { ...cpPatch, incContextReset: true }, `Context reset limit (${this.policy.maxContextResets}) reached`);
            return 'stop';
          }
          resumeAllowed = false; // a resumed session would carry the same exhausted context
          await this.tr('RUNNING', { ...cpPatch, incContextReset: true }, 'Context exhausted; starting a fresh session from checkpoint');
          continue;
        }
        case 'AUTH_REQUIRED':
        case 'INSTALLATION_NOT_FOUND': {
          this.recovery(`${outcome.state} for ${this.target.agentId}/${this.target.providerId}: ${outcome.detail ?? ''}`);
          const alt = await this.pickTarget([this.target, ...this.excludedByProvider(this.target.providerId)]);
          if (alt) {
            this.ev('FallbackStarted', { fromAgentId: this.target.agentId, fromProviderId: this.target.providerId, ...alt, reason: outcome.state });
            this.target = alt;
            resumeAllowed = false;
            continue;
          }
          await this.tr('RECOVERY_REQUIRED', cpPatch, outcome.state === 'AUTH_REQUIRED' ? `Agent ${this.target.agentId} needs authentication for ${this.target.providerId}. Sign in on the worker and retry.` : `Agent ${this.target.agentId} is not installed on this worker`);
          return 'stop';
        }
        case 'NETWORK_ERROR': {
          if (networkRetries++ < 5) {
            this.recovery(`Network error; retrying (attempt ${networkRetries})`);
            await sleep(this.scaled(backoffDelay(networkRetries, 5000, 120_000)));
            continue;
          }
          // fall through to crash handling
        }
        // eslint-disable-next-line no-fallthrough
        case 'CRASHED':
        case 'FAILED':
        case 'STOPPED':
        default: {
          if (outcome.stoppedFor === 'hang') this.ev('AgentHangSuspected', { detail: outcome.detail });
          this.ev('AgentCrashed', { state: outcome.state, detail: outcome.detail, ...this.target });
          const signature = `${outcome.state}:${(outcome.detail ?? '').slice(0, 120)}`;
          this.local.consecutiveFailures.push(signature);
          this.persist();
          const restarts = this.task.restartCount + 1;
          const deterministic = this.local.consecutiveFailures.length >= 3 && this.local.consecutiveFailures.slice(-3).every((s) => s === signature);
          this.recovery(`Agent ${outcome.state} (${outcome.detail ?? 'no detail'}); restart ${restarts}/${this.policy.maxRestarts}`);
          if (restarts > this.policy.maxRestarts || deterministic) {
            await this.tr(
              'RECOVERY_REQUIRED',
              { ...cpPatch, incRestart: true },
              deterministic ? `The agent failed the same way 3 times in a row: ${outcome.detail ?? outcome.state}` : `Agent restart limit (${this.policy.maxRestarts}) reached: ${outcome.detail ?? outcome.state}`,
            );
            return 'stop';
          }
          await this.tr('CRASHED', { ...cpPatch, incRestart: true }, `Agent ${outcome.state}: ${outcome.detail ?? ''}`.slice(0, 1000));
          await sleep(this.scaled(backoffDelay(restarts - 1, 2000, 60_000)));
          continue;
        }
      }
    }
  }

  /** Variables and secrets of the task's environment profile, for the agent and verification (spec §78). */
  private environmentVariables(): Record<string, string> {
    const p = this.claim.environment;
    return p ? { ...p.variables, ...p.secrets } : {};
  }

  /** Removes environment secret values from text that is recorded or sent to the control plane. */
  private scrub(text: string): string {
    let out = text;
    for (const v of Object.values(this.claim.environment?.secrets ?? {})) if (v.length >= 4) out = out.split(v).join('[secret]');
    return out;
  }

  /**
   * OS sandbox for the agent process (SEC-014), per policy. `required` without a sandbox on this
   * worker throws, which stops the task with RECOVERY_REQUIRED and the reason.
   */
  private sandboxed(inv: Awaited<ReturnType<NonNullable<ReturnType<AgentManager['get']>>['buildInvocation']>>, agentId: string) {
    const sb = this.policy.sandbox;
    if (sb.mode === 'off') return inv;
    const available = detectSandbox();
    if (!available.backend) {
      if (sb.mode === 'required') throw new AppError('FORBIDDEN', `The task policy requires an OS sandbox for agents, but this worker has none: ${available.reason}`);
      if (!this.sandboxWarned) this.recovery(`Agent runs without an OS sandbox: ${available.reason}`);
      this.sandboxWarned = true;
      return inv;
    }
    this.ev('AgentStateChanged', { detail: `Agent runs in the ${available.backend} sandbox${sb.network ? '' : ' without network access'}` });
    return wrapInvocation(inv, available, agentId, { projectDir: this.cwd, network: sb.network, writable: [...sb.writable, ...this.others.map((o) => o.path)], hidden: [...sb.hidden, this.deps.dataDir ?? ''].filter(Boolean) });
  }

  private excludedByProvider(providerId: string): ExecutionTarget[] {
    // Returned targets are excluded by providerId match in pickTarget via explicit list; approximate with models known.
    const p = this.deps.providers.get(providerId);
    return (p?.models ?? []).flatMap((m) => this.deps.agents.list().map((a) => ({ agentId: a.id, providerId, modelId: m.id })));
  }

  /** Fallback policy after a limit (spec §9, §29). Returns 'continue' to start another session. */
  private async applyFallback(retryAt: number | null, cpPatch: TransitionRequest['patch']): Promise<'continue' | 'stop'> {
    const inv = await this.deps.inventory();
    const decision = decideFallback({
      current: this.target!,
      stepIndex: this.fallbackStep,
      retryAt,
      waitedMs: this.waitedInStepMs,
      worker: inv,
      requirements: this.requirements(),
      policy: this.policy,
    });
    if (decision.stepIndex !== this.fallbackStep) this.waitedInStepMs = 0;
    this.fallbackStep = decision.stepIndex;
    switch (decision.action) {
      case 'SWITCH': {
        this.ev('FallbackStarted', { fromAgentId: this.target!.agentId, fromProviderId: this.target!.providerId, fromModelId: this.target!.modelId, ...decision.target, reason: decision.reason });
        this.recovery(`Fallback: ${decision.reason}`);
        this.target = decision.target;
        await this.tr('RUNNING', { ...cpPatch, fallbackStep: this.fallbackStep }, decision.reason);
        return 'continue';
      }
      case 'WAIT': {
        const ok = await this.waitForLimit(decision.until, decision.reason, cpPatch);
        return ok ? 'continue' : 'stop';
      }
      case 'ASK_USER': {
        const answer = await this.askUser('The AI provider limit was reached and the fallback policy asks for a decision. Reply "wait" to wait for the limit to reset, or "fail" to stop the task.', cpPatch);
        if (answer === null) return 'stop';
        if (/fail|stop|cancel/i.test(answer)) {
          await this.tr('FAILED', {}, 'Stopped by user after provider limit');
          return 'stop';
        }
        await this.tr('RUNNING', { pendingInteraction: null }, 'User chose to wait for the limit');
        return (await this.waitForLimit(retryAt, 'Waiting for provider limit (user chose to wait)')) ? 'continue' : 'stop';
      }
      case 'FAIL':
        await this.tr('FAILED', cpPatch, 'Provider limit reached and fallback policy is FAIL');
        return 'stop';
    }
  }

  /**
   * WAITING_FOR_LIMIT (spec §28): never fails the task, never fabricates a reset time. Uses the known
   * reset time when available, else polls with exponential backoff + jitter (spec §108). Waiting time
   * is excluded from active execution time (spec §31).
   */
  private async waitForLimit(until: number | null, reason: string, patch: TransitionRequest['patch'] = {}): Promise<boolean> {
    let attempt = 0;
    const waitUntil = until ?? Date.now() + backoffDelay(attempt, this.policy.fallback.limitPollBaseMs, this.policy.fallback.limitPollMaxMs);
    await this.tr('WAITING_FOR_LIMIT', { ...patch, waitingUntil: until ? new Date(until).toISOString() : null }, reason);
    for (;;) {
      const target = attempt === 0 ? waitUntil : Date.now() + backoffDelay(attempt, this.policy.fallback.limitPollBaseMs, this.policy.fallback.limitPollMaxMs);
      const t0 = Date.now();
      const c = await this.waitForControl(['resume'], this.scaled(Math.max(0, target - Date.now())));
      this.waitedInStepMs += Date.now() - t0;
      if (c) this.recovery('Resumed manually while waiting for limit');
      if (this.target) this.deps.providers.clearLimit(this.target.providerId);
      await this.deps.providers.refresh(true).catch(() => undefined);
      const inv = await this.deps.inventory();
      const available = candidateTargets(inv, this.requirements(), this.policy).length > 0;
      if (available || c) {
        await this.tr('RUNNING', {}, 'Provider limit cleared; resuming');
        return true;
      }
      attempt++;
    }
  }

  private async askUser(question: string, patch: TransitionRequest['patch'] = {}): Promise<string | null> {
    await this.tr('WAITING_FOR_INPUT', { ...patch, pendingInteraction: { kind: 'input', question } }, 'Agent needs input');
    this.ev('AgentInputRequested', { question });
    const c = await this.waitForControl(['input']);
    return c?.input ?? null;
  }

  private async runSession(adapter: ReturnType<AgentManager['get']> & object, inst: Awaited<ReturnType<AgentManager['detect']>>, req: Parameters<typeof startAgentSession>[2]): Promise<SessionOutcome> {
    const built = await adapter.buildInvocation(req, inst);
    const invocation = this.sandboxed({ ...built, env: { ...built.env, ...this.environmentVariables() } }, adapter.id);
    let stoppedFor: SessionOutcome['stoppedFor'] = null;
    let inputQuestion: string | null = null;
    let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } = {};
    let outBuf: string[] = [];
    let lastFlush = Date.now();
    const flushOutput = () => {
      if (outBuf.length) this.ev('AgentOutput', { lines: outBuf.slice(-200) });
      outBuf = [];
      lastFlush = Date.now();
    };
    const session = startAgentSession(adapter, inst, req, invocation, {
      hangTimeoutMs: this.scaled(this.policy.hangTimeoutMs),
      watchDir: this.cwd,
      onHangSuspected: (evidence) => {
        // Evidence is recorded before any termination (spec §31).
        this.ev('AgentHangSuspected', { ...evidence });
        stoppedFor = 'hang';
        void session.stop();
      },
    });
    this.session = session;
    const progressTimer = setInterval(() => {
      const p = buildProgress(this.stateRoot, this.taskId);
      if (p) {
        this.ev('TaskProgress', p);
        this.progress({ progress: { currentStep: p.currentStep, message: p.message, percent: p.percent } });
      }
    }, this.scaled(60_000));
    try {
      for await (const e of session.events) {
        switch (e.type) {
          case 'output':
            outBuf.push(this.scrub(e.text.slice(0, 2000)));
            break;
          case 'message':
            outBuf.push(this.scrub(e.text.slice(0, 4000)));
            break;
          case 'tool':
            this.ev('CommandExecuted', { tool: e.name, summary: this.scrub(e.summary) });
            this.progress({ progress: { currentStep: `${e.name}: ${e.summary}`.slice(0, 200) } });
            break;
          case 'usage':
            usage = { inputTokens: (usage.inputTokens ?? 0) + (e.inputTokens ?? 0), outputTokens: (usage.outputTokens ?? 0) + (e.outputTokens ?? 0), costUsd: (usage.costUsd ?? 0) + (e.costUsd ?? 0) };
            break;
          case 'input_request':
            inputQuestion = e.question;
            break;
          case 'limit_warning':
            this.ev('AgentStateChanged', { warning: e.detail, utilization: e.utilization });
            break;
          case 'state':
            this.ev('AgentStateChanged', { state: e.state, detail: e.detail });
            break;
        }
        if (outBuf.length >= 50 || Date.now() - lastFlush > 2000) flushOutput();
      }
    } finally {
      clearInterval(progressTimer);
      flushOutput();
    }
    const exit = await session.done;
    this.pendingActiveMs += exit.durationMs;
    const pendingControl = this.controls.find((c) => c.action === 'pause' || c.action === 'restart');
    if (pendingControl && exit.state === 'STOPPED') {
      this.controls.splice(this.controls.indexOf(pendingControl), 1);
      stoppedFor = pendingControl.action;
    }
    this.ev('AgentExited', { ...this.target, state: exit.state, code: exit.code, durationMs: exit.durationMs, ...usage });
    this.throwIfAborted();
    return { state: exit.state, detail: exit.detail, retryAt: exit.retryAt ?? null, inputQuestion, durationMs: exit.durationMs, stoppedFor };
  }

  /** VERIFYING (spec §43, §44). Returns 'passed', 'stop', or a failure summary for remediation. */
  private async verify(): Promise<'passed' | 'stop' | string> {
    if (this.review) return this.verifyReview();
    if (this.planning) return this.verifyPlan();
    if (!this.policy.verification.enabled) {
      await this.tr('VERIFYING', { verificationStatus: 'SKIPPED' }, 'Verification disabled by policy');
      return 'passed';
    }
    await this.tr('VERIFYING', { verificationStatus: 'RUNNING' }, 'Running verification');
    const attempt = this.task.remediationCount + 1;
    this.ev('VerificationStarted', { attempt });
    const engine = new VerificationEngine(this.cwd, {
      env: this.environmentVariables(),
      onStep: (s) => this.ev('VerificationStepCompleted', { name: s.name, status: s.status, durationMs: s.durationMs, artifacts: s.artifacts }),
      // Screenshots and other artifacts go to control-plane object storage, never into MongoDB (spec §62).
      artifacts: {
        put: async (name, data, contentType) =>
          (await this.client.request<{ key: string }>('POST', `/worker/tasks/${this.taskId}/artifacts`, { name, contentType, data: data.toString('base64') })).key,
      },
    });
    const t0 = Date.now();
    const run = await engine.run(this.policy.verification.steps, attempt, { autoDetect: this.policy.verification.autoDetect });
    await this.verifyOtherRepositories(run, attempt);
    await this.pluginChecks(run);
    this.pendingActiveMs += Date.now() - t0;
    for (const st of run.steps) if (st.outputTail) st.outputTail = this.scrub(st.outputTail);
    this.lastVerification = run;
    fs.writeFileSync(path.join(this.stateRoot, 'verification', `${this.taskId}-${attempt}.json`), JSON.stringify(run, null, 2));
    if (run.status === 'passed') {
      this.ev('VerificationPassed', { attempt, warnings: run.warnings });
      await this.tr('VERIFYING', { verificationStatus: 'PASSED', verificationRun: run as never });
      return 'passed';
    }
    const summary = failureSummary(run);
    this.ev('VerificationFailed', { attempt, failed: run.steps.filter((s) => s.status !== 'passed' && s.status !== 'skipped').map((s) => s.name) });
    if (this.task.remediationCount >= this.policy.maxRemediationAttempts) {
      await this.tr('RECOVERY_REQUIRED', { verificationStatus: 'FAILED', verificationRun: run as never }, `Verification still failing after ${this.policy.maxRemediationAttempts} remediation attempts`);
      return 'stop';
    }
    this.ev('RemediationStarted', { attempt: this.task.remediationCount + 1 });
    this.recovery(`Verification failed (attempt ${attempt}); remediating`);
    await this.tr('RUNNING', { verificationStatus: 'FAILED', verificationRun: run as never, incRemediation: true }, 'Verification failed; agent is fixing the failures');
    return summary;
  }

  /**
   * The other repositories of a multi-repository project that the task changed, verified with the checks
   * detected in each (policy verification steps are written for the primary repository). Their steps
   * join the run, named "<repository>: <step>".
   */
  private async verifyOtherRepositories(run: VerificationRun, attempt: number) {
    for (const o of this.others) {
      if (o.git && o.baseline && !(await o.git.taskChanges(o.baseline)).include.length) continue;
      if (!this.policy.verification.autoDetect) {
        run.warnings.push(`${o.name}: not verified (automatic detection of checks is off, and the verification steps are for the primary repository)`);
        continue;
      }
      const engine = new VerificationEngine(o.path, {
        env: this.environmentVariables(),
        onStep: (s) => this.ev('VerificationStepCompleted', { name: `${o.name}: ${s.name}`, status: s.status, durationMs: s.durationMs, artifacts: s.artifacts }),
      });
      const r = await engine.run([], attempt, { autoDetect: true });
      run.steps.push(...r.steps.map((s) => ({ ...s, name: `${o.name}: ${s.name}` })));
      run.warnings.push(...r.warnings.map((w) => `${o.name}: ${w}`));
      if (r.status === 'failed') run.status = 'failed';
    }
  }

  /** Git policy + completion report + COMPLETED (spec §42, §45). */
  private async finish() {
    if (this.review) return this.finishReview();
    if (this.planning) return this.finishPlan();
    let gitResult: Record<string, unknown> | null = null;
    let gitStatus: 'NONE' | 'COMMITTED' | 'PUSHED' | 'PR_OPENED' | 'BLOCKED' | 'FAILED' = 'NONE';
    const agentReport = readAgentReport(this.stateRoot, this.taskId);
    const others = this.others.filter((o): o is typeof o & { git: GitManager; baseline: Baseline } => Boolean(o.git && o.baseline));
    if (((this.git && this.baseline) || others.length) && this.policy.git.policy !== 'NONE') {
      let pushApproved = false;
      if (this.policy.requireApprovalFor.push && this.policy.git.policy !== 'COMMIT') {
        const question = others.length ? 'Approve pushing the task branch in each changed repository?' : 'Approve pushing the task branch?';
        await this.tr('WAITING_FOR_APPROVAL', { pendingInteraction: { kind: 'approval', question } }, 'Waiting for push approval');
        this.ev('ApprovalRequested', { question: 'push' });
        const c = await this.waitForControl(['approve', 'deny']);
        pushApproved = c?.action === 'approve';
        await this.tr('VERIFYING', { pendingInteraction: null }, pushApproved ? 'Push approved' : 'Push denied');
      }
      const apply = async (git: GitManager, baseline: Baseline, repository?: string) => {
        try {
          const r = await git.applyPolicy({
            policy: this.policy.git.policy,
            baseline,
            branch: this.local.branch,
            message: `${this.task.title}\n\n${summarize(agentReport) ?? ''}\n\nTask: ${this.taskId}\nAgent: ${this.target?.agentId}/${this.target?.providerId}/${this.target?.modelId}`.trim(),
            prTitle: this.task.title,
            prBody: agentReport ?? this.task.originalPrompt,
            requirePushApproval: this.policy.requireApprovalFor.push,
            pushApproved,
          });
          const where = repository ? { repository } : {};
          if (r.commit) this.ev('GitCommitCreated', { commit: r.commit, branch: r.branch, files: r.filesChanged.length, ...where });
          if (r.pushed) this.ev('GitPushed', { branch: r.branch, ...where });
          for (const b of r.blocked) this.ev('GitOperationBlocked', { reason: repository ? `${repository}: ${b}` : b });
          return { r, failed: false };
        } catch (e) {
          this.ev('GitOperationBlocked', { reason: repository ? `${repository}: ${(e as Error).message}` : String((e as Error).message) });
          return { r: { policy: this.policy.git.policy, branch: this.local.branch, baseBranch: null, commit: null, pushed: false, pullRequestUrl: null, filesChanged: [], diffStat: '', blocked: [String((e as Error).message)], warnings: [] }, failed: true };
        }
      };
      const main = this.git && this.baseline ? await apply(this.git, this.baseline) : null;
      const rest = [];
      for (const o of others) rest.push({ name: o.name, ...(await apply(o.git, o.baseline, o.name)) });
      const status = ({ r, failed }: { r: { commit: string | null; pushed: boolean; pullRequestUrl: string | null; blocked: string[] }; failed: boolean }) =>
        failed ? 'FAILED' : r.pullRequestUrl ? 'PR_OPENED' : r.pushed ? 'PUSHED' : r.commit ? 'COMMITTED' : r.blocked.length ? 'BLOCKED' : 'NONE';
      // The task's status is the furthest any repository got; a failure anywhere shows as FAILED.
      const statuses = [...(main ? [status(main)] : []), ...rest.map(status)];
      const order = ['NONE', 'BLOCKED', 'COMMITTED', 'PUSHED', 'PR_OPENED'] as const;
      gitStatus = statuses.includes('FAILED') ? 'FAILED' : statuses.reduce<(typeof order)[number]>((best, s) => (order.indexOf(s as (typeof order)[number]) > order.indexOf(best) ? (s as (typeof order)[number]) : best), 'NONE');
      const base = main?.r ?? { policy: this.policy.git.policy, branch: this.local.branch, baseBranch: null, commit: null, pushed: false, pullRequestUrl: null, filesChanged: [], diffStat: '', blocked: [], warnings: [] };
      gitResult = {
        ...base,
        filesChanged: [...base.filesChanged, ...rest.flatMap((x) => x.r.filesChanged.map((f) => ({ ...f, path: `${x.name}/${f.path}` })))],
        blocked: [...base.blocked, ...rest.flatMap((x) => x.r.blocked.map((b) => `${x.name}: ${b}`))],
        warnings: [...base.warnings, ...rest.flatMap((x) => x.r.warnings.map((w) => `${x.name}: ${w}`))],
        ...(rest.length ? { repositories: rest.map((x) => ({ name: x.name, branch: x.r.branch, commit: x.r.commit, pushed: x.r.pushed, pullRequestUrl: x.r.pullRequestUrl, filesChanged: x.r.filesChanged, blocked: x.r.blocked })) } : {}),
      };
    }
    const report = this.completionReport(gitResult, agentReport);
    await this.tr('COMPLETED', { verificationStatus: this.policy.verification.enabled ? 'PASSED' : 'SKIPPED', gitStatus, gitResult: gitResult as never, completionReport: report as never }, 'Completed and verified');
    await this.runPlugins('task.completed', { report: { summary: report.summary, filesChanged: report.filesChanged, verification: report.verification, git: gitResult } });
  }

  // ── Reviews (FUT-003) ──────────────────────────────────────────────────────
  private reviewFile() {
    return path.join(this.stateRoot, 'progress', `${this.taskId}.review.json`);
  }

  /** Resolves the refs, checks the head out into a worktree of its own and computes the diff. */
  private async prepareReview() {
    const spec = this.task.review;
    const stop = async (reason: string) => {
      await this.tr('RECOVERY_REQUIRED', {}, reason);
      throw new Aborted('cancelled');
    };
    if (!spec) return stop('This review task has no base and head to compare');
    if (!this.git) return stop('Reviews need the project folder to be a Git repository');
    let baseCommit: string;
    let headCommit: string;
    try {
      baseCommit = await this.git.resolveCommit(spec.base);
      headCommit = await this.git.resolveCommit(spec.head, spec.fetchHead);
    } catch (e) {
      return stop(`Could not find the commits to review: ${(e as Error).message}`);
    }
    const worktree = path.join(this.stateRoot, 'worktrees', this.taskId);
    if (!fs.existsSync(worktree)) await this.git.addWorktree(worktree, headCommit);
    const d = await this.git.diffRange(baseCommit, headCommit);
    if (!d.diff.trim()) return stop(`There are no changes between ${spec.base} and ${spec.head}`);
    this.review = { base: spec.base, head: spec.head, baseCommit, headCommit, ...d, worktree };
    this.agentCwd = worktree;
  }

  /**
   * A review passes when the agent wrote a valid review and changed nothing. Otherwise the agent is sent
   * back with the reason (changes are discarded by recreating the worktree, which is ours alone).
   */
  private async verifyReview(): Promise<'passed' | 'stop' | string> {
    const r = this.review!;
    await this.tr('VERIFYING', { verificationStatus: 'RUNNING' }, 'Checking the review');
    const problems: string[] = [];
    const changed = await new GitManager(r.worktree).status();
    if (changed.length) {
      problems.push(`The review changed files, which reviews must not do. The changes were discarded: ${changed.map((c) => c.path).join(', ')}`);
      await this.git!.removeWorktree(r.worktree);
      await this.git!.addWorktree(r.worktree, r.headCommit);
    }
    let parsed: ReviewResult | null = null;
    try {
      const res = reviewResult.safeParse(JSON.parse(fs.readFileSync(this.reviewFile(), 'utf8')));
      if (res.success) parsed = res.data;
      else problems.push(`The review file is not valid: ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    } catch (e) {
      problems.push(`No readable review at ${STATE_DIR}/progress/${this.taskId}.review.json (${(e as Error).message.split('\n')[0]})`);
    }
    if (!problems.length && parsed) {
      this.reviewOutcome = parsed;
      this.ev('VerificationPassed', { attempt: this.task.remediationCount + 1, review: parsed.verdict });
      await this.tr('VERIFYING', { verificationStatus: 'PASSED' });
      return 'passed';
    }
    this.ev('VerificationFailed', { attempt: this.task.remediationCount + 1, failed: problems });
    if (this.task.remediationCount >= this.policy.maxRemediationAttempts) {
      await this.tr('RECOVERY_REQUIRED', { verificationStatus: 'FAILED' }, `The review is still not valid after ${this.policy.maxRemediationAttempts} attempts: ${problems.join(' ')}`.slice(0, 1000));
      return 'stop';
    }
    await this.tr('RUNNING', { verificationStatus: 'FAILED', incRemediation: true }, 'Review not accepted; the agent is fixing it');
    return problems.join('\n\n');
  }

  private async finishReview() {
    const r = this.review!;
    const review = this.reviewOutcome!;
    const counts = review.comments.reduce<Record<string, number>>((acc, c) => ((acc[c.severity] = (acc[c.severity] ?? 0) + 1), acc), {});
    const report = {
      ...this.completionReport(null, readAgentReport(this.stateRoot, this.taskId)),
      summary: review.summary.slice(0, 2000),
      implementation: `Reviewed ${r.head} (${r.headCommit.slice(0, 12)}) against ${r.base} (${r.baseCommit.slice(0, 12)}).`,
      filesChanged: [],
      testsExecuted: [],
      verification: `Review ${review.verdict.replace('_', ' ')}; ${review.comments.length} comment(s)${Object.keys(counts).length ? ` (${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`,
      warnings: r.truncated ? ['The diff was too large to include in full; the agent was told to read the rest itself.'] : [],
      review,
    };
    await this.tr('COMPLETED', { verificationStatus: 'PASSED', gitStatus: 'NONE', completionReport: report as never }, 'Review completed');
    await this.git?.removeWorktree(r.worktree);
    await this.runPlugins('task.completed', { report: { summary: report.summary, filesChanged: [], verification: report.verification, git: null } });
  }

  // ── Plans (FUT-001) ────────────────────────────────────────────────────────
  private planFile() {
    return path.join(this.stateRoot, 'progress', `${this.taskId}.plan.json`);
  }

  /** The planner reads a worktree of the current commit, so it cannot change the user's files. */
  private async preparePlan() {
    if (!this.git) {
      this.planning = { worktree: null, headCommit: null };
      this.recovery('Project is not a Git repository: the planner works in the project folder itself');
      return;
    }
    const head = await this.git.head();
    if (!head) {
      this.planning = { worktree: null, headCommit: null };
      return;
    }
    const worktree = path.join(this.stateRoot, 'worktrees', this.taskId);
    if (!fs.existsSync(worktree)) await this.git.addWorktree(worktree, head);
    this.planning = { worktree, headCommit: head };
    this.agentCwd = worktree;
  }

  private async verifyPlan(): Promise<'passed' | 'stop' | string> {
    const p = this.planning!;
    await this.tr('VERIFYING', { verificationStatus: 'RUNNING' }, 'Checking the plan');
    const problems: string[] = [];
    if (p.worktree && p.headCommit) {
      const changed = await new GitManager(p.worktree).status();
      if (changed.length) {
        problems.push(`The planner changed files, which planning must not do. The changes were discarded: ${changed.map((c) => c.path).join(', ')}`);
        await this.git!.removeWorktree(p.worktree);
        await this.git!.addWorktree(p.worktree, p.headCommit);
      }
    }
    let parsed: PlanResult | null = null;
    try {
      const res = planResult.safeParse(JSON.parse(fs.readFileSync(this.planFile(), 'utf8')));
      if (!res.success) problems.push(`The plan file is not valid: ${res.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      else {
        const cycle = findCycle(res.data.tasks.map((t) => ({ id: t.key, dependencies: t.dependsOn })));
        if (cycle) problems.push(`The tasks depend on each other in a cycle: ${cycle.join(' → ')}`);
        else parsed = res.data;
      }
    } catch (e) {
      problems.push(`No readable plan at ${STATE_DIR}/progress/${this.taskId}.plan.json (${(e as Error).message.split('\n')[0]})`);
    }
    if (!problems.length && parsed) {
      this.planOutcome = parsed;
      this.ev('VerificationPassed', { attempt: this.task.remediationCount + 1, plannedTasks: parsed.tasks.length });
      await this.tr('VERIFYING', { verificationStatus: 'PASSED' });
      return 'passed';
    }
    this.ev('VerificationFailed', { attempt: this.task.remediationCount + 1, failed: problems });
    if (this.task.remediationCount >= this.policy.maxRemediationAttempts) {
      await this.tr('RECOVERY_REQUIRED', { verificationStatus: 'FAILED' }, `The plan is still not valid after ${this.policy.maxRemediationAttempts} attempts: ${problems.join(' ')}`.slice(0, 1000));
      return 'stop';
    }
    await this.tr('RUNNING', { verificationStatus: 'FAILED', incRemediation: true }, 'Plan not accepted; the agent is fixing it');
    return problems.join('\n\n');
  }

  private async finishPlan() {
    const plan = this.planOutcome!;
    const report = {
      ...this.completionReport(null, readAgentReport(this.stateRoot, this.taskId)),
      summary: plan.summary.slice(0, 2000),
      implementation: `Planned ${plan.tasks.length} task(s). Nothing was changed; apply the plan to create the tasks.`,
      filesChanged: [],
      testsExecuted: [],
      verification: `Plan with ${plan.tasks.length} task(s), dependencies checked`,
      plan,
    };
    await this.tr('COMPLETED', { verificationStatus: 'PASSED', gitStatus: 'NONE', completionReport: report as never }, 'Plan ready');
    if (this.planning?.worktree) await this.git?.removeWorktree(this.planning.worktree);
    await this.runPlugins('task.completed', { report: { summary: report.summary, filesChanged: [], verification: report.verification, git: null } });
  }

  // ── Plugins (CAP-012) ──────────────────────────────────────────────────────
  private pluginSpecs(): PluginSpec[] {
    return (this.claim.capabilities ?? [])
      .filter((c) => c.manifest?.type === 'plugin' && c.manifest.plugin)
      .map((c) => ({ id: c.manifest.id, version: c.manifest.version, name: c.manifest.name, permissions: c.manifest.permissions ?? [], plugin: c.manifest.plugin, config: c.config ?? {} }));
  }

  /**
   * Runs one hook of every plugin that implements it, one after another. A failing plugin is recorded
   * and never fails the task by itself; only checks it returns from task.verify can.
   */
  private async runPlugins(hook: HookOutcome['hook'], extra: Record<string, unknown>): Promise<HookOutcome[]> {
    const runner = this.deps.plugins;
    const specs = this.pluginSpecs().filter((s) => runner?.implements(s, hook) ?? Boolean(s.plugin.source && s.plugin.hooks.includes(hook)));
    if (!specs.length) return [];
    const off = !this.claim.features?.['plugins.execution'] ? 'Plugin execution is turned off for this organization (feature flag plugins.execution)' : !this.deps.config().plugins.enabled ? 'Plugin execution is turned off on this worker' : !runner ? 'This worker cannot run plugins' : null;
    if (off) {
      if (!this.pluginsSkippedReported) this.ev('CapabilityPlanCreated', { skipped: this.pluginSpecs().map((s) => s.id), reason: off });
      this.pluginsSkippedReported = true;
      return [];
    }
    const t = this.task;
    const context = { hook, task: { id: t.id, title: t.title, prompt: t.normalizedPrompt ?? t.originalPrompt, projectId: t.projectId, environment: t.environment ?? null }, projectDir: this.cwd, ...extra };
    const outcomes: HookOutcome[] = [];
    for (const spec of specs) {
      this.throwIfAborted();
      const o = await runner!.run(spec, hook, context, { projectDir: this.cwd });
      outcomes.push(o);
      this.ev(o.ok ? 'PluginHookCompleted' : 'PluginHookFailed', { plugin: o.pluginId, version: o.version, hook, durationMs: o.durationMs, sha256: o.sha256, error: o.error, logs: o.logs.slice(-50) });
      if (!o.ok) this.recovery(`Plugin ${o.pluginId} ${hook} failed: ${o.error}`);
    }
    return outcomes;
  }

  /** Checks returned by plugins' task.verify hooks join the verification run as required steps. */
  private async pluginChecks(run: VerificationRun) {
    const outcomes = await this.runPlugins('task.verify', { verification: { attempt: run.attempt, status: run.status, steps: run.steps.map((s) => ({ name: s.name, status: s.status })) }, changedFiles: this.checkpoint?.changedFiles ?? [] });
    for (const o of outcomes) {
      if (!o.ok) {
        run.warnings.push(`Plugin ${o.pluginId} could not verify: ${o.error}`);
        continue;
      }
      for (const c of (o.result as { checks: Array<{ name: string; passed: boolean; summary: string }> }).checks) {
        const step = { kind: 'plugin', name: `${o.pluginId}: ${c.name}`, required: true, status: c.passed ? ('passed' as const) : ('failed' as const), durationMs: o.durationMs, outputTail: c.summary, artifacts: [], reason: c.passed ? undefined : c.summary || 'Check failed' };
        run.steps.push(step);
        this.ev('VerificationStepCompleted', { name: step.name, status: step.status, durationMs: step.durationMs, artifacts: [] });
        if (!c.passed) run.status = 'failed';
      }
    }
  }

  private completionReport(git: Record<string, any> | null, agentReport: string | null) {
    const v = this.lastVerification;
    const cp = this.checkpoint;
    const warnings = [...(v?.warnings ?? []), ...((git?.warnings as string[]) ?? []), ...((git?.blocked as string[]) ?? [])];
    if (!agentReport) warnings.push('The agent did not write a completion report; summary is derived from verified facts only.');
    return {
      summary: summarize(agentReport) ?? `Task "${this.task.title}" executed and verified.`,
      requirements: [{ text: this.task.originalPrompt.slice(0, 500), status: v?.status === 'passed' ? ('done' as const) : ('unknown' as const) }],
      implementation: section(agentReport, 'Implementation') ?? '',
      filesChanged: (git?.filesChanged as Array<{ path: string }> | undefined)?.map((f) => f.path) ?? cp?.changedFiles ?? [],
      testsExecuted: v?.steps.map((s) => `${s.name}: ${s.status}`) ?? [],
      verification: v ? `${v.status} (attempt ${v.attempt}, ${v.steps.length} checks)` : 'Verification disabled by policy',
      git: git as never,
      knownLimitations: lines(section(agentReport, 'Known limitations')),
      // The agent's report is written last; its progress file may be from before the final steps.
      remainingWork: (section(agentReport, 'Remaining work') !== null ? lines(section(agentReport, 'Remaining work')) : (cp?.remainingSteps ?? [])).filter((x) => !/^none\.?$/i.test(x)),
      warnings,
      agentId: this.target?.agentId ?? null,
      providerId: this.target?.providerId ?? null,
      modelId: this.target?.modelId ?? null,
      durationMs: Date.now() - this.startedAt,
      recoveryEvents: this.local.recoveryEvents,
      agentReport: agentReport ?? undefined,
    };
  }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

function section(md: string | null, name: string): string | null {
  if (!md) return null;
  const re = new RegExp(`^#+\\s*${name}\\s*$([\\s\\S]*?)(?=^#+\\s|$(?![\\s\\S]))`, 'im');
  const m = re.exec(md);
  return m ? m[1]!.trim() : null;
}
function summarize(md: string | null) {
  return section(md, 'Summary')?.slice(0, 2000) ?? null;
}
function lines(s: string | null): string[] {
  return s ? s.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter(Boolean) : [];
}

function buildProgress(stateRoot: string, taskId: string) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(stateRoot, 'progress', `${taskId}.json`), 'utf8'));
    const done = Array.isArray(p.completedSteps) ? p.completedSteps.length : 0;
    const left = Array.isArray(p.remainingSteps) ? p.remainingSteps.length : 0;
    return {
      currentStep: typeof p.nextAction === 'string' ? p.nextAction.slice(0, 200) : null,
      message: typeof p.phase === 'string' ? p.phase : null,
      percent: done + left > 0 ? Math.round((done / (done + left)) * 100) : null,
    };
  } catch {
    return null;
  }
}
