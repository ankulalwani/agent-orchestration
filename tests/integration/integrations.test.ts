/**
 * Integration-driven task creation (FUT-002): signed webhooks from GitHub, GitLab and generic sources
 * create tasks idempotently; results are reported back as issue comments or a signed callback. A local
 * server plays GitHub's and GitLab's REST APIs and a callback receiver.
 */
import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import { requirePublicCallbackUrls, type Actor, type Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeOwner, makeServices, makeWorker, testConfig } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let token: string;
let projectId: string;
let fake: http.Server;
let fakeUrl = '';
const received: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any; raw: string }> = [];

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices({ WEB_URL: 'https://orchestrator.test' })).services;
  app = await buildApp(s);
  const o = await makeOwner(s, 'integrations');
  owner = o.actor;
  token = o.auth.accessToken;
  projectId = (await s.projects.create(owner, { name: 'site', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;
  await s.queries.putSecret(owner, 'GH_TOKEN', 'ghp_reply_token_value');
  await s.queries.putSecret(owner, 'GL_TOKEN', 'glpat_reply_token_value');
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      received.push({ path: req.url!, headers: req.headers, body, raw });
      // Like GitHub: line comments outside the diff make the whole review fail with 422.
      if (req.url!.endsWith('/reviews') && (body?.comments ?? []).some((c: { line: number }) => c.line > 100)) return void res.writeHead(422).end('{"message":"Unprocessable"}');
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"id":1}');
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

const api = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth = token) =>
  app.inject({ method, url: `${API_PREFIX}/orgs/${owner.organizationId}${url}`, payload: payload as object, headers: { authorization: `Bearer ${auth}` } });
const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const deliver = (id: string, body: unknown, headers: Record<string, string>) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: 'POST', url: `${API_PREFIX}/hooks/${id}`, payload: raw, headers: { 'content-type': 'application/json', ...headers } });
};
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 30));
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
};
const repo = { full_name: 'acme/site' };
const issue = (n: number, labels: string[], extra: object = {}) => ({ number: n, title: `Issue ${n}`, body: `Body of ${n}`, html_url: `https://github.com/acme/site/issues/${n}`, labels: labels.map((name) => ({ name })), ...extra });

