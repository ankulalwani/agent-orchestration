/**
 * Chat channels: notifications to Slack and Microsoft Teams, and signed actions back from Slack. A local
 * server plays Slack's and Teams' incoming webhooks and Slack's response URL.
 */
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import { AuditLog, ChatChannel, Membership } from '@ao/database';
import type { Actor, Services, WorkerActor } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let token: string;
let projectId: string;
let worker: WorkerActor;
let fake: http.Server;
let fakeUrl = '';
let failNext = 0;
const received: Array<{ path: string; body: any }> = [];
const controls: Array<Record<string, unknown>> = [];
const SIGNING_SECRET = 'slack-signing-secret-0123456789';

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices({ WEB_URL: 'https://orchestration.test', PUBLIC_URL: 'https://api.orchestration.test' })).services;
  app = await buildApp(s);
  const o = await makeOwner(s, 'chat');
  owner = o.actor;
  token = o.auth.accessToken;
  await s.orgs.update(owner, { policy: { concurrency: { perProject: 10 } } });
  projectId = (await s.projects.create(owner, { name: 'site', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;
  worker = (await makeWorker(s, owner, projectId)).worker;
  s.live.registerWorker(worker.workerId, (m) => controls.push(m as Record<string, unknown>));
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ path: req.url!, body: raw ? JSON.parse(raw) : null });
      if (failNext > 0) {
        failNext--;
        return void res.writeHead(404).end('no_service');
      }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
});
afterAll(async () => {
  await app.close();
  fake.close();
  await stopTestDatabase();
});
beforeEach(() => {
  received.length = 0;
  controls.length = 0;
});

const api = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown, auth = token) =>
  app.inject({ method, url: `${API_PREFIX}/orgs/${owner.organizationId}${url}`, payload: payload as object, headers: { authorization: `Bearer ${auth}` } });
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};
const quiet = () => new Promise((r) => setTimeout(r, 150));
const tr = (to: string, patch: Record<string, unknown> = {}) => ({ to: to as never, transitionId: randomUUID(), patch });

