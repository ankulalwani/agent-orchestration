/**
 * End-to-end cloning: the dashboard asks a worker to clone a project repository into its projects folder;
 * the worker clones it (next to, never over, other folders), maps it, and reports back. Workers without a
 * projects folder, offline ones and ones that already have it are skipped with the reason.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog } from '@ao/database';
import type { ProjectDto } from '@ao/contracts';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { cleanupStep, makeOwner, makeServices, makeWorker } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let worker: WorkerRuntime;
let workerId: string;
let projectsRoot: string;
let remote: string;
let project: ProjectDto;

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

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  owner = (await makeOwner(s, 'clone')).actor;

  // A bare repository stands in for GitHub.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-clone-'));
  const src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  const g = (cwd: string, ...a: string[]) => runCommand('git', a, { cwd });
  await g(src, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(src, 'README.md'), '# shop\n');
  await g(src, 'add', '.');
  await g(src, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  remote = path.join(tmp, 'shop.git');
  await g(tmp, 'clone', '-q', '--bare', src, remote);
  project = await s.projects.create(owner, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
  project = await s.projects.updateRepository(owner, project.id, project.repositories[0]!.id, { name: 'shop' });
  // The repository's clone URL (a local path here; https for real repositories).
  const { Project } = await import('@ao/database');
  await Project.updateOne({ _id: project.id }, { $set: { 'repositories.0.url': remote } });

  projectsRoot = path.join(tmp, 'Projects');
  fs.mkdirSync(path.join(projectsRoot, 'shop'), { recursive: true });
  fs.writeFileSync(path.join(projectsRoot, 'shop', 'notes.txt'), 'something else lives here'); // must not be touched

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-clone-worker-'));
  worker = new WorkerRuntime(dataDir, { timeScale: 0.01 });
  await worker.init();
  const pairing = await worker.beginPairing('self-hosted', base, 'clone-worker');
  await s.workers.approvePairing(owner, pairing.userCode!);
  await waitFor(() => worker.client?.state, (st) => st === 'connected', 20_000, 'worker connection');
  workerId = worker.config.get().workerId!;
}, 120_000);

afterAll(async () => {
  await cleanupStep('worker.stop', () => worker?.stop());
  await cleanupStep('app.close', () => app.close());
  await cleanupStep('stopTestDatabase', () => stopTestDatabase());
}, 90_000);

describe('cloning to workers', () => {
  it('skips a worker without a projects folder', async () => {
    await worker.heartbeat(true);
    const r = await s.discovery.requestClone(owner, project.id, project.repositories[0]!.id, [workerId]);
    expect(r).toEqual({ requested: [], queued: [], skipped: [{ workerId, reason: expect.stringContaining('no projects folder') }] });
  });

  it('keeps a clone asked of an offline worker and sends it once when the worker connects', async () => {
    const elsewhere = await s.projects.create(owner, { name: 'elsewhere', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const offline = (await makeWorker(s, owner, elsewhere.id, { name: 'laptop', tools: ['git', 'clone'] })).worker;
    const repositoryId = project.repositories[0]!.id;
    expect(await s.discovery.requestClone(owner, project.id, repositoryId, [offline.workerId])).toEqual({ requested: [], queued: [offline.workerId], skipped: [] });
    // Asking again renews the request instead of adding one.
    await s.discovery.requestClone(owner, project.id, repositoryId, [offline.workerId]);
    expect(await s.discovery.queuedClones(owner, project.id)).toEqual([{ workerId: offline.workerId, repositoryId, expiresAt: expect.any(String) }]);

    const received: Array<Record<string, unknown>> = [];
    const unregister = s.live.registerWorker(offline.workerId, (m) => received.push(m as Record<string, unknown>));
    // Two connections at once (a reconnect racing the old socket) still send it once.
    expect((await Promise.all([s.discovery.deliverQueuedClones(offline), s.discovery.deliverQueuedClones(offline)])).reduce((a, b) => a + b, 0)).toBe(1);
    expect(received).toEqual([expect.objectContaining({ type: 'repository.clone', projectId: project.id, repositoryId, name: 'shop', url: remote })]);
    // The request it got is one the worker may ask a token for.
    await expect(s.discovery.cloneToken(offline, String(received[0]!.requestId))).resolves.toEqual({ token: null });
    expect(await s.discovery.queuedClones(owner, project.id)).toEqual([]);
    expect(await s.discovery.deliverQueuedClones(offline)).toBe(0);

    // A queued clone of a repository that was removed in the meantime is dropped.
    const gone = await s.projects.create(owner, { name: 'gone', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const { Project } = await import('@ao/database');
    await Project.updateOne({ _id: gone.id }, { $set: { 'repositories.0.url': remote } });
    unregister();
    expect((await s.discovery.requestClone(owner, gone.id, gone.repositories[0]!.id, [offline.workerId])).queued).toEqual([offline.workerId]);
    await s.projects.archive(owner, gone.id);
    received.length = 0;
    expect(await s.discovery.deliverQueuedClones(offline)).toBe(0);
    expect(received).toEqual([]);
  });

  it('clones into the projects folder next to an unrelated folder of the same name, and maps it', async () => {
    worker.config.update({ projectsRoot });
    await worker.heartbeat(true);
    await waitFor(async () => (await s.workers.list(owner)).find((w) => w.id === workerId)?.tools, (t) => Boolean(t?.includes('clone')), 10_000, 'clone capability');
    const r = await s.discovery.requestClone(owner, project.id, project.repositories[0]!.id, [workerId]);
    expect(r.requested).toEqual([workerId]);

    const p = await waitFor(() => s.projects.get(owner, project.id), (x) => x.workerPaths.length === 1, 30_000, 'clone mapped');
    const dest = path.join(projectsRoot, 'shop-2');
    expect(p.workerPaths[0]).toMatchObject({ workerId, repositoryId: project.repositories[0]!.id, localPath: dest });
    expect(fs.readFileSync(path.join(dest, 'README.md'), 'utf8').trim()).toBe('# shop'); // line endings follow core.autocrlf
    expect(fs.readdirSync(path.join(projectsRoot, 'shop'))).toEqual(['notes.txt']);
    expect(worker.clones[0]).toMatchObject({ status: 'done', localPath: dest });
    await waitFor(() => AuditLog.countDocuments({ action: 'project.repository_cloned' }), (n) => n === 1, 10_000, 'clone reported');
  });

  it('skips a worker that already has the repository', async () => {
    const r = await s.discovery.requestClone(owner, project.id, project.repositories[0]!.id, [workerId]);
    expect(r.skipped).toEqual([{ workerId, reason: expect.stringContaining('already has it') }]);
  });

  it('refuses clone tokens for requests that are not this worker’s', async () => {
    const actor = { workerId, organizationId: owner.organizationId, correlationId: 't' };
    await expect(s.discovery.cloneToken(actor, 'made-up-request')).rejects.toThrow(/No such clone request/);
  });
});
