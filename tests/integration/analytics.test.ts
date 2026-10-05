import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { Task, mongoose } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

const NOW = new Date('2026-10-05T15:00:00Z');
const HOUR = 3_600_000;

/** A task as it is stored once finished (timestamps set directly: `createdAt` is otherwise "now"). */
async function finished(actor: Actor, projectId: string, f: { status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'RUNNING'; daysAgo: number; agentId?: string; modelId?: string; cost?: number; remediations?: number; activeMs?: number; leadMs?: number }) {
  const completedAt = new Date(NOW.getTime() - f.daysAgo * 24 * HOUR);
  await mongoose.connection.db!.collection('tasks').insertOne({
    organizationId: new mongoose.Types.ObjectId(actor.organizationId),
    projectId: new mongoose.Types.ObjectId(projectId),
    title: 't',
    originalPrompt: 'p',
    status: f.status,
    agentId: f.agentId ?? 'claude-code',
    providerId: 'anthropic',
    modelId: f.modelId ?? 'haiku',
    remediationCount: f.remediations ?? 0,
    activeMs: f.activeMs ?? 0,
    usage: { costUsd: f.cost ?? 0, inputTokens: 0, outputTokens: 0 },
    createdBy: new mongoose.Types.ObjectId(actor.userId),
    correlationId: 'c',
    createdAt: new Date(completedAt.getTime() - (f.leadMs ?? HOUR)),
    completedAt: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(f.status) ? completedAt : null,
  });
}

describe('analytics', () => {
  it('reports success, first-pass, cost and time, in total, per day and by agent, model and project', async () => {
    const { actor } = await makeOwner(s);
    const shop = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const blog = await s.projects.create(actor, { name: 'blog', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, cost: 1, activeMs: 60_000, leadMs: 2 * HOUR });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 0, cost: 3, remediations: 2, activeMs: 180_000, leadMs: 4 * HOUR });
    await finished(actor, shop.id, { status: 'FAILED', daysAgo: 1, cost: 2, remediations: 3 });
    await finished(actor, blog.id, { status: 'COMPLETED', daysAgo: 2, agentId: 'codex', modelId: 'gpt', cost: 0.5, activeMs: 30_000, leadMs: HOUR });
    // Not counted: cancelled, still running, and finished before the period.
    await finished(actor, shop.id, { status: 'CANCELLED', daysAgo: 0, cost: 50 });
    await finished(actor, shop.id, { status: 'RUNNING', daysAgo: 0, cost: 50 });
    await finished(actor, shop.id, { status: 'COMPLETED', daysAgo: 9, cost: 50 });

    const a = await s.queries.analytics(actor, { days: 7 }, NOW);
    expect(a.since).toBe('2026-09-29T00:00:00.000Z');
    expect(a.totals).toMatchObject({ finished: 4, completed: 3, failed: 1, successRate: 0.75, costUsd: 6.5, avgRemediations: 1.25, avgActiveMs: 90_000 });
    expect(a.totals.firstPassRate).toBeCloseTo(2 / 3);
    expect(a.totals.costPerCompletedUsd).toBeCloseTo(6.5 / 3);
    expect(a.totals.avgLeadMs).toBeCloseTo((7 * HOUR) / 3);
    expect(a.totals.created).toBe(6); // every task created in the period, whatever became of it

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

    const onlyBlog = await s.queries.analytics(actor, { days: 7, projectId: blog.id }, NOW);
    expect(onlyBlog.totals).toMatchObject({ finished: 1, successRate: 1, firstPassRate: 1 });
  });

  it('an organization without finished tasks gets zeros and no rates, and never another organization\'s figures', async () => {
    const { actor } = await makeOwner(s);
    const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    await finished(actor, project.id, { status: 'COMPLETED', daysAgo: 0, cost: 9 });
    const { actor: stranger } = await makeOwner(s);
    const a = await s.queries.analytics(stranger, { days: 30 }, NOW);
    expect(a.totals).toMatchObject({ finished: 0, created: 0, successRate: null, firstPassRate: null, costPerCompletedUsd: null, avgActiveMs: null, costUsd: 0 });
    expect(a.daily).toHaveLength(30);
    expect(a.byAgent).toEqual([]);
    await expect(s.queries.analytics(stranger, { days: 30, projectId: project.id }, NOW)).resolves.toMatchObject({ totals: { finished: 0 } });
    expect(await Task.countDocuments()).toBe(1);
  });
});
