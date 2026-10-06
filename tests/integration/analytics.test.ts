import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { Task, UsageRecord, WorkerDailyStat, mongoose } from '@ao/database';
import { analyticsCsv, durationStats, toCsv, type Actor, type Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { expireLease, makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const NOW = new Date('2026-10-05T15:00:00Z');
const HOUR = 3_600_000;
const id = (v: string) => new mongoose.Types.ObjectId(v);

type Finished = {
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RUNNING' | 'RECOVERY_REQUIRED';
  daysAgo: number;
  agentId?: string;
  modelId?: string;
  cost?: number;
  remediations?: number;
  activeMs?: number;
  leadMs?: number;
  workerId?: string;
  createdBy?: string;
  source?: Record<string, unknown> | null;
  kind?: string;
  priority?: string;
  startWaitMs?: number;
  failureCategory?: string;
  stoppedDaysAgo?: number;
  counters?: Record<string, number>;
  verificationRuns?: unknown[];
};

/** A task as it is stored once finished (timestamps set directly: `createdAt` is otherwise "now"). */
async function finished(actor: Actor, projectId: string, f: Finished) {
  const completedAt = new Date(NOW.getTime() - f.daysAgo * 24 * HOUR);
  const createdAt = new Date(completedAt.getTime() - (f.leadMs ?? HOUR));
  const r = await mongoose.connection.db!.collection('tasks').insertOne({
    organizationId: id(actor.organizationId),
    projectId: id(projectId),
    title: 't',
    originalPrompt: 'p',
    status: f.status,
    agentId: f.agentId ?? 'claude-code',
    providerId: 'anthropic',
    modelId: f.modelId ?? 'haiku',
    remediationCount: f.remediations ?? 0,
    activeMs: f.activeMs ?? 0,
    usage: { costUsd: f.cost ?? 0, inputTokens: 0, outputTokens: 0 },
    createdBy: id(f.createdBy ?? actor.userId),
    correlationId: 'c',
    createdAt,
    completedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(f.status) ? completedAt : null,
    workerId: f.workerId ? id(f.workerId) : null,
    source: f.source ?? null,
    kind: f.kind ?? 'code',
    priority: f.priority ?? 'NORMAL',
    startedAt: f.startWaitMs == null ? null : new Date(createdAt.getTime() + f.startWaitMs),
    failureCategory: f.failureCategory ?? null,
    stoppedAt: f.failureCategory ? new Date(NOW.getTime() - (f.stoppedDaysAgo ?? f.daysAgo) * 24 * HOUR) : null,
    verificationRuns: f.verificationRuns ?? [],
    ...(f.counters ?? {}),
  });
  return String(r.insertedId);
}

/** A usage record as an ended agent session leaves it. */
async function session(actor: Actor, projectId: string, u: { daysAgo: number; cost?: number; input?: number; output?: number; durationMs?: number; kind?: string; agentId?: string; modelId?: string; workerId?: string; taskId?: string }) {
  await mongoose.connection.db!.collection('usagerecords').insertOne({
    organizationId: id(actor.organizationId),
    projectId: id(projectId),
    taskId: u.taskId ? id(u.taskId) : null,
    workerId: u.workerId ? id(u.workerId) : null,
    agentId: u.agentId ?? 'claude-code',
    providerId: 'anthropic',
    modelId: u.modelId ?? 'haiku',
    kind: u.kind ?? 'execution',
    durationMs: u.durationMs ?? 0,
    inputTokens: u.input ?? null,
    outputTokens: u.output ?? null,
    costUsd: u.cost ?? null,
    createdAt: new Date(NOW.getTime() - u.daysAgo * 24 * HOUR),
  });
}

const newProject = (actor: Actor, name: string) => s.projects.create(actor, { name, description: '', defaultBranch: 'main', environments: [], knowledge: '' });
const tr = (to: string, patch: Record<string, unknown> = {}, reason?: string) => ({ to: to as never, transitionId: randomUUID(), patch, reason });

describe('analytics', () => {
  it('reports success, first-pass, cost and time, in total, per day and by agent, model and project', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    const blog = await newProject(actor, 'blog');
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, cost: 1, activeMs: 60_000, leadMs: 2 * HOUR });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, cost: 3, remediations: 2, activeMs: 180_000, leadMs: 4 * HOUR });
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 1, cost: 2, remediations: 3 });
    await finished(actor, blog.id, { status: 'COMPLETED', daysAgo: 2, agentId: 'codex', modelId: 'gpt', cost: 0.5, activeMs: 30_000, leadMs: HOUR });
    // Not counted: cancelled, still running, and finished before the period.
    await finished(actor, shop.id, { status: 'CANCELLED', daysAgo: 0, cost: 50 });
    await finished(actor, shop.id, { status: 'RUNNING', daysAgo: 0, cost: 50 });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 9, cost: 50 });

    const a = await s.analytics.overview(actor, { days: 7 }, NOW);
    expect(a.since).toBe('2026-09-29T00:00:00.000Z');
    expect(a.totals).toMatchObject({ finished: 4, completed: 3, failed: 1, successRate: 0.75, costUsd: 6.5, avgRemediations: 1.25, avgActiveMs: 90_000 });
    expect(a.totals.firstPassRate).toBeCloseTo(2 / 3);
    expect(a.totals.costPerCompletedUsd).toBeCloseTo(6.5 / 3);
    expect(a.totals.avgLeadMs).toBeCloseTo((7 * HOUR) / 3);
    expect(a.totals.created).toBe(6); // every task created in the period, whatever became of it
    // The seven days before the period: the task that finished nine days ago, and what was created then.
    expect(a.previous).toMatchObject({ finished: 1, completed: 1, costUsd: 50, created: 1 });

    expect(a.daily).toHaveLength(7);
    expect(a.daily.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05']);
    expect(a.daily.slice(-3)).toEqual([
      { date: '2026-10-03', completed: 1, failed: 0, costUsd: 0.5 },
      { date: '2026-10-04', completed: 0, failed: 1, costUsd: 2 },
      { date: '2026-10-05', completed: 2, failed: 0, costUsd: 4 },
    ]);

    expect(a.byAgent.map((g) => [g.agentId, g.finished, g.successRate])).toEqual([['claude-code', 3, 2 / 3], ['codex', 1, 1]]);
    expect(a.byModel.find((m) => m.modelId === 'gpt')).toMatchObject({ providerId: 'anthropic', completed: 1, costPerCompletedUsd: 0.5 });
    expect(a.byProject.map((p) => [p.name, p.finished])).toEqual([['shop', 3], ['blog', 1]]);

    const onlyBlog = await s.analytics.overview(actor, { days: 7, projectId: blog.id }, NOW);
    expect(onlyBlog.totals).toMatchObject({ finished: 1, successRate: 1, firstPassRate: 1 });
    expect(onlyBlog.previous).toMatchObject({ finished: 0, successRate: null });
  });

  it('an organization without finished tasks gets zeros and no rates, and never another organization\'s figures', async () => {
    const { actor } = await makeOwner(s);
    const project = await newProject(actor, 'shop');
    await finished(actor, project.id, { status: 'COMPLETED', daysAgo: 0, cost: 9 });
    const { actor: stranger } = await makeOwner(s);
    const a = await s.analytics.overview(stranger, { days: 30 }, NOW);
    expect(a.totals).toMatchObject({ finished: 0, created: 0, successRate: null, firstPassRate: null, costPerCompletedUsd: null, avgActiveMs: null, costUsd: 0 });
    expect(a.daily).toHaveLength(30);
    expect(a.byAgent).toEqual([]);
    await expect(s.analytics.overview(stranger, { days: 30, projectId: project.id }, NOW)).resolves.toMatchObject({ totals: { finished: 0 } });
    expect(await Task.countDocuments()).toBe(1);
  });
});

