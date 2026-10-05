import { AppError, ROLES, newSecretToken, roleRank, sha256, type Role } from '@ao/core';
import { Membership, Organization, User, isDuplicateKeyError, mongoose, oid } from '@ao/database';
import type { ServerConfig } from './config.js';
import { hashPassword } from './crypto.js';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';

export const SCIM_TOKEN_PREFIX = 'aos_';
const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** A SCIM failure: the HTTP status and the detail the identity provider shows its administrator. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
  }
  body() {
    return { schemas: [ERROR_SCHEMA], status: String(this.status), detail: this.message, ...(this.scimType ? { scimType: this.scimType } : {}) };
  }
}

/** The organization a SCIM request acts in, from its bearer token. */
export interface ScimContext {
  organizationId: string;
  defaultRole: Role;
}

type ScimUserInput = {
  userName?: unknown;
  externalId?: unknown;
  displayName?: unknown;
  active?: unknown;
  name?: { givenName?: unknown; familyName?: unknown; formatted?: unknown };
  emails?: Array<{ value?: unknown; primary?: unknown }>;
  roles?: Array<{ value?: unknown } | string>;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Identity providers send booleans as booleans, or as the strings "True" and "False" (Microsoft Entra). */
const asBoolean = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : typeof v === 'string' && /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : undefined);

/**
 * User provisioning with SCIM 2.0 (RFC 7643/7644), per organization: an identity provider (Okta, Microsoft
 * Entra ID, …) creates, deactivates and removes members with a bearer token. A user is a member of the
 * organization; `active: false` suspends the membership (no access, nothing lost), DELETE removes it.
 * New accounts have no password: people sign in with single sign-on, or set one through "Forgot password".
 * A role comes from `roles[0].value` (never OWNER), else the default role chosen with the token.
 * Groups are not provisioned.
 */
export class ScimService {
  constructor(private config: ServerConfig) {}

