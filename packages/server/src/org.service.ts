import { AppError, canAssignRole, policyLayerSchema, type Role } from '@ao/core';
import { Membership, Organization, Team, User, isDuplicateKeyError, oid } from '@ao/database';
import type { Actor } from './context.js';
import { requirePermission } from './context.js';
import { audit } from './audit.js';

export class OrgService {
  /** Resolve the caller's role in an org. This is the tenant-isolation gate (spec §18, §57). */
  async resolveActor(userId: string, organizationId: string, correlationId: string, ip?: string | null, platformAdmin?: boolean): Promise<Actor> {
    const m = await Membership.findOne({ userId: oid(userId, 'User'), organizationId: oid(organizationId, 'Organization'), suspended: { $ne: true } }).lean();
    // Non-members get NOT_FOUND, not FORBIDDEN, so org ids can't be probed.
    if (!m) throw new AppError('NOT_FOUND', 'Organization not found');
    return { userId, organizationId, role: m.role, correlationId, ip, platformAdmin };
  }

  /** Organizations on this server by name or slug, for platform administrators (first 50). */
  async searchAll(q?: string) {
    const filter = q ? { $or: [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { slug: { $regex: escapeRegex(q), $options: 'i' } }] } : {};
    const orgs = await Organization.find(filter, { name: 1, slug: 1 }).sort({ name: 1 }).limit(50).lean();
    return orgs.map((o) => ({ id: String(o._id), name: o.name, slug: o.slug }));
  }

  async get(actor: Actor) {
    requirePermission(actor, 'org.read');
    const org = await Organization.findById(oid(actor.organizationId)).lean();
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    return {
      id: String(org._id),
      name: org.name,
      slug: org.slug,
      policy: org.policy ?? {},
      knowledge: org.knowledge ?? '',
      settings: org.settings,
      createdAt: org.createdAt.toISOString(),
    };
  }

  async update(actor: Actor, input: { name?: string; policy?: unknown; knowledge?: string; settings?: Record<string, unknown> }) {
    requirePermission(actor, 'org.update');
    const set: Record<string, unknown> = {};
    if (input.name) set.name = input.name;
    if (input.knowledge !== undefined) set.knowledge = input.knowledge;
    if (input.policy !== undefined) {
      requirePermission(actor, 'policy.manage');
      set.policy = policyLayerSchema.parse(input.policy);
    }
    if (input.settings) {
      requirePermission(actor, 'settings.manage');
      for (const [k, v] of Object.entries(input.settings)) {
        if (v && typeof v === 'object') for (const [k2, v2] of Object.entries(v)) set[`settings.${k}.${k2}`] = v2;
        else set[`settings.${k}`] = v;
      }
    }
    await Organization.updateOne({ _id: oid(actor.organizationId) }, { $set: set });
    await audit(actor, 'org.update', { type: 'organization', id: actor.organizationId }, { fields: Object.keys(set) });
    return this.get(actor);
  }

  async listMembers(actor: Actor) {
    requirePermission(actor, 'member.read');
    const ms = await Membership.find({ organizationId: oid(actor.organizationId) }).lean();
    const users = await User.find({ _id: { $in: ms.map((m) => m.userId) } }).lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    // Whether each member also belongs elsewhere (organization admins can't reset their two-factor then).
    const elsewhere = new Set((await Membership.find({ userId: { $in: ms.map((m) => m.userId) }, organizationId: { $ne: oid(actor.organizationId) } }, { userId: 1 }).lean()).map((m) => String(m.userId)));
    return ms
      .filter((m) => byId.has(String(m.userId)))
      .map((m) => {
        const u = byId.get(String(m.userId))!;
        return { userId: String(u._id), email: u.email, name: u.name, role: m.role, joinedAt: m.createdAt.toISOString(), mfaEnabled: Boolean(u.mfa?.enabled), inOtherOrganizations: elsewhere.has(String(u._id)), suspended: Boolean(m.suspended) };
      });
  }

