/**
 * The weekly analytics digest: when it is due, what it says, and that it is sent once. A local server
 * plays the chat service's incoming webhook; emails go to the test mailer.
 */
import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { Organization, mongoose } from '@ao/database';
import { digestDueAt, type Actor, type Services } from '@ao/server';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;
let sent: Array<{ to: string; subject: string; text: string }>;
let fake: http.Server;
let fakeUrl = '';
const posted: any[] = [];
/** The digests among the sent emails (registering a user sends one too). */
const digests = () => sent.filter((m) => m.subject.startsWith('Weekly digest'));

beforeAll(async () => {
  await startTestDatabase();
  ({ services: s, sent } = await makeServices({ WEB_URL: 'https://orchestration.test' }));
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      posted.push(JSON.parse(raw));
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(async () => {
  fake.close();
  await stopTestDatabase();
});
beforeEach(async () => {
  await clearDatabase();
  sent.length = 0;
  posted.length = 0;
});

// A Monday, 08:30 UTC.
const MONDAY = new Date('2026-10-05T08:30:00Z');
const DAY = 86_400_000;
const id = (v: string) => new mongoose.Types.ObjectId(v);

async function task(actor: Actor, projectId: string, f: { status: string; at: Date; cost?: number; remediations?: number; workerId?: string; failureCategory?: string; steps?: Array<[string, string]> }) {
  await mongoose.connection.db!.collection('tasks').insertOne({
    organizationId: id(actor.organizationId),
    projectId: id(projectId),
    title: 't',
    originalPrompt: 'p',
    status: f.status,
    agentId: 'claude-code',
    remediationCount: f.remediations ?? 0,
    activeMs: 60_000,
    usage: { costUsd: f.cost ?? 0, inputTokens: 0, outputTokens: 0 },
    createdBy: id(actor.userId),
    correlationId: 'c',
    createdAt: new Date(f.at.getTime() - 3_600_000),
    completedAt: ['COMPLETED', 'FAILED'].includes(f.status) ? f.at : null,
    workerId: f.workerId ? id(f.workerId) : null,
    failureCategory: f.failureCategory ?? null,
    stoppedAt: f.failureCategory ? f.at : null,
    verificationRuns: f.steps ? [{ attempt: 1, status: 'failed', steps: f.steps.map(([name, status]) => ({ kind: 'command', name, status, durationMs: 1000 })) }] : [],
  });
  if (f.cost) await mongoose.connection.db!.collection('usagerecords').insertOne({ organizationId: id(actor.organizationId), projectId: id(projectId), kind: 'execution', costUsd: f.cost, durationMs: 60_000, createdAt: f.at });
}

async function setup() {
  const { actor } = await makeOwner(s, 'ada');
  await s.orgs.update(actor, { name: 'Acme', policy: { budget: { organizationMonthlyUsd: 10 } } });
  const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
  const channel = await s.chat.create(actor, { name: 'eng', kind: 'slack', webhookUrl: `${fakeUrl}/hook`, events: [], projectIds: [], enabled: true });
  return { actor, project, channel };
}

describe('weekly digest', () => {
  it('knows the most recent moment it was due', () => {
    expect(digestDueAt(1, 8, MONDAY).toISOString()).toBe('2026-10-05T08:00:00.000Z');
    expect(digestDueAt(1, 9, MONDAY).toISOString()).toBe('2026-09-28T09:00:00.000Z'); // later today: last week's
    expect(digestDueAt(0, 23, MONDAY).toISOString()).toBe('2026-10-04T23:00:00.000Z');
    expect(digestDueAt(2, 0, MONDAY).toISOString()).toBe('2026-09-29T00:00:00.000Z');
  });

  it('summarises the seven full days before, against the week before those', async () => {
    const { actor, project } = await setup();
    const worker = (await makeWorker(s, actor, project.id, { name: 'build-1' })).worker.workerId;
    const day = (n: number) => new Date(Date.UTC(2026, 9, 5) - n * DAY + 12 * 3_600_000); // noon, n days before Monday
    await task(actor, project.id, { status: 'COMPLETED', at: day(1), cost: 2, workerId: worker });
    await task(actor, project.id, { status: 'COMPLETED', at: day(2), cost: 1, remediations: 1, workerId: worker, steps: [['test', 'failed'], ['lint', 'passed']] });
    await task(actor, project.id, { status: 'COMPLETED', at: day(7), cost: 1, workerId: worker });
    await task(actor, project.id, { status: 'FAILED', at: day(3), failureCategory: 'provider_limit' });
    await task(actor, project.id, { status: 'RECOVERY_REQUIRED', at: day(3), failureCategory: 'verification', steps: [['test', 'failed']] });
    await task(actor, project.id, { status: 'RECOVERY_REQUIRED', at: day(4), failureCategory: 'verification' });
    // The week before: two finished, one stop. Today (Monday) is not part of the digest.
    await task(actor, project.id, { status: 'COMPLETED', at: day(8), cost: 2 });
    await task(actor, project.id, { status: 'FAILED', at: day(9), failureCategory: 'timeout' });
    await task(actor, project.id, { status: 'COMPLETED', at: MONDAY, cost: 50 });

    const d = await s.digests.build(actor.organizationId, MONDAY);
    expect(d.subject).toBe('Weekly digest for Acme');
    expect(d.text.split('\n')).toEqual([
      '28 Sept 2026 to 4 Oct 2026 (UTC)',
      '',
      'Tasks: 4 finished (up 100% on the week before): 3 completed, 1 failed.',
      'Success rate: 75% (50% the week before). Passed the checks first time: 67%.',
      'Spend: $4.00 (up 100% on the week before), $1.33 per completed task.',
      // October so far: the three tasks of 1 to 4 October and today's.
      expect.stringMatching(/^Budget this month: \$53\.00 of \$10\.00, forecast \$[\d.]+ \(limit reached\)\.$/),
      'Stopped tasks: 3 (up 200% on the week before). Most common reason: checks still failing (2). 3 still wait for someone.',
      'Check that fails most: test (100% of 2 runs).',
      'Busiest worker: build-1 (3 finished tasks).',
      '',
      'Details: https://orchestration.test/insights',
    ]);
  });

  it('an empty week is still a digest', async () => {
    const { actor } = await makeOwner(s);
    const d = await s.digests.build(actor.organizationId, MONDAY);
    expect(d.text).toContain('Tasks: 0 finished: 0 completed, 0 failed.');
    expect(d.text).toContain('Spend: $0.00.');
    expect(d.text).toContain('Stopped tasks: 0.');
    expect(d.text).not.toContain('Success rate');
    expect(d.text).not.toContain('Budget');
  });

  it('is sent when due to the addresses and channels chosen, once, and not long after its time', async () => {
    const { actor, channel } = await setup();
    const settings = { enabled: true, weekday: 1, hourUtc: 8, emails: ['Lead@Example.com', 'cfo@example.com'], chatChannelIds: [channel.id] };
    expect(await s.digests.update(actor, settings)).toMatchObject({ enabled: true, emails: ['lead@example.com', 'cfo@example.com'], chatChannelIds: [channel.id], lastSentAt: null });

    expect(await s.digests.runDue(new Date('2026-10-05T07:59:00Z'))).toBe(0); // last week's is long past, this week's not yet due
    expect(digests()).toHaveLength(0);

    // Two server instances sweep at once: one digest.
    expect((await Promise.all([s.digests.runDue(MONDAY), s.digests.runDue(MONDAY)])).reduce((a, n) => a + n, 0)).toBe(1);
    expect(digests().map((m) => [m.to, m.subject])).toEqual([['lead@example.com', 'Weekly digest for Acme'], ['cfo@example.com', 'Weekly digest for Acme']]);
    expect(digests()[0]!.text).toContain('Tasks: 0 finished');
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toBe('Weekly digest for Acme');
    expect(JSON.stringify(posted[0].blocks)).toContain('Tasks: 0 finished');
    expect((await s.digests.get(actor)).lastSentAt).toBe(MONDAY.toISOString());

    expect(await s.digests.runDue(new Date('2026-10-05T20:00:00Z'))).toBe(0); // already sent
    expect(await s.digests.runDue(new Date('2026-10-12T08:00:00Z'))).toBe(1); // the next week
    expect(digests()).toHaveLength(4);

    // The server was down at the time and for more than a day after: that week is skipped.
    expect(await s.digests.runDue(new Date('2026-10-20T09:00:00Z'))).toBe(0);
    // Switched off: nothing.
    await s.digests.update(actor, { ...settings, enabled: false });
    expect(await s.digests.runDue(new Date('2026-10-26T08:00:00Z'))).toBe(0);
    expect(digests()).toHaveLength(4);
  });

  it('is set up by administrators only, with channels of the organization, and can be mailed to oneself', async () => {
    const { actor, channel } = await setup();
    const settings = { enabled: true, weekday: 5, hourUtc: 16, emails: [], chatChannelIds: [channel.id] };
    await expect(s.digests.update({ ...actor, role: 'MANAGER' }, settings)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.digests.get({ ...actor, role: 'DEVELOPER' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.digests.update(actor, { ...settings, chatChannelIds: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // nowhere to send it
    const { actor: stranger } = await makeOwner(s);
    await expect(s.digests.update(stranger, settings)).rejects.toMatchObject({ code: 'NOT_FOUND' }); // another organization's channel
    expect(await s.digests.update(actor, settings)).toMatchObject({ weekday: 5, hourUtc: 16 });
    // Recipients are not part of what every member can read of the organization.
    expect((await s.orgs.get({ ...actor, role: 'VIEWER' })).settings).not.toHaveProperty('digest');
    expect((await Organization.findById(actor.organizationId).lean())?.settings?.digest?.chatChannelIds).toHaveLength(1);

    const mine = await s.digests.sendToMe(actor, MONDAY);
    expect(mine.sentTo).toMatch(/^ada-.*@example\.com$/);
    expect(digests()).toEqual([{ to: mine.sentTo, subject: 'Weekly digest for Acme', text: mine.text }]);
    expect(posted).toHaveLength(0);
  });
});
