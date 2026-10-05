import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { Task, TaskEvent } from '@ao/database';
import type { Actor, Services, WorkerActor } from '@ao/server';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const AGENTS = ['claude-code', 'codex', 'aider'].map((id) => ({ id, name: id, installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: ['resume'] }));
const tr = (to: string, patch: Record<string, unknown> = {}) => ({ to: to as never, transitionId: randomUUID(), patch });

async function setup(workers = 2) {
  const { actor } = await makeOwner(s);
  await s.orgs.update(actor, { policy: { concurrency: { perProject: 4 } } });
  const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
  const ws: WorkerActor[] = [];
  const controls: Array<Record<string, unknown>> = [];
  for (let i = 0; i < workers; i++) {
    const w = (await makeWorker(s, actor, project.id, { name: `w${i}`, agents: AGENTS })).worker;
    s.live.registerWorker(w.workerId, (m) => controls.push({ ...(m as object), to: w.workerId }));
    ws.push(w);
  }
  return { actor, project, ws, controls };
}

const race = (actor: Actor, projectId: string, extra: Record<string, unknown> = {}) =>
  s.tasks.create(actor, { projectId, title: 'Fix the flaky checkout test', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], attempts: [{ agentId: 'claude-code' }, { agentId: 'codex', providerId: 'openai', modelId: 'gpt' }], ...extra });

async function start(worker: WorkerActor, taskId: string, agentId: string) {
  expect(await s.tasks.claim(worker, taskId)).toMatchObject({ claimed: true });
  await s.tasks.transition(worker, taskId, tr('PREPARING'));
  await s.tasks.transition(worker, taskId, tr('RUNNING', { agentId, providerId: 'mock', modelId: 'mock-1' }));
}
const pass = async (worker: WorkerActor, taskId: string) => {
  await s.tasks.transition(worker, taskId, tr('VERIFYING', { verificationStatus: 'RUNNING' }));
  return s.tasks.transition(worker, taskId, tr('COMPLETED', { verificationStatus: 'PASSED', completionReport: { summary: 'ok' } }));
};

