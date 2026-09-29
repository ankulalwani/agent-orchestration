import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, Invitation, Membership, Organization, User, oid } from '@ao/database';
import type { Actor } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

beforeAll(startTestDatabase);
afterAll(stopTestDatabase);

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
let n = 0;
const newEmail = () => `invitee-${Date.now()}-${++n}@example.com`;

describe('invitations for people without an account (ORG-005)', () => {
  it('invite → email → register through the link → member of the inviting org only, email verified', async () => {
    // Open registration disabled: the invitation alone authorizes the new account.
    const { services: s, sent } = await makeServices({ ALLOW_REGISTRATION: 'false' });
    const { actor } = await makeOwner(s);
    const email = newEmail();
    const r = await s.invitations.addOrInvite(actor, email.toUpperCase(), 'DEVELOPER');
    expect(r.status).toBe('invited');
    expect(r.invitation).toMatchObject({ email, role: 'DEVELOPER' });
    const mail = sent.find((m) => m.to === email)!;
    expect(mail.text).toContain(r.inviteUrl);
    const token = tokenOf(r.inviteUrl!);

    expect(await s.invitations.preview(token)).toMatchObject({ email, role: 'DEVELOPER', accountExists: false });
    expect(await s.invitations.list(actor)).toHaveLength(1);

    // Without the invitation, registration is closed.
    await expect(s.auth.register({ email, password: 'invitee-password-1', name: 'I' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The link only works for the invited address.
    await expect(s.auth.register({ email: newEmail(), password: 'invitee-password-1', name: 'X', invitationToken: token })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const session = await s.auth.register({ email, password: 'invitee-password-1', name: 'Invitee', invitationToken: token });
    expect(session.user.emailVerified).toBe(true);
    expect(session.memberships).toEqual([expect.objectContaining({ organizationId: actor.organizationId, role: 'DEVELOPER' })]);
    expect(await Organization.countDocuments({ _id: { $ne: oid(actor.organizationId) } })).toBe(0); // no personal org created

    // Single use; no longer pending.
    await expect(s.invitations.preview(token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.auth.register({ email: newEmail(), password: 'invitee-password-1', name: 'Y', invitationToken: token })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await s.invitations.list(actor)).toHaveLength(0);
    expect(await AuditLog.exists({ action: 'member.invite_accept' })).toBeTruthy();
  });

  it('an existing user is added immediately; a signed-in user can accept an invitation for their own email only', async () => {
    const { services: s } = await makeServices();
    const { actor } = await makeOwner(s);
    const existing = await makeOwner(s, 'existing');
    expect(await s.invitations.addOrInvite(actor, existing.auth.user.email, 'VIEWER')).toEqual({ status: 'added' });

    // Invited before creating an account, then registered normally (own org), then accepts while signed in.
    const email = newEmail();
    const inv = await s.invitations.addOrInvite(actor, email, 'MANAGER');
    const later = await s.auth.register({ email, password: 'later-password-1', name: 'Later' });
    const token = tokenOf(inv.inviteUrl!);
    expect((await s.invitations.preview(token)).accountExists).toBe(true);
    await expect(s.invitations.accept(existing.auth.user.id, token)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await s.invitations.accept(later.user.id, token)).toEqual({ organizationId: actor.organizationId });
    expect(await Membership.findOne({ userId: oid(later.user.id), organizationId: oid(actor.organizationId) }).lean()).toMatchObject({ role: 'MANAGER' });
    await expect(s.invitations.accept(later.user.id, token)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('re-inviting replaces the old link; revoked and expired links do not work', async () => {
    const { services: s } = await makeServices();
    const { actor } = await makeOwner(s);
    const email = newEmail();
    const first = await s.invitations.addOrInvite(actor, email, 'DEVELOPER');
    const second = await s.invitations.addOrInvite(actor, email, 'DEVELOPER');
    await expect(s.invitations.preview(tokenOf(first.inviteUrl!))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await s.invitations.list(actor)).toHaveLength(1);

    await s.invitations.revoke(actor, second.invitation!.id);
    await expect(s.auth.register({ email, password: 'invitee-password-1', name: 'I', invitationToken: tokenOf(second.inviteUrl!) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const third = await s.invitations.addOrInvite(actor, email, 'DEVELOPER');
    await Invitation.updateOne({ _id: oid(third.invitation!.id) }, { expiresAt: new Date(Date.now() - 1000) });
    await expect(s.invitations.preview(tokenOf(third.inviteUrl!))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await User.exists({ email })).toBeNull();
  });

  it('two concurrent registrations with one link create exactly one account', async () => {
    const { services: s } = await makeServices();
    const { actor } = await makeOwner(s);
    const email = newEmail();
    const token = tokenOf((await s.invitations.addOrInvite(actor, email, 'DEVELOPER')).inviteUrl!);
    const results = await Promise.allSettled([1, 2].map(() => s.auth.register({ email, password: 'invitee-password-1', name: 'I', invitationToken: token })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await User.countDocuments({ email })).toBe(1);
  });

  it('RBAC: roles above your own cannot be granted, viewers cannot invite, and other orgs cannot revoke', async () => {
    const { services: s } = await makeServices();
    const { actor } = await makeOwner(s);
    const admin: Actor = { ...actor, role: 'ADMIN' };
    const viewer: Actor = { ...actor, role: 'VIEWER' };
    await expect(s.invitations.addOrInvite(admin, newEmail(), 'OWNER')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.invitations.addOrInvite(viewer, newEmail(), 'VIEWER')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const inv = await s.invitations.addOrInvite(actor, newEmail(), 'DEVELOPER');
    const other = await makeOwner(s);
    await expect(s.invitations.revoke(other.actor, inv.invitation!.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await s.invitations.list(other.actor)).toHaveLength(0);
  });
});
