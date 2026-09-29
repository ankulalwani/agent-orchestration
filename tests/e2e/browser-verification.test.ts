/**
 * Browser verification inside a task (spec §43, §76) + artifact storage (§62), end to end:
 * API + worker + mock agent; verification opens a page in Chromium via Playwright, captures console
 * errors and a screenshot, uploads the screenshot to artifact storage, and the user downloads it.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { makeOwner, makeServices } from '../helpers.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';
let hasPlaywright = true;
try {
  await import('playwright');
} catch {
  hasPlaywright = false;
}

describe.runIf(hasPlaywright)('browser verification with artifacts', () => {
  let s: Services;
  let app: FastifyInstance;
  let base: string;
  let owner: Actor;
  let worker: WorkerRuntime;
  let site: http.Server;
  let siteUrl: string;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-artifacts-'));
  // Inside the repo so the project resolves the repo's Playwright installation.
  const projectDir = path.resolve('.tmp-e2e', `browser-${Date.now()}`);

  beforeAll(async () => {
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.url === '/bad' ? '<h1>Checkout</h1><script>console.error("TypeError: cart is undefined")</script>' : '<h1>Checkout</h1>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}`;

    await startTestDatabase();
    s = (await makeServices({ ARTIFACT_DIR: artifactDir })).services;
    app = await buildApp(s);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    s.scheduler.start();
    owner = (await makeOwner(s, 'browser')).actor;
    const project = await s.projects.create(owner, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });

    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"shop","private":true}');
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'b@example.com'], ['config', 'user.name', 'B'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-qm', 'init']]) await runCommand('git', a, { cwd: projectDir });

    worker = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-bv-worker-')), { timeScale: 0.01 });
    worker.config.update({
      enableMockAgent: true,
      projects: [{ projectId: project.id, localPath: projectDir }],
      providers: [{ id: 'mock', kind: 'mock', name: 'Mock', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'scenario:success' }] }],
    });
    await worker.init();
    const p = await worker.beginPairing('self-hosted', base, 'bv');
    await s.workers.approvePairing(owner, p.userCode!);
    for (let i = 0; i < 100 && worker.client?.state !== 'connected'; i++) await new Promise((r) => setTimeout(r, 100));
    (globalThis as any).__projectId = project.id;
  }, 120_000);

  afterAll(async () => {
    // Each step is bounded and named, so a slow one shows up in the output instead of failing the file.
    const step = async (name: string, fn: () => unknown, ms = 20_000) => {
      const t0 = Date.now();
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.resolve().then(fn), new Promise((r) => (timer = setTimeout(r, ms)))]);
      clearTimeout(timer);
      if (Date.now() - t0 > ms / 2) console.warn(`[browser-verification cleanup] "${name}" took ${Date.now() - t0} ms`);
    };
    await step('worker.stop', () => worker?.stop());
    s?.scheduler.stop();
    await step('app.close', () => app?.close());
    await step('stopTestDatabase', () => stopTestDatabase());
    site?.close();
    await step('remove .tmp-e2e', () => fs.rmSync(path.resolve('.tmp-e2e'), { recursive: true, force: true, maxRetries: 5 }));
  }, 90_000);

  async function runTask(url: string) {
    const t = await s.tasks.create(owner, {
      projectId: (globalThis as any).__projectId,
      title: 'checkout ui',
      prompt: 'fix checkout',
      priority: 'NORMAL',
      dependencies: [],
      requirements: {},
      capabilityIds: [],
      policy: { maxRemediationAttempts: 0, git: { policy: 'NONE' }, verification: { autoDetect: false, steps: [{ kind: 'browser', name: 'checkout page', url, required: true, timeoutMs: 30_000 }] } },
    });
    for (let i = 0; i < 600; i++) {
      const x = await s.tasks.get(owner, t.id);
      if (['COMPLETED', 'RECOVERY_REQUIRED', 'FAILED'].includes(x.status)) return x;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('task did not settle');
  }

  it('fails on console errors with a screenshot stored as an artifact; user can download it', async () => {
    const t = await runTask(`${siteUrl}/bad`);
    expect(t.status).toBe('RECOVERY_REQUIRED');
    const step = t.verificationRuns[0]!.steps[0]!;
    expect(step.status).toBe('failed');
    expect(step.outputTail).toContain('cart is undefined');
    expect(step.artifacts[0]?.contentType).toBe('image/png');

    const token = (await s.auth.issueSession(owner.userId)).accessToken;
    const name = step.artifacts[0]!.key.split('/').pop()!;
    const res = await fetch(`${base}/api/v1/orgs/${owner.organizationId}/tasks/${t.id}/artifacts/${name}`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.length).toBeGreaterThan(1000);

    // Another organization cannot read it.
    const other = await makeOwner(s, 'other-org');
    const otherToken = (await s.auth.issueSession(other.actor.userId)).accessToken;
    const denied = await fetch(`${base}/api/v1/orgs/${other.actor.organizationId}/tasks/${t.id}/artifacts/${name}`, { headers: { authorization: `Bearer ${otherToken}` } });
    expect(denied.status).toBe(404);
  }, 120_000);

  it('passes when the page has no errors', async () => {
    const t = await runTask(`${siteUrl}/good`);
    expect(t.status).toBe('COMPLETED');
    expect(t.verificationRuns[0]!.steps[0]!.status).toBe('passed');
  }, 120_000);
});
