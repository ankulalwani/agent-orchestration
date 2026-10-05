import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { BudgetAlert, Notification, Project, Task, TaskEvent, UsageRecord } from '@ao/database';
import { MIGRATIONS } from '@ao/database';
import { mongoose } from '@ao/database';
import type { Actor, Services, WorkerActor } from '@ao/server';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

async function setup(orgBudget: Record<string, unknown> = {}) {
  const { actor } = await makeOwner(s);
  await s.orgs.update(actor, { policy: { budget: orgBudget, concurrency: { perProject: 5 } } });
  const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
  const w1 = await makeWorker(s, actor, project.id, { name: 'w1' });
  return { actor, project, w1 };
}

const tr = (to: string, patch: Record<string, unknown> = {}) => ({ to: to as never, transitionId: randomUUID(), patch });
const newTask = (actor: Actor, projectId: string, extra: Record<string, unknown> = {}) =>
  s.tasks.create(actor, { projectId, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], ...extra });

let sequence = 0;
/** What the worker reports when an agent session ends. */
function agentExited(worker: WorkerActor, taskId: string, usage: { costUsd?: number; inputTokens?: number; outputTokens?: number }) {
  return { eventId: randomUUID(), workerId: worker.workerId, taskId, timestamp: new Date().toISOString(), sequence: ++sequence, type: 'AgentExited' as const, payload: { agentId: 'mock', providerId: 'mock', modelId: 'mock-1', state: 'EXITED', durationMs: 10, ...usage } };
}