describe('cost analytics', () => {
  it('reports spend per day and by project, model, agent and kind, the most expensive tasks and the previous period', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    const blog = await newProject(actor, 'blog');
    const dear = await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0 });
    const cheap = await finished(actor, blog.id, { status: 'COMPLETED', daysAgo: 1 });
    await session(actor, shop.id, { daysAgo: 0, cost: 4, input: 1000, output: 200, durationMs: 60_000, taskId: dear });
    await session(actor, shop.id, { daysAgo: 0, cost: 1, input: 100, output: 20, taskId: dear, kind: 'limit' });
    await session(actor, blog.id, { daysAgo: 1, cost: 0.5, input: 10, output: 2, agentId: 'codex', modelId: 'gpt', taskId: cheap });
    await session(actor, blog.id, { daysAgo: 1, agentId: 'aider', modelId: 'local', taskId: cheap }); // reports no cost
    await session(actor, shop.id, { daysAgo: 8, cost: 20 }); // the previous period

    const c = await s.analytics.cost(actor, { days: 7 }, NOW);
    expect(c.totals).toEqual({ costUsd: 5.5, inputTokens: 1110, outputTokens: 222, sessions: 3 });
    expect(c.previous).toMatchObject({ costUsd: 20, sessions: 1 });
    expect(c.daily).toHaveLength(7);
    expect(c.daily.slice(-2)).toEqual([
      { date: '2026-10-04', costUsd: 0.5, inputTokens: 10, outputTokens: 2 },
      { date: '2026-10-05', costUsd: 5, inputTokens: 1100, outputTokens: 220 },
    ]);
    expect(c.byProject.map((p) => [p.name, p.costUsd])).toEqual([['shop', 5], ['blog', 0.5]]);
    expect(c.byAgent.map((g) => [g.agentId, g.costUsd, g.sessions])).toEqual([['claude-code', 5, 1], ['codex', 0.5, 1], ['aider', 0, 1]]);
    expect(c.byModel[0]).toMatchObject({ providerId: 'anthropic', modelId: 'haiku', costUsd: 5 });
    expect(c.byKind).toEqual([
      { kind: 'execution', count: 3, costUsd: 4.5, inputTokens: 1010, outputTokens: 202, durationMs: 60_000 },
      { kind: 'limit', count: 1, costUsd: 1, inputTokens: 100, outputTokens: 20, durationMs: 0 },
    ]);
    expect(c.topTasks.map((t) => [t.taskId, t.costUsd])).toEqual([[dear, 5], [cheap, 0.5]]);

    const onlyBlog = await s.analytics.cost(actor, { days: 7, projectId: blog.id }, NOW);
    expect(onlyBlog.totals.costUsd).toBe(0.5);
    expect(onlyBlog.budgets.map((b) => b.scope)).toEqual(['project']);
  });

  it('forecasts the month from the spend so far, against the budget limits', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    await s.orgs.update(actor, { policy: { budget: { organizationMonthlyUsd: 100 } } });
    // 5 October 15:00 UTC: 4.625 of 31 days have passed.
    await session(actor, shop.id, { daysAgo: 1, cost: 20 });
    const c = await s.analytics.cost(actor, { days: 30 }, NOW);
    const org = c.budgets.find((b) => b.scope === 'organization')!;
    expect(org).toMatchObject({ limitUsd: 100, spentUsd: 20, state: 'ok', forecastExceeds: true });
    expect(org.forecastUsd).toBeCloseTo((20 * 31) / 4.625);
    // A project without a limit is listed for its spend, and never "exceeds".
    expect(c.budgets.find((b) => b.scope === 'project')).toMatchObject({ name: 'shop', limitUsd: null, spentUsd: 20, forecastExceeds: false });
  });
});

