/**
 * A real coding task with Claude Code (AGENT-005 success path): real control plane, real worker, the
 * installed `claude` CLI with its own login, a small bug in a scratch repository, verification by the
 * worker, and a commit. Opt-in (AO_TEST_CLAUDE_LIVE=1): it uses the machine owner's Claude usage.
 * AO_TEST_CLAUDE_MODEL picks the model (default: Haiku, the cheapest).
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
import { cleanupStep, makeOwner, makeServices } from '../helpers.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';
const enabled = process.env.AO_TEST_CLAUDE_LIVE === '1';
const MODEL = process.env.AO_TEST_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let worker: WorkerRuntime;
let repo: string;
let projectId: string;

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, timeoutMs: number, label: string): Promise<T> {
  const t0 = Date.now();
  let last: T | undefined;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)?.slice(0, 800)}`);
}

describe.runIf(enabled)('Claude Code, live', () => {
  beforeAll(async () => {
    await startTestDatabase();
    s = (await makeServices()).services;
    app = await buildApp(s);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    s.scheduler.start();
    owner = (await makeOwner(s, 'live')).actor;
    projectId = (await s.projects.create(owner, { name: 'calc', description: '', defaultBranch: 'main', environments: [], knowledge: 'Plain Node.js, no dependencies. Keep the code style.' })).id;

    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-live-claude-'));
    const g = (...a: string[]) => runCommand('git', a, { cwd: repo });
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 'live@example.com');
    await g('config', 'user.name', 'Live');
    await g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'math.js'), "// Arithmetic helpers.\nfunction add(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add };\n");
    fs.writeFileSync(
      path.join(repo, 'test.js'),
      "const assert = require('node:assert');\nconst { add } = require('./math');\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-1, 1), 0);\nconsole.log('ok');\n",
    );
    await g('add', '.');
    await g('commit', '-qm', 'init');

    worker = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-live-worker-')));
    worker.config.update({
      maxConcurrentTasks: 1,
      projects: [{ projectId, localPath: repo }],
      providers: [{ id: 'anthropic', kind: 'anthropic', name: 'Anthropic (Claude login)', baseUrl: null, credentialRef: null, useAgentLogin: true, enabled: true, extra: {}, models: [{ id: MODEL }] }],
      agents: { 'claude-code': { enabled: true, settings: {} } },
    });
    await worker.init();
    const pairing = await worker.beginPairing('self-hosted', base, 'live-worker');
    await s.workers.approvePairing(owner, pairing.userCode!);
    await waitFor(async () => (await s.workers.list(owner))[0], (w) => w?.status === 'ONLINE' && w.agents.some((a) => a.id === 'claude-code' && a.installed), 60_000, 'worker online with Claude Code');
  }, 120_000);

  afterAll(async () => {
    await cleanupStep('worker.stop', () => worker?.stop());
    s?.scheduler.stop();
    await cleanupStep('app.close', () => app?.close());
    await cleanupStep('stopTestDatabase', () => stopTestDatabase());
  }, 90_000);

  it('fixes a bug, the worker verifies it, and commits', async () => {
    const t = await s.tasks.create(owner, {
      projectId,
      title: 'Fix add() in math.js',
      prompt: 'add() in math.js returns the wrong result. Fix it so that `node test.js` passes. Change only math.js.',
      priority: 'NORMAL',
      dependencies: [],
      requirements: {},
      capabilityIds: [],
      policy: {
        models: { preferred: [{ providerId: 'anthropic', modelId: MODEL }] },
        verification: { enabled: true, autoDetect: false, steps: [{ kind: 'test', name: 'node test.js', command: [process.execPath, 'test.js'], required: true, timeoutMs: 60_000 }] },
        git: { policy: 'COMMIT', workOnBranch: true },
      },
    });
    const done: TaskDto = await waitFor(() => s.tasks.get(owner, t.id), (x) => ['COMPLETED', 'FAILED', 'CANCELLED', 'RECOVERY_REQUIRED', 'WAITING_FOR_INPUT', 'WAITING_FOR_LIMIT'].includes(x.status), 8 * 60_000, 'task end');
    await worker.flush();
    const events = (await s.tasks.events(owner, t.id, { limit: 1000, includeOutput: true })).items;
    const summary = events.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`).join('\n');
    fs.writeFileSync(path.resolve('test-results', 'claude-live-events.txt'), summary);
    expect(done.status, `${done.statusReason}\n${summary.slice(-4000)}`).toBe('COMPLETED');
    expect(done.agentId).toBe('claude-code');
    expect(done.modelId).toBe(MODEL);
    expect(done.verificationStatus).toBe('PASSED');
    expect(done.gitStatus).toBe('COMMITTED');
    expect(done.gitResult?.filesChanged.map((f) => f.path)).toEqual(['math.js']);
    expect(fs.readFileSync(path.join(repo, 'math.js'), 'utf8')).toMatch(/a \+ b/);
    // Claude Code's session id and usage came through the stream-json parser.
    expect(done.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    const exited = events.find((e) => e.type === 'AgentExited')!.payload as { state: string; costUsd?: number; outputTokens?: number };
    expect(exited.state).toBe('COMPLETED');
    expect(exited.outputTokens ?? 0).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'CommandExecuted')).toBe(true);
    expect(done.completionReport?.summary.length).toBeGreaterThan(10);
    console.log(`Claude Code live task: ${done.status}, cost $${exited.costUsd ?? '?'}, ${exited.outputTokens} output tokens, report: ${done.completionReport?.summary.slice(0, 200)}`);
  }, 10 * 60_000);
});
