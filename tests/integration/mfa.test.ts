import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { totp } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, User } from '@ao/database';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

const PASSWORD = 'mfa-password-123';
let n = 0;
async function enrolledUser() {
  const email = `mfa-${Date.now()}-${++n}@example.com`;
  const r = await s.auth.register({ email, password: PASSWORD, name: 'M' });
  const { secret, otpauthUrl } = await s.auth.setupMfa(r.user.id);
  expect(otpauthUrl).toContain(`secret=${secret}`);
  const { recoveryCodes } = await s.auth.enableMfa(r.user.id, totp(secret));
  // The enrolment code's time step is used up; later codes come from the next step.
  return { email, userId: r.user.id, secret, recoveryCodes, next: (k = 1) => totp(secret, Date.now() + k * 30_000) };
}

describe('two-factor authentication (AUTH-005)', () => {
  it('enrolment: a pending secret is confirmed with a code; the secret is stored encrypted', async () => {
    const r = await s.auth.register({ email: `mfa-e-${Date.now()}@example.com`, password: PASSWORD, name: 'E' });
    await expect(s.auth.enableMfa(r.user.id, '123456')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' }); // no setup yet
    const { secret } = await s.auth.setupMfa(r.user.id);
    await expect(s.auth.enableMfa(r.user.id, '000000')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const { recoveryCodes } = await s.auth.enableMfa(r.user.id, totp(secret));
    expect(recoveryCodes).toHaveLength(10);
    const stored = await User.findById(r.user.id).select('+mfa.secretEnc +mfa.recoveryCodeHashes').lean();
    expect(stored!.mfa!.secretEnc).toMatch(/^v2\./);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(recoveryCodes[0]);
    await expect(s.auth.setupMfa(r.user.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await s.auth.login(stored!.email, PASSWORD, {}, totp(secret, Date.now() + 30_000))).user.mfaEnabled).toBe(true);
  });

  it('login: password alone → MFA_REQUIRED (only after a correct password); code → session; codes are single use', async () => {
    const u = await enrolledUser();
    await expect(s.auth.login(u.email, 'wrong-password')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(s.auth.login(u.email, PASSWORD)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    await expect(s.auth.login(u.email, PASSWORD, {}, '000000')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    const code = u.next();
    expect((await s.auth.login(u.email, PASSWORD, {}, code)).user.id).toBe(u.userId);
    await expect(s.auth.login(u.email, PASSWORD, {}, code)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); // replay
    // An older code than the last accepted one is also refused.
    await expect(s.auth.login(u.email, PASSWORD, {}, totp(u.secret))).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await AuditLog.exists({ action: 'auth.login', 'metadata.method': 'password+totp' })).toBeTruthy();
  });

  it('the same code used twice at once signs in only once', async () => {
    const u = await enrolledUser();
    const code = u.next();
    const results = await Promise.allSettled([1, 2, 3].map(() => s.auth.login(u.email, PASSWORD, {}, code)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('recovery codes work once each, in any case or spacing', async () => {
    const u = await enrolledUser();
    const [c0, c1] = u.recoveryCodes;
    expect((await s.auth.login(u.email, PASSWORD, {}, ` ${c0!.toUpperCase()} `)).user.id).toBe(u.userId);
    await expect(s.auth.login(u.email, PASSWORD, {}, c0)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect((await s.auth.login(u.email, PASSWORD, {}, c1!.replace('-', ''))).user.id).toBe(u.userId);
  });

  it('wrong codes count towards the account lockout', async () => {
    const u = await enrolledUser();
    for (let i = 0; i < 10; i++) await expect(s.auth.login(u.email, PASSWORD, {}, '000000')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(s.auth.login(u.email, PASSWORD, {}, u.next())).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('disable needs the password and a code; afterwards the password alone signs in', async () => {
    const u = await enrolledUser();
    await expect(s.auth.disableMfa(u.userId, 'wrong-password', u.next())).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(s.auth.disableMfa(u.userId, PASSWORD, '000000')).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await s.auth.disableMfa(u.userId, PASSWORD, u.recoveryCodes[3]!);
    const session = await s.auth.login(u.email, PASSWORD);
    expect(session.user.mfaEnabled).toBe(false);
    const stored = await User.findById(u.userId).select('+mfa.secretEnc +mfa.recoveryCodeHashes').lean();
    expect(stored!.mfa!.secretEnc).toBeUndefined();
    expect(stored!.mfa!.recoveryCodeHashes).toBeUndefined();
  });

  it('HTTP: MFA_REQUIRED is a 401 with a distinct code, and mfaCode completes the sign-in', async () => {
    const u = await enrolledUser();
    const first = await app.inject({ method: 'POST', url: `${API_PREFIX}/auth/login`, payload: { email: u.email, password: PASSWORD } });
    expect(first.statusCode).toBe(401);
    expect(first.json().error.code).toBe('MFA_REQUIRED');
    const second = await app.inject({ method: 'POST', url: `${API_PREFIX}/auth/login`, payload: { email: u.email, password: PASSWORD, mfaCode: u.next() } });
    expect(second.statusCode).toBe(200);
    const token = second.json().accessToken as string;
    // Enrolment endpoints require a signed-in user.
    expect((await app.inject({ method: 'POST', url: `${API_PREFIX}/me/mfa/setup` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${API_PREFIX}/me/mfa/setup`, headers: { authorization: `Bearer ${token}` } })).json().error.code).toBe('CONFLICT');
  });
});
