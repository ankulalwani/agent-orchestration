import { AppError, newDeviceCode, newSecretToken, sha256 } from '@ao/core';
import { DeviceLogin, isDuplicateKeyError, oid } from '@ao/database';
import type { AuthResponse } from '@ao/contracts';
import type { ServerConfig } from './config.js';
import type { AuthService } from './auth.service.js';
import { audit } from './audit.js';

const TTL_MS = 10 * 60_000;

/**
 * Device sign-in (RFC 8628 style) for the CLI and the mobile app: they show a code and open the web app,
 * where the person, already signed in there by any method (password, Google, GitHub, SSO, two-factor),
 * approves. The CLI/app then receives a session of its own. Passwords never pass through the CLI.
 */
export class DeviceLoginService {
  constructor(
    private readonly config: ServerConfig,
    private readonly auth: AuthService,
  ) {}

  async start(clientName: string, meta: { ip?: string; userAgent?: string }) {
    const pollSecret = newSecretToken(32);
    for (let i = 0; i < 5; i++) {
      const userCode = newDeviceCode();
      try {
        const d = await DeviceLogin.create({ userCode, pollSecretHash: sha256(pollSecret), clientName, ip: meta.ip ?? null, userAgent: meta.userAgent?.slice(0, 300) ?? null, expiresAt: new Date(Date.now() + TTL_MS) });
        return { userCode, pollSecret, verificationUrl: `${this.config.WEB_URL.replace(/\/+$/, '')}/device?code=${encodeURIComponent(userCode)}`, expiresAt: d.expiresAt.toISOString(), intervalSec: 3 };
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
    }
    throw new AppError('INTERNAL', 'Could not allocate a sign-in code');
  }

  /** What the person is about to approve: shown so they can spot a code someone else sent them. */
  async describe(userCode: string) {
    const d = await DeviceLogin.findOne({ userCode: userCode.trim().toUpperCase(), status: 'PENDING', expiresAt: { $gt: new Date() } }).lean();
    if (!d) throw new AppError('NOT_FOUND', 'This code is not valid or has expired. Start signing in again.');
    return { clientName: d.clientName, ip: d.ip, userAgent: d.userAgent, requestedAt: d.createdAt.toISOString(), expiresAt: d.expiresAt.toISOString() };
  }

  async decide(userId: string, userCode: string, approve: boolean, correlationId: string) {
    const d = await DeviceLogin.findOneAndUpdate(
      { userCode: userCode.trim().toUpperCase(), status: 'PENDING', expiresAt: { $gt: new Date() } },
      { $set: { status: approve ? 'APPROVED' : 'DENIED', userId: oid(userId) } },
      { new: true },
    ).lean();
    if (!d) throw new AppError('NOT_FOUND', 'This code is not valid or has expired. Start signing in again.');
    await audit({ userId, correlationId }, approve ? 'auth.device_login_approved' : 'auth.device_login_denied', { type: 'user', id: userId }, { clientName: d.clientName, ip: d.ip });
  }

  /**
   * Polled by the CLI/app. Pending → `{ status: 'pending' }`; approved → the session, exactly once;
   * denied or expired → an error that tells the client to stop.
   */
  async poll(pollSecret: string, meta: { ip?: string; userAgent?: string }): Promise<{ status: 'pending' } | ({ status: 'approved' } & AuthResponse)> {
    const hash = sha256(pollSecret);
    const d = await DeviceLogin.findOne({ pollSecretHash: hash }).lean();
    if (!d || d.status === 'CONSUMED') throw new AppError('NOT_FOUND', 'Unknown or already used sign-in request');
    if (d.status === 'DENIED') throw new AppError('FORBIDDEN', 'Sign-in was denied in the web app');
    if (d.expiresAt.getTime() < Date.now()) throw new AppError('VALIDATION_FAILED', 'The sign-in code expired. Start again.');
    if (d.status === 'PENDING') return { status: 'pending' };
    const claimed = await DeviceLogin.findOneAndUpdate({ _id: d._id, status: 'APPROVED' }, { $set: { status: 'CONSUMED' } }).lean();
    if (!claimed) throw new AppError('NOT_FOUND', 'Unknown or already used sign-in request');
    return { status: 'approved', ...(await this.auth.issueSession(String(d.userId), { ip: meta.ip, userAgent: meta.userAgent ?? d.clientName })) };
  }
}