async function run(worker: WorkerActor, taskId: string) {
  expect((await s.tasks.claim(worker, taskId)).claimed).toBe(true);
  await s.tasks.transition(worker, taskId, tr('PREPARING'));
  await s.tasks.transition(worker, taskId, tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' }));
}

describe('spend budgets', () => {
  it('without limits nothing is stopped, and a task carries its spend', async () => {
    const { actor, project, w1 } = await setup();
    const t = await newTask(actor, project.id);
    await run(w1.worker, t.id);
    const e = agentExited(w1.worker, t.id, { costUsd: 500, inputTokens: 1000, outputTokens: 50 });
    await s.tasks.ingestEvents(w1.worker, [e]);
    await s.tasks.ingestEvents(w1.worker, [e]); // a replayed event is not counted twice
    const now = await s.tasks.get(actor, t.id);
    expect(now.status).toBe('RUNNING');
    expect(now.usage).toEqual({ costUsd: 500, inputTokens: 1000, outputTokens: 50 });
    expect((await UsageRecord.findOne({ taskId: t.id }).lean())!.projectId!.toString()).toBe(project.id);
  });

  it('a task that reaches its limit stops with RECOVERY_REQUIRED and continues after the limit is raised', async () => {
    const { actor, project, w1 } = await setup({ taskUsd: 1 });
    const t = await newTask(actor, project.id);
    await run(w1.worker, t.id);
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, t.id, { costUsd: 0.4 })]);
    expect((await s.tasks.get(actor, t.id)).status).toBe('RUNNING');
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, t.id, { costUsd: 0.7 })]);

    const stopped = await s.tasks.get(actor, t.id);
    expect(stopped.status).toBe('RECOVERY_REQUIRED');
    expect(stopped.statusReason).toMatch(/Task budget reached: spent \$1\.10 of \$1\.00/);
    expect(stopped.workerId).toBeNull();
    expect(await TaskEvent.countDocuments({ taskId: t.id, type: 'BudgetExceeded' })).toBe(1);
    // The project slot is free again, and the worker has lost the task.
    expect((await Project.findById(project.id).lean())!.activeTaskIds).toHaveLength(0);
    await expect(s.tasks.transition(w1.worker, t.id, tr('VERIFYING', { verificationStatus: 'RUNNING' }))).rejects.toMatchObject({ code: 'LEASE_LOST' });

    // Retrying without a higher limit leaves it queued with the reason.
    await s.tasks.action(actor, t.id, { action: 'retry' });
    expect(await s.tasks.claim(w1.worker, t.id)).toMatchObject({ claimed: false, reason: expect.stringMatching(/Task budget reached/) });
    expect(await s.scheduler.dispatch({ taskId: t.id, organizationId: actor.organizationId })).toBeNull();
    expect((await s.tasks.get(actor, t.id)).statusReason).toMatch(/Task budget reached/);

    await s.orgs.update(actor, { policy: { budget: { taskUsd: 5 } } });
    expect((await s.tasks.claim(w1.worker, t.id)).claimed).toBe(true);
  });

  it('a task layer can lower the task limit but not raise it; token limits count input and output', async () => {
    const { actor, project, w1 } = await setup({ taskUsd: 1, taskTokens: 1000 });
    const generous = await newTask(actor, project.id, { policy: { budget: { taskUsd: 100, taskTokens: null } } });
    await run(w1.worker, generous.id);
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, generous.id, { costUsd: 1.5 })]);
    expect((await s.tasks.get(actor, generous.id)).status).toBe('RECOVERY_REQUIRED');

    const strict = await newTask(actor, project.id, { policy: { budget: { taskUsd: 0.1 } } });
    await run(w1.worker, strict.id);
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, strict.id, { costUsd: 0.2 })]);
    expect((await s.tasks.get(actor, strict.id)).statusReason).toMatch(/of \$0\.10/);

    const tokens = await newTask(actor, project.id);
    await run(w1.worker, tokens.id);
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, tokens.id, { inputTokens: 800, outputTokens: 200 })]);
    expect((await s.tasks.get(actor, tokens.id)).statusReason).toMatch(/used 1000 of 1000 tokens/);
  });

  it('a task being verified is not stopped, but gets no further agent session', async () => {
    const { actor, project, w1 } = await setup({ taskUsd: 1 });
    const done = await newTask(actor, project.id);
    await run(w1.worker, done.id);
    await s.tasks.transition(w1.worker, done.id, tr('VERIFYING', { verificationStatus: 'RUNNING' }));
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, done.id, { costUsd: 2 })]);
    expect((await s.tasks.get(actor, done.id)).status).toBe('VERIFYING');
    expect((await s.tasks.transition(w1.worker, done.id, tr('COMPLETED', { verificationStatus: 'PASSED', completionReport: { summary: 'ok' } }))).status).toBe('COMPLETED');

    const failing = await newTask(actor, project.id);
    await run(w1.worker, failing.id);
    await s.tasks.transition(w1.worker, failing.id, tr('VERIFYING', { verificationStatus: 'RUNNING' }));
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, failing.id, { costUsd: 2 })]);
    // Verification failed: the worker asks for a remediation session.
    await expect(s.tasks.transition(w1.worker, failing.id, tr('RUNNING', { verificationStatus: 'FAILED', incRemediation: true }))).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect((await s.tasks.get(actor, failing.id)).status).toBe('RECOVERY_REQUIRED');
  });

  it('monthly limits: project and organization, this month only, with one warning and one notice each', async () => {
    const { actor, project, w1 } = await setup({ organizationMonthlyUsd: 10, warnAt: 0.5 });
    const other = await s.projects.create(actor, { name: 'blog', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    await s.projects.update(actor, project.id, { policy: { budget: { projectMonthlyUsd: 4, organizationMonthlyUsd: 1_000_000 } } });
    // Last month's spend does not count.
    await UsageRecord.create({ organizationId: actor.organizationId, projectId: project.id, kind: 'execution', costUsd: 500, createdAt: new Date(Date.now() - 40 * 86_400_000) });

    const a = await newTask(actor, project.id);
    const b = await newTask(actor, project.id);
    await run(w1.worker, a.id);
    await run(w1.worker, b.id);
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, a.id, { costUsd: 2.5 })]);
    expect((await s.tasks.get(actor, a.id)).status).toBe('RUNNING');
    expect(await BudgetAlert.find({}, { scope: 1, level: 1, _id: 0 }).lean()).toEqual([{ scope: 'project', level: 'warning' }]);

    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, a.id, { costUsd: 2.5 })]);
    expect((await s.tasks.get(actor, a.id)).statusReason).toMatch(/Project budget for this month reached: spent \$5\.00 of \$4\.00/);
    // The other task of the project runs on until it asks for its next session or reports spend.
    expect((await s.tasks.get(actor, b.id)).status).toBe('RUNNING');
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, b.id, { costUsd: 0.01 })]);
    expect((await s.tasks.get(actor, b.id)).status).toBe('RECOVERY_REQUIRED');
    // New tasks of that project wait; the project layer could not raise the organization limit.
    const queued = await newTask(actor, project.id);
    expect((await s.tasks.claim(w1.worker, queued.id)).claimed).toBe(false);

    const status = await s.budgets.status(actor);
    expect(status.organization).toMatchObject({ limitUsd: 10, state: 'warning' });
    expect(status.organization.spentUsd).toBeCloseTo(5.01);
    expect(status.projects.find((p) => p.projectId === project.id)).toMatchObject({ limitUsd: 4, state: 'exceeded' });
    expect(status.projects.find((p) => p.projectId === other.id)).toMatchObject({ limitUsd: null, spentUsd: 0, state: 'ok' });

    const notices = await Notification.find({ type: { $in: ['budget.warning', 'budget.exceeded'] } }).lean();
    expect(notices.map((n) => n.type).sort()).toEqual(['budget.exceeded', 'budget.warning', 'budget.warning']);
    expect(notices.find((n) => n.type === 'budget.exceeded')!.body).toContain('Project "shop"');

    // The other project still runs until the organization limit is reached.
    const w2 = await makeWorker(s, actor, other.id, { name: 'w2' });
    const c = await newTask(actor, other.id);
    await run(w2.worker, c.id);
    await s.tasks.ingestEvents(w2.worker, [agentExited(w2.worker, c.id, { costUsd: 6 })]);
    expect((await s.tasks.get(actor, c.id)).statusReason).toMatch(/Organization budget for this month reached/);
    expect(await BudgetAlert.countDocuments({ scope: 'organization', level: 'exceeded' })).toBe(1);
  });

  it('spend is counted per organization', async () => {
    const { actor, project, w1 } = await setup({ organizationMonthlyUsd: 10 });
    const t = await newTask(actor, project.id);
    await run(w1.worker, t.id);
    await s.tasks.ingestEvents(w1.worker, [agentExited(w1.worker, t.id, { costUsd: 3 })]);
    expect((await s.budgets.status({ ...actor, role: 'VIEWER' })).organization.spentUsd).toBe(3);
    const { actor: stranger } = await makeOwner(s);
    expect((await s.budgets.status(stranger)).organization).toMatchObject({ spentUsd: 0, limitUsd: null });
  });

  it('migration 0007 gives old usage records their project and tasks their totals', async () => {
    const { actor, project } = await setup();
    const t = await newTask(actor, project.id);
    await UsageRecord.create([
      { organizationId: actor.organizationId, taskId: t.id, kind: 'execution', costUsd: 1.25, inputTokens: 10, outputTokens: 5 },
      { organizationId: actor.organizationId, taskId: t.id, kind: 'execution', costUsd: 0.75, inputTokens: 1 },
    ]);
    const migration = MIGRATIONS.find((m) => m.id === '0007-usage-budgets')!;
    await migration.up(mongoose.connection.db!);
    await migration.up(mongoose.connection.db!); // safe to repeat
    expect((await Task.findById(t.id).lean())!.usage).toEqual({ costUsd: 2, inputTokens: 11, outputTokens: 5 });
    expect(await UsageRecord.countDocuments({ projectId: project.id })).toBe(2);
  });
});
