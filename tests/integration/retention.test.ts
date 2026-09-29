import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, Organization, Task, TaskEvent, mongoose } from '@ao/database';
import { purgeExpiredData, type Services } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);

describe('data retention (spec §126)', () => {
  it('purges expired output, events and audit, but never data of active tasks', async () => {
    const { actor } = await makeOwner(s);
    const org = new mongoose.Types.ObjectId(actor.organizationId);
    await Organization.updateOne({ _id: org }, { 'settings.retentionDays': { events: 10, agentOutput: 2, audit: 30 } });
    const project = await s.projects.create(actor, { name: 'r', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const base = { projectId: project.id, prompt: 'p', priority: 'NORMAL' as const, dependencies: [], requirements: {}, capabilityIds: [] };
    const done = await s.tasks.create(actor, { ...base, title: 'done' });
    const active = await s.tasks.create(actor, { ...base, title: 'active' });
    await Task.updateOne({ _id: done.id }, { status: 'COMPLETED' });
    const old = (days: number) => new Date(Date.now() - days * 86_400_000);
    const ev = (taskId: string, type: string, ephemeral: boolean, days: number) =>
      ({ organizationId: org, taskId: new mongoose.Types.ObjectId(taskId), eventId: randomUUID(), type, timestamp: old(days), ephemeral, payload: {} });
    await TaskEvent.insertMany([
      ev(done.id, 'AgentOutput', true, 5), // expired output → purge
      ev(done.id, 'AgentOutput', true, 1), // recent output → keep
      ev(done.id, 'CheckpointCreated', false, 20), // expired event → purge
      ev(done.id, 'CheckpointCreated', false, 5), // recent → keep
      ev(active.id, 'AgentOutput', true, 50), // active task → keep
      ev(active.id, 'CheckpointCreated', false, 50), // active task → keep
    ]);
    await AuditLog.collection.insertMany([
      { organizationId: org, actorType: 'system', action: 'old', createdAt: old(40), metadata: {} },
      { organizationId: org, actorType: 'system', action: 'recent', createdAt: old(1), metadata: {} },
    ]);
    const r = await purgeExpiredData();
    expect(r).toMatchObject({ outputEvents: 1, events: 1, audit: 1 });
    expect(await TaskEvent.countDocuments({ taskId: active.id })).toBeGreaterThanOrEqual(2);
    expect(await AuditLog.countDocuments({ organizationId: org, action: 'recent' })).toBe(1);
    // Audit immutability for ordinary workflows is unchanged.
    await expect(AuditLog.deleteMany({ organizationId: org })).rejects.toThrow(/immutable/);
  });
});
