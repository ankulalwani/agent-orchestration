import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { totp } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { Membership, OAuthTicket, User, oid } from '@ao/database';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';
import { startFakeIdp, type FakeIdp } from '../fake-idp.js';

const WEB = 'http://web.test';
let idp: FakeIdp;
let s: Services;
let app: FastifyInstance;
let closedApp: FastifyInstance;

async function makeApp(extra: Record<string, string> = {}) {
  const { services } = await makeServices({
    WEB_URL: WEB,
    OIDC_ISSUER: idp.url,
    OIDC_CLIENT_ID: idp.clientId,
    OIDC_CLIENT_SECRET: idp.clientSecret,
    OIDC_DISPLAY_NAME: 'Test SSO',
    GITHUB_CLIENT_ID: idp.clientId,
    GITHUB_CLIENT_SECRET: idp.clientSecret,
    GITHUB_URL: idp.url,
    GITHUB_API_URL: `${idp.url}/api`,
    ...extra,
  });
  return { services, app: await buildApp(services) };
}

beforeAll(async () => {
  await startTestDatabase();
  idp = await startFakeIdp();
  ({ services: s, app } = await makeApp());
  ({ app: closedApp } = await makeApp({ ALLOW_REGISTRATION: 'false' }));
});
afterAll(async () => {
  await app.close();
  await closedApp.close();
  await idp.close();
  await stopTestDatabase();
});

/** Browser round-trip: start → provider → callback. Returns where the API sends the browser at the end. */
async function roundTrip(a: FastifyInstance, startPath: string, headers: Record<string, string> = {}) {
  const start = startPath.startsWith('http') ? { headers: { location: startPath }, statusCode: 302 } : await a.inject({ method: 'GET', url: startPath, headers });
  expect(start.statusCode).toBe(302);
  const atProvider = await fetch(String(start.headers.location), { redirect: 'manual' });
  expect(atProvider.status).toBe(302);
  const callback = new URL(atProvider.headers.get('location')!);
  const done = await a.inject({ method: 'GET', url: callback.pathname + callback.search });
  expect(done.statusCode).toBe(302);
  return { final: String(done.headers.location), callbackPath: callback.pathname + callback.search };
}
const ticketOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1));
const complete = (a: FastifyInstance, ticket: string, mfaCode?: string) => a.inject({ method: 'POST', url: `${API_PREFIX}/auth/oauth/complete`, payload: { ticket, mfaCode } });
let n = 0;
const person = (over: Partial<typeof idp.nextUser> = {}) => {
  n++;
  return (idp.nextUser = { sub: `sub-${Date.now()}-${n}`, email: `sso-${Date.now()}-${n}@example.com`, email_verified: true, name: `SSO Person ${n}`, ...over });
};