describe('worker analytics', () => {
  it('reports each worker\'s finished tasks, agent time, cost, time online, utilization and stops', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    const busy = (await makeWorker(s, actor, shop.id, { name: 'busy' })).worker.workerId;
    const idle = (await makeWorker(s, actor, shop.id, { name: 'idle' })).worker.workerId;
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, workerId: busy, activeMs: 60_000 });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 1, workerId: busy, activeMs: 120_000, remediations: 1 });
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 1, workerId: busy, failureCategory: 'verification' });
    await finished(actor, shop.id, { status: 'RECOVERY_REQUIRED', daysAgo: 2, workerId: busy, failureCategory: 'worker_lost' });
    await session(actor, shop.id, { daysAgo: 0, cost: 2, durationMs: 2 * HOUR, workerId: busy });
    await session(actor, shop.id, { daysAgo: 1, cost: 1, durationMs: HOUR, workerId: busy });
    await session(actor, shop.id, { daysAgo: 1, durationMs: 5 * HOUR, workerId: busy, kind: 'limit' }); // not a session
    await WorkerDailyStat.create([
      { organizationId: actor.organizationId, workerId: busy, date: '2026-10-05', onlineMs: 3 * HOUR },
      { organizationId: actor.organizationId, workerId: busy, date: '2026-10-04', onlineMs: 3 * HOUR },
      { organizationId: actor.organizationId, workerId: busy, date: '2026-09-01', onlineMs: 24 * HOUR }, // before the period
    ]);

    const w = await s.analytics.workers(actor, { days: 7 }, NOW);
    expect(w.workers.map((x) => x.name)).toEqual(['busy', 'idle']);
    const b = w.workers[0]!;
    expect(b).toMatchObject({ workerId: busy, finished: 3, completed: 2, failed: 1, avgActiveMs: 90_000, costUsd: 3, sessions: 2, sessionMs: 3 * HOUR, onlineMs: 6 * HOUR, stops: 2, workerLost: 1 });
    expect(b.successRate).toBeCloseTo(2 / 3);
    expect(b.firstPassRate).toBe(0.5);
    // Two tasks at once (the default): 3 hours of agent time in 6 hours online is a quarter of its capacity.
    expect(b.utilization).toBe(0.25);
    expect(b.onlineShare).toBeCloseTo((6 * HOUR) / (6 * 24 * HOUR + 15 * HOUR));
    // No heartbeat counted: unknown, not zero.
    expect(w.workers[1]).toMatchObject({ workerId: idle, finished: 0, successRate: null, sessions: 0, onlineMs: null, onlineShare: null, utilization: null });
  });

  it('adds up time online from heartbeats, per UTC day, and not across a gap', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    const { worker } = await makeWorker(s, actor, shop.id); // its first heartbeat: nothing to count yet
    const beat = (at: Date) => s.workers.heartbeat(worker, { metrics: {}, activeTasks: [], sentAt: at.toISOString() }, at);
    const total = async () => (await WorkerDailyStat.find().lean()).reduce((a, d) => a + d.onlineMs, 0);
    expect(await total()).toBe(0);
    const t0 = new Date(Date.now() + 10_000);
    await beat(t0);
    const first = await total();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(s.timing.offlineThresholdMs);
    await beat(new Date(t0.getTime() + 15_000));
    expect(await total()).toBe(first + 15_000);
    // A gap longer than the offline threshold: the worker was offline for part of it, so none of it counts.
    const late = new Date(t0.getTime() + 15_000 + s.timing.offlineThresholdMs + 1);
    await beat(late);
    expect(await total()).toBe(first + 15_000);
    // An interval is counted for the day it ends on.
    const midnight = new Date(Date.UTC(late.getUTCFullYear(), late.getUTCMonth(), late.getUTCDate() + 1));
    await beat(new Date(midnight.getTime() - 5_000));
    await beat(new Date(midnight.getTime() + 5_000));
    expect((await WorkerDailyStat.findOne({ date: midnight.toISOString().slice(0, 10) }).lean())?.onlineMs).toBe(10_000);
  });
});

