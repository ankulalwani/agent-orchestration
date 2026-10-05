import { createHash, randomBytes } from 'node:crypto';
import { AppError, roleRank, type Role } from '@ao/core';
import { ApiToken, Membership, User, oid } from '@ao/database';
import { audit } from './audit.js';

export const API_TOKEN_PREFIX = 'aot_';
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface ApiTokenScope {
  tokenId: string;
  organizationId: string;
  role: Role;
}

export interface ApiTokenDto {
  id: string;
  name: string;
  organizationId: string;
  role: Role;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

const toDto = (t: { _id: unknown; name: string; organizationId: unknown; role: string; prefix: string; expiresAt?: Date | null; lastUsedAt?: Date | null; createdAt: Date }): ApiTokenDto => ({
  id: String(t._id),
  name: t.name,
  organizationId: String(t.organizationId),
  role: t.role as Role,
  prefix: t.prefix,
  expiresAt: t.expiresAt?.toISOString() ?? null,
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
});

/**
 * Personal API tokens (for the CLI in CI, scripts and IDE extensions). A token acts as its owner in
 * one organization, with at most the role it was created with and never more than the owner's current
 * role; it can't manage tokens, sign-in settings or the server. Only its hash is stored.
 */
export class ApiTokenService {
  async create(userId: string, input: { name: string; organizationId: string; role?: Role; expiresInDays?: number | null }) {
    const m = await Membership.findOne({ userId: oid(userId), organizationId: oid(input.organizationId), suspended: { $ne: true } }).lean();
    if (!m) throw new AppError('NOT_FOUND', 'Organization not found');
    const role = input.role ?? (m.role as Role);
    if (roleRank(role) > roleRank(m.role as Role)) throw new AppError('FORBIDDEN', `A token can't have a higher role than yours (${m.role})`);
    const token = API_TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const doc = await ApiToken.create({
      userId: oid(userId),
      organizationId: m.organizationId,
      name: input.name,
      role,
      tokenHash: hash(token),
      prefix: token.slice(0, 12),
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    });
    await audit({ userId, organizationId: input.organizationId, role: m.role as Role, correlationId: 'api-token' }, 'api_token.create', { type: 'api_token', id: String(doc._id) }, { name: input.name, role });
    return { token, ...toDto(doc.toObject()) };
  }

  async list(userId: string) {
    const docs = await ApiToken.find({ userId: oid(userId), revokedAt: null }).sort({ createdAt: -1 }).lean();
    return docs.map(toDto);
  }

  async revoke(userId: string, id: string) {
    const doc = await ApiToken.findOneAndUpdate({ _id: oid(id, 'Token'), userId: oid(userId), revokedAt: null }, { $set: { revokedAt: new Date() } }).lean();
    if (!doc) throw new AppError('NOT_FOUND', 'Token not found');
    await audit({ userId, organizationId: String(doc.organizationId), role: doc.role as Role, correlationId: 'api-token' }, 'api_token.revoke', { type: 'api_token', id });
  }

  /** Resolves a presented token. The effective role is the lower of the token's and the owner's current one. */
  async authenticate(token: string): Promise<{ userId: string; scope: ApiTokenScope }> {
    const doc = await ApiToken.findOne({ tokenHash: hash(token), revokedAt: null }).lean();
    if (!doc || (doc.expiresAt && doc.expiresAt.getTime() < Date.now())) throw new AppError('UNAUTHENTICATED', 'Invalid or expired API token');
    const user = await User.findById(doc.userId, { disabled: 1 }).lean();
    if (!user || user.disabled) throw new AppError('UNAUTHENTICATED', "The token owner's account is disabled");
    const m = await Membership.findOne({ userId: doc.userId, organizationId: doc.organizationId, suspended: { $ne: true } }).lean();
    if (!m) throw new AppError('UNAUTHENTICATED', 'The token owner is no longer a member of this organization');
    const role = roleRank(m.role as Role) < roleRank(doc.role as Role) ? (m.role as Role) : (doc.role as Role);
    // At most one write per minute per token for "last used".
    if (!doc.lastUsedAt || Date.now() - doc.lastUsedAt.getTime() > 60_000) void ApiToken.updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } }).exec();
    return { userId: String(doc.userId), scope: { tokenId: String(doc._id), organizationId: String(doc.organizationId), role } };
  }
}
