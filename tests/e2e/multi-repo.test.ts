/**
 * End-to-end: a project with two repositories. The worker only gets the task once it has both checked
 * out; the agent is given both (the primary as working directory, the other as an extra directory and in
 * the prompt); each repository is verified and committed on the same task branch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Actor, Services } from '@ao/server';
import type { ProjectDto, TaskDto } from '@ao/contracts';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { cleanupStep, makeOwner, makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let project: ProjectDto;
let worker: WorkerRuntime;
const repos: Record<'api' | 'web', string> = { api: '', web: '' };

process.env.AO_CREDENTIAL_BACKEND = 'file';

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000, label = ''): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last)?.slice(0, 600)}`);
}

async function gitRepo(name: string, files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ao-multi-${name}-`));
  const g = (...a: string[]) => runCommand('git', a, { cwd: dir });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'e2e@example.com');
  await g('config', 'user.name', 'E2E');
  await g('config', 'commit.gpgsign', 'false');
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  await g('add', '.');
  await g('commit', '-qm', 'init');
  return dir;
}
const git = async (dir: string, ...a: string[]) => (await runCommand('git', a, { cwd: dir })).stdout.trim();

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  s.scheduler.start();
  owner = (await makeOwner(s, 'multi')).actor;
  project = await s.projects.create(owner, { name: 'shop', description: '', repositoryUrl: 'https://github.com/acme/shop-api', defaultBranch: 'main', environments: [], knowledge: '' });
  project = await s.projects.addRepository(owner, project.id, { url: 'https://github.com/acme/shop-web' });

  // The primary repository has the verification script; the other one has none (verification warns).
  repos.api = await gitRepo('api', { 'check.js': "require('fs').existsSync('mock-output.txt') || process.exit(1)" });
  repos.web = await gitRepo('web', { 'README.md': '# web\n' });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-multi-worker-'));
  worker = new WorkerRuntime(dataDir, { timeScale: 0.01 });
  const [api, web] = project.repositories;
  worker.config.update({
    enableMockAgent: true,
    maxConcurrentTasks: 1,
    // Only the primary repository at first.
    projects: [{ projectId: project.id, repositoryId: api!.id, localPath: repos.api }],
    providers: [{ id: 'mocka', kind: 'mock', name: 'Mock', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'scenario:success' }] }],
    agents: { mock: { enabled: true, settings: {} } },
  });
  void web;
  await worker.init();
  const pairing = await worker.beginPairing('self-hosted', base, 'multi-worker');
  await s.workers.approvePairing(owner, pairing.userCode!);
  await waitFor(async () => worker.client?.state, (st) => st === 'connected', 20_000, 'worker connection');
  await waitFor(async () => (await s.workers.list(owner))[0], (w) => w?.status === 'ONLINE' && w.agents.some((a) => a.id === 'mock'), 20_000, 'worker online');
}, 120_000);

afterAll(async () => {
  await cleanupStep('worker.stop', () => worker?.stop());
  s.scheduler.stop();
  await cleanupStep('app.close', () => app.close());
  await cleanupStep('stopTestDatabase', () => stopTestDatabase());
}, 90_000);

describe('multi-repository task', () => {
  it('waits for every repository, then changes, verifies and commits each one', async () => {
    const task = await s.tasks.create(owner, {
      projectId: project.id,
      title: 'Add the feature on both sides',
      prompt: 'Change the API and the web app.',
      priority: 'NORMAL',
      dependencies: [],
      requirements: {},
      capabilityIds: [],
      policy: {
        verification: { enabled: true, autoDetect: true, steps: [{ kind: 'test', name: 'check', command: [process.execPath, 'check.js'], required: true, timeoutMs: 20_000 }] },
        git: { policy: 'COMMIT', workOnBranch: true },
      },
    });
    const waiting = await waitFor(() => s.tasks.get(owner, task.id), (t) => (t.statusReason ?? '').includes('Waiting for an eligible worker'), 20_000, 'waiting reason');
    expect(waiting.status).toBe('QUEUED');
    expect(waiting.statusReason).toContain('Has checkouts of all 2 repositories');

    // Map the second repository; the next heartbeat makes the worker eligible.
    worker.config.update({ projects: [...worker.config.get().projects, { projectId: project.id, repositoryId: project.repositories[1]!.id, localPath: repos.web }] });
    await worker.heartbeat(true);
    const done = await waitFor(() => s.tasks.get(owner, task.id), (t: TaskDto) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(t.status), 60_000, 'task completion');
    expect(done.status).toBe('COMPLETED');

    // Both repositories are on the task branch with a commit containing the agent's change.
    const branch = done.gitResult!.branch!;
    expect(branch).toMatch(/^ao\//);
    for (const dir of [repos.api, repos.web]) {
      expect(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch);
      expect(await git(dir, 'show', '--name-only', '--format=', 'HEAD')).toContain('mock-output.txt');
    }
    // The agent got the web repository as an extra directory and saw it listed in the prompt.
    expect(fs.readFileSync(path.join(repos.web, 'mock-output.txt'), 'utf8')).toContain('prompt-lists-repo:true');

    expect(done.gitStatus).toBe('COMMITTED');
    expect(done.gitResult!.repositories).toEqual([expect.objectContaining({ name: 'shop-web', branch, commit: expect.any(String), filesChanged: [expect.objectContaining({ path: 'mock-output.txt' })] })]);
    expect(done.completionReport!.filesChanged).toEqual(expect.arrayContaining(['mock-output.txt', 'shop-web/mock-output.txt']));
    // The web repository has no checks of its own: verification says so instead of passing silently.
    expect(done.verificationRuns.at(-1)!.warnings.some((w) => w.startsWith('shop-web: '))).toBe(true);
  }, 120_000);
});
