/**
 * Server settings managed in the web app (SELFHOST-002) and feature flags (CORE-010): precedence of
 * the environment, validation, secrets encrypted at rest, live application (SMTP transport, error
 * tracking, rate limits, sign-in), other API instances picking changes up, key rotation, access control.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { SMTPServer } from 'smtp-server';
import { errorReporter, captureError, FEATURES } from '@ao/core';
import { AuditLog, Setting } from '@ao/database';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import { MemoryQueue } from '@ao/queue';
import { SecretBox, createServices, reencryptSecrets, type Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices, testConfig } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let adminToken: string;
let memberToken: string;
let memberOrgId: string;
let adminOrgId: string;
const inbox: Array<{ to: string[]; raw: string }> = [];
let smtp: SMTPServer;
let smtpPort = 0;
let collector: http.Server;
const webhookHits: unknown[] = [];

const inject = (method: 'GET' | 'PATCH' | 'PUT', url: string, token: string | null, payload?: unknown) =>
  app.inject({ method, url: API_PREFIX + url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
const until = async (cond: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
};

beforeAll(async () => {
  await startTestDatabase();
  smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth: (auth, _s, cb) => (auth.username === 'mailer' && auth.password === 'smtp-pass-stored' ? cb(null, { user: 'mailer' }) : cb(new Error('bad auth'))),
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        inbox.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  smtpPort = (smtp.server.address() as { port: number }).port;
  collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      webhookHits.push(JSON.parse(body));
      res.end();
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));

  // The real mailer (no capture override), so switching SMTP in the web app can be observed.
  s = await createServices(testConfig(), { queue: new MemoryQueue(), env: {} });
  app = await buildApp(s);
  const admin = await s.auth.register({ email: `admin-${Date.now()}@example.com`, password: 'admin-password-123', name: 'Admin' });
  const member = await s.auth.register({ email: `member-${Date.now()}@example.com`, password: 'member-password-123', name: 'Member' });
  expect(admin.user.platformAdmin).toBe(true);
  adminToken = admin.accessToken;
  adminOrgId = admin.memberships[0]!.organizationId;
  memberToken = member.accessToken;
  memberOrgId = member.memberships[0]!.organizationId;
});
afterAll(async () => {
  errorReporter.reset();
  await app.close();
  await new Promise<void>((r) => smtp.close(() => r()));
  await new Promise<void>((r) => collector.close(() => r()));
  await stopTestDatabase();
});

describe('server settings managed in the web app', () => {
  it('only platform administrators can read or change them', async () => {
    expect((await inject('PATCH', '/admin/server/settings', null, { values: { ALLOW_REGISTRATION: 'false' } })).statusCode).toBe(401);
    expect((await inject('PATCH', '/admin/server/settings', memberToken, { values: { ALLOW_REGISTRATION: 'false' } })).statusCode).toBe(403);
    expect(s.config.ALLOW_REGISTRATION).toBe(true);
  });

  it('applies a change at once, shows where it came from, and clearing restores the default', async () => {
    const res = await inject('PATCH', '/admin/server/settings', adminToken, { values: { ALLOW_REGISTRATION: 'false' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.find((x: { key: string }) => x.key === 'ALLOW_REGISTRATION')).toMatchObject({ value: false, source: 'admin', editable: true });
    await expect(s.auth.register({ email: `late-${Date.now()}@example.com`, password: 'late-password-123', name: 'Late' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/server-info` })).json().registrationOpen).toBe(false);

    const cleared = await inject('PATCH', '/admin/server/settings', adminToken, { values: { ALLOW_REGISTRATION: null } });
    expect(cleared.json().settings.find((x: { key: string }) => x.key === 'ALLOW_REGISTRATION')).toMatchObject({ value: true, source: 'default' });
    await s.auth.register({ email: `again-${Date.now()}@example.com`, password: 'again-password-123', name: 'Again' });
  });

  it('rejects settings that are environment-only, and invalid values, without saving anything', async () => {
    const before = await Setting.findOne({ key: 'server.config' }).lean();
    const envOnly = await inject('PATCH', '/admin/server/settings', adminToken, { values: { MONGODB_URI: 'mongodb://elsewhere/x' } });
    expect(envOnly.statusCode).toBe(400);
    expect(envOnly.json().error.message).toMatch(/environment/);
    for (const values of [{ RATE_LIMIT_PER_MINUTE: 'lots' }, { RATE_LIMIT_PER_MINUTE: '0' }, { WEB_URL: 'not a url' }, { ALLOW_REGISTRATION: 'maybe' }, { SMTP_URL: 'http://mail' }, { SMTP_FROM: 'x', WEB_URL: 'nope' }]) {
      const r = await inject('PATCH', '/admin/server/settings', adminToken, { values });
      expect(r.statusCode, JSON.stringify(values)).toBe(400);
    }
    expect((await Setting.findOne({ key: 'server.config' }).lean())?.value).toEqual(before?.value);
    expect(s.config.SMTP_FROM).not.toBe('x');
  });

  it('a value set in the environment wins and cannot be changed in the web app', async () => {
    const { services } = await makeServices({ ALLOW_REGISTRATION: 'true' });
    await expect(services.settings.update({ userId: 'u', correlationId: 'c' }, { ALLOW_REGISTRATION: 'false' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Even a value stored earlier (e.g. before the variable was added to the environment) is ignored.
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { REQUIRE_EMAIL_VERIFICATION: 'true' });
    const pinned = (await makeServices({ REQUIRE_EMAIL_VERIFICATION: 'false' })).services;
    await pinned.settings.refresh();
    expect(pinned.config.REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect((await import('@ao/server')).settingsView(pinned.config, pinned.settings.env, pinned.settings).find((v) => v.key === 'REQUIRE_EMAIL_VERIFICATION')).toMatchObject({ source: 'environment', editable: true });
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { REQUIRE_EMAIL_VERIFICATION: null });
  });

  it('stores secrets encrypted, never returns them, and uses them (SMTP with a password, sign-in client secret)', async () => {
    const smtpUrl = `smtp://mailer:smtp-pass-stored@127.0.0.1:${smtpPort}`;
    const res = await inject('PATCH', '/admin/server/settings', adminToken, {
      values: { SMTP_URL: smtpUrl, SMTP_FROM: 'Stored <stored@orchestration.test>', GOOGLE_CLIENT_ID: 'google-client-id', GOOGLE_CLIENT_SECRET: 'google-secret-stored' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('smtp-pass-stored');
    expect(res.body).not.toContain('google-secret-stored');
    const get = (k: string) => res.json().settings.find((x: { key: string }) => x.key === k);
    expect(get('GOOGLE_CLIENT_SECRET')).toMatchObject({ value: 'set', secret: true, source: 'admin' });
    expect(get('SMTP_URL').value).toContain('mailer:%E2%80%A2');
    const raw = JSON.stringify(await Setting.findOne({ key: 'server.config' }).lean());
    expect(raw).not.toContain('smtp-pass-stored');
    expect(raw).not.toContain('google-secret-stored');
    expect(raw).toContain('google-client-id'); // not a secret: stored as is

    // Sign-in with Google is offered now.
    expect(s.oauth.list().map((p) => p.id)).toContain('google');
    // The SMTP transport was replaced: a password reset now goes through the SMTP server.
    await until(() => (s.mailer as { configured?: boolean }).configured === true, 'the SMTP mailer');
    const email = `reset-${Date.now()}@example.com`;
    await s.auth.register({ email, password: 'reset-password-123', name: 'Reset' });
    await s.auth.requestPasswordReset(email);
    await until(() => inbox.some((m) => m.to.includes(email)), 'the reset email');
    expect(inbox.find((m) => m.to.includes(email))!.raw).toContain('stored@orchestration.test');
    expect((await inject('GET', '/admin/server', adminToken)).json().status.email.ok).toBe(true);
  });

  it('error tracking can be switched on and off while the server runs', async () => {
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { ERROR_TRACKING_WEBHOOK_URL: `http://127.0.0.1:${(collector.address() as { port: number }).port}/hook` });
    captureError(new Error('reported after enabling'));
    await until(() => webhookHits.length === 1, 'the error report');
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { ERROR_TRACKING_WEBHOOK_URL: null });
    captureError(new Error('not reported after disabling'));
    await errorReporter.flush(1000);
    await new Promise((r) => setTimeout(r, 200));
    expect(webhookHits).toHaveLength(1);
  });

  it('rate limits follow the setting', async () => {
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { RATE_LIMIT_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.inject({ method: 'GET', url: '/healthz', remoteAddress: '10.9.9.9' })).statusCode);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { RATE_LIMIT_PER_MINUTE: null });
  });

  it('CORS origins follow the setting', async () => {
    const preflight = () => app.inject({ method: 'OPTIONS', url: `${API_PREFIX}/server-info`, headers: { origin: 'https://new.example.com', 'access-control-request-method': 'GET' } });
    expect((await preflight()).headers['access-control-allow-origin']).toBeUndefined();
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { CORS_ORIGINS: 'http://localhost:5173, https://new.example.com' });
    expect((await preflight()).headers['access-control-allow-origin']).toBe('https://new.example.com');
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { CORS_ORIGINS: null });
  });

  it('another API instance picks the change up, and concurrent saves keep both changes', async () => {
    const other = (await makeServices()).services;
    await other.settings.refresh();
    await Promise.all([
      s.settings.update({ userId: 'u', correlationId: 'c' }, { OIDC_DISPLAY_NAME: 'Company SSO' }),
      other.settings.update({ userId: 'u', correlationId: 'c' }, { ACCESS_TOKEN_TTL_SEC: '600' }),
    ]);
    await s.settings.refresh();
    await other.settings.refresh();
    for (const x of [s, other]) expect([x.config.OIDC_DISPLAY_NAME, x.config.ACCESS_TOKEN_TTL_SEC]).toEqual(['Company SSO', 600]);
    await s.settings.update({ userId: 'u', correlationId: 'c' }, { OIDC_DISPLAY_NAME: null, ACCESS_TOKEN_TTL_SEC: null });
  });

  it('changes are audited by key, never with values', async () => {
    const entries = await AuditLog.find({ action: 'server.settings.update' }).lean();
    expect(entries.length).toBeGreaterThan(3);
    expect(JSON.stringify(entries)).not.toContain('smtp-pass-stored');
    expect(entries.some((e) => (e.metadata as { keys: string[] }).keys.includes('GOOGLE_CLIENT_SECRET'))).toBe(true);
  });

  it('secret settings move to a new encryption key with the other secrets', async () => {
    const newKey = 'e'.repeat(64);
    const rotated = new SecretBox(newKey, [s.config.ENCRYPTION_KEY]);
    const r = await reencryptSecrets(rotated);
    expect(r.failed).toEqual([]);
    expect(r.reencrypted).toBeGreaterThanOrEqual(2); // SMTP_URL and GOOGLE_CLIENT_SECRET
    // A server with only the new key reads them.
    const next = await createServices(testConfig({ ENCRYPTION_KEY: newKey }), { queue: new MemoryQueue(), mailer: { send: async () => {} }, env: {} });
    await next.settings.refresh();
    expect(next.config.GOOGLE_CLIENT_SECRET).toBe('google-secret-stored');
    expect(next.config.SMTP_URL).toContain('smtp-pass-stored');
  });
});

describe('feature flags', () => {
  const key = FEATURES[0]!.key;
  const flag = async () => (await inject('GET', '/admin/features', adminToken)).json().flags.find((f: { key: string }) => f.key === key);
  const orgFlags = async (token: string, orgId: string) => (await inject('GET', `/orgs/${orgId}/features`, token)).json();

  it('lists every declared flag, off by default, for administrators only', async () => {
    expect((await inject('GET', '/admin/features', memberToken)).statusCode).toBe(403);
    expect((await inject('PUT', `/admin/features/${key}`, memberToken, { enabled: true })).statusCode).toBe(403);
    const list = (await inject('GET', '/admin/features', adminToken)).json();
    expect(list.flags.map((f: { key: string }) => f.key)).toEqual(FEATURES.map((f) => f.key));
    expect(await flag()).toMatchObject({ enabled: null, effective: false, forcedByEnvironment: false, organizations: [] });
    expect((await orgFlags(memberToken, memberOrgId))[key]).toBe(false);
    expect((await inject('PUT', '/admin/features/no.such.flag', adminToken, { enabled: true })).statusCode).toBe(404);
  });

  it('platform setting, then per-organization override, then back to the default', async () => {
    await inject('PUT', `/admin/features/${key}`, adminToken, { enabled: true });
    expect((await orgFlags(memberToken, memberOrgId))[key]).toBe(true);
    expect(s.features.enabled(key, adminOrgId)).toBe(true);

    const r = await inject('PUT', `/admin/features/${key}/orgs/${memberOrgId}`, adminToken, { enabled: false });
    expect(r.statusCode).toBe(200);
    expect((await flag()).organizations).toEqual([{ organizationId: memberOrgId, name: expect.any(String), enabled: false }]);
    expect((await orgFlags(memberToken, memberOrgId))[key]).toBe(false);
    expect(s.features.enabled(key, adminOrgId)).toBe(true);

    // Another instance converges.
    const other = (await makeServices()).services;
    await other.features.refresh();
    expect([other.features.enabled(key, memberOrgId), other.features.enabled(key, adminOrgId)]).toEqual([false, true]);

    await inject('PUT', `/admin/features/${key}/orgs/${memberOrgId}`, adminToken, { enabled: null });
    await inject('PUT', `/admin/features/${key}`, adminToken, { enabled: null });
    expect(await flag()).toMatchObject({ enabled: null, effective: false, organizations: [] });
    expect((await inject('PUT', `/admin/features/${key}/orgs/000000000000000000000000`, adminToken, { enabled: true })).statusCode).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'feature_flag.update', targetId: key })).toBe(4);
  });

  it('FEATURE_FLAGS in the environment forces a flag on; unknown names are reported', async () => {
    const { services } = await makeServices({ FEATURE_FLAGS: `${key}, old.flag` });
    await services.features.set({ userId: 'u', correlationId: 'c' }, key, false, memberOrgId);
    expect(services.features.enabled(key, memberOrgId)).toBe(true);
    const list = await services.features.list();
    expect(list.flags.find((f) => f.key === key)).toMatchObject({ forcedByEnvironment: true, effective: true });
    expect(list.unknownEnvironmentFlags).toEqual(['old.flag']);
    await services.features.set({ userId: 'u', correlationId: 'c' }, key, null, memberOrgId);
  });
});