describe('GitHub integration', () => {
  let id: string;
  let secret: string;
  const gh = (event: string, body: unknown, sig = true) => deliver(id, body, { 'x-github-event': event, 'x-github-delivery': randomUUID(), 'x-hub-signature-256': sig ? sign(secret, JSON.stringify(body)) : 'sha256=bad' });

  it('is created with a secret shown once and a webhook URL', async () => {
    const r = await api('POST', '/integrations', { name: 'GitHub site', kind: 'github', projectId, settings: { label: 'agent', replyTokenSecret: 'GH_TOKEN', apiBaseUrl: fakeUrl } });
    expect(r.statusCode, r.body).toBe(200);
    ({ id, secret } = r.json());
    expect(secret).toMatch(/^whsec_/);
    expect(r.json().webhookUrl).toMatch(new RegExp(`/api/v1/hooks/${id}$`));
    expect((await api('GET', '/integrations')).body).not.toContain(secret);
    // Only admins manage integrations.
    const dev = await s.auth.register({ email: `dev-int-${Date.now()}@example.com`, password: 'dev-password-123', name: 'Dev' });
    const { Membership } = await import('@ao/database');
    await Membership.create({ userId: dev.user.id, organizationId: owner.organizationId, role: 'DEVELOPER' });
    expect((await api('GET', '/integrations', undefined, dev.accessToken)).statusCode).toBe(403);
  });

  it('rejects bad signatures and answers pings', async () => {
    expect((await gh('issues', { action: 'opened', issue: issue(1, ['agent']), repository: repo }, false)).statusCode).toBe(401);
    expect((await gh('ping', { zen: 'hi' })).json()).toEqual({ status: 'pong' });
    expect((await deliver('000000000000000000000000', {}, {})).statusCode).toBe(404);
  });

  it('labeled issues become one task each, whatever the number of deliveries, and the issue gets a comment', async () => {
    const ignored = await gh('issues', { action: 'opened', issue: issue(2, []), repository: repo });
    expect(ignored.json()).toMatchObject({ status: 'ignored', reason: expect.stringContaining('"agent" label') });

    const created = await gh('issues', { action: 'labeled', label: { name: 'agent' }, issue: issue(2, ['agent']), repository: repo });
    expect(created.statusCode).toBe(201);
    const taskId = created.json().taskId as string;
    const task = await s.tasks.get(owner, taskId);
    expect(task).toMatchObject({ title: 'Issue 2', projectId, source: { integrationId: id, kind: 'github', ref: 'acme/site#2', url: 'https://github.com/acme/site/issues/2' } });
    expect(task.originalPrompt).toContain('Body of 2');
    // A redelivery, or the same issue edited and labeled again, doesn't create another task.
    expect((await gh('issues', { action: 'labeled', label: { name: 'agent' }, issue: issue(2, ['agent']), repository: repo })).json()).toEqual({ status: 'duplicate', taskId });

    await until(() => received.some((r) => r.path === '/repos/acme/site/issues/2/comments'), 'the reply comment');
    const reply = received.find((r) => r.path === '/repos/acme/site/issues/2/comments')!;
    expect(reply.headers.authorization).toBe('Bearer ghp_reply_token_value');
    expect(reply.body.body).toContain(`https://orchestrator.test/tasks/${taskId}`);
  });

  it('comment commands create tasks; other comments and bots are ignored', async () => {
    const comment = (cid: number, body: string, type = 'User') => ({ action: 'created', comment: { id: cid, body, html_url: `https://github.com/acme/site/issues/3#c${cid}` }, issue: issue(3, []), sender: { type }, repository: repo });
    expect((await gh('issue_comment', comment(10, 'looks good'))).json().status).toBe('ignored');
    expect((await gh('issue_comment', comment(11, '/agent fix it', 'Bot'))).json().reason).toBe('comment by a bot');
    const r = await gh('issue_comment', comment(12, '/agent Fix the footer links\nThey 404 on mobile.'));
    expect(r.statusCode).toBe(201);
    const task = await s.tasks.get(owner, r.json().taskId);
    expect(task.title).toBe('Fix the footer links');
    expect(task.originalPrompt).toMatch(/They 404 on mobile[\s\S]*Issue 3/);
  });

  it('reports the outcome on the issue when the task ends', async () => {
    const r = await gh('issues', { action: 'opened', issue: issue(4, ['agent']), repository: repo });
    const taskId = r.json().taskId as string;
    const { worker } = await makeWorker(s, owner, projectId, { name: 'w-int' });
    await s.tasks.claim(worker, taskId);
    const tr = (to: string, patch: Record<string, unknown> = {}) => s.tasks.transition(worker, taskId, { to: to as never, transitionId: randomUUID(), patch });
    await tr('PREPARING');
    await tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' });
    await tr('VERIFYING', { verificationStatus: 'RUNNING' });
    await tr('COMPLETED', { verificationStatus: 'PASSED', completionReport: { summary: 'Fixed the footer.' } });
    await until(() => received.filter((x) => x.path === '/repos/acme/site/issues/4/comments').length === 2, 'the completion comment');
    const last = received.filter((x) => x.path === '/repos/acme/site/issues/4/comments')[1]!;
    expect(last.body.body).toMatch(/^Task completed: Issue 4\n\nFixed the footer\./);
  });

  it('turned off: deliveries are acknowledged and ignored; a rotated secret replaces the old one', async () => {
    await api('PATCH', `/integrations/${id}`, { enabled: false });
    expect((await gh('issues', { action: 'opened', issue: issue(5, ['agent']), repository: repo })).json()).toMatchObject({ status: 'ignored', reason: 'The integration is turned off' });
    await api('PATCH', `/integrations/${id}`, { enabled: true });
    const old = secret;
    secret = (await api('POST', `/integrations/${id}/rotate-secret`)).json().secret;
    expect(secret).not.toBe(old);
    expect((await deliver(id, { zen: 1 }, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(old, JSON.stringify({ zen: 1 })) })).statusCode).toBe(401);
    expect((await gh('ping', { zen: 1 })).json().status).toBe('pong');
    const list = (await api('GET', '/integrations')).json();
    expect(list[0]).toMatchObject({ lastDeliveryResult: 'ping', deliveries: expect.any(Number) });
  });
});