describe('OAuth / OpenID Connect sign-in (AUTH-005)', () => {
  it('lists only configured providers', async () => {
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/auth/oauth/providers` })).json()).toEqual([
      { id: 'github', name: 'GitHub' },
      { id: 'oidc', name: 'Test SSO' },
    ]);
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/auth/oauth/google/start` })).statusCode).toBe(404);
  });

  it('new person: account + own organization, verified email, no password; the ticket is single use', async () => {
    const who = person();
    const { final, callbackPath } = await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start?next=${encodeURIComponent('/tasks?x=1')}`);
    expect(final.startsWith(`${WEB}/oauth/complete#`)).toBe(true);
    const f = ticketOf(final);
    expect(f.get('next')).toBe('/tasks?x=1');
    const res = await complete(app, f.get('ticket')!);
    expect(res.statusCode).toBe(200);
    const session = res.json();
    expect(session.user).toMatchObject({ email: who.email, name: who.name, emailVerified: true, hasPassword: false, identities: [{ provider: 'oidc', email: who.email }] });
    expect(session.memberships).toHaveLength(1);
    expect((await complete(app, f.get('ticket')!)).statusCode).toBe(401); // ticket used up
    // The provider's redirect can't be replayed either (state is single use).
    expect((await app.inject({ method: 'GET', url: callbackPath })).headers.location).toBe(`${WEB}/login?oauthError=expired`);

    // Signing in again with the same identity reaches the same account.
    const again = await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`);
    expect((await complete(app, ticketOf(again.final).get('ticket')!)).json().user.id).toBe(session.user.id);
  });

  it('never redirects off-site: unsafe `next` values become "/"', async () => {
    for (const next of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      person();
      const { final } = await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start?next=${encodeURIComponent(next)}`);
      expect(ticketOf(final).get('next')).toBe('/');
    }
  });

  it('a verified email links to the existing account; an unverified one is refused', async () => {
    const email = `existing-${Date.now()}@example.com`;
    const existing = await s.auth.register({ email, password: 'existing-password-1', name: 'Existing' });
    person({ email, email_verified: false });
    expect((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).toBe(`${WEB}/login?oauthError=email_unverified`);
    expect((await User.findById(existing.user.id).lean())!.identities).toHaveLength(0);

    person({ email: email.toUpperCase(), email_verified: true });
    const { final } = await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`);
    const session = (await complete(app, ticketOf(final).get('ticket')!)).json();
    expect(session.user.id).toBe(existing.user.id);
    expect(session.user.hasPassword).toBe(true);
    expect(await Membership.countDocuments({ userId: oid(existing.user.id) })).toBe(1); // no new organization
  });

  it('two-factor authentication still applies, and ticket guessing is capped', async () => {
    const email = `mfa-sso-${Date.now()}@example.com`;
    const r = await s.auth.register({ email, password: 'mfa-sso-password-1', name: 'M' });
    const { secret } = await s.auth.setupMfa(r.user.id);
    await s.auth.enableMfa(r.user.id, totp(secret));
    const who = person({ email });
    const ticket = ticketOf((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).get('ticket')!;
    const first = await complete(app, ticket);
    expect(first.json().error.code).toBe('MFA_REQUIRED'); // ticket not consumed
    expect((await complete(app, ticket, '000000')).statusCode).toBe(401);
    const ok = await complete(app, ticket, totp(secret, Date.now() + 30_000));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.id).toBe(r.user.id);

    // Attempts per ticket are limited even for someone who never gets a code right.
    idp.nextUser = who;
    const t2 = ticketOf((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).get('ticket')!;
    for (let i = 0; i < 5; i++) await complete(app, t2, '000000');
    expect((await complete(app, t2, totp(secret, Date.now() + 60_000))).json().error.message).toMatch(/invalid or has expired/);
    expect(await OAuthTicket.countDocuments({ attempts: { $gte: 5 }, usedAt: null })).toBeGreaterThan(0);
  });

  it('closed registration: no account → refused; an invitation lets them in', async () => {
    person();
    expect((await roundTrip(closedApp, `${API_PREFIX}/auth/oauth/oidc/start`)).final).toBe(`${WEB}/login?oauthError=no_account`);

    const owner = await s.auth.register({ email: `inv-owner-${Date.now()}@example.com`, password: 'owner-password-1', name: 'Owner' });
    const orgId = owner.memberships[0]!.organizationId;
    const who = person();
    const inv = await s.invitations.addOrInvite({ userId: owner.user.id, organizationId: orgId, role: 'OWNER', correlationId: 't' }, who.email!, 'VIEWER');
    const token = new URL(inv.inviteUrl!).searchParams.get('token')!;
    const { final } = await roundTrip(closedApp, `${API_PREFIX}/auth/oauth/oidc/start?invitation=${token}`);
    const session = (await complete(closedApp, ticketOf(final).get('ticket')!)).json();
    expect(session.memberships).toEqual([expect.objectContaining({ organizationId: orgId, role: 'VIEWER' })]);
  });

  it('cancel at the provider, and forged ID tokens, end in an error page without an account', async () => {
    const before = await User.countDocuments();
    person();
    idp.denyNext = true;
    expect((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).toBe(`${WEB}/login?oauthError=cancelled`);
    idp.forgeNextToken = true;
    expect((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).toBe(`${WEB}/login?oauthError=provider_error`);
    idp.wrongNonceNext = true;
    expect((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).toBe(`${WEB}/login?oauthError=provider_error`);
    expect(await User.countDocuments()).toBe(before);
  });

  it('GitHub: uses the primary verified email', async () => {
    const who = person({ sub: `9${Date.now() % 1_000_000}` });
    const { final } = await roundTrip(app, `${API_PREFIX}/auth/oauth/github/start`);
    const session = (await complete(app, ticketOf(final).get('ticket')!)).json();
    expect(session.user).toMatchObject({ email: who.email, identities: [{ provider: 'github', email: who.email }] });
  });

  it('connect and disconnect providers from account settings', async () => {
    const r = await s.auth.register({ email: `linker-${Date.now()}@example.com`, password: 'linker-password-1', name: 'L' });
    const auth = { authorization: `Bearer ${r.accessToken}` };
    const { url } = (await app.inject({ method: 'POST', url: `${API_PREFIX}/me/oauth/oidc/link`, headers: auth })).json();
    const idpUser = person({ email: 'some-other-address@example.com' }); // linking doesn't need matching emails
    expect((await roundTrip(app, url)).final).toBe(`${WEB}/settings?tab=account&linked=oidc`);
    expect((await User.findById(r.user.id).lean())!.identities!.map((i) => i.subject)).toEqual([idpUser.sub]);

    // The same identity can't be connected to a second account.
    const other = await s.auth.register({ email: `other-${Date.now()}@example.com`, password: 'other-password-1', name: 'O' });
    idp.nextUser = idpUser;
    const { url: url2 } = (await app.inject({ method: 'POST', url: `${API_PREFIX}/me/oauth/oidc/link`, headers: { authorization: `Bearer ${other.accessToken}` } })).json();
    expect((await roundTrip(app, url2)).final).toBe(`${WEB}/settings?tab=account&oauthError=identity_in_use`);

    expect((await app.inject({ method: 'DELETE', url: `${API_PREFIX}/me/identities/oidc`, headers: auth })).statusCode).toBe(204);
    expect((await User.findById(r.user.id).lean())!.identities).toHaveLength(0);
  });

  it('an account without a password keeps its only sign-in method', async () => {
    person();
    const session = (await complete(app, ticketOf((await roundTrip(app, `${API_PREFIX}/auth/oauth/oidc/start`)).final).get('ticket')!)).json();
    const res = await app.inject({ method: 'DELETE', url: `${API_PREFIX}/me/identities/oidc`, headers: { authorization: `Bearer ${session.accessToken}` } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Set a password first/);
  });
});
