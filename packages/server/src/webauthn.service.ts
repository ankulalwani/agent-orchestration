import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { AppError } from '@ao/core';
import { User, mongoose, oid } from '@ao/database';
import type { ServerConfig } from './config.js';
import { audit } from './audit.js';

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_KEYS = 10;

interface StoredKey {
  credentialId: string;
  /** base64url of the COSE public key. */
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: Date;
  lastUsedAt?: Date | null;
}
type Challenge = { value: string; purpose: 'register' | 'signin'; expiresAt: Date };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

/**
 * Security keys and passkeys (WebAuthn) as a second sign-in step, next to authenticator-app codes.
 * A key can be added once two-factor authentication is on, so recovery codes exist for a lost key.
 * The relying party is the dashboard's host (WEB_URL); only public keys are stored.
 */
export class WebAuthnService {
  constructor(private config: ServerConfig) {}

  private rp() {
    const url = new URL(this.config.WEB_URL);
    return { id: url.hostname, origin: url.origin };
  }

  private async keysOf(userId: mongoose.Types.ObjectId) {
    const u = await User.findById(userId).select('+mfa.securityKeys +mfa.challenge').lean();
    return { user: u, keys: ((u?.mfa as { securityKeys?: StoredKey[] } | undefined)?.securityKeys ?? []) as StoredKey[], challenge: (u?.mfa as { challenge?: Challenge } | undefined)?.challenge ?? null };
  }

  /** Takes the challenge in flight, once: a second use (or a concurrent one) finds nothing. */
  private async takeChallenge(userId: mongoose.Types.ObjectId, purpose: Challenge['purpose']): Promise<string | null> {
    const before = await User.findOneAndUpdate({ _id: userId, 'mfa.challenge.purpose': purpose }, { $unset: { 'mfa.challenge': 1 } }, { new: false, projection: { 'mfa.challenge': 1 } }).select('+mfa.challenge').lean();
    const c = (before?.mfa as { challenge?: Challenge } | undefined)?.challenge;
    return c && new Date(c.expiresAt).getTime() > Date.now() ? c.value : null;
  }

  async list(userId: string) {
    const { keys } = await this.keysOf(oid(userId, 'User'));
    return keys.map((k) => ({ id: k.credentialId, name: k.name, createdAt: new Date(k.createdAt).toISOString(), lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt).toISOString() : null }));
  }

  /** Step 1 of adding a key: the options for `navigator.credentials.create`. */
  async registrationOptions(userId: string) {
    const id = oid(userId, 'User');
    const { user, keys } = await this.keysOf(id);
    if (!user) throw new AppError('UNAUTHENTICATED', 'User not found');
    if (!user.mfa?.enabled) throw new AppError('CONFLICT', 'Turn on two-factor authentication with an authenticator app first; its recovery codes are the way back in if a key is lost');
    if (keys.length >= MAX_KEYS) throw new AppError('VALIDATION_FAILED', `An account can have ${MAX_KEYS} security keys`);
    const options = await generateRegistrationOptions({
      rpName: 'Agent Orchestration',
      rpID: this.rp().id,
      userID: new TextEncoder().encode(String(user._id)),
      userName: user.email,
      userDisplayName: user.name,
      attestationType: 'none',
      // A second step, not a replacement for the password: the key need not hold the account.
      authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
      excludeCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports as never })),
    });
    await User.updateOne({ _id: id }, { $set: { 'mfa.challenge': { value: options.challenge, purpose: 'register', expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) } } });
    return options;
  }

  /** Step 2: checks what the browser's authenticator answered, and stores the key. */
  async register(userId: string, name: string, response: unknown) {
    const id = oid(userId, 'User');
    const expectedChallenge = await this.takeChallenge(id, 'register');
    if (!expectedChallenge) throw new AppError('VALIDATION_FAILED', 'That took too long. Start adding the key again.');
    const rp = this.rp();
    let verified;
    try {
      verified = await verifyRegistrationResponse({ response: response as never, expectedChallenge, expectedOrigin: rp.origin, expectedRPID: rp.id, requireUserVerification: false });
    } catch (e) {
      throw new AppError('VALIDATION_FAILED', `The security key could not be added: ${(e as Error).message}`);
    }
    const info = verified.registrationInfo;
    if (!verified.verified || !info) throw new AppError('VALIDATION_FAILED', 'The security key could not be added');
    const key: StoredKey = {
      credentialId: info.credential.id,
      publicKey: b64(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports,
      name: name.trim().slice(0, 60) || 'Security key',
      createdAt: new Date(),
      lastUsedAt: null,
    };
    // Only while two-factor authentication is on, below the limit, and not a key the account already has.
    const r = await User.updateOne(
      { _id: id, 'mfa.enabled': true, 'mfa.securityKeys.credentialId': { $ne: key.credentialId }, [`mfa.securityKeys.${MAX_KEYS - 1}`]: { $exists: false } },
      { $push: { 'mfa.securityKeys': key } },
    );
    if (!r.modifiedCount) throw new AppError('CONFLICT', 'This security key is already on your account, or the account has changed; reload and try again');
    await audit({ system: true }, 'auth.security_key_added', { type: 'user', id: userId }, { name: key.name });
    return { id: key.credentialId, name: key.name, createdAt: key.createdAt.toISOString(), lastUsedAt: null };
  }

  async remove(userId: string, credentialId: string) {
    const r = await User.updateOne({ _id: oid(userId, 'User') }, { $pull: { 'mfa.securityKeys': { credentialId } } });
    if (!r.modifiedCount) throw new AppError('NOT_FOUND', 'Security key not found');
    await audit({ system: true }, 'auth.security_key_removed', { type: 'user', id: userId });
  }

  /**
   * Sign-in, after the first factor is proven: the options for `navigator.credentials.get`, or null for
   * an account without keys. Each call replaces the challenge in flight.
   */
  async signInOptions(userId: mongoose.Types.ObjectId) {
    const { keys } = await this.keysOf(userId);
    if (!keys.length) return null;
    const options = await generateAuthenticationOptions({ rpID: this.rp().id, userVerification: 'preferred', allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports as never })) });
    await User.updateOne({ _id: userId }, { $set: { 'mfa.challenge': { value: options.challenge, purpose: 'signin', expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) } } });
    return options;
  }

  /** True when the response is a valid, fresh assertion by one of the account's keys. */
  async verifySignIn(userId: mongoose.Types.ObjectId, response: unknown): Promise<boolean> {
    const expectedChallenge = await this.takeChallenge(userId, 'signin');
    const { keys } = await this.keysOf(userId);
    const key = keys.find((k) => k.credentialId === (response as { id?: string } | null)?.id);
    if (!expectedChallenge || !key) return false;
    const rp = this.rp();
    try {
      const v = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
        credential: { id: key.credentialId, publicKey: new Uint8Array(Buffer.from(key.publicKey, 'base64url')), counter: key.counter, transports: key.transports as never },
      });
      if (!v.verified) return false;
      await User.updateOne({ _id: userId, 'mfa.securityKeys.credentialId': key.credentialId }, { $set: { 'mfa.securityKeys.$.counter': v.authenticationInfo.newCounter, 'mfa.securityKeys.$.lastUsedAt': new Date() } });
      return true;
    } catch {
      return false; // wrong origin, replayed counter, bad signature: all the same to the caller
    }
  }
}