describe('a task tried by several agents', () => {
  it('becomes one task per attempt, each pinned to its agent and model', async () => {
    const { actor, project } = await setup();
    const first = await race(actor, project.id);
    expect(first.attempt).toMatchObject({ index: 0, of: 2, agentId: 'claude-code', winnerTaskId: null });
    const { items } = await s.tasks.list(actor, { limit: 50, attemptGroupId: first.attempt!.groupId });
    const [a, b] = items.sort((x, y) => x.attempt!.index - y.attempt!.index);
    expect(items).toHaveLength(2);
    expect(a!.policy).toMatchObject({ agents: { allowed: ['claude-code'], preferred: ['claude-code'] } });
    expect(b!.policy).toMatchObject({ agents: { allowed: ['codex'] }, models: { preferred: [{ providerId: 'openai', modelId: 'gpt' }] } });
    expect(b!.title).toBe('Fix the flaky checkout test');
    expect((await s.tasks.list(actor, { limit: 50 })).items).toHaveLength(2);
  });

  it('is created once for one idempotency key', async () => {
    const { actor, project } = await setup();
    const one = await race(actor, project.id, { idempotencyKey: 'race-key-0001' });
    const again = await race(actor, project.id, { idempotencyKey: 'race-key-0001' });
    expect(again.id).toBe(one.id);
    expect(again.attempt!.groupId).toBe(one.attempt!.groupId);
    expect(await Task.countDocuments()).toBe(2);
  });

  it('refuses attempts that make no sense', async () => {
    const { actor, project } = await setup();
    await expect(race(actor, project.id, { kind: 'plan' })).rejects.toThrow(/change code/);
    await expect(race(actor, project.id, { attempts: [{ agentId: 'codex' }, { agentId: 'codex' }] })).rejects.toThrow(/different agent or model/);
    await expect(race(actor, project.id, { attempts: [{ agentId: 'codex' }, { agentId: 'aider', modelId: 'gpt' }] })).rejects.toThrow(/both a provider and a model/);
    expect(await Task.countDocuments()).toBe(0);
  });

  it('the first attempt to pass verification wins; the others are cancelled on their workers', async () => {
    const { actor, project, ws, controls } = await setup(3);
    const first = await race(actor, project.id, { attempts: [{ agentId: 'claude-code' }, { agentId: 'codex' }, { agentId: 'aider' }] });
    const ids = (await s.tasks.list(actor, { limit: 50, attemptGroupId: first.attempt!.groupId })).items.sort((x, y) => x.attempt!.index - y.attempt!.index).map((t) => t.id);
    await start(ws[0]!, ids[0]!, 'claude-code');
    await start(ws[1]!, ids[1]!, 'codex');
    // The third is still queued when the second passes.
    expect((await pass(ws[1]!, ids[1]!)).status).toBe('COMPLETED');

    const [a, b, c] = await Promise.all(ids.map((id) => s.tasks.get(actor, id)));
    expect(b).toMatchObject({ status: 'COMPLETED', attempt: { winnerTaskId: ids[1] } });
    expect(a).toMatchObject({ status: 'CANCELLED', statusReason: 'Another attempt passed verification first (codex)', attempt: { winnerTaskId: ids[1] } });
    expect(c).toMatchObject({ status: 'CANCELLED', attempt: { winnerTaskId: ids[1] } });
    expect(controls).toContainEqual({ type: 'task.control', taskId: ids[0], action: 'cancel', to: ws[0]!.workerId });
    expect(await TaskEvent.countDocuments({ type: 'TaskCancelled', 'payload.reason': 'attempt_lost' })).toBe(2);
    // The loser's worker can no longer move its task on.
    await expect(s.tasks.transition(ws[0]!, ids[0]!, tr('VERIFYING', { verificationStatus: 'RUNNING' }))).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect(await s.tasks.claim(ws[2]!, ids[2]!)).toMatchObject({ claimed: false });
  });

  it('a failed attempt does not end the others', async () => {
    const { actor, project, ws } = await setup();
    const first = await race(actor, project.id);
    const ids = (await s.tasks.list(actor, { limit: 50, attemptGroupId: first.attempt!.groupId })).items.sort((x, y) => x.attempt!.index - y.attempt!.index).map((t) => t.id);
    await start(ws[0]!, ids[0]!, 'claude-code');
    await start(ws[1]!, ids[1]!, 'codex');
    await s.tasks.transition(ws[0]!, ids[0]!, tr('FAILED'));
    expect((await s.tasks.get(actor, ids[1]!)).status).toBe('RUNNING');
    await pass(ws[1]!, ids[1]!);
    expect((await s.tasks.get(actor, ids[0]!))).toMatchObject({ status: 'FAILED', attempt: { winnerTaskId: ids[1] } });
  });

  it('a worker runs one attempt of a task at a time; the next waits or goes to another worker', async () => {
    const { actor, project, ws } = await setup();
    const first = await race(actor, project.id);
    const ids = (await s.tasks.list(actor, { limit: 50, attemptGroupId: first.attempt!.groupId })).items.sort((x, y) => x.attempt!.index - y.attempt!.index).map((t) => t.id);
    await start(ws[0]!, ids[0]!, 'claude-code');
    expect(await s.tasks.claim(ws[0]!, ids[1]!)).toEqual({ claimed: false, reason: 'Another attempt of this task runs on this worker' });
    // The scheduler offers it to the other worker, never to the busy one.
    expect(await s.scheduler.dispatch({ taskId: ids[1]!, organizationId: actor.organizationId })).toBe(ws[1]!.workerId);

    // An ordinary task is not held back by any of this.
    const plain = await s.tasks.create(actor, { projectId: project.id, title: 'x', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    expect(plain.attempt).toBeNull();
    expect(await s.tasks.claim(ws[0]!, plain.id)).toMatchObject({ claimed: true });
  });
});
