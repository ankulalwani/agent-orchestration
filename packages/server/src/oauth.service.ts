import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError, createLogger, newSecretToken, sha256 } from '@ao/core';
import { OAuthState, OAuthTicket, User, isDuplicateKeyError, oid, type mongoose } from '@ao/database';
import type { AuthResponse, OAuthProviderDto } from '@ao/contracts';
import { API_PREFIX } from '@ao/contracts';
import { createHash } from 'node:crypto';
import type { ServerConfig } from './config.js';
import type { AuthService, SecondFactor } from './auth.service.js';
import { audit } from './audit.js';

const log = createLogger('oauth');
const STATE_TTL_MS = 10 * 60_000;
const TICKET_TTL_MS = 2 * 60_000;
const MAX_TICKET_ATTEMPTS = 5;
const HTTP_TIMEOUT_MS = 10_000;

interface ProviderConfig {
  id: 'google' | 'github' | 'oidc';
  name: string;
  kind: 'oidc' | 'github';
  clientId: string;
  clientSecret: string;
  issuer?: string;
  scopes: string;
}

interface Identity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

/** Why a sign-in could not finish. The web app shows a message for each code (never provider text). */
export type OAuthErrorCode = 'cancelled' | 'expired' | 'no_account' | 'email_unverified' | 'identity_in_use' | 'disabled' | 'invitation_invalid' | 'provider_error';

class OAuthFailure extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export function oauthProviders(config: ServerConfig): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    out.push({ id: 'google', name: 'Google', kind: 'oidc', issuer: 'https://accounts.google.com', clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET, scopes: 'openid email profile' });
  }
  if (config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET) {
    out.push({ id: 'github', name: 'GitHub', kind: 'github', clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET, scopes: 'read:user user:email' });
  }
  if (config.OIDC_ISSUER && config.OIDC_CLIENT_ID && config.OIDC_CLIENT_SECRET) {
    out.push({ id: 'oidc', name: config.OIDC_DISPLAY_NAME, kind: 'oidc', issuer: config.OIDC_ISSUER, clientId: config.OIDC_CLIENT_ID, clientSecret: config.OIDC_CLIENT_SECRET, scopes: config.OIDC_SCOPES });
  }
  return out;
}

/** Only same-site relative paths, so the sign-in flow can't be used as an open redirect. */
export function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])[^\s]*$/.test(next) && next.length <= 500 ? next : '/';
}

const base64url = (b: Buffer) => b.toString('base64url');

/**
 * OAuth 2.0 / OpenID Connect sign-in (spec §56): authorization code flow with PKCE (S256), `state`
 * and (OIDC) `nonce`, all single use. ID tokens are verified against the provider's JWKS. The
 * callback never creates a session itself: it hands the browser a short single-use ticket, and the
 * session is issued by `complete`, which also enforces two-factor authentication.
 */
export class OAuthService {
  private discoveryCache = new Map<string, { doc: Discovery; jwks: JWTVerifyGetKey; at: number }>();

  constructor(
    private config: ServerConfig,
    private auth: AuthService,
  ) {}

  list(): OAuthProviderDto[] {
    return oauthProviders(this.config).map((p) => ({ id: p.id, name: p.name }));
  }

  private provider(id: string): ProviderConfig {
    const p = oauthProviders(this.config).find((x) => x.id === id);
    if (!p) throw new AppError('NOT_FOUND', 'This sign-in provider is not configured');
    return p;
  }

