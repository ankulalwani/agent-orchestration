import { SignJWT, jwtVerify } from 'jose';
import { AppError, can, roleRank, type Role, newId, newRecoveryCodes, newSecretToken, newTotpSecret, normalizeRecoveryCode, sha256, totpUri, verifyTotp } from '@ao/core';
import { Membership, OneTimeToken, Organization, RefreshToken, User, isDuplicateKeyError, mongoose, oid } from '@ao/database';
import type { AuthResponse, MembershipDto } from '@ao/contracts';
import type { ServerConfig } from './config.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword, type SecretBox } from './crypto.js';
import { toUserDto } from './dto.js';
import { audit } from './audit.js';
import { claimInvitation, unclaimInvitation } from './invitation.service.js';
import type { Mailer } from './notifications.js';

const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MS = 15 * 60_000;

export interface AccessClaims {
  sub: string;
  pa?: boolean; // platform admin
}

export function slugify(name: string) {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}

export class AuthService {
  private secret: Uint8Array;
  constructor(
    private config: ServerConfig,
    private mailer: Mailer,
    private box: SecretBox,
  ) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  async register(
    input: { email: string; password: string; name: string; organizationName?: string; invitationToken?: string },
    meta: { ip?: string; userAgent?: string } = {},
  ) {
    if (input.invitationToken) return this.registerWithInvitation({ ...input, invitationToken: input.invitationToken }, meta);
    if (!this.config.ALLOW_REGISTRATION) {
      // The very first user may always register so a fresh self-hosted install can be bootstrapped.
      if ((await User.estimatedDocumentCount()) > 0) throw new AppError('FORBIDDEN', 'Registration is disabled on this server');
    }
    const isFirstUser = (await User.estimatedDocumentCount()) === 0;
    let user;
    try {
      user = await User.create({
        email: input.email,
        name: input.name,
        passwordHash: await hashPassword(input.password),
        platformAdmin: isFirstUser && this.config.FIRST_USER_IS_PLATFORM_ADMIN, // first user administers a self-hosted install
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'An account with this email already exists');
      throw e;
    }
    const orgName = input.organizationName ?? `${input.name}'s organization`;
    await this.createOrganizationFor(String(user._id), orgName);
    await audit({ system: true }, 'auth.register', { type: 'user', id: String(user._id) });
    await this.sendEmailVerification(String(user._id), user.email);
    return this.issueSession(String(user._id), meta);
  }

  /**
   * Registration through an invitation (spec §18): allowed even when open registration is disabled,
   * joins the inviting organization instead of creating one, and verifies the email, since the link
   * was delivered to that address.
   */
  private async registerWithInvitation(input: { email: string; password: string; name: string; invitationToken: string }, meta: { ip?: string; userAgent?: string }) {
    const userId = new mongoose.Types.ObjectId();
    const inv = await claimInvitation(input.invitationToken, userId, input.email);
    if (!inv) throw new AppError('VALIDATION_FAILED', 'This invitation is invalid, has expired, or was sent to a different email address');
    try {
      await User.create({ _id: userId, email: input.email, name: input.name, passwordHash: await hashPassword(input.password), emailVerified: true });
    } catch (e) {
      await unclaimInvitation(inv._id);
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'An account with this email already exists. Sign in to accept the invitation.');
      throw e;
    }
    await Membership.create({ organizationId: inv.organizationId, userId, role: inv.role });
    await audit({ system: true, organizationId: String(inv.organizationId) }, 'auth.register', { type: 'user', id: String(userId) }, { invitationId: String(inv._id) });
    await audit({ system: true, organizationId: String(inv.organizationId) }, 'member.invite_accept', { type: 'user', id: String(userId) }, { invitationId: String(inv._id), role: inv.role });
    return this.issueSession(String(userId), meta);
  }