/** A task that waits for approval (or for an answer) on the connected worker. */
async function waitingTask(kind: 'approval' | 'input', title = 'Deploy the site') {
  const t = await s.tasks.create(owner, { projectId, title, prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
  await s.tasks.claim(worker, t.id);
  await s.tasks.transition(worker, t.id, tr('PREPARING'));
  await s.tasks.transition(worker, t.id, tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' }));
  await s.tasks.transition(worker, t.id, tr(kind === 'approval' ? 'WAITING_FOR_APPROVAL' : 'WAITING_FOR_INPUT', { pendingInteraction: { kind, question: kind === 'approval' ? 'Push to production?' : 'Which database?' } }));
  return t.id;
}

/** A request as Slack sends it: form-encoded, signed over the raw body. */
function slack(id: string, fields: Record<string, string>, opts: { secret?: string; timestamp?: number } = {}) {
  const body = new URLSearchParams(fields).toString();
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = `v0=${createHmac('sha256', opts.secret ?? SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
  return app.inject({ method: 'POST', url: `${API_PREFIX}/chat/slack/${id}`, payload: body, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature } });
}
const click = (id: string, actionId: string, taskId: string, user: string, responseUrl = `${fakeUrl}/response`) =>
  slack(id, { payload: JSON.stringify({ type: 'block_actions', user: { id: user }, response_url: responseUrl, actions: [{ action_id: actionId, value: taskId }] }) });
const command = (id: string, text: string, user: string) => slack(id, { command: '/agent', text, user_id: user });

describe('chat channels', () => {
  let slackId: string;
  let teamsId: string;

  it('are managed by administrators; the webhook URL and signing secret never come back', async () => {
    const created = await api('POST', '/chat-channels', { name: 'Slack #agents', kind: 'slack', webhookUrl: `${fakeUrl}/services/T1/B1/secretpath`, signingSecret: SIGNING_SECRET });
    expect(created.statusCode, created.body).toBe(201);
    slackId = created.json().id;
    expect(created.json()).toMatchObject({ kind: 'slack', interactive: true, webhookHost: new URL(fakeUrl).host, requestUrl: `https://api.orchestration.test/api/v1/chat/slack/${slackId}`, events: expect.arrayContaining(['task.approval_required', 'task.input_required']) });
    const teams = await api('POST', '/chat-channels', { name: 'Teams', kind: 'teams', webhookUrl: `${fakeUrl}/teams/hook`, signingSecret: 'ignored-for-teams', events: ['task.approval_required', 'task.completed'] });
    teamsId = teams.json().id;
    expect(teams.json()).toMatchObject({ interactive: false, requestUrl: null });

    const listed = await api('GET', '/chat-channels');
    expect(listed.json()).toHaveLength(2);
    expect(listed.body).not.toContain('secretpath');
    expect(listed.body).not.toContain(SIGNING_SECRET);
    expect(JSON.stringify(await ChatChannel.find().lean())).not.toContain('secretpath'); // encrypted at rest

    expect((await api('POST', '/chat-channels', { name: 'Slack #agents', kind: 'slack', webhookUrl: `${fakeUrl}/x` })).statusCode).toBe(409);
    expect((await api('POST', '/chat-channels', { name: 'bad', kind: 'slack', webhookUrl: 'ftp://example.com/x' })).statusCode).toBe(400);

    const dev = await makeOwner(s, 'chatdev');
    await Membership.create({ organizationId: owner.organizationId, userId: dev.actor.userId, role: 'DEVELOPER' });
    expect((await api('GET', '/chat-channels', undefined, dev.auth.accessToken)).statusCode).toBe(403);
    expect((await api('POST', '/chat-channels', { name: 'x', kind: 'slack', webhookUrl: `${fakeUrl}/x` }, dev.auth.accessToken)).statusCode).toBe(403);
  });

  it('a shared installation refuses webhook URLs that are not public https', async () => {
    const hosted = (await makeServices({ DEPLOYMENT_MODE: 'cloud' })).services;
    const o = await makeOwner(hosted, 'chathosted');
    const input = { name: 'x', kind: 'slack' as const, events: [], projectIds: [], enabled: true };
    await expect(hosted.chat.create(o.actor, { ...input, webhookUrl: 'http://hooks.slack.com/services/x' })).rejects.toThrow(/public https/);
    await expect(hosted.chat.create(o.actor, { ...input, webhookUrl: 'https://10.0.0.5/hook' })).rejects.toThrow(/public https/);
    await expect(hosted.chat.create(o.actor, { ...input, webhookUrl: 'https://hooks.slack.com/services/x' })).resolves.toMatchObject({ webhookHost: 'hooks.slack.com' });
  });

  it('sends a test message and records what the chat service answered', async () => {
    expect((await api('POST', `/chat-channels/${slackId}/test`)).json()).toEqual({ result: 'ok' });
    expect(received[0]).toMatchObject({ path: '/services/T1/B1/secretpath', body: { text: 'Agent Orchestration is connected' } });
    failNext = 1;
    expect((await api('POST', `/chat-channels/${teamsId}/test`)).json()).toEqual({ result: 'failed: HTTP 404' });
    expect((await api('GET', '/chat-channels')).json().find((c: { id: string }) => c.id === teamsId).lastDeliveryResult).toBe('failed: HTTP 404');
  });

  it('an approval request reaches both channels: Slack with buttons, Teams with a link', async () => {
    const taskId = await waitingTask('approval');
    await until(() => received.length >= 2, 'both channels');
    const toSlack = received.find((r) => r.path.startsWith('/services/'))!.body;
    expect(toSlack.text).toBe('Approval required: Deploy the site');
    expect(JSON.stringify(toSlack.blocks)).toContain('Push to production?');
    const actions = toSlack.blocks.find((b: { type: string }) => b.type === 'actions').elements;
    expect(actions.map((a: { action_id: string }) => a.action_id)).toEqual(['ao_approve', 'ao_deny', 'ao_open']);
    expect(actions[0].value).toBe(taskId);
    expect(actions[2].url).toBe(`https://orchestration.test/tasks/${taskId}`);

    const card = received.find((r) => r.path === '/teams/hook')!.body.attachments[0];
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.body[0].text).toBe('Approval required: Deploy the site');
    expect(card.content.actions).toEqual([{ type: 'Action.OpenUrl', title: 'Open task', url: `https://orchestration.test/tasks/${taskId}` }]);
  });

  it('only the chosen events and projects are sent; a channel that is off gets nothing', async () => {
    const other = (await s.projects.create(owner, { name: 'blog', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;
    await api('PATCH', `/chat-channels/${slackId}`, { projectIds: [other] });
    await api('PATCH', `/chat-channels/${teamsId}`, { enabled: false });
    await waitingTask('approval', 'Other project only');
    await quiet();
    expect(received).toHaveLength(0);
    // Notices without a task (budget, workers) still reach a channel limited to projects.
    await api('PATCH', `/chat-channels/${slackId}`, { events: ['budget.exceeded', 'task.approval_required', 'task.input_required', 'task.recovery_required'] });
    await s.notifications.notify({ organizationId: owner.organizationId, type: 'budget.exceeded', title: 'Budget reached', body: 'x' });
    await s.notifications.notify({ organizationId: owner.organizationId, type: 'worker.offline', title: 'Worker offline', body: 'x' });
    await until(() => received.length >= 1, 'budget notice');
    await quiet();
    expect(received.map((r) => r.body.text)).toEqual(['Budget reached']);
    await api('PATCH', `/chat-channels/${slackId}`, { projectIds: [] });
  });

  describe('actions from Slack', () => {
    it('are refused without a valid, recent signature', async () => {
      const taskId = await waitingTask('approval');
      const body = { payload: JSON.stringify({ type: 'block_actions', user: { id: 'U0OWNER01' }, response_url: `${fakeUrl}/response`, actions: [{ action_id: 'ao_approve', value: taskId }] }) };
      expect((await slack(slackId, body, { secret: 'wrong-secret' })).statusCode).toBe(401);
      expect((await slack(slackId, body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
      expect((await slack(teamsId, body)).statusCode).toBe(404); // not a Slack channel
      expect((await slack('0'.repeat(24), body)).statusCode).toBe(404);
      expect((await s.tasks.get(owner, taskId)).status).toBe('WAITING_FOR_APPROVAL');
      expect(controls.filter((c) => c.action === 'approve')).toHaveLength(0);
    });

    it('someone whose Slack account is not linked is told how to link it', async () => {
      const taskId = await waitingTask('approval');
      expect((await click(slackId, 'ao_approve', taskId, 'U0NOBODY1')).statusCode).toBe(200);
      await until(() => received.some((r) => r.path === '/response'), 'the answer in Slack');
      expect(received.find((r) => r.path === '/response')!.body).toMatchObject({ response_type: 'ephemeral', text: expect.stringMatching(/not linked/) });
      expect(controls.filter((c) => c.action === 'approve')).toHaveLength(0);
      expect((await command(slackId, 'status', 'U0NOBODY1')).json().text).toMatch(/not linked/);
    });

    it('a linked member approves with the button; the worker is told and it is audited as them', async () => {
      expect((await api('PUT', '/chat-identity', { slackUserId: 'not-an-id' })).statusCode).toBe(400);
      expect((await api('PUT', '/chat-identity', { slackUserId: 'U0OWNER01' })).json()).toEqual({ slackUserId: 'U0OWNER01' });
      expect((await api('GET', '/chat-identity')).json()).toEqual({ slackUserId: 'U0OWNER01' });

      const taskId = await waitingTask('approval', 'Release 4.2');
      await click(slackId, 'ao_approve', taskId, 'U0OWNER01');
      expect(controls).toContainEqual({ type: 'task.control', taskId, action: 'approve', input: undefined });
      await until(() => received.some((r) => r.path === '/response'), 'the answer in Slack');
      expect(received.find((r) => r.path === '/response')!.body).toMatchObject({ response_type: 'in_channel', text: 'Approved: Release 4.2 (<@U0OWNER01>)' });
      const entry = await AuditLog.findOne({ action: 'task.approve', targetId: taskId }).lean();
      expect(entry).toMatchObject({ actorId: owner.userId, metadata: { reason: 'From Slack (Slack #agents)' } });
      // Clicking "Open task" is reported by Slack too: nothing happens.
      expect((await click(slackId, 'ao_open', taskId, 'U0OWNER01')).statusCode).toBe(200);
    });

    it('the action runs with the member\'s role, and never in another organization', async () => {
      const viewer = await makeOwner(s, 'chatviewer');
      await Membership.create({ organizationId: owner.organizationId, userId: viewer.actor.userId, role: 'VIEWER', slackUserId: 'U0VIEWER1' });
      const taskId = await waitingTask('approval');
      expect((await command(slackId, `approve ${taskId}`, 'U0VIEWER1')).json().text).toMatch(/does not allow task\.approve/);
      expect(controls.filter((c) => c.action === 'approve')).toHaveLength(0);

      // The same Slack member ID cannot be claimed twice in one organization.
      expect((await api('PUT', '/chat-identity', { slackUserId: 'U0VIEWER1' })).statusCode).toBe(409);

      const elsewhere = await makeOwner(s, 'chatelse');
      const foreignProject = (await s.projects.create(elsewhere.actor, { name: 'x', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;
      const foreign = await s.tasks.create(elsewhere.actor, { projectId: foreignProject, title: 'Foreign', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
      expect((await command(slackId, `cancel ${foreign.id}`, 'U0OWNER01')).json().text).toMatch(/not found/i);
      expect((await s.tasks.get(elsewhere.actor, foreign.id)).status).toBe('QUEUED');
    });

    it('the slash command lists waiting tasks, denies with a reason, answers a question and explains itself', async () => {
      const approval = await waitingTask('approval', 'Drop the old table');
      const question = await waitingTask('input', 'Migrate <orders>');
      const status = (await command(slackId, 'status', 'U0OWNER01')).json();
      expect(status.response_type).toBe('ephemeral');
      expect(status.text).toContain(`\`${approval.slice(-6)}\` waiting for approval: <https://orchestration.test/tasks/${approval}|Drop the old table>`);
      expect(status.text).toContain('Migrate &lt;orders&gt;');

      expect((await command(slackId, `deny ${approval.slice(-6)} not on a Friday`, 'U0OWNER01')).json().text).toBe('Denied: Drop the old table');
      expect((await AuditLog.findOne({ action: 'task.deny', targetId: approval }).lean())!.metadata).toMatchObject({ reason: 'not on a Friday' });

      expect((await command(slackId, `answer ${question.slice(-6)}`, 'U0OWNER01')).json().text).toMatch(/What is the answer/);
      expect((await command(slackId, `answer ${question.slice(-6)} use the staging database`, 'U0OWNER01')).json().text).toBe('Answer sent: Migrate &lt;orders&gt;');
      expect(controls).toContainEqual({ type: 'task.control', taskId: question, action: 'input', input: 'use the staging database' });

      expect((await command(slackId, 'approve ffffff', 'U0OWNER01')).json().text).toMatch(/No task "ffffff"/);
      expect((await command(slackId, 'approve', 'U0OWNER01')).json().text).toMatch(/Which task/);
      expect((await command(slackId, 'dance', 'U0OWNER01')).json().text).toMatch(/Unknown command "dance"/);
      expect((await command(slackId, '', 'U0OWNER01')).json().text).toMatch(/^Commands:/);
    });

    it('stop when the signing secret is removed or the channel is turned off or deleted', async () => {
      await api('PATCH', `/chat-channels/${slackId}`, { enabled: false });
      expect((await command(slackId, 'status', 'U0OWNER01')).json().text).toMatch(/turned off/);
      await api('PATCH', `/chat-channels/${slackId}`, { enabled: true, signingSecret: '' });
      expect((await api('GET', '/chat-channels')).json().find((c: { id: string }) => c.id === slackId)).toMatchObject({ interactive: false, requestUrl: null });
      expect((await command(slackId, 'status', 'U0OWNER01')).statusCode).toBe(404);
      // Without a signing secret the message has no action buttons.
      const taskId = await waitingTask('approval');
      await until(() => received.some((r) => r.path.startsWith('/services/')), 'the Slack message');
      const actions = received.find((r) => r.path.startsWith('/services/'))!.body.blocks.find((b: { type: string }) => b.type === 'actions').elements;
      expect(actions.map((a: { action_id: string }) => a.action_id)).toEqual(['ao_open']);
      expect(taskId).toBeTruthy();

      expect((await api('DELETE', `/chat-channels/${slackId}`)).statusCode).toBe(204);
      expect((await api('DELETE', `/chat-channels/${slackId}`)).statusCode).toBe(404);
      expect((await api('PUT', '/chat-identity', { slackUserId: null })).json()).toEqual({ slackUserId: null });
    });
  });
});
