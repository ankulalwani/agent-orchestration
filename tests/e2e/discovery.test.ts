/**
 * End-to-end repository discovery: a real worker scans a folder tree for Git repositories. Clones of
 * repositories that are in projects are mapped automatically; others are suggested in the dashboard,
 * and accepting one creates its project and maps it. The worker never maps a folder it did not find.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX, type DiscoveredSuggestionDto, type ProjectDto } from '@ao/contracts';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { scanForRepositories } from '../../apps/worker/src/discovery.js';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let token: string;
let worker: WorkerRuntime;
let root: string;
let apiProject: ProjectDto;

process.env.AO_CREDENTIAL_BACKEND = 'file';

async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 20_000, label = ''): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last)?.slice(0, 600)}`);
}

async function repoAt(rel: string, opts: { remote?: string; commit?: boolean } = {}) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a: string[]) => runCommand('git', a, { cwd: dir });
  await g('init', '-q', '-b', 'main');
  if (opts.remote) await g('remote', 'add', 'origin', opts.remote);
  if (opts.commit !== false) {
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${rel}\n${Math.random()}\n`);
    await g('add', '.');
    await g('-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  }
  return dir;
}

const api = async <T,>(method: 'GET' | 'POST', url: string, payload?: unknown) => {
  const r = await app.inject({ method, url: `${API_PREFIX}/orgs/${owner.organizationId}${url}`, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() as T };
};
const mapped = () => worker.config.get().projects;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const o = await makeOwner(s, 'disc');
  owner = o.actor;
  token = o.auth.accessToken;
  apiProject = await s.projects.create(owner, { name: 'api', description: '', repositoryUrl: 'https://github.com/acme/api', defaultBranch: 'main', environments: [], knowledge: '' });

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-discovery-'));
  await repoAt('work/api', { remote: 'git@github.com:acme/api.git' }); // matches the project
  await repoAt('work/web', { remote: 'https://github.com/acme/web.git' }); // unknown for now
  await repoAt('work/tool'); // no remote: known by its root commit
  await repoAt('work/empty', { commit: false }); // no remote, no commits
  await repoAt('work/site/node_modules/dep', { remote: 'https://github.com/x/dep' }); // dependency folder: skipped
  await repoAt('a/b/c/d/e/f/g/h/i/deep'); // deeper than maxDepth
  await repoAt('work/api/packages/nested'); // inside a repository: not searched

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-discovery-worker-'));
  worker = new WorkerRuntime(dataDir, { timeScale: 0.01 });
  worker.config.update({ discovery: { enabled: true, roots: [root], exclude: [], intervalHours: 6, maxDepth: 6 } });
  await worker.init();
  const pairing = await worker.beginPairing('self-hosted', base, 'disc-worker');
  await s.workers.approvePairing(owner, pairing.userCode!);
  await waitFor(() => worker.client?.state, (st) => st === 'connected', 20_000, 'worker connection');
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await app.close();
  await stopTestDatabase();
});

describe('repository discovery', () => {
  it('finds repositories, skipping dependency folders, nested repositories and folders past the depth limit', async () => {
    const r = await scanForRepositories({ roots: [root], maxDepth: 6 });
    expect(r.repos.map((x) => path.relative(root, x.localPath).replace(/\\/g, '/')).sort()).toEqual(['work/api', 'work/empty', 'work/tool', 'work/web']);
    const api = r.repos.find((x) => x.localPath.endsWith('api'))!;
    expect(api).toMatchObject({ name: 'api', branch: 'main', remotes: [{ name: 'origin', url: 'git@github.com:acme/api.git' }], rootCommit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(r.repos.find((x) => x.localPath.endsWith('empty'))?.rootCommit).toBeNull();
  });

  it('maps a clone of a project repository automatically and suggests the rest', async () => {
    await worker.scanRepositories();
    const auto = await waitFor(mapped, (p) => p.length === 1, 10_000, 'automatic mapping');
    expect(auto[0]).toMatchObject({ projectId: apiProject.id, repositoryId: apiProject.repositories[0]!.id, localPath: path.join(root, 'work', 'api') });
    // The next heartbeat tells the control plane; the project now has this worker's checkout.
    await waitFor(() => s.projects.get(owner, apiProject.id), (p) => p.workerPaths.length === 1, 10_000, 'checkout on the project');

    const suggestions = (await api<DiscoveredSuggestionDto[]>('GET', '/discovered')).body;
    expect(suggestions.map((x) => [x.name, x.key?.replace(/^local:[0-9a-f]+$/, 'local:…') ?? null]).sort()).toEqual([
      ['empty', null],
      ['tool', 'local:…'],
      ['web', 'github.com/acme/web'],
    ]);
    expect(suggestions[0]!.locations[0]).toMatchObject({ workerName: 'disc-worker' });
  });

  it('maps an already found clone as soon as its repository joins a project', async () => {
    await s.projects.addRepository(owner, apiProject.id, { url: 'https://github.com/acme/web' });
    const web = await waitFor(mapped, (p) => p.some((x) => x.localPath.endsWith('web')), 10_000, 'mapping pushed over the socket');
    expect(web.find((x) => x.localPath.endsWith('web'))).toMatchObject({ projectId: apiProject.id });
    expect((await api<DiscoveredSuggestionDto[]>('GET', '/discovered')).body.map((x) => x.name).sort()).toEqual(['empty', 'tool']);
  });

  it('creates a project from a suggestion and maps it where it was found; dismissed ones stay hidden', async () => {
    const [empty, tool] = (await api<DiscoveredSuggestionDto[]>('GET', '/discovered')).body.sort((a, b) => a.name.localeCompare(b.name));
    const accepted = await api<ProjectDto>('POST', '/discovered/accept', { ids: tool!.locations.map((l) => l.id) });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ name: 'tool', repositories: [expect.objectContaining({ key: tool!.key, source: 'discovered', url: null, primary: true })] });
    await waitFor(mapped, (p) => p.some((x) => x.projectId === accepted.body.id), 10_000, 'accepted mapping');

    expect((await api('POST', '/discovered/dismiss', { ids: empty!.locations.map((l) => l.id) })).status).toBe(200);
    expect((await api<DiscoveredSuggestionDto[]>('GET', '/discovered')).body).toEqual([]);
    // A second scan does not bring the dismissed repository back.
    await worker.scanRepositories();
    expect((await api<DiscoveredSuggestionDto[]>('GET', '/discovered')).body).toEqual([]);
  });

  it('never maps a folder the worker did not find itself', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-not-found-'));
    const before = mapped().length;
    expect(worker.applyMappings([{ projectId: apiProject.id, repositoryId: '0'.repeat(24), localPath: outside }])).toBe(0);
    expect(mapped()).toHaveLength(before);
  });

  it('forgets folders that are gone', async () => {
    fs.rmSync(path.join(root, 'work', 'empty'), { recursive: true, force: true });
    await worker.scanRepositories();
    const { DiscoveredRepository } = await import('@ao/database');
    expect(await DiscoveredRepository.countDocuments({ localPath: path.join(root, 'work', 'empty') })).toBe(0);
  });
});
