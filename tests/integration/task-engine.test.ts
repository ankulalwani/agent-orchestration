import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { AuditLog, ConcurrencySlot, Project, Task, TaskEvent } from '@ao/database';
import type { Services } from '@ao/server';
import { expireLease, makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

async function setup() {
  const { actor } = await makeOwner(s);
  const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: 'Use pnpm' });
  const w1 = await makeWorker(s, actor, project.id, { name: 'w1' });
  return { actor, project, w1 };
}

const tr = (to: string, patch: Record<string, unknown> = {}, reason?: string) => ({ to: to as never, transitionId: randomUUID(), patch, reason });

describe('task lifecycle (spec §89 flow)', () => {
  it('create → claim → run → verify → complete, with events and git/report', async () => {
    const { actor, project, w1 } = await setup();
    const task = await s.tasks.create(actor, { projectId: project.id, title: 'Add Razorpay', prompt: 'Add Razorpay support', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    expect(task.status).toBe('QUEUED');
    expect(task.originalPrompt).toBe('Add Razorpay support');

    const claim = await s.tasks.claim(w1.worker, task.id);
    expect(claim.claimed).toBe(true);
    expect(claim.localPath).toBe('/tmp/project');
    expect(claim.knowledge).toEqual(['### Project\n\nUse pnpm']);

    await s.tasks.transition(w1.worker, task.id, tr('PREPARING'));
    await s.tasks.transition(w1.worker, task.id, tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1', sessionId: 's1' }));
    await s.tasks.transition(w1.worker, task.id, tr('VERIFYING', { verificationStatus: 'RUNNING' }));

    // Verification gate: cannot complete without passing verification.
    await expect(s.tasks.transition(w1.worker, task.id, tr('COMPLETED', { completionReport: { summary: 'x' } }))).rejects.toThrow(/verification/);
    const done = await s.tasks.transition(w1.worker, task.id, tr('COMPLETED', {
      verificationStatus: 'PASSED',
      gitStatus: 'COMMITTED',
      gitResult: { policy: 'COMMIT', branch: 'ao/x', commit: 'abc123', pushed: false, filesChanged: [], blocked: [] },
      completionReport: { summary: 'Added Razorpay' },
      activeMsDelta: 1234,
    }));
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).not.toBeNull();
    expect(done.gitResult?.commit).toBe('abc123');
    expect(done.activeMs).toBe(1234);
    expect(done.leaseExpiresAt).toBeNull();

    const events = await s.tasks.events(actor, task.id, { limit: 100 });
    const types = events.items.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['TaskCreated', 'TaskClaimed', 'TaskStatusChanged', 'TaskCompleted']));
    // Project slot released.
    expect((await Project.findById(project.id).lean())!.activeTaskIds).toHaveLength(0);
  });

  it('rejects undeclared transitions', async () => {
    const { actor, project, w1 } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w1.worker, t.id);
    await expect(s.tasks.transition(w1.worker, t.id, tr('VERIFYING'))).rejects.toThrow(/cannot move/);
  });

  it('transitions are idempotent by transitionId', async () => {
    const { actor, project, w1 } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w1.worker, t.id);
    const req = tr('PREPARING', { incRestart: true });
    await s.tasks.transition(w1.worker, t.id, req);
    const again = await s.tasks.transition(w1.worker, t.id, req);
    expect(again.status).toBe('PREPARING');
    expect(again.restartCount).toBe(1);
  });

  it('task creation is idempotent by idempotencyKey', async () => {
    const { actor, project } = await setup();
    const input = { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL' as const, dependencies: [], requirements: {}, capabilityIds: [], idempotencyKey: 'key-12345678' };
    const [a, b] = await Promise.all([s.tasks.create(actor, input), s.tasks.create(actor, input)]);
    expect(a.id).toBe(b.id);
    expect(await Task.countDocuments()).toBe(1);
  });
});

