/** Personal API tokens: scope to one organization, role cap, revocation, expiry, what they can't do. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ApiToken, Membership, User } from '@ao/database';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let session: string;
let userId: string;
let orgA: string;
let orgB: string;

const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH', url: string, auth: string | null, payload?: unknown) =>
  app.inject({ method, url: API_PREFIX + url, payload: payload as object, headers: auth ? { authorization: `Bearer ${auth}` } : {} });

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  const r = await s.auth.register({ email: `tok-${Date.now()}@example.com`, password: 'token-password-123', name: 'Tok' });
  session = r.accessToken;
  userId = r.user.id;
  orgA = r.memberships[0]!.organizationId;
  orgB = (await s.auth.createOrganizationFor(userId, 'Second org'))._id.toString();
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

async function newToken(body: Record<string, unknown>) {
  const res = await call('POST', '/me/tokens', session, body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { token: string; id: string; role: string; prefix: string };
}

describe('personal API tokens', () => {
  it('work in their organization with their role; the value is shown once and stored hashed', async () => {
    const t = await newToken({ name: 'CI', organizationId: orgA, role: 'DEVELOPER' });
    expect(t.token).toMatch(/^aot_/);
    expect(t.prefix).toBe(t.token.slice(0, 12));
    expect(JSON.stringify(await ApiToken.findById(t.id).lean())).not.toContain(t.token);
    expect((await call('GET', '/me/tokens', session)).body).not.toContain(t.token);

    expect((await call('GET', `/orgs/${orgA}/tasks`, t.token)).statusCode).toBe(200);
    const project = await call('POST', `/orgs/${orgA}/projects`, t.token, { name: 'from token' });
    expect(project.statusCode).toBe(403); // developers can't create projects
    expect((await call('GET', `/orgs/${orgA}/members`, t.token)).statusCode).toBe(200);
    expect((await call('POST', `/orgs/${orgA}/members`, t.token, { email: 'x@example.com', role: 'VIEWER' })).statusCode).toBe(403);
    // Another organization of the same user looks like it doesn't exist.
    expect((await call('GET', `/orgs/${orgB}/tasks`, t.token)).statusCode).toBe(404);
    const me = (await call('GET', '/me', t.token)).json();
    expect(me.memberships).toEqual([expect.objectContaining({ organizationId: orgA, role: 'DEVELOPER' })]);
    expect(me.user.platformAdmin).toBe(false);
  });

  it('cannot manage tokens, security settings or the server', async () => {
    const t = await newToken({ name: 'owner-level', organizationId: orgA });
    expect(t.role).toBe('OWNER');
    for (const [method, url, body] of [
      ['GET', '/me/tokens', undefined],
      ['POST', '/me/tokens', { name: 'x', organizationId: orgA }],
      ['POST', '/me/mfa/setup', {}],
      ['GET', '/admin/server', undefined],
    ] as const) {
      expect((await call(method, url, t.token, body)).statusCode, url).toBe(403);
    }
  });

  it('never exceeds the owner: higher roles are refused and a demotion applies at once', async () => {
    const other = await s.auth.register({ email: `dev-${Date.now()}@example.com`, password: 'dev-password-123', name: 'Dev' });
    await Membership.create({ userId: other.user.id, organizationId: orgA, role: 'DEVELOPER' });
    const devSession = other.accessToken;
    expect((await call('POST', '/me/tokens', devSession, { name: 'x', organizationId: orgA, role: 'ADMIN' })).statusCode).toBe(403);
    const devToken = (await call('POST', '/me/tokens', devSession, { name: 'x', organizationId: orgA })).json().token as string;
    expect((await call('GET', `/orgs/${orgA}/tasks`, devToken)).statusCode).toBe(200);
    await Membership.updateOne({ userId: other.user.id, organizationId: orgA }, { $set: { role: 'VIEWER' } });
    expect((await call('GET', '/me', devToken)).json().memberships[0].role).toBe('VIEWER');
    await Membership.deleteOne({ userId: other.user.id, organizationId: orgA });
    expect((await call('GET', `/orgs/${orgA}/tasks`, devToken)).statusCode).toBe(401);
  });

  it('stop working when revoked, expired, or the account is disabled', async () => {
    const a = await newToken({ name: 'revoke me', organizationId: orgA });
    expect((await call('DELETE', `/me/tokens/${a.id}`, session)).statusCode).toBe(204);
    expect((await call('GET', `/orgs/${orgA}/tasks`, a.token)).statusCode).toBe(401);

    const b = await newToken({ name: 'expiring', organizationId: orgA, expiresInDays: 1 });
    await ApiToken.updateOne({ _id: b.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await call('GET', `/orgs/${orgA}/tasks`, b.token)).statusCode).toBe(401);

    const c = await newToken({ name: 'disabled owner', organizationId: orgA });
    await User.updateOne({ _id: userId }, { $set: { disabled: true } });
    expect((await call('GET', `/orgs/${orgA}/tasks`, c.token)).statusCode).toBe(401);
    await User.updateOne({ _id: userId }, { $set: { disabled: false } });
    expect((await call('GET', `/orgs/${orgA}/tasks`, 'aot_madeup')).statusCode).toBe(401);
  });
});
