import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { AuditLog, Membership, Schedule, Task } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

async function setup() {
  const { actor } = await makeOwner(s);
  const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
  return { actor, project };
}

const at = (iso: string) => new Date(iso);
const body = (projectId: string, extra: Record<string, unknown> = {}) => ({
  name: 'Nightly dependencies',
  projectId,
  cron: '0 2 * * *',
  timeZone: 'UTC',
  enabled: true,
  overlap: 'skip' as const,
  task: { title: 'Update dependencies {date}', prompt: 'Update the dependencies. Today is {date}.', priority: 'LOW' as const, requirements: {}, capabilityIds: [] },
  ...extra,
});

describe('scheduled tasks', () => {
  it('creates one task per run, on behalf of its creator, with the date filled in', async () => {
    const { actor, project } = await setup();
    const sched = await s.schedules.create(actor, body(project.id), at('2026-10-05T10:00:00Z'));
    expect(sched.nextRunAt).toBe('2026-10-06T02:00:00.000Z');

    expect(await s.schedules.runDue(at('2026-10-06T01:59:59Z'))).toBe(0);
    // Two server instances sweep at the same moment: one task.
    const runs = await Promise.all([s.schedules.runDue(at('2026-10-06T02:00:05Z')), s.schedules.runDue(at('2026-10-06T02:00:05Z'))]);
    expect(runs.reduce((a, b) => a + b, 0)).toBe(1);
    const tasks = await Task.find({}).lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'Update dependencies 2026-10-06', originalPrompt: 'Update the dependencies. Today is 2026-10-06.', priority: 'LOW', status: 'QUEUED' });
    expect(String(tasks[0]!.createdBy)).toBe(actor.userId);
    expect(tasks[0]!.source).toMatchObject({ kind: 'schedule', scheduleId: sched.id, name: 'Nightly dependencies' });

    const [after] = await s.schedules.list(actor);
    expect(after).toMatchObject({ nextRunAt: '2026-10-07T02:00:00.000Z', lastResult: 'created', lastTaskId: String(tasks[0]!._id), runCount: 1 });
    expect(await s.schedules.runDue(at('2026-10-06T02:00:30Z'))).toBe(0);
  });

  it('skips a run while the previous task is unfinished, unless overlap is allowed', async () => {
    const { actor, project } = await setup();
    const sched = await s.schedules.create(actor, body(project.id), at('2026-10-05T10:00:00Z'));
    await s.schedules.runDue(at('2026-10-06T02:00:00Z'));
    expect(await s.schedules.runDue(at('2026-10-07T02:00:00Z'))).toBe(0);
    expect((await s.schedules.list(actor))[0]).toMatchObject({ lastResult: 'skipped: the task of the previous run is not finished', runCount: 1, nextRunAt: '2026-10-08T02:00:00.000Z' });

    const first = (await Task.findOne({}).lean())!;
    await s.tasks.action(actor, String(first._id), { action: 'cancel' });
    expect(await s.schedules.runDue(at('2026-10-08T02:00:00Z'))).toBe(1);

    await s.schedules.update(actor, sched.id, { overlap: 'allow' }, at('2026-10-08T03:00:00Z'));
    expect(await s.schedules.runDue(at('2026-10-09T02:00:00Z'))).toBe(1);
    expect(await Task.countDocuments()).toBe(3);
  });

  it('a run missed while the server was down runs once, in the zone of the schedule', async () => {
    const { actor, project } = await setup();
    await s.schedules.create(actor, body(project.id, { cron: '30 9 * * mon-fri', timeZone: 'Asia/Kolkata', overlap: 'allow' }), at('2026-10-05T00:00:00Z'));
    expect((await s.schedules.list(actor))[0]!.nextRunAt).toBe('2026-10-05T04:00:00.000Z');
    // Back after three days.
    expect(await s.schedules.runDue(at('2026-10-08T12:00:00Z'))).toBe(1);
    expect((await s.schedules.list(actor))[0]!.nextRunAt).toBe('2026-10-09T04:00:00.000Z');
    expect(await Task.countDocuments()).toBe(1);
  });

  it('validates the expression, time zone, frequency and project', async () => {
    const { actor, project } = await setup();
    await expect(s.schedules.create(actor, body(project.id, { cron: 'every night' }))).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(s.schedules.create(actor, body(project.id, { cron: '* * * * *' }))).rejects.toThrow(/every 5 minutes/);
    await expect(s.schedules.create(actor, body(project.id, { timeZone: 'Mars/Olympus' }))).rejects.toThrow(/time zone/);
    await expect(s.schedules.create(actor, body(randomUUID().replace(/-/g, '').slice(0, 24)))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await s.schedules.create(actor, body(project.id));
    await expect(s.schedules.create(actor, body(project.id))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await Schedule.countDocuments()).toBe(1);
  });

  it('roles, tenants, disabling, run now and deletion', async () => {
    const { actor, project } = await setup();
    const developer: Actor = { ...actor, role: 'DEVELOPER' };
    await expect(s.schedules.create(developer, body(project.id))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const sched = await s.schedules.create(actor, body(project.id), at('2026-10-05T10:00:00Z'));
    expect(await s.schedules.list(developer)).toHaveLength(1);

    const { actor: stranger } = await makeOwner(s);
    expect(await s.schedules.list(stranger)).toHaveLength(0);
    await expect(s.schedules.runNow(stranger, sched.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.schedules.remove(stranger, sched.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Run now: as the caller, without moving the next run.
    const task = await s.schedules.runNow(developer, sched.id, at('2026-10-05T11:00:00Z'));
    expect(task.title).toBe('Update dependencies 2026-10-05');
    expect((await s.schedules.list(actor))[0]).toMatchObject({ nextRunAt: '2026-10-06T02:00:00.000Z', runCount: 1 });

    const off = await s.schedules.update(actor, sched.id, { enabled: false });
    expect(off.nextRunAt).toBeNull();
    expect(await s.schedules.runDue(at('2027-01-01T00:00:00Z'))).toBe(0);
    const on = await s.schedules.update(actor, sched.id, { enabled: true, cron: '@weekly' }, at('2026-10-05T10:00:00Z'));
    expect(on.nextRunAt).toBe('2026-10-11T00:00:00.000Z');

    await s.schedules.remove(actor, sched.id);
    expect(await s.schedules.list(actor)).toHaveLength(0);
    expect(await AuditLog.distinct('action', { action: /^schedule\./ })).toEqual(['schedule.create', 'schedule.delete', 'schedule.run', 'schedule.update']);
  });

  it('stops when its creator left the organization or may no longer create tasks', async () => {
    const { actor, project } = await setup();
    await s.schedules.create(actor, body(project.id, { overlap: 'allow' }), at('2026-10-05T10:00:00Z'));
    await Membership.updateOne({ userId: actor.userId, organizationId: actor.organizationId }, { role: 'VIEWER' });
    expect(await s.schedules.runDue(at('2026-10-06T02:00:00Z'))).toBe(0);
    expect((await s.schedules.list(actor))[0]).toMatchObject({ enabled: true, lastResult: expect.stringMatching(/^failed: .*task\.create/) });

    await Membership.deleteOne({ userId: actor.userId, organizationId: actor.organizationId });
    expect(await s.schedules.runDue(at('2026-10-07T02:00:00Z'))).toBe(0);
    expect((await s.schedules.list(actor))[0]).toMatchObject({ enabled: false, nextRunAt: null, lastResult: expect.stringMatching(/left the organization/) });
    expect(await Task.countDocuments()).toBe(0);
  });

  it('the scheduler sweep runs due schedules, and a scheduled task is dispatched like any other', async () => {
    const { actor, project } = await setup();
    const w = await makeWorker(s, actor, project.id);
    const sched = await s.schedules.create(actor, body(project.id));
    await Schedule.updateOne({ _id: sched.id }, { nextRunAt: new Date(Date.now() - 1000) });
    await s.scheduler.sweep();
    const task = (await Task.findOne({}).lean())!;
    expect(task.source).toMatchObject({ scheduleId: sched.id });
    expect((await s.tasks.claim(w.worker, String(task._id))).claimed).toBe(true);
  });
});