  baseUrl() {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}/scim/v2`;
  }

  // ── Setup (organization administrators) ─────────────────────────────────────
  async status(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    const org = await Organization.findById(oid(actor.organizationId), { scim: 1 }).lean();
    const scim = org?.scim;
    return {
      enabled: Boolean(scim?.tokenPrefix),
      baseUrl: this.baseUrl(),
      tokenPrefix: scim?.tokenPrefix ?? null,
      defaultRole: (scim?.defaultRole ?? 'DEVELOPER') as Role,
      createdAt: scim?.createdAt?.toISOString() ?? null,
      lastUsedAt: scim?.lastUsedAt?.toISOString() ?? null,
    };
  }

  /** Turns provisioning on, or replaces the token. The token is returned once; only its hash is stored. */
  async createToken(actor: Actor, defaultRole: Role) {
    requirePermission(actor, 'settings.manage');
    if (defaultRole === 'OWNER' || roleRank(defaultRole) > roleRank(actor.role)) throw new AppError('FORBIDDEN', 'Provisioned members cannot get a role above your own, and never the owner role');
    const token = `${SCIM_TOKEN_PREFIX}${newSecretToken(32)}`;
    await Organization.updateOne({ _id: oid(actor.organizationId) }, { $set: { scim: { tokenHash: sha256(token), tokenPrefix: token.slice(0, 10), defaultRole, createdAt: new Date() } } });
    await audit(actor, 'scim.token_created', { type: 'organization', id: actor.organizationId }, { defaultRole });
    return { token, ...(await this.status(actor)) };
  }

  async disable(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    await Organization.updateOne({ _id: oid(actor.organizationId) }, { $unset: { 'scim.tokenHash': 1, 'scim.tokenPrefix': 1, 'scim.createdAt': 1, 'scim.lastUsedAt': 1 } });
    await audit(actor, 'scim.disabled', { type: 'organization', id: actor.organizationId });
  }

  // ── Requests from the identity provider ─────────────────────────────────────
  async authenticate(authorization: string | undefined): Promise<ScimContext> {
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token.startsWith(SCIM_TOKEN_PREFIX)) throw new ScimError(401, 'A SCIM bearer token is required');
    const org = await Organization.findOneAndUpdate({ 'scim.tokenHash': sha256(token) }, { $set: { 'scim.lastUsedAt': new Date() } }, { projection: { scim: 1 } }).lean();
    if (!org) throw new ScimError(401, 'The SCIM token is not valid');
    return { organizationId: String(org._id), defaultRole: (org.scim?.defaultRole ?? 'DEVELOPER') as Role };
  }

  private resource(u: { _id: unknown; email: string; name: string; createdAt: Date; updatedAt?: Date }, m: { role: string; suspended?: boolean | null; scimExternalId?: string | null; updatedAt?: Date }) {
    const [givenName = '', ...rest] = u.name.split(' ');
    return {
      schemas: [USER_SCHEMA],
      id: String(u._id),
      ...(m.scimExternalId ? { externalId: m.scimExternalId } : {}),
      userName: u.email,
      displayName: u.name,
      name: { formatted: u.name, givenName, familyName: rest.join(' ') },
      emails: [{ value: u.email, primary: true, type: 'work' }],
      active: !m.suspended,
      roles: [{ value: m.role, primary: true }],
      meta: { resourceType: 'User', created: u.createdAt.toISOString(), lastModified: (m.updatedAt ?? u.updatedAt ?? u.createdAt).toISOString(), location: `${this.baseUrl()}/Users/${String(u._id)}` },
    };
  }

  private role(ctx: ScimContext, input: ScimUserInput, fallback: Role): Role {
    const first = input.roles?.[0];
    const value = String((typeof first === 'string' ? first : first?.value) ?? '').toUpperCase();
    if (!value) return fallback;
    if (!(ROLES as readonly string[]).includes(value) || value === 'OWNER') throw new ScimError(400, `"${value}" is not a role that can be provisioned. Use one of: ${ROLES.filter((r) => r !== 'OWNER').join(', ')}`, 'invalidValue');
    return value as Role;
  }

  private nameOf(input: ScimUserInput, fallback: string) {
    const parts = [input.name?.givenName, input.name?.familyName].filter((p): p is string => typeof p === 'string' && p.trim() !== '');
    const name = (typeof input.displayName === 'string' && input.displayName.trim()) || (typeof input.name?.formatted === 'string' && input.name.formatted.trim()) || parts.join(' ').trim() || fallback;
    return name.slice(0, 120);
  }

  private async member(ctx: ScimContext, id: string) {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new ScimError(404, 'User not found');
    const m = await Membership.findOne({ organizationId: oid(ctx.organizationId), userId: oid(id) }).lean();
    const u = m ? await User.findById(m.userId).lean() : null;
    if (!m || !u) throw new ScimError(404, 'User not found');
    return { m, u };
  }

  /** `filter=userName eq "x"` (also `externalId eq`, `emails.value eq`); anything else lists every member. */
  async listUsers(ctx: ScimContext, q: { filter?: string; startIndex?: number; count?: number }) {
    const orgId = oid(ctx.organizationId);
    const start = Math.max(1, Math.floor(q.startIndex ?? 1));
    const count = Math.min(200, Math.max(0, Math.floor(q.count ?? 100)));
    const f = /^\s*(userName|externalId|emails(?:\.value|\[type eq "work"\]\.value)?)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(q.filter ?? '');
    if (q.filter && !f) throw new ScimError(400, 'Only filters of the form userName eq "…" or externalId eq "…" are supported', 'invalidFilter');
    const filter: Record<string, unknown> = { organizationId: orgId };
    if (f) {
      const value = f[2]!.replace(/\\(.)/g, '$1');
      if (f[1]!.toLowerCase() === 'externalid') filter.scimExternalId = value;
      else {
        const u = await User.findOne({ email: value.toLowerCase() }, { _id: 1 }).lean();
        filter.userId = u?._id ?? new mongoose.Types.ObjectId();
      }
    }
    const total = await Membership.countDocuments(filter);
    const ms = await Membership.find(filter).sort({ _id: 1 }).skip(start - 1).limit(count).lean();
    const users = new Map((await User.find({ _id: { $in: ms.map((m) => m.userId) } }).lean()).map((u) => [String(u._id), u]));
    const Resources = ms.filter((m) => users.has(String(m.userId))).map((m) => this.resource(users.get(String(m.userId))!, m));
    return { schemas: [LIST_SCHEMA], totalResults: total, startIndex: start, itemsPerPage: Resources.length, Resources };
  }

  async getUser(ctx: ScimContext, id: string) {
    const { m, u } = await this.member(ctx, id);
    return this.resource(u, m);
  }

  /** Makes someone a member: an existing account with that email joins; otherwise an account is created. */
  async createUser(ctx: ScimContext, input: ScimUserInput) {
    const primary = input.emails?.find((e) => asBoolean(e.primary))?.value ?? input.emails?.[0]?.value;
    const email = [input.userName, primary].find((v): v is string => typeof v === 'string' && EMAIL.test(v.trim()))?.trim().toLowerCase();
    if (!email) throw new ScimError(400, 'userName (or the primary email) must be an email address', 'invalidValue');
    const role = this.role(ctx, input, ctx.defaultRole);
    let user = await User.findOne({ email }).lean();
    if (!user) {
      try {
        const created = await User.create({ email, name: this.nameOf(input, email.split('@')[0]!), passwordHash: await hashPassword(newSecretToken(32)), hasPassword: false, emailVerified: true });
        user = created.toObject() as never;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        user = await User.findOne({ email }).lean(); // created by a parallel request
      }
    }
    if (!user) throw new ScimError(500, 'The user could not be created');
    try {
      const m = await Membership.create({ organizationId: oid(ctx.organizationId), userId: user._id, role, suspended: asBoolean(input.active) === false, ...(typeof input.externalId === 'string' && input.externalId ? { scimExternalId: input.externalId.slice(0, 200) } : {}) });
      await audit({ system: true }, 'scim.user_provisioned', { type: 'user', id: String(user._id) }, { organizationId: ctx.organizationId, role });
      return this.resource(user, m.toObject());
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new ScimError(409, 'This user is already a member of the organization', 'uniqueness');
      throw e;
    }
  }

  /** Applies a change to a member: activation, role, external id, and the name of people who belong here only. */
  private async apply(ctx: ScimContext, id: string, change: ScimUserInput) {
    const { m, u } = await this.member(ctx, id);
    const set: Record<string, unknown> = {};
    const active = asBoolean(change.active);
    if (change.active !== undefined && active === undefined) throw new ScimError(400, 'active must be true or false', 'invalidValue');
    const role = change.roles ? this.role(ctx, change, m.role as Role) : (m.role as Role);
    // The organization keeps an owner whatever the identity provider says.
    if (m.role === 'OWNER' && (active === false || role !== 'OWNER')) {
      const owners = await Membership.countDocuments({ organizationId: m.organizationId, role: 'OWNER', suspended: { $ne: true } });
      if (owners <= 1) throw new ScimError(409, 'This is the organization’s only owner; make someone else an owner in the dashboard first', 'mutability');
    }
    if (active !== undefined) set.suspended = !active;
    if (change.roles && m.role !== 'OWNER') set.role = role;
    if (typeof change.externalId === 'string') set.scimExternalId = change.externalId.slice(0, 200);
    if (Object.keys(set).length) await Membership.updateOne({ _id: m._id }, { $set: set });
    if ((change.displayName !== undefined || change.name) && !(await Membership.exists({ userId: u._id, organizationId: { $ne: m.organizationId } }))) {
      await User.updateOne({ _id: u._id }, { $set: { name: this.nameOf(change, u.name) } });
    }
    if (active !== undefined && active === Boolean(m.suspended)) await audit({ system: true }, active ? 'scim.user_activated' : 'scim.user_deactivated', { type: 'user', id }, { organizationId: ctx.organizationId });
    return this.getUser(ctx, id);
  }

  replaceUser(ctx: ScimContext, id: string, input: ScimUserInput) {
    return this.apply(ctx, id, input);
  }

  /** PATCH with `Operations`: `replace`/`add` of active, displayName, name.*, externalId and roles. */
  async patchUser(ctx: ScimContext, id: string, body: { Operations?: Array<{ op?: unknown; path?: unknown; value?: unknown }> }) {
    const change: ScimUserInput = {};
    for (const op of body.Operations ?? []) {
      const kind = String(op.op ?? '').toLowerCase();
      if (!['replace', 'add'].includes(kind)) throw new ScimError(400, `Operation "${String(op.op)}" is not supported`, 'invalidSyntax');
      const path = typeof op.path === 'string' ? op.path : '';
      if (!path) Object.assign(change, op.value as object); // { "active": false, … }
      else if (path === 'active') change.active = op.value;
      else if (path === 'displayName') change.displayName = op.value;
      else if (path === 'externalId') change.externalId = op.value;
      else if (path === 'name.givenName' || path === 'name.familyName' || path === 'name.formatted') change.name = { ...(change.name ?? {}), [path.slice(5)]: op.value };
      else if (path === 'roles' || /^roles\[.*\]\.value$/.test(path)) change.roles = Array.isArray(op.value) ? (op.value as never) : [{ value: op.value }];
      // Other attributes (addresses, phone numbers, …) are not kept: accepted and ignored.
    }
    return this.apply(ctx, id, change);
  }

  /** Removes the member from the organization. The account stays (it may belong to other organizations). */
  async deleteUser(ctx: ScimContext, id: string) {
    const { m } = await this.member(ctx, id);
    if (m.role === 'OWNER' && (await Membership.countDocuments({ organizationId: m.organizationId, role: 'OWNER', suspended: { $ne: true } })) <= 1) {
      throw new ScimError(409, 'This is the organization’s only owner; make someone else an owner in the dashboard first', 'mutability');
    }
    await Membership.deleteOne({ _id: m._id });
    await audit({ system: true }, 'scim.user_removed', { type: 'user', id }, { organizationId: ctx.organizationId });
  }

  // ── Discovery ───────────────────────────────────────────────────────────────
  serviceProviderConfig() {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The provisioning token from Settings → Members', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${this.baseUrl()}/ServiceProviderConfig` },
    };
  }

  resourceTypes() {
    return { schemas: [LIST_SCHEMA], totalResults: 1, startIndex: 1, itemsPerPage: 1, Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: USER_SCHEMA, meta: { resourceType: 'ResourceType', location: `${this.baseUrl()}/ResourceTypes/User` } }] };
  }

  /** Groups are not provisioned: identity providers that look for them find none. */
  emptyList() {
    return { schemas: [LIST_SCHEMA], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] };
  }
}