describe('reliability analytics', () => {
  const step = (name: string, status: string, durationMs = 1000) => ({ kind: 'command', name, required: true, status, durationMs, artifacts: [] });
  const run = (attempt: number, steps: unknown[]) => ({ attempt, status: 'failed', startedAt: NOW.toISOString(), finishedAt: NOW.toISOString(), steps });

  it('reports stops by category, recoveries by agent and failure rates of verification steps', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    await finished(actor, shop.id, {
      status: 'COMPLETED',
      daysAgo: 0,
      remediations: 1,
      counters: { limitHitCount: 2, fallbackStep: 0, restartCount: 1 },
      verificationRuns: [run(1, [step('test', 'failed', 3000), step('lint', 'passed')]), run(2, [step('test', 'passed', 1000), step('lint', 'passed'), step('build', 'skipped')])],
    });
    // Stopped for verification three days ago, retried and completed today.
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, agentId: 'codex', failureCategory: 'verification', stoppedDaysAgo: 3, counters: { contextResetCount: 1 } });
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 1, failureCategory: 'provider_limit', verificationRuns: [run(1, [step('test', 'error')])] });
    await finished(actor, shop.id, { status: 'RECOVERY_REQUIRED', daysAgo: 1, failureCategory: 'verification' });
    await finished(actor, shop.id, { status: 'RECOVERY_REQUIRED', daysAgo: 10, failureCategory: 'timeout' }); // the previous period
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 2 }); // stopped before categories existed: not a counted stop

    const r = await s.analytics.reliability(actor, { days: 7 }, NOW);
    expect(r.totals).toEqual({ finished: 4, limitHits: 2, fallbacks: 1, contextResets: 1, restarts: 1, remediations: 1, stops: 3, previousStops: 1, stillStopped: 2, recovered: 1 });
    expect(r.byCategory).toEqual([
      { category: 'verification', stops: 2, stillStopped: 1, recovered: 1 },
      { category: 'provider_limit', stops: 1, stillStopped: 1, recovered: 0 },
    ]);
    expect(r.daily.slice(-4)).toEqual([
      { date: '2026-10-02', stops: 1 },
      { date: '2026-10-03', stops: 0 },
      { date: '2026-10-04', stops: 2 },
      { date: '2026-10-05', stops: 0 },
    ]);
    expect(r.byAgent).toEqual([
      { agentId: 'claude-code', finished: 3, limitHits: 2, fallbacks: 1, contextResets: 0, restarts: 1, remediations: 1 },
      { agentId: 'codex', finished: 1, limitHits: 0, fallbacks: 0, contextResets: 1, restarts: 0, remediations: 0 },
    ]);
    // Every run of a step counts; skipped steps don't. An error counts as a failure.
    expect(r.verificationSteps).toEqual([
      { name: 'test', kind: 'command', runs: 3, failed: 2, failureRate: 2 / 3, avgDurationMs: 5000 / 3 },
      { name: 'lint', kind: 'command', runs: 2, failed: 0, failureRate: 0, avgDurationMs: 1000 },
    ]);
  });

  it('records why and when a task stops: from the worker, from the transition itself, from a lost worker', async () => {
    const { actor } = await makeOwner(s);
    await s.orgs.update(actor, { policy: { concurrency: { perProject: 4 }, onWorkerLost: 'RECOVERY_REQUIRED' } });
    const shop = await newProject(actor, 'shop');
    const { worker } = await makeWorker(s, actor, shop.id);
    const start = async () => {
      const t = await s.tasks.create(actor, { projectId: shop.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
      expect(await s.tasks.claim(worker, t.id)).toMatchObject({ claimed: true });
      await s.tasks.transition(worker, t.id, tr('PREPARING'));
      await s.tasks.transition(worker, t.id, tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' }));
      return t.id;
    };
    const stored = (taskId: string) => Task.findById(taskId, { status: 1, failureCategory: 1, stoppedAt: 1 }).lean();

    // The worker names the reason.
    const named = await start();
    expect((await s.tasks.transition(worker, named, tr('RECOVERY_REQUIRED', { failureCategory: 'timeout' }, 'Execution time limit exceeded'))).failureCategory).toBe('timeout');
    expect((await stored(named))?.stoppedAt).toBeInstanceOf(Date);

    // An older worker names none: a failed verification is still recognised, anything else is "other".
    const verification = await start();
    await s.tasks.transition(worker, verification, tr('VERIFYING', { verificationStatus: 'RUNNING' }));
    expect((await s.tasks.transition(worker, verification, tr('RECOVERY_REQUIRED', { verificationStatus: 'FAILED' }, 'Verification still failing'))).failureCategory).toBe('verification');
    const unnamed = await start();
    expect((await s.tasks.transition(worker, unnamed, tr('FAILED', {}, 'Stopped'))).failureCategory).toBe('other');

    // A lost worker, under a policy that asks for manual recovery.
    const lost = await start();
    await expireLease(lost);
    expect(await s.tasks.sweepExpiredLeases()).toBe(1);
    expect(await stored(lost)).toMatchObject({ status: 'RECOVERY_REQUIRED', failureCategory: 'worker_lost' });

    // The category outlives a retry, so a stop that was recovered from is still known.
    await s.tasks.action(actor, named, { action: 'retry' });
    expect(await stored(named)).toMatchObject({ status: 'QUEUED', failureCategory: 'timeout' });

    const r = await s.analytics.reliability(actor, { days: 1 });
    expect(Object.fromEntries(r.byCategory.map((c) => [c.category, c.stops]))).toEqual({ timeout: 1, verification: 1, other: 1, worker_lost: 1 });
    expect(r.totals).toMatchObject({ stops: 4, stillStopped: 3 });
  });
});

describe('flow analytics', () => {
  it('reports waiting, agent and lead times, and finished tasks by creator, source, kind and priority', async () => {
    const { actor } = await makeOwner(s, 'ada');
    const shop = await newProject(actor, 'shop');
    const gone = new mongoose.Types.ObjectId().toString(); // a member who has since been removed
    for (let i = 1; i <= 10; i++) await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, startWaitMs: i * 60_000, activeMs: i * 1000, leadMs: i * HOUR });
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 1, createdBy: gone, source: { kind: 'schedule', name: 'nightly' }, kind: 'review', priority: 'HIGH', activeMs: 999_999 });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 1, source: { kind: 'jira', name: 'JIRA' }, leadMs: 11 * HOUR }); // never started an agent: no start wait

    const f = await s.analytics.flow(actor, { days: 7 }, NOW);
    expect(f).toMatchObject({ samples: 11, capped: false });
    expect(f.times.startWait).toEqual({ avgMs: 5.5 * 60_000, p50Ms: 5 * 60_000, p90Ms: 9 * 60_000 });
    expect(f.times.lead).toEqual({ avgMs: 6 * HOUR, p50Ms: 6 * HOUR, p90Ms: 10 * HOUR });
    expect(f.times.active.p90Ms).toBe(9000); // completed tasks only
    expect(f.byCreator.map((c) => [c.name, c.finished, c.successRate])).toEqual([['ada', 11, 1], ['removed user', 1, 0]]);
    expect(f.bySource.map((x) => [x.source, x.finished]).sort()).toEqual([['jira', 1], ['manual', 10], ['schedule', 1]]);
    expect(f.byKind.map((x) => [x.kind, x.finished])).toEqual([['code', 11], ['review', 1]]);
    expect(f.byPriority.map((x) => [x.priority, x.finished])).toEqual([['NORMAL', 11], ['HIGH', 1]]);
  });

  it('computes nearest-rank percentiles', () => {
    expect(durationStats([])).toEqual({ avgMs: null, p50Ms: null, p90Ms: null });
    expect(durationStats([7])).toEqual({ avgMs: 7, p50Ms: 7, p90Ms: 7 });
    expect(durationStats([4, 1, 3, 2])).toEqual({ avgMs: 2.5, p50Ms: 2, p90Ms: 4 });
  });
});