describe('pull and merge request reviews (FUT-003)', () => {
  const finishReview = async (taskId: string, review: object) => {
    const { worker } = await makeWorker(s, owner, projectId, { name: `w-rev-${taskId.slice(-4)}` });
    await s.tasks.claim(worker, taskId);
    const tr = (to: string, patch: Record<string, unknown> = {}) => s.tasks.transition(worker, taskId, { to: to as never, transitionId: randomUUID(), patch });
    await tr('PREPARING');
    await tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' });
    await tr('VERIFYING', { verificationStatus: 'RUNNING' });
    await tr('COMPLETED', { verificationStatus: 'PASSED', completionReport: { summary: 'Reviewed.', review } });
  };

  it('GitHub: opened pull requests become review tasks, and the review is posted with line comments', async () => {
    const r = await api('POST', '/integrations', { name: 'GitHub reviews', kind: 'github', projectId, settings: { reviews: 'off', replyTokenSecret: 'GH_TOKEN', apiBaseUrl: fakeUrl, command: '' } });
    const { id, secret } = r.json();
    const pr = (n: number, action: string, extra: object = {}) => ({ action, number: n, pull_request: { number: n, title: `Add feature ${n}`, body: 'Please review', html_url: `https://github.com/acme/site/pull/${n}`, draft: false, base: { ref: 'main' }, head: { ref: `feature-${n}`, sha: `sha${n}` }, ...extra }, repository: repo });
    const gh = (body: unknown) => deliver(id, body, { 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(secret, JSON.stringify(body)) });
    expect((await gh(pr(7, 'opened'))).json()).toMatchObject({ status: 'ignored', reason: 'pull request reviews are off' });
    await api('PATCH', `/integrations/${id}`, { settings: { reviews: 'opened' } });
    expect((await gh(pr(7, 'opened', { draft: true }))).json().reason).toBe('draft pull request');
    expect((await gh(pr(7, 'synchronize'))).json().status).toBe('ignored'); // pushes only with every_push
    const created = await gh(pr(7, 'opened'));
    expect(created.statusCode).toBe(201);
    const task = await s.tasks.get(owner, created.json().taskId);
    expect(task).toMatchObject({ kind: 'review', title: 'Review: Add feature 7', review: { base: 'main', head: 'feature-7', fetchHead: 'pull/7/head', pullRequest: { number: 7 } }, source: { refType: 'pr', ref: 'acme/site#7' } });

    await finishReview(task.id, { summary: 'Two problems.', verdict: 'request_changes', comments: [{ path: 'src/a.ts', line: 12, severity: 'major', body: 'Null check missing.' }, { path: 'README.md', severity: 'nit', body: 'Typo.' }] });

    await until(() => received.some((x) => x.path === '/repos/acme/site/pulls/7/reviews'), 'the review');
    const posted = received.find((x) => x.path === '/repos/acme/site/pulls/7/reviews')!;
    expect(posted.body).toMatchObject({ event: 'COMMENT', comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: '**major**: Null check missing.' }] });
    expect(posted.body.body).toMatch(/^\*\*Agent review — Changes requested\*\*\n\nTwo problems\.\n\n- \*\*nit\*\* `README\.md`: Typo\./);

    // Line comments GitHub refuses (outside the diff): posted again with everything in the text.
    await api('PATCH', `/integrations/${id}`, { settings: { reviews: 'every_push' } });
    const pushed = await gh(pr(8, 'synchronize'));
    await finishReview(pushed.json().taskId, { summary: 'One.', verdict: 'comment', comments: [{ path: 'src/b.ts', line: 999, severity: 'minor', body: 'Far away.' }] });
    await until(() => received.filter((x) => x.path === '/repos/acme/site/pulls/8/reviews').length === 2, 'the fallback review');
    const fallback = received.filter((x) => x.path === '/repos/acme/site/pulls/8/reviews')[1]!;
    expect(fallback.body.comments).toBeUndefined();
    expect(fallback.body.body).toContain('`src/b.ts:999`: Far away.');
  });

  it('GitLab: merge requests become review tasks; the review is one merge request note', async () => {
    const r = await api('POST', '/integrations', { name: 'GitLab reviews', kind: 'gitlab', projectId, settings: { reviews: 'every_push', replyTokenSecret: 'GL_TOKEN', apiBaseUrl: fakeUrl, command: '' } });
    const { id, secret } = r.json();
    const mr = (action: string, extra: object = {}) => ({ project: { id: 88 }, object_attributes: { iid: 3, action, title: 'Refactor', description: 'd', url: 'https://gitlab.com/acme/site/-/merge_requests/3', source_branch: 'refactor', target_branch: 'main', last_commit: { id: `c-${action}` }, ...extra } });
    const gl = (body: unknown) => deliver(id, body, { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-token': secret });
    expect((await gl(mr('update'))).json().status).toBe('ignored'); // metadata change, no push
    const created = await gl(mr('update', { oldrev: 'abc' }));
    expect(created.statusCode).toBe(201);
    const task = await s.tasks.get(owner, created.json().taskId);
    expect(task.review).toMatchObject({ base: 'main', head: 'refactor', fetchHead: 'refs/merge-requests/3/head' });
    await finishReview(task.id, { summary: 'Fine.', verdict: 'approve', comments: [] });
    await until(() => received.some((x) => x.path === '/api/v4/projects/88/merge_requests/3/notes' && String(x.body?.body).includes('Agent review')), 'the MR note');
    expect(received.find((x) => x.path === '/api/v4/projects/88/merge_requests/3/notes' && String(x.body?.body).includes('Agent review'))!.body.body).toMatch(/^\*\*Agent review — Looks good\*\*\n\nFine\./);
  });
});

