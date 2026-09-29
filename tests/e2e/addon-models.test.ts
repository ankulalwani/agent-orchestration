/**
 * End-to-end: harnesses run on their own login by default (no provider needed); add-on models are used
 * when that login reaches its limit — automatically or after asking, as the worker is set — through the
 * worker's model gateway; and tasks go back to the harness's own login once it is available again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Actor, Services } from '@ao/server';
import type { TaskDto } from '@ao/contracts';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { makeOwner, makeServices } from '../helpers.js';
import { FakeLlm } from '../fake-llm.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';
process.env.AO_MOCK_NATIVE_LOGIN = '1';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let projectId: string;
let worker: WorkerRuntime;
let llm: FakeLlm;

async function waitFor<T>(fn: () => Promise<T> | T, pred: (v: T) => boolean, timeoutMs = 30_000, label = ''): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label}: last=${JSON.stringify(last)?.slice(0, 800)}`);
}
const getTask = (id: string) => s.tasks.get(owner, id);
const createTask = (title: string) =>
  s.tasks.create(owner, { projectId, title, prompt: title, priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], policy: { verification: { enabled: false, autoDetect: false, steps: [] }, git: { policy: 'NONE' } } });
const done = (t: TaskDto) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED', 'CANCELLED'].includes(t.status);
const events = async (id: string) => (await s.tasks.events(owner, id, {} as never)).items;

beforeAll(async () => {
  llm = await new FakeLlm().start();
  llm.handler = () => ({ text: 'hello from the add-on model' });
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  s.scheduler.start();
  owner = (await makeOwner(s, 'addons')).actor;
  projectId = (await s.projects.create(owner, { name: 'app', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-addons-repo-'));
  await runCommand('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-addons-worker-'));
  worker = new WorkerRuntime(dataDir, { timeScale: 0.01 });
  worker.config.update({
    enableMockAgent: true,
    maxConcurrentTasks: 1,
    projects: [{ projectId, localPath: repo }],
    // One add-on provider (any OpenAI-compatible API); no provider for the harness itself.
    providers: [{ id: 'router', kind: 'openai-compatible', name: 'Router', baseUrl: llm.url, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'free-model' }] }],
    // Only the mock: never the real harnesses that may be installed on this machine.
    agents: { mock: { enabled: true, settings: { retryAtOffsetMs: 10 * 60_000 } }, ...Object.fromEntries(['claude-code', 'codex', 'gemini', 'opencode', 'aider'].map((a) => [a, { enabled: false, settings: {} }])) },
    addons: { onHarnessLimit: 'switch' },
  });
  await worker.init();
  const pairing = await worker.beginPairing('self-hosted', base, 'addons-worker');
  await s.workers.approvePairing(owner, pairing.userCode!);
  await waitFor(() => worker.client?.state, (st) => st === 'connected', 20_000, 'worker connection');
  await waitFor(async () => (await s.workers.list(owner))[0], (w) => Boolean(w?.providers.some((p) => (p as { id: string }).id === 'native:mock')), 20_000, 'own login in the inventory');
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  s.scheduler.stop();
  await app.close();
  await stopTestDatabase();
  llm.close();
});

describe('add-on models', { timeout: 90_000 }, () => {
  it("runs on the harness's own login by default, without any provider for it", async () => {
    process.env.AO_MOCK_NATIVE_SCENARIO = 'success';
    const t = await waitFor(async () => getTask((await createTask('own login')).id), () => true);
    const end = await waitFor(() => getTask(t.id), done, 30_000, 'task');
    expect(end).toMatchObject({ status: 'COMPLETED', agentId: 'mock', providerId: 'native:mock', modelId: 'default' });
    expect(llm.requests).toHaveLength(0);
  });

  it('switches to add-on models automatically when the own login reaches its limit (setting: switch)', async () => {
    process.env.AO_MOCK_NATIVE_SCENARIO = 'rate_limit';
    const t = await createTask('limit then switch');
    const end = await waitFor(() => getTask(t.id), done, 30_000, 'task');
    expect(end).toMatchObject({ status: 'COMPLETED', providerId: 'router' });
    // The mock went through the gateway to the add-on model the task ran on.
    expect(llm.requests.at(-1)).toMatchObject({ model: end.modelId });
    const fallback = (await events(t.id)).find((e) => e.type === 'FallbackStarted');
    expect(fallback?.payload).toMatchObject({ fromProviderId: 'native:mock', providerId: 'router', reason: 'HARNESS_LIMIT' });
    expect(worker.providers.isLimited('native:mock')).toBe(true);
  });

  it('asks first when set to ask; "switch" continues on add-on models', async () => {
    worker.providers.clearLimit('native:mock');
    worker.config.update({ addons: { onHarnessLimit: 'ask' } });
    const t = await createTask('limit then ask');
    const waiting = await waitFor(() => getTask(t.id), (x) => x.status === 'WAITING_FOR_INPUT', 30_000, 'question');
    expect(waiting.pendingInteraction?.question).toMatch(/own login reached its usage limit.*"switch".*"wait"/s);
    await s.tasks.action(owner, t.id, { action: 'input', input: 'switch' });
    const end = await waitFor(() => getTask(t.id), done, 30_000, 'task');
    expect(end).toMatchObject({ status: 'COMPLETED', providerId: 'router' });
  });

  it('"wait" waits for the limit to reset instead', async () => {
    worker.providers.clearLimit('native:mock');
    const t = await createTask('limit then wait');
    await waitFor(() => getTask(t.id), (x) => x.status === 'WAITING_FOR_INPUT', 30_000, 'question');
    await s.tasks.action(owner, t.id, { action: 'input', input: 'wait' });
    await waitFor(() => getTask(t.id), (x) => x.status === 'WAITING_FOR_LIMIT', 30_000, 'waiting for the limit');
    await s.tasks.action(owner, t.id, { action: 'cancel' });
    await waitFor(() => getTask(t.id), (x) => x.status === 'CANCELLED', 30_000, 'cancelled');
  });

  it("goes back to the harness's own login once it is available again", async () => {
    worker.providers.clearLimit('native:mock');
    process.env.AO_MOCK_NATIVE_SCENARIO = 'success';
    const t = await createTask('own login again');
    const end = await waitFor(() => getTask(t.id), done, 30_000, 'task');
    expect(end).toMatchObject({ status: 'COMPLETED', providerId: 'native:mock' });
  });
});