  async createOrganizationFor(userId: string, name: string) {
    let slug = slugify(name);
    for (let attempt = 0; ; attempt++) {
      try {
        const org = await Organization.create({ name, slug: attempt ? `${slug}-${newSecretToken(3).toLowerCase()}` : slug });
        await Membership.create({ organizationId: org._id, userId: oid(userId), role: 'OWNER' });
        return org;
      } catch (e) {
        if (!isDuplicateKeyError(e) || attempt > 5) throw e;
        slug = slugify(name);
      }
    }
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string } = {}, mfaCode?: string): Promise<AuthResponse> {
    const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    const invalid = new AppError('UNAUTHENTICATED', 'Invalid email or password');
    if (!user) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH); // equalise timing
      throw invalid;
    }
    if (user.disabled) throw invalid;
    this.assertNotLocked(user);
    if (!(await verifyPassword(password, user.passwordHash))) {
      await this.recordFailedSignIn(user, 'password', meta);
      throw invalid;
    }
    return this.completeSignIn(user, 'password', mfaCode, meta);
  }

  private assertNotLocked(user: { lockedUntil?: Date | null }) {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppError('RATE_LIMITED', 'Too many failed attempts; try again later', { retryable: true });
    }
  }

  private async recordFailedSignIn(user: { _id: mongoose.Types.ObjectId; failedLoginCount?: number | null }, reason: string, meta: { ip?: string }) {
    const failed = (user.failedLoginCount ?? 0) + 1;
    await User.updateOne(
      { _id: user._id },
      { failedLoginCount: failed >= MAX_FAILED_LOGINS ? 0 : failed, lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MS) : null },
    );
    await audit({ system: true }, 'auth.login_failed', { type: 'user', id: String(user._id) }, { ip: meta.ip, reason });
  }

  /**
   * Final steps shared by every sign-in method once the first factor is proven (password, or an
   * OAuth identity): email-verification policy, the second factor when enabled (spec §56), audit,
   * session. `beforeSession` lets the caller consume a single-use credential only after 2FA passed.
   */
  private async completeSignIn(
    user: { _id: mongoose.Types.ObjectId; emailVerified?: boolean | null; failedLoginCount?: number | null; mfa?: { enabled?: boolean | null } | null },
    firstFactor: string,
    mfaCode: string | undefined,
    meta: { ip?: string; userAgent?: string },
    beforeSession?: () => Promise<boolean>,
  ): Promise<AuthResponse> {
    if (this.config.REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) {
      throw new AppError('FORBIDDEN', 'Please verify your email address first');
    }
    let method = firstFactor;
    if (user.mfa?.enabled) {
      // Wrong codes count towards the same lockout as wrong passwords.
      if (!mfaCode) throw new AppError('MFA_REQUIRED', 'Enter the code from your authenticator app');
      const factor = await this.checkSecondFactor(user._id, mfaCode);
      if (!factor) {
        await this.recordFailedSignIn(user, 'mfa', meta);
        throw new AppError('UNAUTHENTICATED', 'Invalid authentication code');
      }
      method = `${firstFactor}+${factor}`;
    }
    if (beforeSession && !(await beforeSession())) throw new AppError('UNAUTHENTICATED', 'This sign-in link is invalid or has expired. Start again.');
    await User.updateOne({ _id: user._id }, { failedLoginCount: 0, lockedUntil: null });
    await audit({ system: true }, 'auth.login', { type: 'user', id: String(user._id) }, { ip: meta.ip, method });
    return this.issueSession(String(user._id), meta);
  }

  /** Sign-in with an external identity already proven by the provider (see OAuthService). */
  async signInWithIdentity(userId: mongoose.Types.ObjectId, provider: string, mfaCode: string | undefined, meta: { ip?: string; userAgent?: string }, consume: () => Promise<boolean>) {
    const user = await User.findById(userId).lean();
    if (!user || user.disabled) throw new AppError('UNAUTHENTICATED', 'This account cannot sign in');
    this.assertNotLocked(user);
    return this.completeSignIn(user, `oauth:${provider}`, mfaCode, meta, consume);
  }

  /**
   * Creates an account for a new external identity. With an invitation, it joins that organization
   * (the invitation must be for this email); otherwise open-registration rules apply, as for `register`.
   */
  async createExternalUser(input: { email: string; name: string; provider: string; subject: string; invitationToken?: string | null }) {
    const userId = new mongoose.Types.ObjectId();
    const inv = input.invitationToken ? await claimInvitation(input.invitationToken, userId, input.email) : null;
    if (input.invitationToken && !inv) throw new AppError('VALIDATION_FAILED', 'This invitation is invalid, has expired, or was sent to a different email address');
    const isFirstUser = (await User.estimatedDocumentCount()) === 0;
    if (!inv && !this.config.ALLOW_REGISTRATION && !isFirstUser) throw new AppError('FORBIDDEN', 'No account exists for this email. Ask an administrator for an invitation.');
    try {
      await User.create({
        _id: userId,
        email: input.email,
        name: input.name,
        // Unusable random password: the user signs in with the provider, or sets one via password reset.
        passwordHash: await hashPassword(newSecretToken(32)),
        hasPassword: false,
        emailVerified: true,
        platformAdmin: isFirstUser && !inv && this.config.FIRST_USER_IS_PLATFORM_ADMIN,
        identities: [{ provider: input.provider, subject: input.subject, email: input.email, linkedAt: new Date() }],
      });
    } catch (e) {
      if (inv) await unclaimInvitation(inv._id);
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'An account with this email already exists');
      throw e;
    }
    if (inv) {
      await Membership.create({ organizationId: inv.organizationId, userId, role: inv.role });
      await audit({ system: true, organizationId: String(inv.organizationId) }, 'member.invite_accept', { type: 'user', id: String(userId) }, { invitationId: String(inv._id), role: inv.role });
    } else {
      await this.createOrganizationFor(String(userId), `${input.name}'s organization`);
    }
    await audit({ system: true }, 'auth.register', { type: 'user', id: String(userId) }, { provider: input.provider });
    return userId;
  }

  async issueSession(userId: string, meta: { ip?: string; userAgent?: string } = {}, familyId: string = newId()): Promise<AuthResponse> {
    const user = await User.findById(userId).lean();
    if (!user) throw new AppError('UNAUTHENTICATED', 'User not found');
    const accessToken = await this.signAccess({ sub: userId, pa: user.platformAdmin || undefined });
    const refreshToken = newSecretToken(32);
    await RefreshToken.create({
      userId: user._id,
      tokenHash: sha256(refreshToken),
      familyId,
      expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      userAgent: meta.userAgent,
      ip: meta.ip,
    });
    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SEC,
      user: toUserDto(user),
      memberships: await this.memberships(userId),
    };
  }

  /** Rotating refresh tokens; presenting an already-rotated token revokes the whole family. */
  async refresh(refreshToken: string, meta: { ip?: string; userAgent?: string } = {}): Promise<AuthResponse> {
    const hash = sha256(refreshToken);
    const rotated = await RefreshToken.findOneAndUpdate(
      { tokenHash: hash, revokedAt: null, expiresAt: { $gt: new Date() } },
      { revokedAt: new Date() },
    );
    if (!rotated) {
      const reused = await RefreshToken.findOne({ tokenHash: hash });
      if (reused) {
        await RefreshToken.updateMany({ familyId: reused.familyId, revokedAt: null }, { revokedAt: new Date() });
        await audit({ system: true }, 'auth.refresh_reuse_detected', { type: 'user', id: String(reused.userId) });
      }
      throw new AppError('UNAUTHENTICATED', 'Session expired; please sign in again');
    }
    return this.issueSession(String(rotated.userId), meta, rotated.familyId);
  }

  async logout(refreshToken: string) {
    const t = await RefreshToken.findOne({ tokenHash: sha256(refreshToken) });
    if (t) await RefreshToken.updateMany({ familyId: t.familyId, revokedAt: null }, { revokedAt: new Date() });
  }

  async signAccess(claims: AccessClaims): Promise<string> {
    return new SignJWT({ pa: claims.pa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer('agent-orchestrator')
      .setAudience('ao-api')
      .setExpirationTime(`${this.config.ACCESS_TOKEN_TTL_SEC}s`)
      .sign(this.secret);
  }

  async verifyAccess(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, { issuer: 'agent-orchestrator', audience: 'ao-api', algorithms: ['HS256'] });
      if (!payload.sub) throw new Error('no sub');
      return { sub: payload.sub, pa: payload.pa === true };
    } catch {
      throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token');
    }
  }

  async memberships(userId: string): Promise<MembershipDto[]> {
    const ms = await Membership.find({ userId: oid(userId) }).lean();
    const orgs = await Organization.find({ _id: { $in: ms.map((m) => m.organizationId) } }).lean();
    const byId = new Map(orgs.map((o) => [String(o._id), o]));
    return ms
      .filter((m) => byId.has(String(m.organizationId)))
      .map((m) => {
        const o = byId.get(String(m.organizationId))!;
        return { organizationId: String(o._id), organizationName: o.name, organizationSlug: o.slug, role: m.role };
      });
  }

  // ── Multi-factor authentication (TOTP) ──────────────────────────────────────
  /**
   * Verifies an authenticator code (each time step accepted once) or consumes a recovery code.
   * Both checks are single atomic updates, so a code cannot be used twice even concurrently.
   */
  private async checkSecondFactor(userId: mongoose.Types.ObjectId, code: string): Promise<'totp' | 'recovery' | null> {
    const u = await User.findById(userId).select('+mfa.secretEnc +mfa.lastStep').lean();
    if (!u?.mfa?.enabled || !u.mfa.secretEnc) return null;
    if (/^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
      const step = verifyTotp(this.box.decrypt(u.mfa.secretEnc), code, { afterStep: u.mfa.lastStep ?? null });
      if (step === null) return null;
      const r = await User.updateOne(
        { _id: userId, $or: [{ 'mfa.lastStep': null }, { 'mfa.lastStep': { $exists: false } }, { 'mfa.lastStep': { $lt: step } }] },
        { $set: { 'mfa.lastStep': step } },
      );
      return r.modifiedCount ? 'totp' : null;
    }
    const hash = sha256(normalizeRecoveryCode(code));
    const r = await User.updateOne({ _id: userId, 'mfa.recoveryCodeHashes': hash }, { $pull: { 'mfa.recoveryCodeHashes': hash } });
    return r.modifiedCount ? 'recovery' : null;
  }

  /** Step 1 of enrolment: a new secret, kept pending until a code from it is confirmed. */
  async setupMfa(userId: string) {
    const user = await User.findById(oid(userId, 'User')).lean();
    if (!user) throw new AppError('UNAUTHENTICATED', 'User not found');
    if (user.mfa?.enabled) throw new AppError('CONFLICT', 'Two-factor authentication is already on. Turn it off first to set up a new device.');
    const secret = newTotpSecret();
    await User.updateOne({ _id: user._id }, { $set: { 'mfa.pendingSecretEnc': this.box.encrypt(secret) } });
    return { secret, otpauthUrl: totpUri(secret, user.email) };
  }

  /** Step 2: confirm a code from the new secret; returns one-time recovery codes (shown once). */
  async enableMfa(userId: string, code: string) {
    const user = await User.findById(oid(userId, 'User')).select('+mfa.pendingSecretEnc').lean();
    if (!user) throw new AppError('UNAUTHENTICATED', 'User not found');
    if (user.mfa?.enabled) throw new AppError('CONFLICT', 'Two-factor authentication is already on');
    if (!user.mfa?.pendingSecretEnc) throw new AppError('VALIDATION_FAILED', 'Start the setup first');
    const pending = user.mfa.pendingSecretEnc;
    const step = verifyTotp(this.box.decrypt(pending), code);
    if (step === null) throw new AppError('VALIDATION_FAILED', 'That code is not valid. Check the time on your device and try the current code.');
    const recoveryCodes = newRecoveryCodes();
    const r = await User.updateOne(
      { _id: user._id, 'mfa.enabled': { $ne: true }, 'mfa.pendingSecretEnc': pending },
      {
        $set: { 'mfa.enabled': true, 'mfa.secretEnc': pending, 'mfa.lastStep': step, 'mfa.recoveryCodeHashes': recoveryCodes.map((c) => sha256(normalizeRecoveryCode(c))) },
        $unset: { 'mfa.pendingSecretEnc': 1 },
      },
    );
    if (!r.modifiedCount) throw new AppError('CONFLICT', 'Setup changed in the meantime; start again');
    await audit({ system: true }, 'auth.mfa_enabled', { type: 'user', id: userId });
    return { recoveryCodes };
  }

  /** Turning MFA off needs the password and a current code (or a recovery code). */
  async disableMfa(userId: string, password: string, code: string) {
    const user = await User.findById(oid(userId, 'User')).select('+passwordHash').lean();
    if (!user?.mfa?.enabled) throw new AppError('CONFLICT', 'Two-factor authentication is not on');
    if (!(await verifyPassword(password, user.passwordHash))) throw new AppError('UNAUTHENTICATED', 'Wrong password');
    if (!(await this.checkSecondFactor(user._id, code))) throw new AppError('UNAUTHENTICATED', 'Invalid authentication code');
    await User.updateOne({ _id: user._id }, { $set: { 'mfa.enabled': false }, $unset: { 'mfa.secretEnc': 1, 'mfa.pendingSecretEnc': 1, 'mfa.recoveryCodeHashes': 1, 'mfa.lastStep': 1 } });
    await audit({ system: true }, 'auth.mfa_disabled', { type: 'user', id: userId });
  }

  /**
   * An administrator turns off someone's two-factor authentication, for a person who lost their
   * authenticator and recovery codes. Platform administrators can do this for anyone. Organization owners
   * and admins only for members who belong to no other organization and do not outrank them, so an
   * administrator of one organization can't weaken an account used elsewhere. The person is signed out
   * everywhere, told by email, and the reset is audited with its reason. Their password still applies.
   */
  async resetMfaFor(actor: { userId: string; correlationId: string; ip?: string | null; platformAdmin?: boolean; organizationId?: string; role?: Role }, targetUserId: string, reason: string) {
    if (targetUserId === actor.userId) throw new AppError('VALIDATION_FAILED', 'Turn off your own two-factor authentication in your account settings');
    const target = await User.findById(oid(targetUserId, 'User')).lean();
    if (!target) throw new AppError('NOT_FOUND', 'User not found');
    if (!actor.platformAdmin) {
      if (!actor.organizationId || !actor.role || !can(actor.role, 'member.remove')) throw new AppError('FORBIDDEN', 'Only organization owners and admins can reset two-factor authentication');
      const memberships = await Membership.find({ userId: target._id }).lean();
      const here = memberships.find((m) => String(m.organizationId) === actor.organizationId);
      if (!here) throw new AppError('NOT_FOUND', 'User not found');
      if (memberships.length > 1) throw new AppError('FORBIDDEN', 'This person also belongs to other organizations; ask a server administrator to reset their two-factor authentication');
      if (roleRank(here.role as Role) > roleRank(actor.role)) throw new AppError('FORBIDDEN', `You can't reset two-factor authentication for a ${here.role.toLowerCase()}`);
    }
    if (!target.mfa?.enabled) throw new AppError('CONFLICT', 'Two-factor authentication is not on for this person');
    await User.updateOne({ _id: target._id }, { $set: { 'mfa.enabled': false }, $unset: { 'mfa.secretEnc': 1, 'mfa.pendingSecretEnc': 1, 'mfa.recoveryCodeHashes': 1, 'mfa.lastStep': 1 } });
    await RefreshToken.updateMany({ userId: target._id, revokedAt: null }, { revokedAt: new Date() }); // sign out everywhere
    await audit(
      actor.organizationId && actor.role ? { userId: actor.userId, organizationId: actor.organizationId, role: actor.role, correlationId: actor.correlationId, ip: actor.ip } : { userId: actor.userId, correlationId: actor.correlationId, ip: actor.ip },
      'auth.mfa_reset_by_admin',
      { type: 'user', id: targetUserId },
      { reason, byPlatformAdmin: Boolean(actor.platformAdmin) },
    );
    await this.mailer.send(
      target.email,
      'Two-factor authentication was turned off on your account',
      `An administrator turned off two-factor authentication on your Agent Orchestrator account and signed you out everywhere.\nReason given: ${reason}\n\nSign in with your password and turn two-factor authentication on again in Settings → Your account. If you did not ask for this, change your password and contact your administrator.`,
    );
  }

  /** People on this server, for platform administrators (first 50 matches by email or name). */
  async searchUsers(q?: string) {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = q ? { $or: [{ email: { $regex: esc(q), $options: 'i' } }, { name: { $regex: esc(q), $options: 'i' } }] } : {};
    const users = await User.find(filter).sort({ email: 1 }).limit(50).lean();
    const counts = await Membership.aggregate<{ _id: unknown; n: number }>([{ $match: { userId: { $in: users.map((u) => u._id) } } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]);
    const n = new Map(counts.map((c) => [String(c._id), c.n]));
    return users.map((u) => ({ id: String(u._id), email: u.email, name: u.name, mfaEnabled: Boolean(u.mfa?.enabled), platformAdmin: Boolean(u.platformAdmin), disabled: Boolean(u.disabled), organizations: n.get(String(u._id)) ?? 0 }));
  }

  // ── Password reset & email verification ────────────────────────────────────
  private async issueOneTime(userId: mongoose.Types.ObjectId, purpose: 'password_reset' | 'email_verify', ttlMs: number) {
    const token = newSecretToken(32);
    await OneTimeToken.create({ userId, purpose, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
    return token;
  }

  private async consumeOneTime(token: string, purpose: 'password_reset' | 'email_verify') {
    const t = await OneTimeToken.findOneAndUpdate(
      { tokenHash: sha256(token), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
      { usedAt: new Date() },
    );
    if (!t) throw new AppError('VALIDATION_FAILED', 'This link is invalid or has expired');
    return t.userId;
  }

  /** Always succeeds from the caller's perspective so it can't be used to probe for accounts. */
  async requestPasswordReset(email: string): Promise<{ token?: string }> {
    const user = await User.findOne({ email: email.toLowerCase() }).lean();
    if (!user) return {};
    const token = await this.issueOneTime(user._id, 'password_reset', 60 * 60_000);
    await this.mailer.send(user.email, 'Reset your password', `Reset your password: ${this.config.WEB_URL}/reset-password?token=${token}\nThis link expires in 1 hour.`);
    await audit({ system: true }, 'auth.password_reset_requested', { type: 'user', id: String(user._id) });
    return this.config.NODE_ENV === 'test' ? { token } : {};
  }

  async confirmPasswordReset(token: string, password: string) {
    const userId = await this.consumeOneTime(token, 'password_reset');
    await User.updateOne({ _id: userId }, { passwordHash: await hashPassword(password), hasPassword: true, failedLoginCount: 0, lockedUntil: null });
    await RefreshToken.updateMany({ userId, revokedAt: null }, { revokedAt: new Date() }); // sign out everywhere
    await audit({ system: true }, 'auth.password_reset', { type: 'user', id: String(userId) });
  }

  async sendEmailVerification(userId: string, email: string): Promise<string> {
    const token = await this.issueOneTime(oid(userId), 'email_verify', 7 * 86_400_000);
    await this.mailer.send(email, 'Verify your email', `Verify your email: ${this.config.WEB_URL}/verify-email?token=${token}`);
    return token;
  }

  async verifyEmail(token: string) {
    const userId = await this.consumeOneTime(token, 'email_verify');
    await User.updateOne({ _id: userId }, { emailVerified: true });
  }
}
