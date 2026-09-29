/**
 * Device sign-in for the CLI and mobile app: approve in the web app (where SSO and two-factor apply),
 * then the device gets its own session. Includes the real `agentctl login` as a process.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AuditLog, DeviceLogin } from '@ao/database';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let base: string;
let web: { token: string; email: string; userId: string };

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const r = await s.auth.register({ email: `dev-login-${Date.now()}@example.com`, password: 'device-password-1', name: 'Dev' });
  web = { token: r.accessToken, email: r.user.email, userId: r.user.id };
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

const call = (method: 'GET' | 'POST', url: string, body?: unknown, token?: string) =>
  app.inject({ method, url: API_PREFIX + url, payload: body as object, headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('device sign-in', () => {
  it('pending until approved in the web app; then one session for the device, once', async () => {
    const start = (await call('POST', '/auth/device/start', { clientName: 'agentctl on build-box' })).json();
    expect(start).toMatchObject({ userCode: expect.stringMatching(/^[A-Z]{4}-\d{4}$/), verificationUrl: expect.stringContaining(`/device?code=${start.userCode}`), intervalSec: 3 });
    expect(JSON.stringify(await DeviceLogin.findOne({ userCode: start.userCode }).lean())).not.toContain(start.pollSecret);

    // Polling every few seconds for minutes must not hit the sign-in rate limit.
    for (let i = 0; i < 25; i++) expect((await call('POST', '/auth/device/poll', { pollSecret: start.pollSecret })).json()).toEqual({ status: 'pending' });

    expect((await call('GET', `/auth/device/${start.userCode}`)).statusCode).toBe(401); // needs a web session
    const described = (await call('GET', `/auth/device/${start.userCode.toLowerCase()}`, undefined, web.token)).json();
    expect(described).toMatchObject({ clientName: 'agentctl on build-box', ip: '127.0.0.1' });
    expect((await call('POST', `/auth/device/${start.userCode}/decision`, { approve: true }, web.token)).statusCode).toBe(204);

    const done = (await call('POST', '/auth/device/poll', { pollSecret: start.pollSecret })).json();
    expect(done).toMatchObject({ status: 'approved', user: { email: web.email }, accessToken: expect.any(String), refreshToken: expect.any(String) });
    expect((await call('GET', '/me', undefined, done.accessToken)).json().user.email).toBe(web.email);
    expect((await call('POST', '/auth/device/poll', { pollSecret: start.pollSecret })).statusCode).toBe(404); // used
    expect((await call('GET', `/auth/device/${start.userCode}`, undefined, web.token)).statusCode).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'auth.device_login_approved', actorId: web.userId })).toBe(1);
  });

  it('denied, expired and API-token approvals are refused', async () => {
    const a = (await call('POST', '/auth/device/start', { clientName: 'x' })).json();
    await call('POST', `/auth/device/${a.userCode}/decision`, { approve: false }, web.token);
    expect((await call('POST', '/auth/device/poll', { pollSecret: a.pollSecret })).json().error.message).toMatch(/denied/);

    const b = (await call('POST', '/auth/device/start', { clientName: 'y' })).json();
    await DeviceLogin.updateOne({ userCode: b.userCode }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('POST', '/auth/device/poll', { pollSecret: b.pollSecret })).json().error.message).toMatch(/expired/);
    expect((await call('POST', `/auth/device/${b.userCode}/decision`, { approve: true }, web.token)).statusCode).toBe(404);

    const c = (await call('POST', '/auth/device/start', { clientName: 'z' })).json();
    const orgId = (await s.auth.memberships(web.userId))[0]!.organizationId;
    const apiToken = (await s.apiTokens.create(web.userId, { name: 't', organizationId: orgId })).token;
    expect((await call('POST', `/auth/device/${c.userCode}/decision`, { approve: true }, apiToken)).statusCode).toBe(403);
  });

  it('`agentctl login --server` signs in through the browser flow and can use the API afterwards', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-device-'));
    const env = { ...process.env, XDG_CONFIG_HOME: home, AO_CREDENTIAL_BACKEND: 'file', AO_WORKER_HOME: path.join(home, 'worker') };
    const cli = (args: string[]) => spawn(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'apps/cli/src/main.ts', ...args], { env });
    const child = cli(['login', '--server', base, '--no-browser']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    for (let i = 0; i < 300 && !/code ([A-Z]{4}-\d{4})/.test(stderr); i++) await new Promise((r) => setTimeout(r, 100));
    const code = /code ([A-Z]{4}-\d{4})/.exec(stderr)![1]!;
    expect(stderr).toContain(`/device?code=${code}`);
    expect((await call('GET', `/auth/device/${code}`, undefined, web.token)).json().clientName).toBe(`agentctl on ${os.hostname()}`);
    await call('POST', `/auth/device/${code}/decision`, { approve: true }, web.token);
    const exit = await new Promise<number | null>((r) => child.on('exit', r));
    expect(exit, stderr).toBe(0);
    expect(stdout).toContain(`Signed in as ${web.email}`);

    // The stored session works for later commands.
    const list = cli(['project', 'list', '--json']);
    let out = '';
    list.stdout.on('data', (d) => (out += d));
    expect(await new Promise<number | null>((r) => list.on('exit', r))).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
  }, 90_000);
});
