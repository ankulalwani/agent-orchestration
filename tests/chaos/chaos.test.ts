/**
 * Chaos tests (spec §90): control plane outage mid-task, worker death with takeover by another worker.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { interruptTestDatabase, resumeTestDatabase, startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { cleanupStep, expireLease, makeOwner, makeServices } from '../helpers.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';

let s: Services;
let app: FastifyInstance;
let port = 0;
let base = '';
let owner: Actor;
let projectId: string;
const workers: WorkerRuntime[] = [];

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

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-chaos-repo-'));
  const g = (...a: string[]) => runCommand('git', a, { cwd: dir });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 'c@example.com');
  await g('config', 'user.name', 'C');
  await g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'check.js'), "process.exit(require('fs').existsSync('mock-output.txt')?0:1)");
  await g('add', '.');
  await g('commit', '-qm', 'init');
  return dir;
}

async function startWorker(name: string, localPath: string, delayMs: number) {
  const w = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), `ao-chaos-${name}-`)), { timeScale: 0.01 });
  w.config.update({
    enableMockAgent: true,
    maxConcurrentTasks: 1,
    projects: [{ projectId, localPath }],
    providers: [{ id: 'mock', kind: 'mock', name: 'Mock', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'scenario:slow' }] }],
    agents: { mock: { enabled: true, settings: { delayMs } } },
  });
  await w.init();
  const p = await w.beginPairing('self-hosted', base, name);
  await s.workers.approvePairing(owner, p.userCode!);
  await waitFor(async () => w.client?.state, (st) => st === 'connected', 20_000, `${name} connected`);
  workers.push(w);
  return w;
}

const policy = {
  verification: { enabled: true, autoDetect: false, steps: [{ kind: 'test' as const, name: 'check', command: [process.execPath, 'check.js'], required: true, timeoutMs: 20_000 }] },
  git: { policy: 'COMMIT' as const, workOnBranch: false },
};

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
  s.scheduler.start();
  owner = (await makeOwner(s, 'chaos')).actor;
  projectId = (await s.projects.create(owner, { name: 'chaos', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;
}, 60_000);

afterAll(async () => {
  for (const w of workers) await cleanupStep('worker.stop', () => w.stop());
  s.scheduler.stop();
  await cleanupStep('app.close', () => app.close());
  await cleanupStep('stopTestDatabase', () => stopTestDatabase());
}, 120_000);

describe('chaos', () => {
  it('control plane outage mid-task: worker keeps working, buffers events, resyncs, completes', async () => {
    const dir = await repo();
    const w = await startWorker('outage', dir, 3000);
    const t = await s.tasks.create(owner, { projectId, title: 'outage', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], policy });
    await waitFor(() => s.tasks.get(owner, t.id), (x) => x.status === 'RUNNING', 30_000, 'running');

    // Control plane goes down while the agent is working.
    await app.close();
    await new Promise((r) => setTimeout(r, 1500));
    expect(w.executor.running.has(t.id)).toBe(true); // task still running locally
    await waitFor(async () => w.buffer.size, (n) => n > 0, 10_000, 'events buffered while offline');

    // Control plane comes back on the same address.
    app = await buildApp(s);
    await app.listen({ port, host: '127.0.0.1' });
    const done = await waitFor(() => s.tasks.get(owner, t.id), (x) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(x.status), 60_000, 'completion after outage');
    expect(done.status).toBe('COMPLETED');
    await waitFor(async () => w.buffer.size, (n) => n === 0, 20_000, 'buffer drained');
    const types = (await s.tasks.events(owner, t.id, { limit: 500 })).items.map((e) => e.type);
    expect(types).toContain('AgentExited'); // produced while offline, delivered after reconnect
    await w.stop();
  }, 120_000);

  it('MongoDB outage mid-task: API degrades without crashing, the worker keeps going, everything completes after recovery', async () => {
    const dir = await repo();
    const w = await startWorker('mongo-outage', dir, 4000);
    const t = await s.tasks.create(owner, { projectId, title: 'mongo outage', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], policy });
    await waitFor(() => s.tasks.get(owner, t.id), (x) => x.status === 'RUNNING', 30_000, 'running');

    await interruptTestDatabase();
    const outageStart = Date.now();
    // Liveness stays OK (don't restart the process); readiness reports the database.
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await waitFor(() => fetch(`${base}/readyz`).then(async (r) => ({ status: r.status, body: await r.json() })), (r) => r.status === 503, 5_000, 'readyz degraded within 5 s');
    expect(ready.body).toMatchObject({ mongo: false });
    // Requests fail as retryable server errors instead of hanging or crashing the API.
    const res = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x@example.com', password: 'whatever-123' }) });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatchObject({ code: 'INTERNAL', retryable: true });
    await expect(s.scheduler.sweep()).resolves.toBeUndefined(); // background loops survive
    expect(w.executor.running.has(t.id)).toBe(true); // the agent keeps working locally
    await waitFor(async () => w.buffer.size, (n) => n > 0, 20_000, 'events buffered during the outage');

    await resumeTestDatabase();
    await waitFor(() => fetch(`${base}/readyz`).then((r) => r.status), (st) => st === 200, 30_000, 'readyz recovered');
    const done = await waitFor(() => s.tasks.get(owner, t.id), (x) => ['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(x.status), 90_000, 'completion after database recovery');
    expect(done.status).toBe('COMPLETED');
    expect(done.restartCount).toBe(0); // no lease was lost: continued, not restarted
    expect(Date.now() - outageStart).toBeGreaterThan(1000);
    await waitFor(async () => w.buffer.size, (n) => n === 0, 30_000, 'buffer drained');
    const types = (await s.tasks.events(owner, t.id, { limit: 500 })).items.map((e) => e.type);
    expect(types).toContain('AgentExited');
    await w.stop();
  }, 180_000);

  it('worker dies mid-task: lease expires, another worker continues from the checkpoint', async () => {
    const dir = await repo();
    const a = await startWorker('dying', dir, 20_000);
    const t = await s.tasks.create(owner, { projectId, title: 'takeover', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [], policy });
    await waitFor(() => s.tasks.get(owner, t.id), (x) => x.status === 'RUNNING' && x.workerId !== null, 30_000, 'running on A');
    const firstWorker = (await s.tasks.get(owner, t.id)).workerId;

    // Hard stop worker A (simulates machine loss): no further heartbeats.
    a.client?.close();
    await a.executor.shutdown();
    await expireLease(t.id);
    await s.tasks.sweepExpiredLeases();
    expect((await s.tasks.get(owner, t.id)).status).toBe('QUEUED');

    // Worker B (fast agent) picks it up.
    const b = await startWorker('rescuer', dir, 100);
    await s.scheduler.dispatch({ taskId: t.id, organizationId: owner.organizationId });
    const done = await waitFor(() => s.tasks.get(owner, t.id), (x) => x.status === 'COMPLETED', 60_000, 'completion on B');
    expect(done.workerId).not.toBe(firstWorker);
    expect(done.restartCount).toBeGreaterThanOrEqual(1);
    const events = (await s.tasks.events(owner, t.id, { limit: 500 })).items.map((e) => e.type);
    expect(events).toContain('LeaseExpired');
    await b.stop();
  }, 120_000);
});