  /** Adds an existing user by email. People without an account are invited instead (InvitationService). */
  async addMember(actor: Actor, email: string, role: Role) {
    requirePermission(actor, 'member.invite');
    if (!canAssignRole(actor.role, role)) throw new AppError('FORBIDDEN', `You cannot grant the ${role} role`);
    const user = await User.findOne({ email: email.toLowerCase() }).lean();
    if (!user) throw new AppError('NOT_FOUND', 'No user with that email. Ask them to create an account first.');
    try {
      await Membership.create({ organizationId: oid(actor.organizationId), userId: user._id, role });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'User is already a member');
      throw e;
    }
    await audit(actor, 'member.add', { type: 'user', id: String(user._id) }, { role });
  }

  async updateMemberRole(actor: Actor, userId: string, role: Role) {
    requirePermission(actor, 'member.update_role');
    if (!canAssignRole(actor.role, role)) throw new AppError('FORBIDDEN', `You cannot grant the ${role} role`);
    const m = await Membership.findOne({ organizationId: oid(actor.organizationId), userId: oid(userId) });
    if (!m) throw new AppError('NOT_FOUND', 'Member not found');
    if (m.role === 'OWNER' && actor.role !== 'OWNER') throw new AppError('FORBIDDEN', 'Only owners can change an owner');
    if (m.role === 'OWNER' && role !== 'OWNER') await this.assertNotLastOwner(actor.organizationId);
    const from = m.role;
    m.role = role;
    await m.save();
    await audit(actor, 'member.role_change', { type: 'user', id: userId }, { from, to: role });
  }

  async removeMember(actor: Actor, userId: string) {
    requirePermission(actor, 'member.remove');
    const m = await Membership.findOne({ organizationId: oid(actor.organizationId), userId: oid(userId) });
    if (!m) throw new AppError('NOT_FOUND', 'Member not found');
    if (m.role === 'OWNER') {
      if (actor.role !== 'OWNER') throw new AppError('FORBIDDEN', 'Only owners can remove an owner');
      await this.assertNotLastOwner(actor.organizationId);
    }
    await Membership.deleteOne({ _id: m._id });
    await audit(actor, 'member.remove', { type: 'user', id: userId });
  }

  private async assertNotLastOwner(organizationId: string) {
    const owners = await Membership.countDocuments({ organizationId: oid(organizationId), role: 'OWNER' });
    if (owners <= 1) throw new AppError('CONFLICT', 'An organization must keep at least one owner');
  }

  async listTeams(actor: Actor) {
    requirePermission(actor, 'member.read');
    const teams = await Team.find({ organizationId: oid(actor.organizationId) }).lean();
    return teams.map((t) => ({ id: String(t._id), name: t.name, memberIds: t.memberIds.map(String), createdAt: t.createdAt.toISOString() }));
  }

  async createTeam(actor: Actor, name: string, memberIds: string[]) {
    requirePermission(actor, 'team.manage');
    const members = await Membership.find({ organizationId: oid(actor.organizationId), userId: { $in: memberIds.map((m) => oid(m)) } }).lean();
    if (members.length !== new Set(memberIds).size) throw new AppError('VALIDATION_FAILED', 'All team members must belong to the organization');
    try {
      const t = await Team.create({ organizationId: oid(actor.organizationId), name, memberIds: members.map((m) => m.userId) });
      await audit(actor, 'team.create', { type: 'team', id: String(t._id) });
      return { id: String(t._id), name: t.name, memberIds: t.memberIds.map(String), createdAt: t.createdAt.toISOString() };
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A team with this name exists');
      throw e;
    }
  }

  async deleteTeam(actor: Actor, teamId: string) {
    requirePermission(actor, 'team.manage');
    const r = await Team.deleteOne({ _id: oid(teamId), organizationId: oid(actor.organizationId) });
    if (!r.deletedCount) throw new AppError('NOT_FOUND', 'Team not found');
    await audit(actor, 'team.delete', { type: 'team', id: teamId });
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
