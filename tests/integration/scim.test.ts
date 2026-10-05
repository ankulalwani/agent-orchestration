/**
 * User provisioning with SCIM 2.0: an identity provider creates, suspends and removes the members of one
 * organization with a bearer token. Requests are made as Okta and Microsoft Entra ID make them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import { AuditLog, Membership, Organization, User } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let owner: Actor;
let ownerToken: string;
let token = '';

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices({ PUBLIC_URL: 'https://ao.example.test' })).services;
  app = await buildApp(s);
  const o = await makeOwner(s, 'scim');
  owner = o.actor;
  ownerToken = o.auth.accessToken;
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, auth = ownerToken) => app.inject({ method, url: `${API_PREFIX}/orgs/${owner.organizationId}${url}`, payload: payload as object, headers: { authorization: `Bearer ${auth}` } });
const scim = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, auth = token) =>
  app.inject({ method, url: `/scim/v2${url}`, payload: payload === undefined ? undefined : JSON.stringify(payload), headers: { authorization: `Bearer ${auth}`, ...(payload === undefined ? {} : { 'content-type': 'application/scim+json' }) } });
const person = (email: string, extra: object = {}) => ({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: email, name: { givenName: 'Maria', familyName: 'Rossi' }, emails: [{ value: email, primary: true }], active: true, ...extra });
const actorOf = (userId: string) => s.orgs.resolveActor(userId, owner.organizationId, 'test');

describe('SCIM setup', () => {
  it('is off until an administrator creates a token, which is shown once and stored hashed', async () => {
    expect((await api('GET', '/scim')).json()).toMatchObject({ enabled: false, baseUrl: 'https://ao.example.test/scim/v2', tokenPrefix: null });
    expect((await scim('GET', '/Users', undefined, 'aos_made_up')).statusCode).toBe(401);

    expect((await api('POST', '/scim/token', { defaultRole: 'OWNER' })).statusCode).toBe(403);
    const created = await api('POST', '/scim/token', { defaultRole: 'DEVELOPER' });
    expect(created.statusCode, created.body).toBe(200);
    token = created.json().token;
    expect(token).toMatch(/^aos_/);
    expect(created.json()).toMatchObject({ enabled: true, defaultRole: 'DEVELOPER', tokenPrefix: token.slice(0, 10) });
    expect((await api('GET', '/scim')).body).not.toContain(token);
    expect(JSON.stringify(await Organization.findById(owner.organizationId).select('+scim.tokenHash').lean())).not.toContain(token);

    const dev = await makeOwner(s, 'scimdev');
    await Membership.create({ organizationId: owner.organizationId, userId: dev.actor.userId, role: 'DEVELOPER' });
    expect((await api('POST', '/scim/token', {}, dev.auth.accessToken)).statusCode).toBe(403);
    expect((await api('GET', '/scim', undefined, dev.auth.accessToken)).statusCode).toBe(403);
    await Membership.deleteOne({ organizationId: owner.organizationId, userId: dev.actor.userId });
  });

  it('answers discovery and refuses requests without its token, in SCIM form', async () => {
    const config = await scim('GET', '/ServiceProviderConfig');
    expect(config.headers['content-type']).toContain('application/scim+json');
    expect(config.json()).toMatchObject({ patch: { supported: true }, filter: { supported: true }, bulk: { supported: false } });
    expect((await scim('GET', '/ResourceTypes')).json().Resources[0]).toMatchObject({ id: 'User', endpoint: '/Users' });
    expect((await scim('GET', '/Groups')).json()).toMatchObject({ totalResults: 0, Resources: [] });

    const anonymous = await app.inject({ method: 'GET', url: '/scim/v2/Users' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toEqual({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401', detail: 'A SCIM bearer token is required' });
    // A member's own sign-in is not a provisioning token.
    expect((await scim('GET', '/Users', undefined, ownerToken)).statusCode).toBe(401);
  });
});

describe('SCIM users', () => {
  let mariaId = '';

  it('creates an account without a password and makes it a member with the default role', async () => {
    const r = await scim('POST', '/Users', person('Maria.Rossi@Acme.test', { externalId: '00u1maria' }));
    expect(r.statusCode, r.body).toBe(201);
    const u = r.json();
    mariaId = u.id;
    expect(u).toMatchObject({ userName: 'maria.rossi@acme.test', displayName: 'Maria Rossi', externalId: '00u1maria', active: true, roles: [{ value: 'DEVELOPER' }], emails: [{ value: 'maria.rossi@acme.test', primary: true }], meta: { resourceType: 'User', location: `https://ao.example.test/scim/v2/Users/${u.id}` } });
    expect(await User.findById(u.id).lean()).toMatchObject({ email: 'maria.rossi@acme.test', hasPassword: false, emailVerified: true });
    expect((await actorOf(u.id)).role).toBe('DEVELOPER');
    await expect(s.auth.login('maria.rossi@acme.test', 'anything')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    // Sending the same person again is a conflict (Okta then links the existing one).
    const again = await scim('POST', '/Users', person('maria.rossi@acme.test'));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ scimType: 'uniqueness', status: '409' });
    expect((await scim('POST', '/Users', { userName: 'no-email' })).json()).toMatchObject({ status: '400', scimType: 'invalidValue' });
    expect((await scim('POST', '/Users', person('boss@acme.test', { roles: [{ value: 'owner' }] }))).json().detail).toMatch(/"OWNER" is not a role that can be provisioned/);
    expect(await User.countDocuments({ email: 'boss@acme.test' })).toBe(0);
  });

  it('an existing account joins, with the role the identity provider names', async () => {
    const existing = await makeOwner(s, 'scimexisting');
    const email = (await User.findById(existing.actor.userId).lean())!.email;
    const r = await scim('POST', '/Users', person(email, { roles: [{ value: 'manager', primary: true }] }));
    expect(r.statusCode).toBe(201);
    expect(r.json().id).toBe(existing.actor.userId);
    expect((await actorOf(existing.actor.userId)).role).toBe('MANAGER');
    // Their name is theirs: they belong to another organization too.
    await scim('PATCH', `/Users/${existing.actor.userId}`, { Operations: [{ op: 'replace', path: 'displayName', value: 'Renamed By Idp' }] });
    expect((await User.findById(existing.actor.userId).lean())!.name).toBe('scimexisting');
  });

  it('finds users by userName and externalId, and pages through the members', async () => {
    const byName = (await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "maria.rossi@acme.test"')}`)).json();
    expect(byName).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    expect(byName.Resources[0].id).toBe(mariaId);
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('externalId eq "00u1maria"')}`)).json().Resources[0].id).toBe(mariaId);
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('userName eq "nobody@acme.test"')}`)).json()).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await scim('GET', `/Users?filter=${encodeURIComponent('title co "x"')}`)).json()).toMatchObject({ status: '400', scimType: 'invalidFilter' });

    const all = (await scim('GET', '/Users')).json();
    expect(all.totalResults).toBe(3); // the owner, Maria, and the existing account
    const page = (await scim('GET', '/Users?startIndex=2&count=1')).json();
    expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });
    expect((await scim('GET', `/Users/${mariaId}`)).json().userName).toBe('maria.rossi@acme.test');
    expect((await scim('GET', '/Users/000000000000000000000000')).statusCode).toBe(404);
    expect((await scim('GET', '/Users/not-an-id')).statusCode).toBe(404);
  });

  it('deactivation suspends the member at once and reactivation restores them (Okta and Entra forms)', async () => {
    const session = await s.auth.issueSession(mariaId, {});
    const tasks = () => app.inject({ method: 'GET', url: `${API_PREFIX}/orgs/${owner.organizationId}/tasks`, headers: { authorization: `Bearer ${session.accessToken}` } });
    expect((await tasks()).statusCode).toBe(200);

    // Okta: a value object without a path.
    const off = await scim('PATCH', `/Users/${mariaId}`, { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', value: { active: false } }] });
    expect(off.json()).toMatchObject({ id: mariaId, active: false });
    expect((await tasks()).statusCode).toBe(404); // the organization is gone for them, with a token issued before
    await expect(actorOf(mariaId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await s.auth.issueSession(mariaId, {})).memberships).toEqual([]);
    // Suspended members get no notifications.
    await s.notifications.notify({ organizationId: owner.organizationId, type: 'organization.notice', title: 'Hello', body: '' });
    const { Notification } = await import('@ao/database');
    expect(await Notification.countDocuments({ userId: mariaId })).toBe(0);

    // Entra: op capitalised, a path, the boolean as a string.
    const on = await scim('PATCH', `/Users/${mariaId}`, { Operations: [{ op: 'Replace', path: 'active', value: 'True' }] });
    expect(on.json().active).toBe(true);
    expect((await tasks()).statusCode).toBe(200);
    expect(await AuditLog.distinct('action', { action: /^scim\.user_(de)?activated$/ })).toEqual(['scim.user_activated', 'scim.user_deactivated']);
  });

  it('PUT and PATCH change the role, the name and the external id; the owner role is out of reach', async () => {
    const put = await scim('PUT', `/Users/${mariaId}`, person('maria.rossi@acme.test', { displayName: 'Maria R. Rossi', externalId: '00u1maria-v2', roles: [{ value: 'ADMIN' }] }));
    expect(put.json()).toMatchObject({ displayName: 'Maria R. Rossi', externalId: '00u1maria-v2', active: true, roles: [{ value: 'ADMIN' }] });
    const patched = await scim('PATCH', `/Users/${mariaId}`, { Operations: [{ op: 'replace', path: 'name.givenName', value: 'Mariella' }, { op: 'replace', path: 'name.familyName', value: 'Rossi' }, { op: 'replace', path: 'roles', value: [{ value: 'viewer' }] }, { op: 'add', path: 'phoneNumbers', value: [{ value: '+39 1' }] }] });
    expect(patched.json()).toMatchObject({ displayName: 'Mariella Rossi', roles: [{ value: 'VIEWER' }] });
    expect((await scim('PATCH', `/Users/${mariaId}`, { Operations: [{ op: 'replace', path: 'roles', value: [{ value: 'OWNER' }] }] })).statusCode).toBe(400);
    expect((await scim('PATCH', `/Users/${mariaId}`, { Operations: [{ op: 'remove', path: 'active' }] })).json()).toMatchObject({ status: '400', scimType: 'invalidSyntax' });
    expect((await scim('PATCH', `/Users/${mariaId}`, { Operations: [{ op: 'replace', path: 'active', value: 'maybe' }] })).statusCode).toBe(400);
    expect((await actorOf(mariaId)).role).toBe('VIEWER');
  });

  it('the only owner cannot be suspended, demoted or removed by the identity provider', async () => {
    for (const r of [
      await scim('PATCH', `/Users/${owner.userId}`, { Operations: [{ op: 'replace', path: 'active', value: false }] }),
      await scim('DELETE', `/Users/${owner.userId}`),
    ]) {
      expect(r.statusCode).toBe(409);
      expect(r.json().detail).toMatch(/only owner/);
    }
    // A role sent for an owner is ignored rather than applied.
    expect((await scim('PATCH', `/Users/${owner.userId}`, { Operations: [{ op: 'replace', path: 'externalId', value: 'idp-owner' }] })).json()).toMatchObject({ roles: [{ value: 'OWNER' }], externalId: 'idp-owner' });
    expect((await actorOf(owner.userId)).role).toBe('OWNER');
  });

  it('DELETE removes the membership and keeps the account; another organization’s token sees none of this', async () => {
    const other = await makeOwner(s, 'scimother');
    const otherToken = (await s.scim.createToken(other.actor, 'DEVELOPER')).token;
    expect((await scim('GET', `/Users/${mariaId}`, undefined, otherToken)).statusCode).toBe(404);
    expect((await scim('DELETE', `/Users/${mariaId}`, undefined, otherToken)).statusCode).toBe(404);
    expect((await scim('GET', '/Users', undefined, otherToken)).json().totalResults).toBe(1);

    expect((await scim('DELETE', `/Users/${mariaId}`)).statusCode).toBe(204);
    expect((await scim('GET', `/Users/${mariaId}`)).statusCode).toBe(404);
    expect(await User.exists({ _id: mariaId })).toBeTruthy();
    await expect(actorOf(mariaId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a replaced token stops the old one, and turning provisioning off stops them all', async () => {
    const old = token;
    token = (await api('POST', '/scim/token', { defaultRole: 'VIEWER' })).json().token;
    expect((await scim('GET', '/Users', undefined, old)).statusCode).toBe(401);
    expect((await scim('POST', '/Users', person('new.viewer@acme.test'))).json().roles).toEqual([{ value: 'VIEWER', primary: true }]);
    expect((await api('GET', '/scim')).json().lastUsedAt).toEqual(expect.any(String));
    expect((await api('DELETE', '/scim')).statusCode).toBe(204);
    expect((await scim('GET', '/Users')).statusCode).toBe(401);
    expect((await api('GET', '/scim')).json()).toMatchObject({ enabled: false, tokenPrefix: null });
  });
});