  private redirectUri(providerId: string) {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}${API_PREFIX}/auth/oauth/${providerId}/callback`;
  }

  private webUrl(pathAndQuery: string) {
    return `${this.config.WEB_URL.replace(/\/+$/, '')}${pathAndQuery}`;
  }

  private async discovery(issuer: string) {
    const cached = this.discoveryCache.get(issuer);
    if (cached && Date.now() - cached.at < 3_600_000) return cached;
    const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new OAuthFailure('provider_error', `discovery HTTP ${res.status}`);
    const doc = (await res.json()) as Discovery;
    if (doc.issuer.replace(/\/+$/, '') !== issuer.replace(/\/+$/, '')) throw new OAuthFailure('provider_error', 'discovery issuer mismatch');
    const entry = { doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)), at: Date.now() };
    this.discoveryCache.set(issuer, entry);
    return entry;
  }

  /** Builds the provider's authorization URL and records the request (state, PKCE verifier, nonce). */
  async start(providerId: string, opts: { next?: unknown; invitationToken?: string | null; linkUserId?: string | null } = {}): Promise<string> {
    const p = this.provider(providerId);
    const state = newSecretToken(32);
    const codeVerifier = base64url(Buffer.from(newSecretToken(48)));
    const nonce = newSecretToken(24);
    await OAuthState.create({
      stateHash: sha256(state),
      provider: p.id,
      codeVerifier,
      nonce,
      mode: opts.linkUserId ? 'link' : 'login',
      userId: opts.linkUserId ? oid(opts.linkUserId, 'User') : null,
      next: safeNext(opts.next),
      invitationToken: opts.invitationToken ?? null,
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: p.clientId,
      redirect_uri: this.redirectUri(p.id),
      scope: p.scopes,
      state,
      code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256',
    });
    if (p.kind === 'oidc') {
      params.set('nonce', nonce);
      return `${(await this.discovery(p.issuer!)).doc.authorization_endpoint}?${params}`;
    }
    return `${this.config.GITHUB_URL.replace(/\/+$/, '')}/login/oauth/authorize?${params}`;
  }

  /** Provider → us. Returns where to send the browser next (the web app), never throws. */
  async callback(providerId: string, q: { code?: string; state?: string; error?: string }): Promise<string> {
    let mode: 'login' | 'link' = 'login';
    try {
      if (!q.state) throw new OAuthFailure('expired');
      const st = await OAuthState.findOneAndUpdate(
        { stateHash: sha256(q.state), provider: providerId, usedAt: null, expiresAt: { $gt: new Date() } },
        { usedAt: new Date() },
        { new: true },
      ).lean();
      if (!st) throw new OAuthFailure('expired');
      mode = st.mode as 'login' | 'link';
      if (q.error || !q.code) throw new OAuthFailure('cancelled', q.error);
      const p = this.provider(providerId);
      const identity = await this.fetchIdentity(p, q.code, st.codeVerifier, st.nonce);

      if (st.mode === 'link') {
        await this.link(st.userId!, p.id, identity);
        return this.webUrl(`/settings?tab=account&linked=${p.id}`);
      }
      const userId = await this.resolveUser(p.id, identity, st.invitationToken ?? null);
      const ticket = newSecretToken(32);
      await OAuthTicket.create({ ticketHash: sha256(ticket), userId, provider: p.id, expiresAt: new Date(Date.now() + TICKET_TTL_MS) });
      // The ticket travels in the URL fragment, which browsers never send to servers or put in Referer.
      return this.webUrl(`/oauth/complete#ticket=${ticket}&next=${encodeURIComponent(st.next)}`);
    } catch (e) {
      const code: OAuthErrorCode = e instanceof OAuthFailure ? e.code : 'provider_error';
      if (!(e instanceof OAuthFailure) || code === 'provider_error') log.warn({ provider: providerId, err: String(e) }, 'OAuth sign-in failed');
      return mode === 'link' ? this.webUrl(`/settings?tab=account&oauthError=${code}`) : this.webUrl(`/login?oauthError=${code}`);
    }
  }

  /** Exchanges the ticket for a session. 2FA applies exactly as for password sign-in. */
  async complete(ticket: string, mfaCode: SecondFactor | undefined, meta: { ip?: string; userAgent?: string }): Promise<AuthResponse> {
    const hash = sha256(ticket);
    const t = await OAuthTicket.findOneAndUpdate(
      { ticketHash: hash, usedAt: null, expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_TICKET_ATTEMPTS } },
      { $inc: { attempts: 1 } },
      { new: true },
    ).lean();
    if (!t) throw new AppError('UNAUTHENTICATED', 'This sign-in link is invalid or has expired. Start again.');
    return this.auth.signInWithIdentity(t.userId, t.provider, mfaCode, meta, async () => (await OAuthTicket.updateOne({ _id: t._id, usedAt: null }, { usedAt: new Date() })).modifiedCount === 1);
  }

  /** Removes a linked identity, keeping at least one way to sign in. */
  async unlink(userId: string, providerId: string) {
    const user = await User.findById(oid(userId, 'User')).lean();
    if (!user) throw new AppError('UNAUTHENTICATED', 'User not found');
    const identities = user.identities ?? [];
    if (!identities.some((i) => i.provider === providerId)) throw new AppError('NOT_FOUND', 'This account is not connected');
    if (user.hasPassword === false && identities.length <= 1) {
      throw new AppError('CONFLICT', 'Set a password first (use "Forgot password" on the sign-in page), so you can still sign in.');
    }
    await User.updateOne({ _id: user._id }, { $pull: { identities: { provider: providerId } } });
    await audit({ system: true }, 'auth.identity_unlinked', { type: 'user', id: userId }, { provider: providerId });
  }

  private async link(userId: mongoose.Types.ObjectId, provider: string, identity: Identity) {
    const owner = await User.findOne({ identities: { $elemMatch: { provider, subject: identity.subject } } }, { _id: 1 }).lean();
    if (owner && !owner._id.equals(userId)) throw new OAuthFailure('identity_in_use');
    if (owner) return; // already linked to this user
    try {
      const r = await User.updateOne(
        { _id: userId, 'identities.provider': { $ne: provider } },
        { $push: { identities: { provider, subject: identity.subject, email: identity.email, linkedAt: new Date() } } },
      );
      if (!r.modifiedCount) throw new OAuthFailure('identity_in_use', 'a different account from this provider is already connected');
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new OAuthFailure('identity_in_use');
      throw e;
    }
    await audit({ system: true }, 'auth.identity_linked', { type: 'user', id: String(userId) }, { provider });
  }

  /**
   * Existing link → that user. Otherwise a *verified* email matching an account links the identity
   * to it. Otherwise a new account (registration rules or an invitation apply).
   */
  private async resolveUser(provider: string, identity: Identity, invitationToken: string | null): Promise<mongoose.Types.ObjectId> {
    const linked = await User.findOne({ identities: { $elemMatch: { provider, subject: identity.subject } } }).lean();
    if (linked) {
      if (linked.disabled) throw new OAuthFailure('disabled');
      return linked._id;
    }
    if (!identity.email || !identity.emailVerified) throw new OAuthFailure('email_unverified');
    const email = identity.email.toLowerCase();
    const existing = await User.findOne({ email }).lean();
    if (existing) {
      if (existing.disabled) throw new OAuthFailure('disabled');
      await this.link(existing._id, provider, identity);
      // The provider proved control of this address.
      if (!existing.emailVerified) await User.updateOne({ _id: existing._id }, { emailVerified: true });
      return existing._id;
    }
    try {
      return await this.auth.createExternalUser({ email, name: identity.name || email.split('@')[0]!, provider, subject: identity.subject, invitationToken });
    } catch (e) {
      if (e instanceof AppError && e.code === 'FORBIDDEN') throw new OAuthFailure('no_account');
      if (e instanceof AppError && e.code === 'VALIDATION_FAILED') throw new OAuthFailure('invitation_invalid');
      throw e;
    }
  }

  private async fetchIdentity(p: ProviderConfig, code: string, codeVerifier: string, nonce: string): Promise<Identity> {
    const tokenEndpoint = p.kind === 'oidc' ? (await this.discovery(p.issuer!)).doc.token_endpoint : `${this.config.GITHUB_URL.replace(/\/+$/, '')}/login/oauth/access_token`;
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(p.id), client_id: p.clientId, client_secret: p.clientSecret, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const tokens = (await res.json().catch(() => ({}))) as { access_token?: string; id_token?: string; error?: string };
    if (!res.ok || tokens.error || !tokens.access_token) throw new OAuthFailure('provider_error', `token exchange failed: ${tokens.error ?? res.status}`);
    return p.kind === 'oidc' ? this.oidcIdentity(p, tokens, nonce) : this.githubIdentity(tokens.access_token);
  }

  private async oidcIdentity(p: ProviderConfig, tokens: { access_token?: string; id_token?: string }, nonce: string): Promise<Identity> {
    if (!tokens.id_token) throw new OAuthFailure('provider_error', 'no id_token');
    const d = await this.discovery(p.issuer!);
    let claims: Record<string, unknown>;
    try {
      ({ payload: claims } = await jwtVerify(tokens.id_token, d.jwks, { issuer: d.doc.issuer, audience: p.clientId }));
    } catch (e) {
      throw new OAuthFailure('provider_error', `id_token rejected: ${(e as Error).message}`);
    }
    if (claims.nonce !== nonce) throw new OAuthFailure('provider_error', 'nonce mismatch');
    let email = typeof claims.email === 'string' ? claims.email : null;
    let verified = claims.email_verified === true || claims.email_verified === 'true';
    let name = typeof claims.name === 'string' ? claims.name : null;
    if (!email && d.doc.userinfo_endpoint && tokens.access_token) {
      const r = await fetch(d.doc.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const info = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (r.ok && info.sub === claims.sub) {
        email = typeof info.email === 'string' ? info.email : null;
        verified = info.email_verified === true || info.email_verified === 'true';
        name ??= typeof info.name === 'string' ? info.name : null;
      }
    }
    return { subject: String(claims.sub), email, emailVerified: verified, name };
  }

  private async githubIdentity(accessToken: string): Promise<Identity> {
    const api = this.config.GITHUB_API_URL.replace(/\/+$/, '');
    const get = async <T>(path: string) => {
      const r = await fetch(`${api}${path}`, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-orchestration' },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!r.ok) throw new OAuthFailure('provider_error', `GitHub ${path} HTTP ${r.status}`);
      return (await r.json()) as T;
    };
    const user = await get<{ id: number; login: string; name?: string | null }>('/user');
    const emails = await get<Array<{ email: string; primary: boolean; verified: boolean }>>('/user/emails');
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return { subject: String(user.id), email: primary?.email ?? null, emailVerified: Boolean(primary), name: user.name || user.login };
  }
}
