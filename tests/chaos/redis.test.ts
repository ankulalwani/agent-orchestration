/**
 * Multi-instance control plane on real Redis (LIVE-001, TASK-003, TEST-003 "Redis restart"): two API
 * instances share MongoDB and Redis (BullMQ dispatch + pub/sub bridge); a real worker connects to one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { createServices, type Actor, type Services } from '@ao/server';
import type { LiveMessage } from '@ao/contracts';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { makeOwner, testConfig } from '../helpers.js';
import { REDIS_BIN, startRedis, type TestRedis } from '../redis-helper.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs = 30_000, label = ''): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout: ${label} last=${JSON.stringify(last)?.slice(0, 400)}`);
}

interface Instance {
  s: Services;
  app: FastifyInstance;
  base: string;
}

describe.runIf(REDIS_BIN)('two API instances on real Redis', () => {
  let redis: TestRedis;
  let A: Instance;
  let B: Instance;
  let owner: Actor;
  let projectId: string;
  let worker: WorkerRuntime;
  let workerId: string;

  async function instance(): Promise<Instance> {
    const s = await createServices(testConfig({ REDIS_URL: redis.url, SWEEP_INTERVAL_MS: '1000' }), { mailer: { send: async () => undefined } });
    expect(s.queue.driver).toBe('bullmq');
    const app = await buildApp(s);
    await app.listen({ port: 0, host: '127.0.0.1' });
    s.scheduler.start();
    return { s, app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}` };
  }

  const newTask = (s: Services, title: string, delayScenario = 'scenario:slow') =>
    s.tasks.create(owner, {
      projectId,
      title,
      prompt: 'p',
      priority: 'NORMAL',
      dependencies: [],
      requirements: {},
      capabilityIds: [],
      policy: {
        models: { preferred: [{ providerId: 'mock', modelId: delayScenario }] },
        verification: { enabled: true, autoDetect: false, steps: [{ kind: 'test', name: 'check', command: [process.execPath, 'check.js'], required: true, timeoutMs: 20_000 }] },
        git: { policy: 'COMMIT', workOnBranch: false },
      },
    });

  beforeAll(async () => {
    await startTestDatabase();
    redis = await startRedis();
    A = await instance();
    B = await instance();
    owner = (await makeOwner(A.s, 'redis')).actor;
    projectId = (await A.s.projects.create(owner, { name: 'redis', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-redis-repo-'));
    const g = (...a: string[]) => runCommand('git', a, { cwd: dir });
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 'r@example.com');
    await g('config', 'user.name', 'R');
    await g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync('mock-output.txt')?0:1)");
    await g('add', '.');
    await g('commit', '-qm', 'init');

    // The worker talks only to instance A.
    worker = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-redis-worker-')), { timeScale: 0.01 });
    worker.config.update({
      enableMockAgent: true,
      maxConcurrentTasks: 1,
      projects: [{ projectId, localPath: dir }],
      providers: [{ id: 'mock', kind: 'mock', name: 'Mock', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'scenario:slow' }, { id: 'scenario:success' }] }],
      agents: { mock: { enabled: true, settings: { delayMs: 3000 } } },
    });
    await worker.init();
    const p = await worker.beginPairing('self-hosted', A.base, 'redis-worker');
    await A.s.workers.approvePairing(owner, p.userCode!);
    await waitFor(async () => worker.client?.state, (st) => st === 'connected', 20_000, 'worker connected to A');
    workerId = worker.config.get().workerId!;
  }, 120_000);

  afterAll(async () => {
    await worker?.stop().catch(() => undefined);
    for (const i of [A, B]) {
      if (!i) continue;
      i.s.scheduler.stop();
      i.s.live.stop();
      await i.app.close().catch(() => undefined);
      await i.s.queue.close().catch(() => undefined);
    }
    await redis?.kill();
    await stopTestDatabase();
  });

  it('B knows about a worker connected to A, dispatches to it, and sees its live updates', async () => {
    // The worker sees its socket open slightly before A has processed its hello and registered it.
    await waitFor(async () => A.s.live.isWorkerConnected(workerId), Boolean, 10_000, 'A registers the worker');
    await waitFor(async () => B.s.live.isWorkerConnected(workerId), Boolean, 15_000, 'B learns presence');
    // A replica started later learns about the worker too (presence sync on start).
    const C = await instance();
    await waitFor(async () => C.s.live.isWorkerConnected(workerId), Boolean, 3_000, 'late replica learns presence at once, not at the next 10 s announcement');
    C.s.scheduler.stop();
    C.s.live.stop();
    await C.app.close();
    await C.s.queue.close();

    const seenOnB: LiveMessage[] = [];
    const off = B.s.live.subscribeOrg(owner.organizationId, (m) => seenOnB.push(m));
    const t = await newTask(B.s, 'created on B', 'scenario:success'); // enqueued in BullMQ by B
    const done = await waitFor(() => B.s.tasks.get(owner, t.id), (x) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(x.status), 60_000, 'completion');
    expect(done.status).toBe('COMPLETED');
    // Status changes happen on A (the worker's instance) and reach B's subscribers through Redis,
    // which can be a moment after MongoDB already shows them.
    const statuses = () => seenOnB.filter((m) => m.type === 'task.updated').map((m) => (m as { task: { status: string } }).task.status);
    await waitFor(async () => statuses(), (s) => s.includes('COMPLETED'), 10_000, 'COMPLETED relayed to B');
    off();
    expect(statuses()).toEqual(expect.arrayContaining(['RUNNING', 'COMPLETED']));
  }, 120_000);

  it('a cancel sent through B reaches the worker connected to A', async () => {
    const t = await newTask(A.s, 'long');
    await waitFor(() => A.s.tasks.get(owner, t.id), (x) => x.status === 'RUNNING', 30_000, 'running');
    await B.s.tasks.action(owner, t.id, { action: 'cancel' });
    await waitFor(async () => worker.executor.running.has(t.id), (r) => !r, 15_000, 'worker stopped the agent');
    expect((await A.s.tasks.get(owner, t.id)).status).toBe('CANCELLED');
  }, 90_000);

  it('Redis dies mid-task: nothing hangs, the running task finishes, queued work resumes after Redis returns', async () => {
    const running = await newTask(A.s, 'during redis outage');
    await waitFor(() => A.s.tasks.get(owner, running.id), (x) => x.status === 'RUNNING', 30_000, 'running');

    await redis.kill();
    const ready = await waitFor(() => fetch(`${A.base}/readyz`).then(async (r) => ({ status: r.status, body: await r.json() })), (r) => r.status === 503, 10_000, 'readyz degraded');
    expect(ready.body).toMatchObject({ mongo: true, queue: false });
    // Creating a task doesn't hang on the queue: MongoDB records it; the sweeper enqueues it later.
    const t0 = Date.now();
    const queued = await newTask(B.s, 'created during redis outage', 'scenario:success');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(queued.status).toBe('QUEUED');
    // The running task doesn't depend on Redis (worker ↔ API over HTTP/WebSocket, state in MongoDB).
    expect((await waitFor(() => A.s.tasks.get(owner, running.id), (x) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(x.status), 60_000, 'running task finishes')).status).toBe('COMPLETED');

    await redis.restart(); // empty: every queued job was lost
    await waitFor(() => fetch(`${A.base}/readyz`).then((r) => r.status), (st) => st === 200, 30_000, 'readyz recovered');
    const done = await waitFor(() => B.s.tasks.get(owner, queued.id), (x) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(x.status), 90_000, 'task created during the outage completes');
    expect(done.status).toBe('COMPLETED');
    // Presence recovers too: B still knows the worker after the Redis restart.
    await waitFor(async () => B.s.live.isWorkerConnected(workerId), Boolean, 30_000, 'presence after restart');
  }, 180_000);
});

