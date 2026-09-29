import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let base: string;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

async function api(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + '/api/v1' + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

function nextMessage(ws: WebSocket, pred: (m: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ws message: ' + pred.toString())), timeoutMs);
    const on = (raw: WebSocket.RawData) => {
      const m = JSON.parse(raw.toString());
      if (pred(m)) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(m);
      }
    };
    ws.on('message', on);
  });
}

describe('HTTP API end-to-end', () => {
  it('runs the full control-plane flow over HTTP and WebSockets', async () => {
    const reg = await api('POST', '/auth/register', { email: `e2e-${Date.now()}@example.com`, password: 'long-enough-password', name: 'E2E' });
    expect(reg.status).toBe(200);
    const token = reg.body.accessToken as string;
    const orgId = reg.body.memberships[0].organizationId as string;

    const proj = await api('POST', `/orgs/${orgId}/projects`, { name: 'shop' }, token);
    expect(proj.status).toBe(200);

    // Worker pairing via device code.
    const start = await api('POST', '/worker/pairing', { name: 'laptop', hostname: 'laptop', os: 'linux', arch: 'x64', version: '0.1.0' });
    expect(start.body.userCode).toMatch(/^[A-Z]{4}-\d{4}$/);
    expect((await api('POST', '/worker/pairing/poll', { pairingId: start.body.pairingId, pollSecret: start.body.pollSecret })).body.status).toBe('PENDING');
    expect((await api('POST', '/worker/pairing/poll', { pairingId: start.body.pairingId, pollSecret: 'wrong' })).status).toBe(404);
    expect((await api('POST', '/pairing/approve', { userCode: start.body.userCode, organizationId: orgId }, token)).status).toBe(200);
    const poll = await api('POST', '/worker/pairing/poll', { pairingId: start.body.pairingId, pollSecret: start.body.pollSecret });
    expect(poll.body.status).toBe('APPROVED');
    const cred = poll.body.credential as string;
    // Credential is minted once.
    expect((await api('POST', '/worker/pairing/poll', { pairingId: start.body.pairingId, pollSecret: start.body.pollSecret })).body.status).toBe('EXPIRED');

    // Browser live stream.
    const live = new WebSocket(base.replace('http', 'ws') + '/api/v1/live');
    await new Promise((r) => live.once('open', r));
    live.send(JSON.stringify({ type: 'auth', token, organizationId: orgId }));
    await nextMessage(live, (m) => m.type === 'ready');

    // Worker connects over WS and heartbeats its inventory.
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/v1/worker/ws', { headers: { authorization: `Bearer ${cred}` } });
    await nextMessage(ws, (m) => m.type === 'welcome');
    ws.send(JSON.stringify({
      type: 'heartbeat',
      payload: {
        metrics: { cpuCount: 8, freeMemoryMb: 8000 },
        activeTasks: [],
        sentAt: new Date().toISOString(),
        inventory: {
          agents: [{ id: 'mock', name: 'Mock', installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: [] }],
          providers: [{ id: 'mock', kind: 'mock', name: 'Mock', healthy: true, models: [{ id: 'm1' }] }],
          tools: ['node'],
          projects: [{ projectId: proj.body.id, localPath: '/src/shop' }],
        },
      },
    }));
    await nextMessage(ws, (m) => m.type === 'heartbeat.ack');

    // Create a task → scheduler offers it over WS.
    const offer = nextMessage(ws, (m) => m.type === 'task.offer');
    const created = await api('POST', `/orgs/${orgId}/tasks`, { projectId: proj.body.id, title: 'Checkout', prompt: 'Add Razorpay' }, token, { 'idempotency-key': 'idem-key-0001' });
    expect(created.status).toBe(201);
    const again = await api('POST', `/orgs/${orgId}/tasks`, { projectId: proj.body.id, title: 'Checkout', prompt: 'Add Razorpay' }, token, { 'idempotency-key': 'idem-key-0001' });
    expect(again.body.id).toBe(created.body.id);
    const taskId = created.body.id;
    await s.scheduler.dispatch({ taskId, organizationId: orgId });
    expect((await offer).taskId).toBe(taskId);

    const claim = await api('POST', `/worker/tasks/${taskId}/claim`, undefined, cred);
    expect(claim.body.claimed).toBe(true);
    expect(claim.body.localPath).toBe('/src/shop');

    const liveUpdate = nextMessage(live, (m) => m.type === 'task.updated' && m.task.status === 'PREPARING');
    const t1 = await api('POST', `/worker/tasks/${taskId}/transition`, { to: 'PREPARING', transitionId: randomUUID() }, cred);
    expect(t1.status).toBe(200);
    await liveUpdate;

    // Invalid transition is rejected with a structured error.
    const bad = await api('POST', `/worker/tasks/${taskId}/transition`, { to: 'COMPLETED', transitionId: randomUUID() }, cred);
    expect(bad.status).toBe(409);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');
    expect(bad.body.error.correlationId).toBeTruthy();

    const ev = await api('POST', '/worker/events', { events: [{ eventId: randomUUID(), workerId: claim.body.task.workerId, taskId, timestamp: new Date().toISOString(), sequence: 1, type: 'AgentStarted', payload: {} }] }, cred);
    expect(ev.body.accepted).toBe(1);

    const timeline = await api('GET', `/orgs/${orgId}/tasks/${taskId}/events`, undefined, token);
    expect(timeline.body.items.map((e: any) => e.type)).toContain('AgentStarted');

    const overview = await api('GET', `/orgs/${orgId}/overview`, undefined, token);
    expect(overview.body.activeTasks).toBe(1);
    expect(overview.body.workersOnline).toBe(1);

    ws.close();
    live.close();
  });

  it('enforces auth, validation, isolation, and security headers', async () => {
    const a = await api('POST', '/auth/register', { email: `a-${Date.now()}@example.com`, password: 'long-enough-password', name: 'A' });
    const b = await api('POST', '/auth/register', { email: `b-${Date.now()}@example.com`, password: 'long-enough-password', name: 'B' });
    const orgA = a.body.memberships[0].organizationId;
    expect((await api('GET', `/orgs/${orgA}/tasks`)).status).toBe(401);
    expect((await api('GET', `/orgs/${orgA}/tasks`, undefined, b.body.accessToken)).status).toBe(404);
    expect((await api('GET', `/orgs/not-an-id/tasks`, undefined, a.body.accessToken)).status).toBe(404);
    const v = await api('POST', `/orgs/${orgA}/projects`, { name: '' }, a.body.accessToken);
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe('VALIDATION_FAILED');
    expect((await api('POST', '/auth/register', { email: 'bad', password: 'short', name: '' })).status).toBe(400);
    expect((await api('GET', '/worker/me', undefined, a.body.accessToken)).status).toBe(401); // user token ≠ worker credential
    const res = await fetch(base + '/healthz');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  });

  it('web clients get the refresh token only as an httpOnly cookie', async () => {
    const r = await fetch(base + '/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-client': 'web' },
      body: JSON.stringify({ email: `c-${Date.now()}@example.com`, password: 'long-enough-password', name: 'C' }),
    });
    const body = await r.json();
    expect(body.refreshToken).toBe('');
    const cookie = r.headers.get('set-cookie')!;
    expect(cookie).toMatch(/ao_rt=.+HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const rt = /ao_rt=([^;]+)/.exec(cookie)![1];
    // Without the x-client header the cookie is ignored (CSRF protection): no session is issued.
    const noHeader = await fetch(base + '/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json', cookie: `ao_rt=${rt}` }, body: '{}' });
    expect(noHeader.status).toBe(204);
    expect(await noHeader.text()).toBe('');
    expect(noHeader.headers.get('set-cookie')).toBeNull();
    const ok = await fetch(base + '/api/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json', 'x-client': 'web', cookie: `ao_rt=${rt}` }, body: '{}' });
    expect(ok.status).toBe(200);
  });

  it('serves OpenAPI, health, readiness and Prometheus metrics', async () => {
    const spec = await api('GET', '/openapi.json');
    expect(spec.body.openapi).toBe('3.1.0');
    expect(Object.keys(spec.body.paths)).toContain('/api/v1/orgs/{orgId}/tasks');
    expect((await fetch(base + '/readyz')).status).toBe(200);
    const m = await (await fetch(base + '/metrics')).text();
    expect(m).toContain('tasks_created_total');
    expect(m).toContain('worker_online_count');
  });
});

describe('sign-in rate limit', () => {
  it('limits sign-in attempts, but not session refreshes (every page load refreshes)', async () => {
    const statuses = async (url: string, n: number, body: object) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).status);
      return out;
    };
    expect(await statuses('/api/v1/auth/refresh', 25, { refreshToken: 'x'.repeat(40) })).not.toContain(429);
    expect(await statuses('/api/v1/auth/login', 25, { email: 'nobody@example.com', password: 'wrong-password' })).toContain(429);
  });
});