describe('GitLab and generic integrations', () => {
  it('GitLab: token header, labeled issues and note commands, reply as a note', async () => {
    const r = await api('POST', '/integrations', { name: 'GitLab', kind: 'gitlab', projectId, settings: { label: 'agent', replyTokenSecret: 'GL_TOKEN', apiBaseUrl: fakeUrl } });
    const { id, secret } = r.json();
    const gl = (event: string, body: unknown, tok = secret) => deliver(id, body, { 'x-gitlab-event': event, 'x-gitlab-token': tok });
    const issueHook = (action: string, labels: string[], changes?: object) => ({ object_kind: 'issue', project: { id: 77 }, labels: labels.map((title) => ({ title })), object_attributes: { action, iid: 9, title: 'Slow search', description: 'Search takes 5 s', url: 'https://gitlab.com/acme/site/-/issues/9' }, changes });
    expect((await gl('Issue Hook', issueHook('open', ['agent']), 'wrong')).statusCode).toBe(401);
    expect((await gl('Issue Hook', issueHook('open', []))).json().status).toBe('ignored');
    const created = await gl('Issue Hook', issueHook('update', ['agent'], { labels: { previous: [], current: [{ title: 'agent' }] } }));
    expect(created.statusCode).toBe(201);
    expect((await s.tasks.get(owner, created.json().taskId)).source).toMatchObject({ kind: 'gitlab', ref: '77#9' });
    const note = await gl('Note Hook', { project: { id: 77 }, object_attributes: { id: 5, noteable_type: 'Issue', note: '/agent add an index', url: 'u' }, issue: { iid: 9, title: 'Slow search', description: 'd' } });
    expect((await s.tasks.get(owner, note.json().taskId)).title).toBe('add an index');
    await until(() => received.some((x) => x.path === '/api/v4/projects/77/issues/9/notes'), 'the GitLab note');
    expect(received.find((x) => x.path === '/api/v4/projects/77/issues/9/notes')!.headers['private-token']).toBe('glpat_reply_token_value');
  });

  it('generic: HMAC signature, templates, delivery id idempotency, signed callback with the result', async () => {
    const r = await api('POST', '/integrations', { name: 'Tickets', kind: 'generic', projectId, settings: { titleTemplate: '[{{ticket.key}}] {{ticket.summary}}', promptTemplate: '{{ticket.description}}\nReporter: {{ticket.reporter.name}}', callbackUrl: `${fakeUrl}/callback`, priority: 'HIGH' } });
    const { id, secret } = r.json();
    const body = { ticket: { key: 'OPS-7', summary: 'Rotate logs', description: 'Logs fill the disk.', reporter: { name: 'Sam' } } };
    const send = (headers: Record<string, string> = {}) => deliver(id, body, { 'x-ao-signature': sign(secret, JSON.stringify(body)), 'x-ao-delivery': 'd-1', ...headers });
    expect((await deliver(id, body, { 'x-ao-signature': 'sha256=00' })).statusCode).toBe(401);
    const created = await send();
    expect(created.statusCode).toBe(201);
    const task = await s.tasks.get(owner, created.json().taskId);
    expect(task).toMatchObject({ title: '[OPS-7] Rotate logs', priority: 'HIGH', originalPrompt: 'Logs fill the disk.\nReporter: Sam' });
    expect((await send()).json().status).toBe('duplicate');

    const { worker } = await makeWorker(s, owner, projectId, { name: 'w-gen' });
    await s.tasks.claim(worker, task.id);
    await s.tasks.transition(worker, task.id, { to: 'PREPARING', transitionId: randomUUID(), patch: {} });
    await s.tasks.transition(worker, task.id, { to: 'RECOVERY_REQUIRED', transitionId: randomUUID(), patch: {}, reason: 'Needs a person' });
    await until(() => received.some((x) => x.path === '/callback'), 'the callback');
    const cb = received.find((x) => x.path === '/callback')!;
    expect(cb.body).toMatchObject({ taskId: task.id, status: 'RECOVERY_REQUIRED', summary: 'Needs a person', url: `https://orchestrator.test/tasks/${task.id}` });
    expect(cb.headers['x-ao-signature']).toBe(sign(secret, cb.raw));
  });
});