describe('knowledge (spec §77)', () => {
  it('organization, project and task knowledge reach the worker in that order, also after a worker restart', async () => {
    const { actor, project, w1 } = await setup();
    const viewer = { ...actor, role: 'VIEWER' as const };
    await expect(s.orgs.update(viewer, { knowledge: 'nope' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await s.orgs.update(actor, { knowledge: '  Deploys go through the release train.  ' })).knowledge).toContain('release train');

    const task = await s.tasks.create(actor, { projectId: project.id, title: 'T', prompt: 'Do it', knowledge: 'Ticket: PAY-42. Keep the old API working.', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    expect(task.knowledge).toBe('Ticket: PAY-42. Keep the old API working.');
    const claim = await s.tasks.claim(w1.worker, task.id);
    const expected = ['### Organization\n\nDeploys go through the release train.', '### Project\n\nUse pnpm', '### This task\n\nTicket: PAY-42. Keep the old API working.'];
    expect(claim.knowledge).toEqual(expected);
    expect((await s.tasks.ownedTaskInfo(w1.worker, task.id)).knowledge).toEqual(expected);

    // Empty levels are left out.
    await s.orgs.update(actor, { knowledge: '' });
    const plain = await s.tasks.create(actor, { projectId: project.id, title: 'T2', prompt: 'Do it', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await Project.updateOne({ _id: project.id }, { $set: { activeTaskIds: [] } });
    expect((await s.tasks.claim(w1.worker, plain.id)).knowledge).toEqual(['### Project\n\nUse pnpm']);
  });
});

describe('plans (FUT-001)', () => {
  it('applying a completed plan creates its tasks once, in dependency order, linked to the plan', async () => {
    const { actor, project, w1 } = await setup();
    const planTask = await s.tasks.create(actor, { projectId: project.id, title: 'Orders', prompt: 'Build orders', kind: 'plan', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await expect(s.tasks.applyPlan(actor, planTask.id)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // not completed yet
    await s.tasks.claim(w1.worker, planTask.id);
    for (const [to, patch] of [['PREPARING', {}], ['RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' }], ['VERIFYING', { verificationStatus: 'RUNNING' }]] as const) await s.tasks.transition(w1.worker, planTask.id, tr(to, patch));
    const plan = {
      summary: 'Three steps.',
      tasks: [
        { key: 'ui', title: 'Orders page', prompt: 'Page', dependsOn: ['api'], priority: 'NORMAL' },
        { key: 'schema', title: 'Orders table', prompt: 'Table', dependsOn: [], priority: 'NORMAL' },
        { key: 'api', title: 'Orders API', prompt: 'API', dependsOn: ['schema'], priority: 'HIGH' },
      ],
    };
    await s.tasks.transition(w1.worker, planTask.id, tr('COMPLETED', { verificationStatus: 'PASSED', completionReport: { summary: 'Three steps.', plan } }));

    // Until someone creates its tasks, the plan is listed under "needs attention".
    const attention = async () => (await s.queries.overview(actor)).needsAttention.filter((x) => x.taskId === planTask.id);
    expect(await attention()).toEqual([expect.objectContaining({ status: 'COMPLETED', reason: 'Plan ready: review it and create its 3 tasks' })]);
    const viewer = { ...actor, role: 'VIEWER' as const };
    await expect(s.tasks.applyPlan(viewer, planTask.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Applying twice at once still creates each task once.
    const [a, b] = await Promise.all([s.tasks.applyPlan(actor, planTask.id), s.tasks.applyPlan(actor, planTask.id)]);
    expect(a.taskIds).toEqual(b.taskIds);
    expect(await Task.countDocuments({ parentTaskId: planTask.id })).toBe(3);
    const [ui, schema, api] = await Promise.all(a.taskIds.map((id) => s.tasks.get(actor, id)));
    expect([ui!.title, schema!.title, api!.title]).toEqual(['Orders page', 'Orders table', 'Orders API']);
    expect(schema!.dependencies).toEqual([]);
    expect(api!.dependencies).toEqual([schema!.id]);
    expect(ui!.dependencies).toEqual([api!.id]);
    expect(api!.priority).toBe('HIGH');
    expect(ui!.parentTaskId).toBe(planTask.id);
    expect(ui!.knowledge).toContain('part of the plan "Orders"');
    // Tasks waiting for their dependencies stay queued but can't be claimed yet.
    expect(await s.tasks.claim(w1.worker, ui!.id)).toMatchObject({ claimed: false, reason: 'Dependencies not complete' });
    const applied = await s.tasks.get(actor, planTask.id);
    expect(applied.planApplied).toMatchObject({ by: actor.userId, taskIds: a.taskIds });
    expect((await s.tasks.applyPlan(actor, planTask.id)).taskIds).toEqual(a.taskIds);
    expect(await attention()).toEqual([]);
  });
});

describe('atomic claiming & concurrency (spec §23, §46)', () => {
  it('exactly one of many concurrent claimants wins', async () => {
    const { actor, project } = await setup();
    const workers = await Promise.all(Array.from({ length: 5 }, (_, i) => makeWorker(s, actor, project.id, { name: `c${i}` })));
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const results = await Promise.all(workers.map((w) => s.tasks.claim(w.worker, t.id)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
  });

  it('defaults to one active task per project; different projects run concurrently', async () => {
    const { actor, project, w1 } = await setup();
    const a = await s.tasks.create(actor, { projectId: project.id, title: 'a', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const b = await s.tasks.create(actor, { projectId: project.id, title: 'b', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const w2 = await makeWorker(s, actor, project.id, { name: 'w2' });
    const [ra, rb] = await Promise.all([s.tasks.claim(w1.worker, a.id), s.tasks.claim(w2.worker, b.id)]);
    expect([ra.claimed, rb.claimed].filter(Boolean)).toHaveLength(1);

    const other = await s.projects.create(actor, { name: 'other', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    await makeWorker(s, actor, other.id, { name: 'w3' }); // re-maps nothing on w1
    const c = await s.tasks.create(actor, { projectId: other.id, title: 'c', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const w3 = await makeWorker(s, actor, other.id, { name: 'w4' });
    expect((await s.tasks.claim(w3.worker, c.id)).claimed).toBe(true);
  });

  it('a worker without the project cannot claim', async () => {
    const { actor, project } = await setup();
    const other = await s.projects.create(actor, { name: 'o', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const wOther = await makeWorker(s, actor, other.id, { name: 'wo' });
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    expect(await s.tasks.claim(wOther.worker, t.id)).toMatchObject({ claimed: false });
  });
});

describe('organization, agent and provider slots (spec §19, §46)', () => {
  const newTask = (actor: Awaited<ReturnType<typeof setup>>['actor'], projectId: string, title: string) =>
    s.tasks.create(actor, { projectId, title, prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
  const run = (agentId: string, providerId = 'mock') => tr('RUNNING', { agentId, providerId, modelId: 'mock-1', sessionId: randomUUID() });

  it('the organization limit is atomic across projects and freed when a task ends', async () => {
    const { actor } = await setup();
    const policy = { concurrency: { perOrganization: 1 } };
    const pa = await s.projects.create(actor, { name: 'a', description: '', defaultBranch: 'main', environments: [], knowledge: '', policy });
    const pb = await s.projects.create(actor, { name: 'b', description: '', defaultBranch: 'main', environments: [], knowledge: '', policy });
    const [wa, wb] = [await makeWorker(s, actor, pa.id, { name: 'wa' }), await makeWorker(s, actor, pb.id, { name: 'wb' })];
    const [ta, tb] = [await newTask(actor, pa.id, 'a'), await newTask(actor, pb.id, 'b')];
    const results = await Promise.all([s.tasks.claim(wa.worker, ta.id), s.tasks.claim(wb.worker, tb.id)]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const [winner, loser] = results[0]!.claimed ? [{ w: wa, t: ta }, { w: wb, t: tb }] : [{ w: wb, t: tb }, { w: wa, t: ta }];
    expect(await s.tasks.claim(loser.w.worker, loser.t.id)).toMatchObject({ claimed: false, reason: 'Organization concurrency limit reached' });
    // The losing claim must not leave a project slot behind.
    expect((await Project.findById(loser.t.projectId).lean())!.activeTaskIds).toHaveLength(0);

    await s.tasks.action(actor, winner.t.id, { action: 'cancel' });
    expect((await s.tasks.claim(loser.w.worker, loser.t.id)).claimed).toBe(true);
  });

  it('per-agent limit: a second task cannot start on a saturated agent, may use another, and gets the slot when freed', async () => {
    const { actor } = await setup();
    const project = await s.projects.create(actor, { name: 'p', description: '', defaultBranch: 'main', environments: [], knowledge: '', policy: { concurrency: { perProject: 5, perAgent: { mock: 1 } } } });
    const w = await makeWorker(s, actor, project.id);
    const [a, b] = [await newTask(actor, project.id, 'a'), await newTask(actor, project.id, 'b')];
    for (const t of [a, b]) {
      await s.tasks.claim(w.worker, t.id);
      await s.tasks.transition(w.worker, t.id, tr('PREPARING'));
    }
    await s.tasks.transition(w.worker, a.id, run('mock'));
    await expect(s.tasks.transition(w.worker, b.id, run('mock'))).rejects.toMatchObject({ code: 'CONCURRENCY_LIMIT', context: { scope: 'agent', key: 'mock', limit: 1 } });
    expect((await s.tasks.get(actor, b.id)).status).toBe('PREPARING'); // rejected transition changed nothing

    // Another agent is not limited.
    await s.tasks.transition(w.worker, b.id, run('other'));
    // Freeing A's slot lets B switch to the limited agent; B's old agent slot is released.
    await s.tasks.action(actor, a.id, { action: 'cancel' });
    await s.tasks.transition(w.worker, b.id, run('mock'));
    const slots = await ConcurrencySlot.find({ scope: 'agent' }).lean();
    expect(slots.map((x) => [x.key, x.taskIds.map(String)])).toEqual([['mock', [b.id]]]);
  });

  it('per-provider limit: concurrent starts on one provider admit exactly the limit', async () => {
    const { actor } = await setup();
    const project = await s.projects.create(actor, { name: 'p', description: '', defaultBranch: 'main', environments: [], knowledge: '', policy: { concurrency: { perProject: 10, perProvider: { mock: 2 } } } });
    const w = await makeWorker(s, actor, project.id);
    const tasks = await Promise.all(Array.from({ length: 5 }, (_, i) => newTask(actor, project.id, `t${i}`)));
    for (const t of tasks) {
      await s.tasks.claim(w.worker, t.id);
      await s.tasks.transition(w.worker, t.id, tr('PREPARING'));
    }
    const results = await Promise.allSettled(tasks.map((t) => s.tasks.transition(w.worker, t.id, run('mock'))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'CONCURRENCY_LIMIT')).toBe(true);
  });

  it('reconcile drops slot holders that no longer hold a lease', async () => {
    const { actor } = await setup();
    const project = await s.projects.create(actor, { name: 'p', description: '', defaultBranch: 'main', environments: [], knowledge: '', policy: { concurrency: { perAgent: { mock: 1 }, perOrganization: 3 } } });
    const w = await makeWorker(s, actor, project.id);
    const t = await newTask(actor, project.id, 't');
    await s.tasks.claim(w.worker, t.id);
    await s.tasks.transition(w.worker, t.id, tr('PREPARING'));
    await s.tasks.transition(w.worker, t.id, run('mock'));
    // Simulate an API crash between the status write and the slot release.
    await Task.updateOne({ _id: t.id }, { status: 'FAILED' });
    await s.tasks.reconcile();
    const slots = await ConcurrencySlot.find().lean();
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every((x) => x.taskIds.length === 0)).toBe(true);
  });
});

describe('leases & worker failure (spec §23, §90)', () => {
  it('expired lease requeues from checkpoint and fences the old worker', async () => {
    const { actor, project, w1 } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w1.worker, t.id);
    await s.tasks.transition(w1.worker, t.id, tr('PREPARING'));
    await s.tasks.transition(w1.worker, t.id, tr('RUNNING', { lastCheckpoint: { taskId: t.id, phase: 'impl', completedSteps: ['a'], remainingSteps: ['b'], changedFiles: [], testsRun: [], knownIssues: [], nextAction: 'b', createdAt: new Date().toISOString() } }));
    await expireLease(t.id);
    expect(await s.tasks.sweepExpiredLeases()).toBe(1);
    const after = await s.tasks.get(actor, t.id);
    expect(after.status).toBe('QUEUED');
    expect(after.workerId).toBeNull();
    expect(after.restartCount).toBe(1);
    expect(after.lastCheckpoint?.nextAction).toBe('b'); // progress preserved
    // Zombie worker comes back: fenced.
    await expect(s.tasks.transition(w1.worker, t.id, tr('VERIFYING'))).rejects.toMatchObject({ code: 'LEASE_LOST' });
    // Another worker can pick it up.
    const w2 = await makeWorker(s, actor, project.id, { name: 'w2' });
    expect((await s.tasks.claim(w2.worker, t.id)).claimed).toBe(true);
  });

  it('heartbeat renews leases and reports revoked tasks', async () => {
    const { actor, project, w1 } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w1.worker, t.id);
    await expireLease(t.id);
    const ack = await s.workers.heartbeat(w1.worker, { metrics: {}, activeTasks: [{ taskId: t.id, status: 'CLAIMING' }], sentAt: new Date().toISOString() });
    expect(ack.leasesRenewedUntil).not.toBeNull();
    expect(await s.tasks.sweepExpiredLeases()).toBe(0);
    await s.tasks.action(actor, t.id, { action: 'cancel' });
    const ack2 = await s.workers.heartbeat(w1.worker, { metrics: {}, activeTasks: [{ taskId: t.id, status: 'CLAIMING' }], sentAt: new Date().toISOString() });
    expect(ack2.revokedTaskIds).toEqual([t.id]);
  });

  it('repeated worker loss ends in RECOVERY_REQUIRED instead of endless retries', async () => {
    const { actor, project, w1 } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], policy: { maxRestarts: 1 } });
    await s.tasks.claim(w1.worker, t.id);
    await expireLease(t.id);
    await s.tasks.sweepExpiredLeases();
    await s.tasks.claim(w1.worker, t.id);
    await expireLease(t.id);
    await s.tasks.sweepExpiredLeases();
    expect((await s.tasks.get(actor, t.id)).status).toBe('RECOVERY_REQUIRED');
  });

  it('marks silent workers offline', async () => {
    const { w1 } = await setup();
    const { Worker } = await import('@ao/database');
    await Worker.updateOne({ _id: w1.worker.workerId }, { lastHeartbeatAt: new Date(Date.now() - 120_000) });
    expect(await s.workers.sweepOffline()).toBe(1);
    expect((await Worker.findById(w1.worker.workerId).lean())!.status).toBe('OFFLINE');
  });
});

describe('dependencies (spec §24)', () => {
  it('blocks until dependencies complete, flags failed dependencies', async () => {
    const { actor, project, w1 } = await setup();
    const base = { projectId: project.id, prompt: 'p', priority: 'NORMAL' as const, requirements: {}, capabilityIds: [] };
    const a = await s.tasks.create(actor, { ...base, title: 'A', dependencies: [] });
    const b = await s.tasks.create(actor, { ...base, title: 'B', dependencies: [a.id] });
    expect(await s.tasks.claim(w1.worker, b.id)).toMatchObject({ claimed: false, reason: 'Dependencies not complete' });
    await expect(s.tasks.create(actor, { ...base, title: 'X', dependencies: ['0123456789abcdef01234567'] })).rejects.toThrow(/do not exist/);

    await s.tasks.claim(w1.worker, a.id);
    await s.tasks.transition(w1.worker, a.id, tr('PREPARING'));
    await s.tasks.transition(w1.worker, a.id, tr('FAILED', {}, 'boom'));
    expect((await Task.findById(b.id).lean())!.blockedReason).toMatch(/failed/);
    await s.tasks.action(actor, a.id, { action: 'retry' });
    expect((await Task.findById(b.id).lean())!.status).toBe('QUEUED');
  });
});

describe('tenant isolation & RBAC (spec §18, §57)', () => {
  it('users cannot see or act on other organizations’ tasks', async () => {
    const { actor, project } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const { actor: other } = await makeOwner(s, 'intruder');
    await expect(s.tasks.get(other, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.tasks.action(other, t.id, { action: 'cancel' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.tasks.create(other, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.orgs.resolveActor(other.userId, actor.organizationId, 'c')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Worker from another org cannot claim
    const otherProject = await s.projects.create(other, { name: 'x', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const foreign = await makeWorker(s, other, otherProject.id);
    await expect(s.tasks.claim(foreign.worker, t.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('viewers cannot create or control tasks', async () => {
    const { actor, project } = await setup();
    const viewer = { ...actor, role: 'VIEWER' as const };
    await expect(s.tasks.create(viewer, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await s.tasks.list(viewer, { limit: 10 })).items).toEqual([]);
  });

  it('writes audit entries', async () => {
    const { actor, project } = await setup();
    await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    expect(await AuditLog.countDocuments({ action: 'task.create' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'worker.pair' })).toBe(1);
  });
});

describe('event ingestion (spec §107)', () => {
  it('deduplicates replayed events and rejects foreign tasks', async () => {
    const { actor, project, w1 } = await setup();
    const t = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const ev = (seq: number) => ({ eventId: randomUUID(), workerId: w1.worker.workerId, taskId: t.id, timestamp: new Date().toISOString(), sequence: seq, type: 'AgentOutput' as const, payload: { line: `sk-ant-api03-SECRETSECRETSECRET ${seq}` } });
    const batch = [ev(1), ev(2), ev(3)];
    expect(await s.tasks.ingestEvents(w1.worker, batch)).toMatchObject({ accepted: 3, duplicates: 0, highestSequence: 3 });
    expect(await s.tasks.ingestEvents(w1.worker, [...batch, ev(4)])).toMatchObject({ accepted: 1, duplicates: 3 });
    const stored = await TaskEvent.find({ type: 'AgentOutput' }).lean();
    expect(stored).toHaveLength(4);
    expect(JSON.stringify(stored)).not.toContain('SECRETSECRET');
  });
});

describe('auth (spec §56)', () => {
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const { auth } = await makeOwner(s);
    const r1 = await s.auth.refresh(auth.refreshToken);
    await expect(s.auth.refresh(auth.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(s.auth.refresh(r1.refreshToken)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); // family revoked
  });

  it('locks out after repeated failures and supports password reset', async () => {
    const { auth } = await makeOwner(s);
    await expect(s.auth.login(auth.user.email, 'wrong-password')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const { token } = await s.auth.requestPasswordReset(auth.user.email);
    await s.auth.confirmPasswordReset(token!, 'a-brand-new-password');
    await expect(s.auth.confirmPasswordReset(token!, 'another-password1')).rejects.toThrow(/invalid or has expired/);
    expect((await s.auth.login(auth.user.email, 'a-brand-new-password')).user.email).toBe(auth.user.email);
  });

  it('verifies access tokens', async () => {
    const { auth } = await makeOwner(s);
    expect((await s.auth.verifyAccess(auth.accessToken)).sub).toBe(auth.user.id);
    await expect(s.auth.verifyAccess(auth.accessToken + 'x')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
