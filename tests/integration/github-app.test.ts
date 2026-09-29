/**
 * GitHub App repository sync: the app is created with the manifest flow, installed (only with the
 * dashboard's state), its repositories become projects, webhooks and syncs keep them current, and new
 * repositories are created in organizations (installation token) and personal accounts (member's token).
 * A local server plays GitHub (web and REST API) and checks the app's JWTs with the key it issued.
 */
import http from 'node:http';
import { createHmac, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { GitHubApp, GitHubInstallation, Project } from '@ao/database';
import { API_PREFIX, type GithubStatusDto, type ProjectDto } from '@ao/contracts';
import { reencryptSecrets, type Actor, type Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let token: string;
let fake: http.Server;
let fakeUrl = '';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const WEBHOOK_SECRET = 'whsec-test-value';
const calls: Array<{ method: string; path: string; auth: string; body: any }> = [];
const repo = (id: number, owner: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  full_name: `${owner}/${name}`,
  html_url: `https://github.com/${owner}/${name}`,
  clone_url: `https://github.com/${owner}/${name}.git`,
  default_branch: 'main',
  private: true,
  archived: false,
  description: `${name} repo`,
  owner: { login: owner },
  ...extra,
});
const installations: Record<number, { account: { login: string; type: string; id: number }; selection: string; repos: any[] }> = {
  11: { account: { login: 'acme', type: 'Organization', id: 1 }, selection: 'all', repos: [repo(101, 'acme', 'api'), repo(102, 'acme', 'web'), repo(103, 'acme', 'old', { archived: true })] },
  22: { account: { login: 'alice', type: 'User', id: 2 }, selection: 'selected', repos: [] },
};

function verifyAppJwt(auth: string) {
  const [h, p, sig] = auth.replace(/^Bearer /, '').split('.');
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, 'base64url'));
  return ok && JSON.parse(Buffer.from(p!, 'base64url').toString()).iss === '777';
}

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      const auth = String(req.headers.authorization ?? '');
      calls.push({ method: req.method!, path: url.pathname, auth, body });
      const send = (code: number, data: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      let m: RegExpExecArray | null;
      if (req.method === 'POST' && (m = /^\/app-manifests\/([\w-]+)\/conversions$/.exec(url.pathname))) {
        return m[1] === 'good-code'
          ? send(201, { id: 777, slug: 'ao-test', name: 'AO Test', html_url: 'https://github.com/apps/ao-test', owner: { login: 'acme', type: 'Organization' }, client_id: 'Iv1.client', client_secret: 'client-secret-value', webhook_secret: WEBHOOK_SECRET, pem })
          : send(404, { message: 'Not Found' });
      }
      if ((m = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(url.pathname))) {
        if (!verifyAppJwt(auth)) return send(401, { message: 'Bad JWT' });
        const i = installations[Number(m[1])];
        if (!i) return send(404, { message: 'Not Found' });
        if (m[2]) return send(201, { token: `ghs_inst_${m[1]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
        return send(200, { id: Number(m[1]), app_id: 777, account: i.account, repository_selection: i.selection, suspended_at: null });
      }
      if (url.pathname === '/installation/repositories') {
        const i = installations[Number(auth.replace('Bearer ghs_inst_', ''))];
        return i ? send(200, { total_count: i.repos.length, repositories: i.repos }) : send(401, { message: 'Bad credentials' });
      }
      if (req.method === 'POST' && (m = /^\/orgs\/([\w-]+)\/repos$/.exec(url.pathname))) {
        if (auth !== 'Bearer ghs_inst_11') return send(403, { message: 'Resource not accessible by integration' });
        const r = repo(200 + calls.length, m[1]!, body.name, { private: body.private, description: body.description });
        installations[11]!.repos.push(r);
        return send(201, r);
      }
      if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        if (body.code === 'user-code' || body.refresh_token === 'ghr_refresh') return send(200, { access_token: 'ghu_user_token', refresh_token: 'ghr_refresh', expires_in: 28800, refresh_token_expires_in: 15897600 });
        return send(200, { error: 'bad_verification_code' });
      }
      if (url.pathname === '/user') return auth === 'Bearer ghu_user_token' ? send(200, { login: 'alice', id: 2 }) : send(401, { message: 'Bad credentials' });
      if (req.method === 'POST' && url.pathname === '/user/repos') {
        if (auth !== 'Bearer ghu_user_token') return send(401, { message: 'Bad credentials' });
        return send(201, repo(300, 'alice', body.name, { private: body.private }));
      }
      if (req.method === 'PUT' && (m = /^\/user\/installations\/(\d+)\/repositories\/(\d+)$/.exec(url.pathname))) {
        installations[Number(m[1])]!.repos.push(repo(Number(m[2]), 'alice', 'notes'));
        return res.writeHead(204).end();
      }
      send(404, { message: `unhandled ${req.method} ${url.pathname}` });
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  await startTestDatabase();
  s = (await makeServices({ GITHUB_URL: fakeUrl, GITHUB_API_URL: fakeUrl, WEB_URL: 'http://dash.test', PUBLIC_URL: 'http://localhost:4000' })).services;
  app = await buildApp(s);
  const o = await makeOwner(s, 'gh');
  owner = o.actor;
  token = o.auth.accessToken;
});
afterAll(async () => {
  await app.close();
  fake.close();
  await stopTestDatabase();
});

const api = async <T,>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `${API_PREFIX}/orgs/${owner.organizationId}${url}`, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() as T };
};
const redirect = async (path: string) => {
  const r = await app.inject({ method: 'GET', url: `${API_PREFIX}${path}` });
  expect(r.statusCode).toBe(302);
  return new URL(r.headers.location as string);
};
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const sign = (body: string, secret = WEBHOOK_SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const hook = (event: string, body: unknown, secret?: string) => {
  const raw = JSON.stringify(body);
  return app.inject({ method: 'POST', url: `${API_PREFIX}/github/webhook`, payload: raw, headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sign(raw, secret) } });
};
const projectsByRepo = async () => {
  const list = await s.projects.list(owner);
  return Object.fromEntries(list.flatMap((p) => p.repositories.map((r) => [r.key, { project: p.name, repo: r }])));
};

describe('GitHub App', () => {
  it('creates the app from a manifest (no webhook on a local PUBLIC_URL) and stores its secrets encrypted', async () => {
    const start = await api<{ postUrl: string; manifest: string }>('POST', '/github/app/manifest', { organization: 'acme' });
    expect(start.status).toBe(200);
    expect(start.body.postUrl).toMatch(new RegExp(`^${fakeUrl}/organizations/acme/settings/apps/new\\?state=`));
    const manifest = JSON.parse(start.body.manifest);
    expect(manifest).toMatchObject({ redirect_url: 'http://localhost:4000/api/v1/github/app/callback', setup_url: 'http://localhost:4000/api/v1/github/app/setup', public: true, default_permissions: expect.objectContaining({ contents: 'write', administration: 'write' }) });
    expect(manifest.hook_attributes).toBeUndefined();

    // A wrong state never stores anything.
    expect((await redirect('/github/app/callback?code=good-code&state=forged')).searchParams.get('error')).toBe('state');
    const done = await redirect(`/github/app/callback?code=good-code&state=${stateOf(start.body.postUrl)}`);
    expect(`${done.origin}${done.pathname}`).toBe('http://dash.test/settings');
    expect(done.searchParams.get('created')).toBe('ao-test');
    // The state is single-use.
    expect((await redirect(`/github/app/callback?code=good-code&state=${stateOf(start.body.postUrl)}`)).searchParams.get('error')).toBe('state');

    const stored = await GitHubApp.findOne({ appId: 777 }).select('+privateKeyEnc +clientSecretEnc').lean();
    expect(stored?.privateKeyEnc).not.toContain('PRIVATE KEY');
    expect(stored?.clientSecretEnc).not.toContain('client-secret-value');
    const status = await api<GithubStatusDto>('GET', '/github');
    expect(status.body).toMatchObject({ app: { appId: 777, slug: 'ao-test' }, installations: [], user: null, publicUrlIsLocal: true });
    expect(JSON.stringify(status.body)).not.toContain('client-secret-value');
  });

  it('accepts only installations started from the dashboard, then syncs their repositories into projects', async () => {
    // A repository added by hand before the app existed: synced into, not duplicated.
    await s.projects.create(owner, { name: 'website', description: '', repositoryUrl: 'git@github.com:acme/web.git', defaultBranch: 'main', environments: [], knowledge: '' });

    expect((await redirect('/github/app/setup?installation_id=11&setup_action=install')).searchParams.get('error')).toBe('state');
    const link = await api<{ url: string }>('POST', '/github/installations');
    expect(link.body.url).toMatch(/^https:\/\/github\.com\/apps\/ao-test\/installations\/new\?state=/);
    const done = await redirect(`/github/app/setup?installation_id=11&setup_action=install&state=${stateOf(link.body.url)}`);
    expect(done.searchParams.get('installed')).toBe('acme');

    const sync = await api<{ repositories: number; projectsCreated: number; errors: string[] }>('POST', '/github/sync');
    expect(sync.body).toMatchObject({ repositories: 3, errors: [] });
    const repos = await projectsByRepo();
    expect(repos['github.com/acme/api']).toMatchObject({ project: 'api', repo: { source: 'github', primary: true, url: 'https://github.com/acme/api.git', github: { installationId: 11, repoId: 101, private: true, accessible: true } } });
    expect(repos['github.com/acme/web']).toMatchObject({ project: 'website', repo: { source: 'manual', github: { repoId: 102 } } });
    expect(repos['github.com/acme/old']).toBeUndefined(); // archived on GitHub: not imported
    // Syncing again changes nothing.
    await s.github.syncOrganization(null, owner.organizationId);
    expect((await s.projects.list(owner)).filter((p) => p.name === 'api')).toHaveLength(1);
  });

  it('follows webhooks: signed deliveries only; lost access marks repositories, never deletes them', async () => {
    expect((await hook('repository', { action: 'created', installation: { id: 11 } }, 'wrong-secret')).statusCode).toBe(401);
    expect((await hook('repository', { action: 'created', installation: { id: 99 } })).json()).toEqual({ status: 'ignored' }); // unknown installation
    expect((await hook('ping', { hook: { app_id: 777 } })).json()).toEqual({ status: 'pong' });

    installations[11]!.repos = installations[11]!.repos.filter((r) => r.id !== 101); // access to acme/api removed
    installations[11]!.repos.push(repo(104, 'acme', 'docs'));
    expect((await hook('installation_repositories', { action: 'removed', installation: { id: 11, app_id: 777 } })).json()).toEqual({ status: 'ok' });
    await expect.poll(async () => (await projectsByRepo())['github.com/acme/docs'], { timeout: 5000 }).toBeTruthy();
    expect((await projectsByRepo())['github.com/acme/api']?.repo.github?.accessible).toBe(false);

    await hook('installation', { action: 'suspend', installation: { id: 11, app_id: 777 } });
    expect((await GitHubInstallation.findOne({ installationId: 11 }).lean())?.suspended).toBe(true);
    await hook('installation', { action: 'unsuspend', installation: { id: 11, app_id: 777 } });
  });

  it('creates repositories in an organization through the installation', async () => {
    const r = await api<ProjectDto>('POST', '/github/repositories', { owner: 'acme', name: 'billing', private: true, description: 'Billing service' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'billing', repositories: [expect.objectContaining({ key: 'github.com/acme/billing', source: 'github', primary: true })] });
    expect(calls.find((c) => c.path === '/orgs/acme/repos')?.body).toMatchObject({ name: 'billing', private: true, auto_init: true });
    // Into an existing project as a second repository.
    const more = await api<ProjectDto>('POST', '/github/repositories', { owner: 'acme', name: 'billing-ui', projectId: r.body.id });
    expect(more.body.repositories.map((x) => [x.name, x.primary])).toEqual([['billing', true], ['billing-ui', false]]);
    const unknown = await api<{ error: { message: string } }>('POST', '/github/repositories', { owner: 'nobody', name: 'x' });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.message).toContain('not installed on nobody');
  });

  it("creates repositories in a member's personal account with their own authorization", async () => {
    const link = await api<{ url: string }>('POST', '/github/installations');
    await redirect(`/github/app/setup?installation_id=22&state=${stateOf(link.body.url)}`);
    const refused = await api<{ error: { message: string } }>('POST', '/github/repositories', { owner: 'alice', name: 'notes' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toContain('connect that GitHub account');

    const auth = await api<{ url: string }>('POST', '/github/user');
    expect(auth.body.url).toMatch(new RegExp(`^${fakeUrl}/login/oauth/authorize\\?client_id=Iv1.client&`));
    const done = await redirect(`/github/user/callback?code=user-code&state=${stateOf(auth.body.url)}`);
    expect(done.searchParams.get('connected')).toBe('alice');
    expect((await api<GithubStatusDto>('GET', '/github')).body.user).toEqual({ login: 'alice' });
    expect((await api<Array<{ login: string; canCreate: boolean }>>('GET', '/github/owners')).body).toEqual(expect.arrayContaining([{ login: 'alice', type: 'User', canCreate: true }]));

    const created = await api<ProjectDto>('POST', '/github/repositories', { owner: 'alice', name: 'notes', private: true });
    expect(created.status).toBe(200);
    expect(calls.find((c) => c.path === '/user/repos')).toMatchObject({ auth: 'Bearer ghu_user_token', body: expect.objectContaining({ name: 'notes' }) });
    // The installation only has selected repositories: the new one is added to it.
    expect(calls.some((c) => c.method === 'PUT' && c.path === '/user/installations/22/repositories/300')).toBe(true);
    expect(created.body.repositories[0]).toMatchObject({ key: 'github.com/alice/notes', source: 'github', github: expect.objectContaining({ installationId: 22 }) });
  });

  it("gives the worker holding a task tokens limited to the task's repositories", async () => {
    const billing = (await s.projects.list(owner)).find((p) => p.name === 'billing')!;
    const { worker } = await makeWorker(s, owner, billing.id, {
      agents: [{ id: 'mock', installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: ['resume', 'additionalDirectories'] }],
    });
    await s.workers.heartbeat(worker, {
      metrics: {},
      activeTasks: [],
      sentAt: new Date().toISOString(),
      inventory: { agents: [], providers: [], tools: [], projects: billing.repositories.map((r) => ({ projectId: billing.id, repositoryId: r.id, localPath: `/w/${r.name}` })) },
    });
    const task = await s.tasks.create(owner, { projectId: billing.id, title: 'x', prompt: 'x', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    const stranger = { workerId: worker.workerId, organizationId: owner.organizationId, correlationId: 't' };
    await expect(s.discovery.taskCredentials(stranger, task.id)).rejects.toThrow(/does not hold/);
    expect((await s.tasks.claim(worker, task.id)).claimed).toBe(true);

    const creds = await s.discovery.taskCredentials(worker, task.id);
    expect(creds.repositories.map((r) => [r.name, r.token, r.host])).toEqual([
      ['billing', 'ghs_inst_11', new URL(fakeUrl).host],
      ['billing-ui', 'ghs_inst_11', new URL(fakeUrl).host],
    ]);
    const tokenCall = calls.filter((c) => c.path === '/app/installations/11/access_tokens').at(-1)!;
    expect(tokenCall.body).toEqual({ repository_ids: billing.repositories.map((r) => r.github!.repoId), permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
  });

  it('re-encrypts the app credentials when the encryption key is rotated', async () => {
    const r = await reencryptSecrets(s.box);
    expect(r.failed).toEqual([]);
  });

  it('forgets an installation without deleting its projects', async () => {
    expect((await api('DELETE', '/github/installations/22')).status).toBe(200);
    const p = await Project.findOne({ 'repositories.key': 'github.com/alice/notes' }).lean();
    expect(p?.repositories[0]?.github).toMatchObject({ accessible: false });
  });
});
