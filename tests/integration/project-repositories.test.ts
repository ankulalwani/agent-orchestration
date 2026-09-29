/**
 * Projects with several repositories: the repository API (add, rename, primary, move, split), worker
 * checkouts reported per repository, eligibility only with every repository checked out, and the
 * migration that gives existing projects a primary repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { MIGRATIONS, Project, mongoose } from '@ao/database';
import { API_PREFIX, type ProjectDto } from '@ao/contracts';
import { evaluateWorker, repositoryKey, repositoryName, localRepositoryKey, DEFAULT_POLICY } from '@ao/core';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let token: string;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  const o = await makeOwner(s, 'repos');
  owner = o.actor;
  token = o.auth.accessToken;
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

const api = async <T = ProjectDto>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `${API_PREFIX}/orgs/${owner.organizationId}${url}`, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() as T };
};
const newProject = (name: string, repositoryUrl?: string) => s.projects.create(owner, { name, description: '', repositoryUrl, defaultBranch: 'main', environments: [], knowledge: '' });

describe('repository identity', () => {
  it('gives every URL form of a repository the same key', () => {
    const forms = ['https://github.com/Acme/Site.git', 'git@github.com:acme/site.git', 'ssh://git@github.com:22/acme/site', 'https://user:pw@github.com/acme/site/'];
    expect(new Set(forms.map(repositoryKey))).toEqual(new Set(['github.com/acme/site']));
    expect(repositoryKey('/local/path/repo.git')).toBeNull();
    expect(repositoryKey('')).toBeNull();
    expect(localRepositoryKey('ABC123')).toBe('local:abc123');
    expect(repositoryName('git@github.com:acme/my-api.git')).toBe('my-api');
    expect(repositoryName(null, 'My Project!')).toBe('My-Project');
  });
});

describe('project repositories', () => {
  it('creates a project with its repository as the primary one', async () => {
    const p = await newProject('shop', 'https://github.com/acme/shop-api.git');
    expect(p.repositories).toEqual([expect.objectContaining({ name: 'shop-api', key: 'github.com/acme/shop-api', primary: true, source: 'manual' })]);
    const bare = await newProject('notes');
    expect(bare.repositories).toEqual([expect.objectContaining({ name: 'notes', key: null, primary: true })]);
  });

  it('adds, renames and switches the primary repository; one repository per organization', async () => {
    const p = await newProject('store', 'https://github.com/acme/store-api');
    const added = await api('POST', `/projects/${p.id}/repositories`, { url: 'git@github.com:acme/store-web.git' });
    expect(added.status).toBe(200);
    expect(added.body.repositories.map((r) => [r.name, r.primary])).toEqual([['store-api', true], ['store-web', false]]);

    // The same repository cannot be in two projects (any URL form).
    const dup = await api('POST', `/projects/${p.id}/repositories`, { url: 'https://github.com/ACME/store-web' });
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).toContain('store');
    expect((await api('POST', `/projects/${p.id}/repositories`, { url: 'not a url' })).status).toBe(400);

    const web = added.body.repositories.find((r) => r.name === 'store-web')!;
    const primary = await api('PATCH', `/projects/${p.id}/repositories/${web.id}`, { primary: true, name: 'frontend', defaultBranch: 'develop' });
    expect(primary.status).toBe(200);
    expect(primary.body.repositories.filter((r) => r.primary).map((r) => r.name)).toEqual(['frontend']);
    // The project's repositoryUrl and defaultBranch follow the primary repository (older clients).
    expect(primary.body).toMatchObject({ repositoryUrl: 'git@github.com:acme/store-web.git', defaultBranch: 'develop' });
    const clash = await api('PATCH', `/projects/${p.id}/repositories/${web.id}`, { name: 'store-api' });
    expect(clash.status).toBe(409);
  });

  it('moves a repository with its worker checkouts, and archives a project left empty', async () => {
    const a = await newProject('mobile', 'https://github.com/acme/mobile');
    const b = await newProject('backend', 'https://github.com/acme/backend');
    const { worker } = await makeWorker(s, owner, a.id);
    const aRepo = a.repositories[0]!;
    // makeWorker reported a path without repository id: it counts as the primary repository's.
    expect((await s.projects.get(owner, a.id)).workerPaths).toEqual([expect.objectContaining({ workerId: worker.workerId, repositoryId: aRepo.id })]);

    const moved = await api('POST', `/projects/${b.id}/repositories`, { fromProjectId: a.id, repositoryId: aRepo.id });
    expect(moved.status).toBe(200);
    expect(moved.body.repositories.map((r) => [r.name, r.primary])).toEqual([['backend', true], ['mobile', false]]);
    expect(moved.body.workerPaths).toEqual([expect.objectContaining({ workerId: worker.workerId, repositoryId: aRepo.id, localPath: '/tmp/project' })]);
    expect((await Project.findById(a.id).lean())?.archived).toBe(true);
    expect((await s.projects.list(owner)).some((p) => p.id === a.id)).toBe(false);

    // A worker whose configuration still names the old project: the repository is found by its id.
    await s.workers.heartbeat(worker, { metrics: {}, activeTasks: [], sentAt: new Date().toISOString(), inventory: { agents: [], providers: [], tools: [], projects: [{ projectId: a.id, repositoryId: aRepo.id, localPath: '/w/mobile' }] } });
    expect((await s.projects.get(owner, b.id)).workerPaths).toEqual([{ workerId: worker.workerId, repositoryId: aRepo.id, localPath: '/w/mobile' }]);

    // Split it out again into a project of its own.
    const back = await api('POST', `/projects/${b.id}/repositories/${aRepo.id}/split`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ name: 'mobile (2)', repositories: [expect.objectContaining({ id: aRepo.id, primary: true })] });
    expect((await s.projects.get(owner, b.id)).repositories.map((r) => r.name)).toEqual(['backend']);
    expect((await api('POST', `/projects/${b.id}/repositories/${b.repositories[0]!.id}/split`)).status).toBe(400); // only repository
  });

  it('makes a worker eligible only with every repository checked out', async () => {
    const p = await newProject('platform', 'https://github.com/acme/platform-api');
    const withWeb = (await api('POST', `/projects/${p.id}/repositories`, { url: 'https://github.com/acme/platform-web' })).body;
    const [api_, web] = withWeb.repositories;
    const { worker } = await makeWorker(s, owner, p.id, { agents: [{ id: 'mock', installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: ['resume', 'additionalDirectories'] }] });
    const task = await s.tasks.create(owner, { projectId: p.id, title: 'both', prompt: 'x', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });

    // Only the primary repository is checked out: the claim is refused.
    const partial = await s.tasks.claim(worker, task.id);
    expect(partial).toMatchObject({ claimed: false, reason: expect.stringContaining('Not every repository') });

    await s.workers.heartbeat(worker, {
      metrics: {},
      activeTasks: [],
      sentAt: new Date().toISOString(),
      inventory: {
        agents: [{ id: 'mock', installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: ['resume', 'additionalDirectories'] }],
        providers: [{ id: 'mock', kind: 'mock', healthy: true, models: [{ id: 'mock-1' }] }],
        tools: [],
        projects: [
          { projectId: p.id, repositoryId: api_!.id, localPath: '/w/api' },
          { projectId: p.id, repositoryId: web!.id, localPath: '/w/web' },
        ],
      },
    });
    const claim = await s.tasks.claim(worker, task.id);
    expect(claim).toMatchObject({
      claimed: true,
      localPath: '/w/api',
      repositories: [
        { repositoryId: api_!.id, name: 'platform-api', localPath: '/w/api', primary: true, defaultBranch: 'main' },
        { repositoryId: web!.id, name: 'platform-web', localPath: '/w/web', primary: false, defaultBranch: 'main' },
      ],
    });
  });

  it('needs an agent that can work in several directories for multi-repository projects', () => {
    const worker = {
      id: 'w',
      online: true,
      approved: true,
      os: 'linux' as const,
      labels: [],
      activeTaskCount: 0,
      maxConcurrentTasks: 2,
      projects: { p: '/w/api' },
      agents: [{ id: 'aider', installed: true, supportedProviders: ['openai'], capabilities: ['resume'] }],
      providers: [{ id: 'openai', kind: 'openai', healthy: true, models: [{ id: 'gpt' }] }],
      tools: [],
    };
    const single = evaluateWorker(worker, { projectId: 'p' }, DEFAULT_POLICY);
    expect(single.eligible).toBe(true);
    const multi = evaluateWorker(worker, { projectId: 'p', repositoryCount: 2 }, DEFAULT_POLICY);
    expect(multi.eligible).toBe(false);
    expect(multi.checks.map((c) => c.label)).toContain('Has checkouts of all 2 repositories');
    expect(multi.checks.find((c) => c.label === 'Compatible agent + provider + model')?.ok).toBe(false);
    worker.agents[0]!.capabilities.push('additionalDirectories');
    expect(evaluateWorker(worker, { projectId: 'p', repositoryCount: 2 }, DEFAULT_POLICY).eligible).toBe(true);
  });
});

describe('migration 0004-project-repositories', () => {
  it('gives older projects a primary repository and ties their worker paths to it, once', async () => {
    const db = mongoose.connection.db!;
    const workerId = new mongoose.Types.ObjectId();
    const { insertedId } = await db.collection('projects').insertOne({
      organizationId: new mongoose.Types.ObjectId(owner.organizationId),
      name: 'Legacy App',
      repositoryUrl: 'git@github.com:acme/legacy.git',
      defaultBranch: 'trunk',
      workerPaths: [{ workerId, localPath: '/w/legacy' }],
    });
    const m = MIGRATIONS.find((x) => x.id === '0004-project-repositories')!;
    await m.up(db);
    await m.up(db); // idempotent
    const p = await db.collection('projects').findOne({ _id: insertedId });
    expect(p?.repositories).toEqual([expect.objectContaining({ name: 'legacy', key: 'github.com/acme/legacy', defaultBranch: 'trunk', primary: true })]);
    expect(p?.workerPaths).toEqual([{ workerId, localPath: '/w/legacy', repositoryId: p?.repositories[0]._id }]);
  });
});