describe('analytics access and export', () => {
  it('every view is the caller\'s organization only, and needs a member', async () => {
    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, 'shop');
    const { worker } = await makeWorker(s, actor, shop.id);
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 0, cost: 9, workerId: worker.workerId, failureCategory: 'timeout' });
    await session(actor, shop.id, { daysAgo: 0, cost: 9, workerId: worker.workerId });
    const { actor: stranger } = await makeOwner(s);
    const q = { days: 30 };
    expect((await s.analytics.cost(stranger, q, NOW)).totals.costUsd).toBe(0);
    expect((await s.analytics.cost(stranger, { ...q, projectId: shop.id }, NOW)).totals.costUsd).toBe(0);
    expect((await s.analytics.workers(stranger, q, NOW)).workers).toEqual([]);
    expect((await s.analytics.reliability(stranger, q, NOW)).totals.stops).toBe(0);
    expect((await s.analytics.flow(stranger, q, NOW)).byCreator).toEqual([]);
    // A viewer may read. Someone who is not a member never becomes an actor of the organization.
    await expect(s.analytics.workers({ ...actor, role: 'VIEWER' }, q, NOW)).resolves.toMatchObject({ workers: [{ finished: 1 }] });
    await expect(s.orgs.resolveActor(stranger.userId, actor.organizationId, 'test')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await UsageRecord.countDocuments()).toBe(1);
  });

  it('exports a table as CSV, quoted where needed and safe to open in a spreadsheet', async () => {
    expect(toCsv([{ name: 'plain', n: 1, ok: true, none: null }, { name: 'a "quoted", name', extra: 'x\ny' }])).toBe('name,n,ok,none,extra\r\nplain,1,true,,\r\n"a ""quoted"", name",,,,"x\ny"\r\n');
    expect(toCsv([{ name: '=HYPERLINK("http://x")' }, { name: '+1' }, { name: '-1' }, { name: '@cmd' }, { name: -1 }])).toBe('name\r\n"\'=HYPERLINK(""http://x"")"\r\n\'+1\r\n\'-1\r\n\'@cmd\r\n-1\r\n');

    const { actor } = await makeOwner(s);
    const shop = await newProject(actor, '=shop');
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, cost: 2 });
    const a = await s.analytics.overview(actor, { days: 7 }, NOW);
    const lines = analyticsCsv(a, 'byProject').trimEnd().split('\r\n');
    expect(lines[0]).toBe('projectId,name,finished,completed,failed,successRate,firstPassRate,avgRemediations,costUsd,costPerCompletedUsd,avgActiveMs,avgLeadMs');
    expect(lines[1]).toBe(`${shop.id},'=shop,1,1,0,1,1,0,2,2,0,${HOUR}`);
    expect(analyticsCsv(a, 'daily').trimEnd().split('\r\n')).toHaveLength(8);
    expect(() => analyticsCsv(a, 'totals')).toThrow('table must be one of: daily, byAgent, byModel, byProject');
    expect(() => analyticsCsv(a, undefined)).toThrow('table must be one of');
  });
});