describe('callback URL guard for shared installations', () => {
  const generic = (callbackUrl: string) => ({ name: `Guarded ${randomUUID()}`, kind: 'generic' as const, projectId, settings: { titleTemplate: 't', promptTemplate: 'p', callbackUrl } });

  it('defaults: off for self-hosted, on for DEPLOYMENT_MODE=cloud; the explicit setting wins', () => {
    expect(requirePublicCallbackUrls(testConfig())).toBe(false);
    expect(requirePublicCallbackUrls(testConfig({ DEPLOYMENT_MODE: 'cloud' }))).toBe(true);
    expect(requirePublicCallbackUrls(testConfig({ REQUIRE_PUBLIC_CALLBACK_URLS: 'true' }))).toBe(true);
    expect(requirePublicCallbackUrls(testConfig({ DEPLOYMENT_MODE: 'cloud', REQUIRE_PUBLIC_CALLBACK_URLS: 'false' }))).toBe(false);
  });

  it('when on, private-network and plain-http callbacks are rejected and public https ones accepted', async () => {
    const guarded = (await makeServices({ REQUIRE_PUBLIC_CALLBACK_URLS: 'true' })).services;
    for (const url of [`${fakeUrl}/callback`, 'https://10.0.0.5/cb', 'https://192.168.1.2/cb', 'http://example.com/cb']) {
      await expect(guarded.integrations.create(owner, generic(url) as never)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    await expect(guarded.integrations.create(owner, generic('https://hooks.example.com/cb') as never)).resolves.toMatchObject({ kind: 'generic' });
    // Self-hosted default: a callback on the local network is allowed.
    await expect(s.integrations.create(owner, generic(`${fakeUrl}/callback`) as never)).resolves.toMatchObject({ kind: 'generic' });
  });
});
