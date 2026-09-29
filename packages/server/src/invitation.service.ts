import { AppError, canAssignRole, newSecretToken, sha256, type Role } from '@ao/core';
import { Invitation, Membership, Organization, User, isDuplicateKeyError, oid, type mongoose } from '@ao/database';
import type { AddMemberResponse, InvitationDto, InvitationPreviewDto } from '@ao/contracts';
import type { ServerConfig } from './config.js';
import type { Actor } from './context.js';
import { requirePermission } from './context.js';
import { audit } from './audit.js';
import type { Mailer } from './notifications.js';
import type { OrgService } from './org.service.js';

const INVITATION_TTL_MS = 7 * 86_400_000;

type InvitationLean = { _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; email: string; role: string; invitedBy: mongoose.Types.ObjectId; expiresAt: Date; createdAt: Date };

const pendingFilter = () => ({ acceptedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } });

/**
 * Atomically marks a pending invitation accepted so a link works exactly once. With `email`, the
 * invitation must be for that address. Returns null when the link is invalid, used, revoked or expired.
 */
export async function claimInvitation(token: string, acceptedBy: mongoose.Types.ObjectId, email?: string) {
  return (await Invitation.findOneAndUpdate(
    { tokenHash: sha256(token), ...pendingFilter(), ...(email ? { email: email.toLowerCase() } : {}) },
    { acceptedAt: new Date(), acceptedBy },
    { new: true },
  ).lean()) as InvitationLean | null;
}

/** Undo a claim when the step after it fails (e.g. the account could not be created). */
export async function unclaimInvitation(id: mongoose.Types.ObjectId) {
  await Invitation.updateOne({ _id: id }, { acceptedAt: null, acceptedBy: null });
}

/** Organization invitations for people who may not have an account yet (spec §18). */
export class InvitationService {
  constructor(
    private config: ServerConfig,
    private mailer: Mailer,
    private orgs: OrgService,
  ) {}

  /** Adds an existing user immediately; anyone else receives an invitation link by email. */
  async addOrInvite(actor: Actor, email: string, role: Role): Promise<AddMemberResponse> {
    requirePermission(actor, 'member.invite');
    if (!canAssignRole(actor.role, role)) throw new AppError('FORBIDDEN', `You cannot grant the ${role} role`);
    const normalized = email.toLowerCase();
    if (await User.exists({ email: normalized })) {
      await this.orgs.addMember(actor, normalized, role);
      return { status: 'added' };
    }
    const orgId = oid(actor.organizationId);
    // Re-inviting replaces the pending invitation, so only the newest link works.
    await Invitation.updateMany({ organizationId: orgId, email: normalized, ...pendingFilter() }, { revokedAt: new Date() });
    const token = newSecretToken(32);
    const inv = await Invitation.create({ organizationId: orgId, email: normalized, role, tokenHash: sha256(token), invitedBy: oid(actor.userId), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) });
    const [org, inviter] = await Promise.all([Organization.findById(orgId).lean(), User.findById(oid(actor.userId)).lean()]);
    const inviteUrl = `${this.config.WEB_URL}/invite?token=${token}`;
    await this.mailer.send(
      normalized,
      `You're invited to ${org?.name ?? 'an organization'}`,
      `${inviter?.name ?? 'A member'} invited you to join ${org?.name ?? 'their organization'} on Agent Orchestration as ${role.toLowerCase()}.\n\nAccept: ${inviteUrl}\nThis link expires in 7 days.`,
    );
    await audit(actor, 'member.invite', { type: 'invitation', id: String(inv._id) }, { email: normalized, role });
    // The link is also returned so the inviter can share it when the server has no email configured.
    return { status: 'invited', invitation: toDto(inv.toObject() as InvitationLean, inviter?.name ?? ''), inviteUrl };
  }

  async list(actor: Actor): Promise<InvitationDto[]> {
    requirePermission(actor, 'member.read');
    const invs = (await Invitation.find({ organizationId: oid(actor.organizationId), ...pendingFilter() }).sort({ createdAt: -1 }).lean()) as InvitationLean[];
    const inviters = await User.find({ _id: { $in: invs.map((i) => i.invitedBy) } }, { name: 1 }).lean();
    const names = new Map(inviters.map((u) => [String(u._id), u.name]));
    return invs.map((i) => toDto(i, names.get(String(i.invitedBy)) ?? ''));
  }

  async revoke(actor: Actor, invitationId: string) {
    requirePermission(actor, 'member.invite');
    const r = await Invitation.updateOne({ _id: oid(invitationId, 'Invitation'), organizationId: oid(actor.organizationId), ...pendingFilter() }, { revokedAt: new Date() });
    if (!r.modifiedCount) throw new AppError('NOT_FOUND', 'Invitation not found');
    await audit(actor, 'member.invite_revoke', { type: 'invitation', id: invitationId });
  }

  /** Public: the token itself is the secret, so its holder may see who invited them to what. */
  async preview(token: string): Promise<InvitationPreviewDto> {
    const inv = (await Invitation.findOne({ tokenHash: sha256(token), ...pendingFilter() }).lean()) as InvitationLean | null;
    if (!inv) throw new AppError('NOT_FOUND', 'This invitation is invalid, was already used, or has expired');
    const [org, inviter, account] = await Promise.all([Organization.findById(inv.organizationId).lean(), User.findById(inv.invitedBy).lean(), User.exists({ email: inv.email })]);
    return {
      organizationName: org?.name ?? '',
      email: inv.email,
      role: inv.role as Role,
      invitedByName: inviter?.name ?? '',
      expiresAt: inv.expiresAt.toISOString(),
      accountExists: Boolean(account),
    };
  }

  /** A signed-in user accepts an invitation addressed to their own email. */
  async accept(userId: string, token: string) {
    const user = await User.findById(oid(userId, 'User')).lean();
    if (!user) throw new AppError('UNAUTHENTICATED', 'User not found');
    const inv = await claimInvitation(token, user._id, user.email);
    if (!inv) {
      const other = await Invitation.exists({ tokenHash: sha256(token), ...pendingFilter() });
      throw other
        ? new AppError('FORBIDDEN', 'This invitation was sent to a different email address. Sign in with that account.')
        : new AppError('NOT_FOUND', 'This invitation is invalid, was already used, or has expired');
    }
    try {
      await Membership.create({ organizationId: inv.organizationId, userId: user._id, role: inv.role });
    } catch (e) {
      if (!isDuplicateKeyError(e)) {
        await unclaimInvitation(inv._id);
        throw e;
      }
      // Already a member: the invitation is simply used up.
    }
    await audit({ system: true, organizationId: String(inv.organizationId) }, 'member.invite_accept', { type: 'user', id: userId }, { invitationId: String(inv._id), role: inv.role });
    return { organizationId: String(inv.organizationId) };
  }
}

function toDto(i: InvitationLean, invitedByName: string): InvitationDto {
  return { id: String(i._id), email: i.email, role: i.role as Role, invitedByName, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() };
}
