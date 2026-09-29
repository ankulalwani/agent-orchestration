/**
 * End-to-end: real control plane (Fastify + MongoDB) + real worker runtime + deterministic mock agent
 * in a real Git repository. Exercises spec §89 (full flow) and the recovery paths of §90.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { ConcurrencySlot, Task, mongoose } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import type { TaskDto } from '@ao/contracts';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let base: string;
let owner: Actor;
let projectId: string;
let repo: string;
let worker: WorkerRuntime;

process.env.AO_CREDENTIAL_BACKEND = 'file';

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000, label = ''): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last)?.slice(0, 600)}`);
}

const getTask = (id: string) => s.tasks.get(owner, id);
const settled = (t: TaskDto) => ['COMPLETED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED', 'WAITING_FOR_INPUT'].includes(t.status);

async function createTask(title: string, model: string, policy: Record<string, unknown> = {}) {
  return s.tasks.create(owner, {
    projectId,
    title,
    prompt: `Do ${title}`,
    priority: 'NORMAL',
    dependencies: [],
    requirements: {},
    capabilityIds: [],
    policy: {
      models: { preferred: [{ providerId: model.split('/')[0]!, modelId: model.split('/')[1]! }] },
      verification: { enabled: true, autoDetect: false, steps: [{ kind: 'test', name: 'check', command: [process.execPath, 'check.js'], required: true, timeoutMs: 20_000 }] },
      git: { policy: 'COMMIT', workOnBranch: false },
      ...policy,
    },
  });
}

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  s.scheduler.start();
  owner = (await makeOwner(s, 'e2e')).actor;
  projectId = (await s.projects.create(owner, { name: 'demo', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;

  // A real Git repository with a verification script. check.js passes unless the task title asks for remediation.
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-e2e-repo-'));
  const g = (...a: string[]) => runCommand('git', a, { cwd: repo });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'e2e@example.com');
  await g('config', 'user.name', 'E2E');
  await g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(
    path.join(repo, 'check.js'),
    `const fs=require('fs');const out=fs.existsSync('mock-output.txt')?fs.readFileSync('mock-output.txt','utf8'):'';
     const needFix=fs.existsSync('REQUIRE_REMEDIATION');
     if(!out){console.error('mock-output.txt missing');process.exit(1)}
     if(needFix&&!out.includes('prompt-has-failures:true')){console.error('assertion failed: expected fix');process.exit(1)}
     console.log('ok')`,
  );
  await g('add', '.');
  await g('commit', '-qm', 'init');

  // Worker: pair through the real device-code flow.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-e2e-worker-'));
  worker = new WorkerRuntime(dataDir, { timeScale: 0.01 });
  worker.config.update({
    enableMockAgent: true,
    maxConcurrentTasks: 1,
    projects: [{ projectId, localPath: repo }],
    providers: [
      { id: 'mocka', kind: 'mock', name: 'Mock A', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: ['success', 'rate_limit', 'limit_once', 'context_once', 'flaky', 'crash', 'input', 'slow', 'key_expires', 'review', 'review_dirty', 'plan', 'plan_cycle'].map((sc) => ({ id: `scenario:${sc}` })) },
      { id: 'mockb', kind: 'mock', name: 'Mock B', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'scenario:success' }] },
    ],
    agents: { mock: { enabled: true, settings: { retryAtOffsetMs: 300 } } },
  });
  await worker.init();
  const pairing = await worker.beginPairing('self-hosted', base, 'e2e-worker');
  await s.workers.approvePairing(owner, pairing.userCode!);
  await waitFor(async () => worker.client?.state, (st) => st === 'connected', 20_000, 'worker connection');
  await waitFor(async () => (await s.workers.list(owner))[0], (w) => w?.status === 'ONLINE' && w.agents.some((a) => a.id === 'mock'), 20_000, 'worker online with inventory');
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  s.scheduler.stop();
  await app.close();
  await stopTestDatabase();
});

async function resetRepo() {
  const g = (...a: string[]) => runCommand('git', a, { cwd: repo });
  fs.rmSync(path.join(repo, 'mock-output.txt'), { force: true });
  fs.rmSync(path.join(repo, 'REQUIRE_REMEDIATION'), { force: true });
  await g('add', '-A');
  await g('commit', '-qm', 'reset', '--allow-empty');
}

describe('worker end-to-end', () => {
  it('create → schedule → claim → agent → verify → commit → COMPLETED with report', async () => {
    await resetRepo();
    const t = await createTask('happy path', 'mocka/scenario:success');
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.verificationStatus).toBe('PASSED');
    expect(done.gitStatus).toBe('COMMITTED');
    expect(done.gitResult?.filesChanged.map((f) => f.path)).toContain('mock-output.txt');
    // The agent's cache (declared in the adapter's gitExcludes) is hidden from Git, never committed.
    expect(done.gitResult?.filesChanged.some((f) => f.path.startsWith('.mock-cache'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.mock-cache', 'index.json'))).toBe(true);
    expect(done.completionReport?.summary).toContain('Implemented the change');
    expect(done.completionReport?.testsExecuted).toEqual(['check: passed']);
    expect(done.agentId).toBe('mock');
    const log = (await runCommand('git', ['log', '--format=%s', '-1'], { cwd: repo })).stdout.trim();
    expect(log).toBe('happy path');
    // The timeline is in the order things happened: the worker's events come before the completion.
    await worker.flush();
    const order = (await s.tasks.events(owner, t.id, { limit: 500 })).items.map((e) => e.type);
    expect(order.indexOf('VerificationPassed')).toBeLessThan(order.indexOf('TaskCompleted'));
    expect(order.indexOf('GitCommitCreated')).toBeLessThan(order.indexOf('TaskCompleted'));
    expect(order.indexOf('AgentExited')).toBeLessThan(order.indexOf('TaskCompleted'));
    // State dir is excluded from Git.
    expect((await runCommand('git', ['status', '--porcelain'], { cwd: repo })).stdout).not.toContain('.agent-orchestrator');
    // Timeline via buffered events reached the server.
    await worker.flush();
    const types = (await s.tasks.events(owner, t.id, { limit: 500, includeOutput: true })).items.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['TaskClaimed', 'AgentStarted', 'CheckpointCreated', 'VerificationStarted', 'VerificationPassed', 'GitCommitCreated', 'TaskCompleted', 'AgentExited']));
    // Usage tracking (spec §50): token counts and cost survive redaction and reach usage records.
    const usage = (await s.queries.usage(owner, 1)) as Array<{ _id: { kind: string }; outputTokens: number; costUsd: number }>;
    const exec = usage.find((u) => u._id.kind === 'execution');
    expect(exec?.outputTokens).toBeGreaterThan(0);
    expect(exec?.costUsd).toBeGreaterThan(0);
  }, 90_000);

  it('provider limit → automatic fallback to a compatible provider', async () => {
    await resetRepo();
    const t = await createTask('fallback', 'mocka/scenario:rate_limit', { fallback: { chain: [{ kind: 'FALLBACK_PROVIDER', providerId: 'mockb' }, { kind: 'WAIT' }] } });
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'fallback completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.providerId).toBe('mockb');
    expect(done.limitHitCount).toBe(1);
    expect(done.completionReport?.recoveryEvents.join('\n')).toMatch(/Fallback/);
    worker.providers.clearLimit('mocka');
  }, 90_000);

  it('provider at its organization concurrency limit → worker starts on another provider (spec §46)', async () => {
    await resetRepo();
    // Another running task (elsewhere in the organization) holds the only mocka slot.
    const holder = new mongoose.Types.ObjectId();
    const orgId = new mongoose.Types.ObjectId(owner.organizationId);
    await Task.collection.insertOne({ _id: holder, organizationId: orgId, projectId: new mongoose.Types.ObjectId(), status: 'RUNNING', providerId: 'mocka', leaseExpiresAt: new Date(Date.now() + 3_600_000) });
    await ConcurrencySlot.create({ organizationId: orgId, scope: 'provider', key: 'mocka', taskIds: [holder] });
    try {
      const t = await createTask('provider slot', 'mocka/scenario:success', { concurrency: { perProvider: { mocka: 1 } } });
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'completion on another provider');
      expect(done.status).toBe('COMPLETED');
      expect(done.providerId).toBe('mockb');
      const slot = await ConcurrencySlot.findOne({ scope: 'provider', key: 'mocka' }).lean();
      expect(slot!.taskIds.map(String)).toEqual([String(holder)]);
    } finally {
      await Task.collection.deleteOne({ _id: holder });
      await ConcurrencySlot.deleteMany({});
    }
  }, 90_000);

  it('provider limit with known reset → WAITING_FOR_LIMIT → resumes (never marked failed)', async () => {
    await resetRepo();
    const t = await createTask('limit wait', 'mocka/scenario:limit_once', { fallback: { chain: [{ kind: 'WAIT' }] } });
    const seen = new Set<string>();
    const done = await waitFor(
      async () => {
        const x = await getTask(t.id);
        seen.add(x.status);
        return x;
      },
      settled,
      60_000,
      'limit wait completion',
    );
    expect(done.status).toBe('COMPLETED');
    expect(seen.has('WAITING_FOR_LIMIT') || done.limitHitCount === 1).toBe(true);
    expect(done.limitHitCount).toBe(1);
    expect(done.providerId).toBe('mocka');
  }, 90_000);

  it('context exhaustion → checkpoint → fresh session continues', async () => {
    await resetRepo();
    const t = await createTask('context', 'mocka/scenario:context_once');
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'context completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.contextResetCount).toBe(1);
    expect(done.lastCheckpoint).not.toBeNull();
  }, 90_000);

  it('agent crash → restart → completes', async () => {
    await resetRepo();
    const t = await createTask('flaky', 'mocka/scenario:flaky');
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'flaky completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.restartCount).toBe(1);
  }, 90_000);

  it('deterministic crashes → RECOVERY_REQUIRED instead of endless retries', async () => {
    await resetRepo();
    const t = await createTask('always crash', 'mocka/scenario:crash', { maxRestarts: 10 });
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'crash settle');
    expect(done.status).toBe('RECOVERY_REQUIRED');
    expect(done.statusReason).toMatch(/same way 3 times/);
    expect(done.restartCount).toBe(3);
  }, 90_000);

  it('agent asks for input → WAITING_FOR_INPUT → user responds → completes', async () => {
    await resetRepo();
    const t = await createTask('needs input', 'mocka/scenario:input');
    const waiting = await waitFor(() => getTask(t.id), (x) => x.status === 'WAITING_FOR_INPUT', 60_000, 'input request');
    expect(waiting.pendingInteraction?.question).toMatch(/currency/);
    await s.tasks.action(owner, t.id, { action: 'input', input: 'INR' });
    const done = await waitFor(() => getTask(t.id), (x) => x.status === 'COMPLETED' || x.status === 'RECOVERY_REQUIRED' || x.status === 'FAILED', 60_000, 'post-input completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.completionReport?.summary).toMatch(/user response/);
  }, 90_000);

  it('verification failure → auto-remediation with failure context → passes', async () => {
    await resetRepo();
    fs.writeFileSync(path.join(repo, 'REQUIRE_REMEDIATION'), '1');
    await runCommand('git', ['add', '-A'], { cwd: repo });
    await runCommand('git', ['commit', '-qm', 'require remediation'], { cwd: repo });
    const t = await createTask('remediate', 'mocka/scenario:success');
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'remediation completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.remediationCount).toBe(1);
    expect(done.verificationRuns).toHaveLength(2);
    expect(done.verificationRuns[0]!.status).toBe('failed');
    expect(done.verificationRuns[1]!.status).toBe('passed');
  }, 90_000);

  it('AI readiness: worker collects repo facts, control plane produces a report (spec §41)', async () => {
    const requested = await s.projects.requestReadiness(owner, projectId, s.live);
    expect(requested.readiness?.status).toBe('PENDING');
    const done = await waitFor(() => s.projects.get(owner, projectId), (p) => p.readiness?.status !== 'PENDING', 30_000, 'readiness');
    expect(done.readiness?.status).toBe('COMPLETED');
    const report = done.readiness!.report as { score: number; items: Array<{ id: string; category: string }> };
    expect(report.items.find((i) => i.id === 'git.repo')?.category).toBe('available');
    expect(report.items.find((i) => i.id === 'tests')?.category).toBe('required'); // demo repo has no test suite
    expect(typeof report.score).toBe('number');
  }, 60_000);

  it('pause stops the agent with a checkpoint; resume continues and completes (spec §83)', async () => {
    await resetRepo();
    const t = await createTask('pause me', 'mocka/scenario:slow');
    await waitFor(() => getTask(t.id), (x) => x.status === 'RUNNING', 60_000, 'running');
    await s.tasks.action(owner, t.id, { action: 'pause' });
    const paused = await waitFor(() => getTask(t.id), (x) => x.status === 'PAUSED', 30_000, 'paused');
    expect(paused.lastCheckpoint?.reason).toBe('pause');
    await s.tasks.action(owner, t.id, { action: 'resume' });
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'completion after resume');
    expect(done.status).toBe('COMPLETED');
    const types = (await s.tasks.events(owner, t.id, { limit: 500 })).items.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['TaskPaused', 'TaskResumed']));
  }, 90_000);

  /** As the worker UI does: store the key in the credential store and reconfigure the provider. */
  async function setProviderKey(id: string, value: string | null) {
    const ref = `provider:${id}`;
    if (value) await worker.credentials.set(ref, value);
    worker.config.update((c) => ({ ...c, providers: c.providers.map((p) => (p.id === id ? { ...p, credentialRef: value ? ref : null } : p)) }));
    await worker.providers.configure(worker.config.get().providers);
  }

  it('provider credentials expire mid-task → the task continues on another provider from the checkpoint (spec §90)', async () => {
    await resetRepo();
    await setProviderKey('mocka', 'expired-key-1');
    try {
      const t = await createTask('key expires, fallback', 'mocka/scenario:key_expires');
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'completion on the other provider');
      expect(done.status).toBe('COMPLETED');
      expect(done.providerId).toBe('mockb');
      expect(done.completionReport?.recoveryEvents.join('\n')).toMatch(/AUTH_REQUIRED for mock\/mocka/);
      // Work from before the credentials expired is kept, and the new session was given the checkpoint.
      expect(fs.readFileSync(path.join(repo, 'mock-partial.txt'), 'utf8')).toContain('part 1 done');
      expect(fs.readFileSync(path.join(repo, 'mock-output.txt'), 'utf8')).toContain('prompt-has-resume:true');
      await worker.flush(); // worker events are sent in batches
      const types = (await s.tasks.events(owner, t.id, { limit: 500 })).items.map((e) => e.type);
      expect(types).toContain('FallbackStarted');
    } finally {
      await setProviderKey('mocka', null);
    }
  }, 90_000);

  it('credentials expire with no alternative → RECOVERY_REQUIRED with instructions; a new key + Retry continues from the checkpoint', async () => {
    await resetRepo();
    await setProviderKey('mocka', 'expired-key-2');
    try {
      const t = await createTask('key expires, no fallback', 'mocka/scenario:key_expires', {
        models: { preferred: [{ providerId: 'mocka', modelId: 'scenario:key_expires' }], allowedProviders: ['mocka'] },
      });
      const stuck = await waitFor(() => getTask(t.id), settled, 60_000, 'recovery required');
      expect(stuck.status).toBe('RECOVERY_REQUIRED');
      expect(stuck.statusReason).toMatch(/needs authentication for mocka.*Sign in on the worker and retry/);
      expect(stuck.lastCheckpoint?.completedSteps).toEqual(expect.arrayContaining(['part 1']));
      // The creator is told.
      // The notification is written right after the status change; wait for it rather than race it.
      await waitFor(
        () => s.queries.notifications(owner, { limit: 50 }),
        (notes) => notes.items.some((n: { type: string; taskId: string | null }) => n.type === 'task.recovery_required' && n.taskId === t.id),
        10_000,
        'recovery notification',
      );

      // The user puts in a working key on the worker and retries the task.
      await setProviderKey('mocka', 'valid-key-3');
      expect((await s.tasks.action(owner, t.id, { action: 'retry' })).status).toBe('QUEUED');
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'completion after new key');
      expect(done.status).toBe('COMPLETED');
      expect(done.providerId).toBe('mocka');
      expect(fs.readFileSync(path.join(repo, 'mock-output.txt'), 'utf8')).toContain('prompt-has-resume:true');
      expect(done.completionReport?.summary).toContain('Completed with a valid key');
    } finally {
      await setProviderKey('mocka', null);
    }
  }, 120_000);

  it('MCP servers from installed capabilities are health-checked; a broken one is withheld from the agent (CAP-011)', async () => {
    await resetRepo();
    const server = path.resolve('tests/fixtures/mcp-server.mjs');
    const installs: string[] = [];
    for (const [id, mode] of [['mcp-good', 'stdio'], ['mcp-broken', 'crash']] as const) {
      await s.capabilities.register(owner, { id, name: id, version: '1.0.0', type: 'mcp', mcp: { transport: 'stdio', command: [process.execPath, server, mode] } });
      installs.push((await s.capabilities.install(owner, { capabilityId: id, scope: 'PROJECT', projectId, enabled: true, config: {} })).id);
    }
    try {
      const t = await createTask('with mcp servers', 'mocka/scenario:success');
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'completion with MCP');
      expect(done.status).toBe('COMPLETED');
      expect(fs.readFileSync(path.join(repo, 'mock-output.txt'), 'utf8')).toContain('mcp-servers:mcp-good\n');
      expect(done.completionReport?.recoveryEvents.join('\n')).toMatch(/mcp-broken \(exited \(1\).*GITHUB_TOKEN/);
      await worker.flush();
      const plan = (await s.tasks.events(owner, t.id, { limit: 500 })).items.find((e) => e.type === 'CapabilityPlanCreated' && JSON.stringify(e.payload).includes('health check'));
      expect(plan?.payload).toMatchObject({ skipped: ['mcp-broken'] });
    } finally {
      for (const id of installs) await s.capabilities.uninstall(owner, id);
    }
  }, 90_000);

  it('plugins run their hooks in the sandbox only when the feature flag is on; a failed plugin check sends the agent back (CAP-012)', async () => {
    const { AuditLog } = await import('@ao/database');
    await resetRepo();
    await s.queries.putSecret(owner, 'PLUGIN_TOKEN', 'tok-plugin-123');
    const source = `
      import fs from 'node:fs';
      import path from 'node:path';
      export function prepare(ctx) { return { instructions: 'Follow the house style. MARKER-PLUGIN-PREPARED' }; }
      export function verify(ctx) {
        const out = fs.readFileSync(path.join(ctx.projectDir, 'mock-output.txt'), 'utf8');
        const runs = Number(out.split('\\n')[0]);
        ctx.log('verify sees run', runs, 'for', ctx.task.title);
        return { checks: [
          { name: 'second pass', passed: runs >= 2, summary: runs >= 2 ? 'ok' : 'The house style needs a second pass' },
          { name: 'token', passed: ctx.config.token === 'tok-plugin-123', summary: 'configured secret' },
        ] };
      }
      export function completed(ctx) { ctx.log('completed:', ctx.report.summary); }`;
    await s.capabilities.register(owner, {
      id: 'house-style', name: 'House style', version: '1.0.0', type: 'plugin',
      permissions: ['filesystem.project.read', 'secrets.read'],
      configuration: [{ key: 'token', secret: true, required: true }],
      plugin: { hooks: ['task.prepare', 'task.verify', 'task.completed'], source },
    });
    const install = await s.capabilities.install(owner, { capabilityId: 'house-style', scope: 'PROJECT', projectId, enabled: true, config: { token: 'secret:PLUGIN_TOKEN' } });
    expect(install.status).toBe('ACTIVE');
    const eventsOf = async (id: string) => {
      await worker.flush();
      return (await s.tasks.events(owner, id, { limit: 500 })).items;
    };
    try {
      // Flag off (the default): the plugin is not run and its secret is never sent to the worker.
      const off = await createTask('plugin flag off', 'mocka/scenario:success');
      expect((await waitFor(() => getTask(off.id), settled, 60_000, 'completion with flag off')).status).toBe('COMPLETED');
      const offEvents = await eventsOf(off.id);
      expect(offEvents.find((e) => e.type === 'CapabilityPlanCreated')?.payload).toMatchObject({ skipped: ['house-style'], reason: expect.stringContaining('plugins.execution') });
      expect(offEvents.some((e) => e.type.startsWith('PluginHook'))).toBe(false);
      expect(await AuditLog.countDocuments({ action: 'secret.deliver' })).toBe(0);

      await s.features.set({ userId: owner.userId, correlationId: 'test' }, 'plugins.execution', true, owner.organizationId);
      await resetRepo();
      const on = await createTask('plugin flag on', 'mocka/scenario:success');
      const done = await waitFor(() => getTask(on.id), settled, 90_000, 'completion with plugin');
      expect(done.status).toBe('COMPLETED');
      // The plugin's failed check made the agent fix it once; its instructions were in the prompt.
      expect(done.remediationCount).toBe(1);
      const output = fs.readFileSync(path.join(repo, 'mock-output.txt'), 'utf8');
      expect(output).toContain('prompt-markers:MARKER-PLUGIN-PREPARED');
      expect(done.completionReport?.testsExecuted).toEqual(['check: passed', 'house-style: second pass: passed', 'house-style: token: passed']);
      // task.completed runs after the task is marked COMPLETED.
      const hooksOf = (evs: Awaited<ReturnType<typeof eventsOf>>) => evs.filter((e) => e.type === 'PluginHookCompleted').map((e) => (e.payload as { hook: string }).hook);
      const events = await waitFor(() => eventsOf(on.id), (evs) => hooksOf(evs).includes('task.completed'), 30_000, 'the completed hook');
      expect(hooksOf(events)).toEqual(['task.prepare', 'task.verify', 'task.verify', 'task.completed']);
      const logs = events.filter((e) => e.type === 'PluginHookCompleted').flatMap((e) => (e.payload as { logs: string[] }).logs);
      expect(logs).toContain('verify sees run 1 for plugin flag on');
      expect(logs.some((l) => l.startsWith('completed:'))).toBe(true);
      expect(JSON.stringify(events)).not.toContain('tok-plugin-123');
      expect(await AuditLog.countDocuments({ action: 'secret.deliver' })).toBe(1);
    } finally {
      await s.features.set({ userId: owner.userId, correlationId: 'test' }, 'plugins.execution', null, owner.organizationId);
      await s.capabilities.uninstall(owner, install.id);
    }
  }, 150_000);

  it('environment profiles: variables and secrets reach the agent and verification, secrets are scrubbed, approval enforced (FUT-006)', async () => {
    const { AuditLog } = await import('@ao/database');
    await resetRepo();
    await s.queries.putSecret(owner, 'PAYMENT_ACCOUNT', 'acct-live-xyz-987');
    const staging = { name: 'staging' as const, variables: { APP_MODE: 'staging', AO_MOCK_ECHO_ENV: 'APP_MODE,PAYMENT_ACCOUNT' }, secretRefs: ['PAYMENT_ACCOUNT'], requiresApproval: true };
    const testing = { name: 'testing' as const, variables: {}, secretRefs: ['NOT_CREATED'], requiresApproval: false };
    await s.projects.update(owner, projectId, { environments: [staging, testing] });
    const envTask = (title: string, environment: string) =>
      s.tasks.create(owner, {
        projectId, title, prompt: `Do ${title}`, priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], environment,
        policy: {
          models: { preferred: [{ providerId: 'mocka', modelId: 'scenario:success' }] },
          verification: { enabled: true, autoDetect: false, steps: [
            { kind: 'test', name: 'check', command: [process.execPath, 'check.js'], required: true, timeoutMs: 20_000 },
            { kind: 'test', name: 'env', command: [process.execPath, '-e', "process.exit(process.env.APP_MODE === 'staging' && process.env.PAYMENT_ACCOUNT.length === 17 && process.env.PAYMENT_ACCOUNT.endsWith('-987') ? 0 : 1)"], required: true, timeoutMs: 20_000 },
          ] },
          git: { policy: 'NONE' },
        },
      });
    try {
      const missing = await envTask('env with a missing secret', 'testing');
      const stopped = await waitFor(() => getTask(missing.id), settled, 60_000, 'missing secret');
      expect(stopped.status).toBe('RECOVERY_REQUIRED');
      expect(stopped.statusReason).toMatch(/Environment "testing" references secrets that do not exist: NOT_CREATED/);

      const t = await envTask('env staging', 'staging');
      const waiting = await waitFor(() => getTask(t.id), (x) => x.status === 'WAITING_FOR_APPROVAL', 60_000, 'environment approval');
      expect(waiting.pendingInteraction?.question).toMatch(/staging environment/);
      await s.tasks.action(owner, t.id, { action: 'approve' });
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'staging completion');
      expect(done.status).toBe('COMPLETED');
      expect(done.completionReport?.testsExecuted).toEqual(['check: passed', 'env: passed']);
      await worker.flush();
      const events = (await s.tasks.events(owner, t.id, { limit: 500, includeOutput: true })).items;
      const output = events.filter((e) => e.type === 'AgentOutput').flatMap((e) => (e.payload as { lines: string[] }).lines);
      expect(output).toContain('env APP_MODE=staging');
      expect(output).toContain('env PAYMENT_ACCOUNT=[secret]'); // not caught by the generic redactor: removed by value
      expect(JSON.stringify(events)).not.toContain('acct-live-xyz-987');
      expect(JSON.stringify(await getTask(t.id))).not.toContain('acct-live-xyz-987');
      expect(await AuditLog.countDocuments({ action: 'secret.deliver', 'metadata.environment': 'staging' })).toBeGreaterThanOrEqual(1);
    } finally {
      await s.projects.update(owner, projectId, { environments: [] });
    }
  }, 150_000);

  it('review tasks: the agent reviews a branch in its own worktree, changes nothing, and the review is the result (FUT-003)', async () => {
    await resetRepo();
    const g = (...a: string[]) => runCommand('git', a, { cwd: repo });
    await g('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature line\n');
    await g('add', 'feature.txt');
    await g('commit', '-qm', 'feature');
    await g('checkout', '-q', 'main');
    const reviewTask = (title: string, scenario: string) =>
      s.tasks.create(owner, {
        projectId, title, prompt: 'Review the feature branch', kind: 'review', review: { base: 'main', head: 'feature' },
        priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [],
        policy: { models: { preferred: [{ providerId: 'mocka', modelId: `scenario:${scenario}` }] }, git: { policy: 'COMMIT', workOnBranch: true } },
      });
    const t = await reviewTask('review feature', 'review');
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'review completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.kind).toBe('review');
    expect(done.completionReport?.review).toMatchObject({ verdict: 'request_changes', summary: expect.stringContaining('MARKER-DIFF-SEEN'), comments: [expect.objectContaining({ path: 'feature.txt', line: 1, severity: 'major' }), expect.objectContaining({ severity: 'nit' })] });
    expect(done.completionReport?.verification).toBe('Review request changes; 2 comment(s) (1 major, 1 nit)');
    expect(done.gitStatus).toBe('NONE'); // no commit, no task branch
    // The user's checkout was never touched, and the worktree is gone.
    expect((await g('rev-parse', '--abbrev-ref', 'HEAD')).stdout.trim()).toBe('main');
    expect((await g('branch', '--list', 'ao/*')).stdout.trim()).toBe('');
    expect(fs.existsSync(path.join(repo, 'feature.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.agent-orchestrator', 'worktrees', t.id))).toBe(false);

    // A reviewer that edits files is sent back; its edits never reach the user's checkout.
    const dirty = await reviewTask('review that edits', 'review_dirty');
    const fixed = await waitFor(() => getTask(dirty.id), settled, 60_000, 'dirty review');
    expect(fixed.status).toBe('COMPLETED');
    expect(fixed.remediationCount).toBe(1);
    expect(fs.existsSync(path.join(repo, 'reviewer-was-here.txt'))).toBe(false);
    await worker.flush();
    const failed = (await s.tasks.events(owner, dirty.id, { limit: 500 })).items.find((e) => e.type === 'VerificationFailed');
    expect(JSON.stringify(failed?.payload)).toContain('reviewer-was-here.txt');

    // Without anything to review, the task stops with a reason.
    const none = await s.tasks.create(owner, { projectId, title: 'nothing', prompt: 'x', kind: 'review', review: { base: 'main', head: 'main' }, priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], policy: { models: { preferred: [{ providerId: 'mocka', modelId: 'scenario:review' }] } } });
    const stopped = await waitFor(() => getTask(none.id), settled, 60_000, 'empty review');
    expect(stopped).toMatchObject({ status: 'RECOVERY_REQUIRED', statusReason: 'There are no changes between main and main' });
    await expect(s.tasks.create(owner, { projectId, title: 'x', prompt: 'x', kind: 'review', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  }, 150_000);

  it('plan tasks: the agent breaks a goal into tasks without changing anything; an invalid plan is sent back (FUT-001)', async () => {
    await resetRepo();
    const planTask = (title: string, scenario: string) =>
      s.tasks.create(owner, {
        projectId, title, prompt: 'Build order management', kind: 'plan',
        priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [],
        policy: { models: { preferred: [{ providerId: 'mocka', modelId: `scenario:${scenario}` }] }, git: { policy: 'COMMIT', workOnBranch: true } },
      });
    const t = await planTask('plan orders', 'plan');
    const done = await waitFor(() => getTask(t.id), settled, 60_000, 'plan completion');
    expect(done.status).toBe('COMPLETED');
    expect(done.completionReport?.plan?.summary).toContain('MARKER-PLANNING');
    expect(done.completionReport?.plan?.tasks.map((x) => x.key)).toEqual(['schema', 'api', 'ui']);
    expect(done.gitStatus).toBe('NONE');
    expect((await runCommand('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()).toBe('');
    expect((await runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })).stdout.trim()).toBe('main');
    expect(fs.existsSync(path.join(repo, '.agent-orchestrator', 'worktrees', t.id))).toBe(false);

    const cyc = await planTask('plan with a cycle', 'plan_cycle');
    const fixed = await waitFor(() => getTask(cyc.id), settled, 60_000, 'cyclic plan');
    expect(fixed.status).toBe('COMPLETED');
    expect(fixed.remediationCount).toBe(1);
    await worker.flush();
    const failed = (await s.tasks.events(owner, cyc.id, { limit: 500 })).items.find((e) => e.type === 'VerificationFailed');
    expect(JSON.stringify(failed?.payload)).toMatch(/cycle/);
  }, 150_000);

  it('pull request policy: pushes the task branch and opens the PR with the worker’s token for the host (GIT-004)', async () => {
    const http = await import('node:http');
    const prs: Array<{ url: string; auth: string | undefined; body: any }> = [];
    const api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        prs.push({ url: req.url!, auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(201, { 'content-type': 'application/json' }).end('{"html_url":"https://github.com/acme/site/pull/42"}');
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const g = (...a: string[]) => runCommand('git', a, { cwd: repo });
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-e2e-remote-'));
    await runCommand('git', ['init', '-q', '--bare', bare]);
    try {
      await resetRepo();
      await g('remote', 'add', 'origin', 'https://github.com/acme/site.git');
      await g('config', `url.${bare.split(path.sep).join('/')}.insteadOf`, 'https://github.com/acme/site.git');
      await worker.credentials.set('git-hosting:github.com', 'ghp_e2e_token');
      worker.config.update((c) => ({ ...c, git: { ...c.git, hosting: [{ host: 'github.com', kind: 'github', apiBaseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}` }] } }));
      const t = await createTask('open a pull request', 'mocka/scenario:success', { git: { policy: 'PULL_REQUEST', workOnBranch: true } });
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'PR task');
      expect(done.status).toBe('COMPLETED');
      expect(done.gitStatus).toBe('PR_OPENED');
      expect(done.gitResult).toMatchObject({ pushed: true, pullRequestUrl: 'https://github.com/acme/site/pull/42' });
      expect(prs).toEqual([{ url: '/repos/acme/site/pulls', auth: 'Bearer ghp_e2e_token', body: expect.objectContaining({ title: 'open a pull request', base: 'main', head: done.gitResult!.branch }) }]);
      expect((await runCommand('git', ['branch', '--list', done.gitResult!.branch!], { cwd: bare })).stdout).toContain(done.gitResult!.branch!);
    } finally {
      api.close();
      await g('remote', 'remove', 'origin');
      await g('checkout', '-q', 'main');
      worker.config.update((c) => ({ ...c, git: { ...c.git, hosting: [] } }));
    }
  }, 120_000);

  it('OS sandbox policy: required without a sandbox stops the task; with one, the agent runs inside it (SEC-014)', async () => {
    await resetRepo();
    const sandbox = { mode: 'required', network: false, writable: [], hidden: [] };
    const saved = { backend: process.env.AO_SANDBOX_BACKEND, exe: process.env.AO_SANDBOX_EXECUTABLE };
    try {
      delete process.env.AO_SANDBOX_BACKEND;
      if (process.platform === 'win32') {
        const t = await createTask('sandbox unavailable', 'mocka/scenario:success', { sandbox });
        const done = await waitFor(() => getTask(t.id), settled, 60_000, 'recovery without sandbox');
        expect(done.status).toBe('RECOVERY_REQUIRED');
        expect(done.statusReason).toMatch(/requires an OS sandbox.*No OS sandbox is available for agents on win32/);
      }

      // A stand-in for bwrap: records its arguments, then runs the command after "--" like bwrap would.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fake-bwrap-'));
      const record = path.join(dir, 'args.json');
      fs.writeFileSync(
        path.join(dir, 'bwrap.mjs'),
        `import fs from 'node:fs'; import { spawn } from 'node:child_process';
         const args = process.argv.slice(2); fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(args));
         const [cmd, ...rest] = args.slice(args.indexOf('--') + 1);
         spawn(cmd, rest, { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 1));`,
      );
      const exe = process.platform === 'win32' ? path.join(dir, 'bwrap.cmd') : path.join(dir, 'bwrap');
      fs.writeFileSync(exe, process.platform === 'win32' ? `@"${process.execPath}" "${path.join(dir, 'bwrap.mjs')}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'bwrap.mjs')}" "$@"\n`, { mode: 0o755 });
      process.env.AO_SANDBOX_BACKEND = 'bubblewrap';
      process.env.AO_SANDBOX_EXECUTABLE = exe;
      await resetRepo();
      const t = await createTask('sandboxed agent', 'mocka/scenario:success', { sandbox });
      const done = await waitFor(() => getTask(t.id), settled, 60_000, 'sandboxed completion');
      expect(done.status).toBe('COMPLETED');
      const args = JSON.parse(fs.readFileSync(record, 'utf8')) as string[];
      const joined = args.join(' ');
      expect(joined).toContain(`--bind ${path.resolve(repo)} ${path.resolve(repo)}`);
      expect(joined).toContain(`--chdir ${path.resolve(repo)}`);
      expect(joined).toContain(`--tmpfs ${path.resolve(worker.dataDir)}`); // the worker's own data is hidden
      expect(args).toContain('--unshare-net');
      expect(args.indexOf('--')).toBeGreaterThan(0);
    } finally {
      if (saved.backend === undefined) delete process.env.AO_SANDBOX_BACKEND;
      else process.env.AO_SANDBOX_BACKEND = saved.backend;
      if (saved.exe === undefined) delete process.env.AO_SANDBOX_EXECUTABLE;
      else process.env.AO_SANDBOX_EXECUTABLE = saved.exe;
    }
  }, 120_000);

  it('approval gate: approve runs the task, deny cancels it (spec §37, §78)', async () => {
    await resetRepo();
    const approveMe = await createTask('needs approval', 'mocka/scenario:success', { requireApprovalFor: { plan: true } });
    const waiting = await waitFor(() => getTask(approveMe.id), (x) => x.status === 'WAITING_FOR_APPROVAL', 60_000, 'approval request');
    expect(waiting.pendingInteraction?.kind).toBe('approval');
    // Developers cannot approve; managers and above can.
    await expect(s.tasks.action({ ...owner, role: 'DEVELOPER' }, approveMe.id, { action: 'approve' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await s.tasks.action(owner, approveMe.id, { action: 'approve' });
    expect((await waitFor(() => getTask(approveMe.id), settled, 60_000, 'approved completion')).status).toBe('COMPLETED');

    await resetRepo();
    const denyMe = await createTask('will be denied', 'mocka/scenario:success', { requireApprovalFor: { plan: true } });
    await waitFor(() => getTask(denyMe.id), (x) => x.status === 'WAITING_FOR_APPROVAL', 60_000, 'approval request 2');
    await s.tasks.action(owner, denyMe.id, { action: 'deny', reason: 'not now' });
    const denied = await waitFor(() => getTask(denyMe.id), (x) => x.status === 'CANCELLED', 30_000, 'denied');
    expect(denied.statusReason).toMatch(/denied/i);
    expect(fs.existsSync(path.join(repo, 'mock-output.txt'))).toBe(false); // the agent never ran
  }, 120_000);

  it('cancel stops a running task and the worker stops the agent', async () => {
    await resetRepo();
    const t = await createTask('slow cancel', 'mocka/scenario:slow');
    await waitFor(() => getTask(t.id), (x) => x.status === 'RUNNING', 60_000, 'running');
    await s.tasks.action(owner, t.id, { action: 'cancel' });
    await waitFor(async () => worker.executor.running.size, (n) => n === 0, 20_000, 'executor idle');
    expect((await getTask(t.id)).status).toBe('CANCELLED');
  }, 90_000);
});
