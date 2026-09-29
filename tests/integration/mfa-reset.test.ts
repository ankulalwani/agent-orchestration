/**
 * Administrators turning off someone's two-factor authentication (lost authenticator and recovery codes):
 * who may, what happens to the person's sessions, and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { totp } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, Membership } from '@ao/database';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

let s: Services;
let sent: Array<{ to: string; subject: string; text: string }>;
let app: FastifyInstance;
let platformAdmin: string;
let n = 0;

beforeAll(async () => {
  await startTestDatabase();
  ({ services: s, sent } = await makeServices());
  app = await buildApp(s);
  platformAdmin = (await s.auth.register({ email: 'root@example.com', password: 'root-password-123', name: 'Root' })).accessToken; // first user
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

async function user(role?: { orgId: string; role: string }) {
  const email = `u${++n}-${Date.now()}@example.com`;
  const r = await s.auth.register({ email, password: 'user-password-123', name: `U${n}` });
  if (role) await Membership.create({ userId: r.user.id, organizationId: role.orgId, role: role.role });
  return { email, id: r.user.id, token: r.accessToken, refresh: r.refreshToken, orgId: r.memberships[0]!.organizationId };
}
async function withMfa(u: { id: string }) {
  const { secret } = await s.auth.setupMfa(u.id);
  await s.auth.enableMfa(u.id, totp(secret));
}
const post = (url: string, token: string, reason = 'Lost their phone and codes') => app.inject({ method: 'POST', url: API_PREFIX + url, headers: { authorization: `Bearer ${token}` }, payload: { reason } });

describe('resetting two-factor authentication', () => {
  it('an organization owner resets it for a member of that organization only; the member is signed out and told', async () => {
    const owner = await user();
    const member = await user({ orgId: owner.orgId, role: 'DEVELOPER' });
    await withMfa(member);
    const members = (await app.inject({ method: 'GET', url: `${API_PREFIX}/orgs/${owner.orgId}/members`, headers: { authorization: `Bearer ${owner.token}` } })).json() as Array<{ userId: string; mfaEnabled: boolean; inOtherOrganizations: boolean }>;
    expect(members.find((m) => m.userId === member.id)).toMatchObject({ mfaEnabled: true, inOtherOrganizations: true }); // their own organization from registration

    // The member's personal organization makes them belong elsewhere: organization admins can't reset.
    const refused = await post(`/orgs/${owner.orgId}/members/${member.id}/reset-mfa`, owner.token);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toMatch(/other organizations/);
    await Membership.deleteOne({ userId: member.id, organizationId: member.orgId });

    expect((await post(`/orgs/${owner.orgId}/members/${member.id}/reset-mfa`, owner.token, 'x')).statusCode).toBe(400); // a reason is required
    const ok = await post(`/orgs/${owner.orgId}/members/${member.id}/reset-mfa`, owner.token);
    expect(ok.statusCode, ok.body).toBe(204);
    // Signed in again with the password only; old sessions are gone.
    const login = await s.auth.login(member.email, 'user-password-123', {});
    expect(login.accessToken).toBeTruthy();
    await expect(s.auth.refresh(member.refresh, {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(sent.find((m) => m.to === member.email && m.subject.includes('Two-factor'))?.text).toContain('Lost their phone and codes');
    const entry = await AuditLog.findOne({ action: 'auth.mfa_reset_by_admin', targetId: member.id }).lean();
    expect(entry).toMatchObject({ actorId: owner.id, metadata: { reason: 'Lost their phone and codes', byPlatformAdmin: false } });
    // Nothing to reset any more.
    expect((await post(`/orgs/${owner.orgId}/members/${member.id}/reset-mfa`, owner.token)).statusCode).toBe(409);
  });

  it('organization admins cannot reset owners, people outside the organization, or themselves; developers cannot at all', async () => {
    const owner = await user();
    await withMfa(owner);
    const admin = await user({ orgId: owner.orgId, role: 'ADMIN' });
    await Membership.deleteOne({ userId: admin.id, organizationId: admin.orgId });
    const dev = await user({ orgId: owner.orgId, role: 'DEVELOPER' });
    const outsider = await user();
    await withMfa(outsider);
    expect((await post(`/orgs/${owner.orgId}/members/${owner.id}/reset-mfa`, admin.token)).statusCode).toBe(403); // outranks them
    expect((await post(`/orgs/${owner.orgId}/members/${outsider.id}/reset-mfa`, admin.token)).statusCode).toBe(404);
    expect((await post(`/orgs/${owner.orgId}/members/${owner.id}/reset-mfa`, dev.token)).statusCode).toBe(403);
    expect((await post(`/orgs/${owner.orgId}/members/${owner.id}/reset-mfa`, owner.token)).statusCode).toBe(400); // yourself
  });

  it('platform administrators find anyone and reset it regardless of organizations', async () => {
    const person = await user();
    await withMfa(person);
    const other = await user();
    await Membership.create({ userId: person.id, organizationId: other.orgId, role: 'VIEWER' });
    const found = (await app.inject({ method: 'GET', url: `${API_PREFIX}/admin/users?q=${encodeURIComponent(person.email)}`, headers: { authorization: `Bearer ${platformAdmin}` } })).json();
    expect(found).toEqual([expect.objectContaining({ id: person.id, mfaEnabled: true, organizations: 2 })]);
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/admin/users`, headers: { authorization: `Bearer ${other.token}` } })).statusCode).toBe(403);
    expect((await post(`/admin/users/${person.id}/reset-mfa`, other.token)).statusCode).toBe(403);
    expect((await post(`/admin/users/${person.id}/reset-mfa`, platformAdmin)).statusCode).toBe(204);
    expect((await AuditLog.findOne({ action: 'auth.mfa_reset_by_admin', targetId: person.id }).lean())?.metadata).toMatchObject({ byPlatformAdmin: true });
  });
});