describe('analytics over HTTP', () => {
  it('serves every view as JSON, and one table of it as a CSV download', async () => {
    const app = await buildApp(s);
    try {
      const { actor, auth } = await makeOwner(s);
      const shop = await newProject(actor, 'shop');
      await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, cost: 2 });
      const get = (path: string) => app.inject({ method: 'GET', url: `/api/v1/orgs/${actor.organizationId}/analytics${path}`, headers: { authorization: `Bearer ${auth.accessToken}` } });
      for (const view of ['', '/cost', '/workers', '/reliability', '/flow']) {
        const res = await get(`${view}?days=7`);
        expect(res.statusCode, view).toBe(200);
        expect(res.json(), view).toMatchObject({ days: 7 });
      }
      const csv = await get('?days=7&format=csv&table=byProject');
      expect(csv.statusCode).toBe(200);
      expect(csv.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csv.headers['content-disposition']).toBe('attachment; filename="analytics-byProject-7d.csv"');
      expect(csv.body.split('\r\n')[1]).toContain(',shop,1,1,0,');
      expect((await get('/workers?format=csv&table=workers')).headers['content-disposition']).toBe('attachment; filename="analytics-workers-workers-30d.csv"');
      expect((await get('/cost?format=csv&table=nope')).statusCode).toBe(400);
      expect((await get('?days=0')).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: `/api/v1/orgs/${actor.organizationId}/analytics/cost` })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
