/**
 * Security keys (WebAuthn) as a second sign-in step, in a real browser with Chromium's virtual
 * authenticator: enrolment in the account settings, sign-in with the key, and what the server refuses.
 * Requires `pnpm --filter @ao/web build` first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { totp } from '@ao/core';
import { API_PREFIX } from '@ao/contracts';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, User } from '@ao/database';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { cleanupStep, makeServices } from '../helpers.js';

const WEB_DIST = path.resolve('apps/web/dist');
const hasBuild = fs.existsSync(path.join(WEB_DIST, 'index.html'));

let s: Services;
let app: FastifyInstance;
let base: string;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let cdp: CDPSession;
let authenticatorId: string;
let secret = '';
const email = `keys-${Date.now()}@example.com`;
const PASSWORD = 'keys-password-123';
const consoleErrors: string[] = [];
const logins: Array<Record<string, any>> = [];
const shots = path.resolve('test-results', 'web-security-keys');

/** A browser page with a virtual authenticator (a USB key that confirms presence by itself). */
async function withAuthenticator(ctx: BrowserContext) {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => consoleErrors.push(e.message));
  const session = await ctx.newCDPSession(p);
  await session.send('WebAuthn.enable');
  const { authenticatorId: id } = await session.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { page: p, cdp: session, authenticatorId: id };
}

describe.runIf(hasBuild)('security keys (browser)', () => {
  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    await startTestDatabase();
    s = (await makeServices({ RATE_LIMIT_PER_MINUTE: '5000', AUTH_RATE_LIMIT_PER_MINUTE: '1000' })).services;
    app = await buildApp(s, { webDistDir: WEB_DIST });
    await app.listen({ port: 0, host: '127.0.0.1' });
    // WebAuthn's relying party is a host name: an IP address is not one, "localhost" is.
    base = `http://localhost:${(app.server.address() as { port: number }).port}`;
    (s.config as { WEB_URL: string }).WEB_URL = base;
    (s.config as { PUBLIC_URL: string }).PUBLIC_URL = base;
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    ({ page, cdp, authenticatorId } = await withAuthenticator(context));

    await page.goto(base + '/register');
    await page.getByLabel('Your name').fill('Key Tester');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Getting started' }).waitFor();
  }, 120_000);

  afterAll(async () => {
    await cleanupStep('browser.close', () => browser?.close());
    await cleanupStep('app.close', () => app?.close());
    await cleanupStep('stopTestDatabase', () => stopTestDatabase());
  }, 150_000);

  it('a key can be added only once two-factor authentication is on', async () => {
    const token = (await s.auth.login(email, PASSWORD)).accessToken;
    const refused = await app.inject({ method: 'POST', url: `${API_PREFIX}/me/security-keys/options`, headers: { authorization: `Bearer ${token}` } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/Turn on two-factor authentication/);

    await page.goto(base + '/settings?tab=account');
    await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
    secret = (await page.getByLabel('Setup key').textContent())!.replace(/\s/g, '');
    await page.getByLabel('6-digit code').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
    await page.getByText('On. Signing in asks for a code').waitFor();

    await page.getByLabel('Name for a new key').fill('Test YubiKey');
    await page.getByRole('button', { name: 'Add a security key' }).click();
    const list = page.getByRole('list', { name: 'Security keys' });
    await list.getByText('Test YubiKey').waitFor();
    await list.getByText(/not used yet/).waitFor();
    await page.screenshot({ path: path.join(shots, '01-key-added.png'), fullPage: true });

    // Only the public key is stored, and the challenge is gone once used.
    const stored = (await User.findOne({ email }).select('+mfa.securityKeys +mfa.challenge').lean())!.mfa as { securityKeys: Array<Record<string, unknown>>; challenge?: unknown };
    expect(stored.securityKeys).toHaveLength(1);
    expect(stored.securityKeys[0]).toMatchObject({ name: 'Test YubiKey', counter: expect.any(Number), publicKey: expect.any(String) });
    expect(stored.challenge).toBeUndefined();
    expect(await AuditLog.countDocuments({ action: 'auth.security_key_added' })).toBe(1);

    // The same key cannot be added twice.
    await page.getByRole('button', { name: 'Add a security key' }).click();
    await page.getByText('This security key is already on your account.').waitFor();
  }, 90_000);

  it('signs in with the key instead of a code; the code still works', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const other = await withAuthenticator(ctx);
    // The key from the first browser, plugged into this one.
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    await other.cdp.send('WebAuthn.addCredential', { authenticatorId: other.authenticatorId, credential: credentials[0]! });
    other.page.on('request', (r) => {
      if (r.url().endsWith('/auth/login') && r.method() === 'POST') logins.push(r.postDataJSON());
    });

    await other.page.goto(base + '/login');
    await other.page.getByLabel('Email').fill(email);
    await other.page.getByLabel('Password').fill(PASSWORD);
    await other.page.getByRole('button', { name: 'Sign in' }).click();
    await other.page.getByRole('button', { name: 'Use a security key' }).waitFor();
    await other.page.screenshot({ path: path.join(shots, '02-second-step.png') });
    await other.page.getByRole('button', { name: 'Use a security key' }).click();
    await other.page.waitForURL(`${base}/`);
    expect(await AuditLog.findOne({ action: 'auth.login', 'metadata.method': 'password+security_key' }).lean()).toBeTruthy();
    const key = ((await User.findOne({ email }).select('+mfa.securityKeys').lean())!.mfa as { securityKeys: Array<{ lastUsedAt: Date | null }> }).securityKeys[0]!;
    expect(key.lastUsedAt).toBeInstanceOf(Date);
    await ctx.close();

    // An authenticator code is still accepted for the same account.
    const withCode = await s.auth.login(email, PASSWORD, {}, totp(secret, Date.now() + 30_000));
    expect(withCode.user.email).toBe(email);
  }, 90_000);

  it('the server refuses a replayed answer, an answer without a challenge, and one from another site', async () => {
    const answered = logins.find((l) => l.securityKey);
    expect(answered).toBeTruthy();
    const post = (body: unknown) => app.inject({ method: 'POST', url: `${API_PREFIX}/auth/login`, payload: body as object });
    // The answer that just signed in: its challenge was used.
    expect((await post(answered)).statusCode).toBe(401);
    // A fresh challenge, answered with the old answer.
    const required = await post({ email, password: PASSWORD });
    expect(required.statusCode).toBe(401);
    expect(required.json().error).toMatchObject({ code: 'MFA_REQUIRED', context: { securityKey: { challenge: expect.any(String), rpId: 'localhost', allowCredentials: [expect.objectContaining({ id: answered!.securityKey.id })] } } });
    expect((await post(answered)).json().error.message).toBe('Invalid authentication code');
    // A wrong password gets no challenge at all.
    const wrong = await post({ email, password: 'not-the-password', securityKey: answered!.securityKey });
    expect(wrong.json().error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'Invalid email or password' });

    // A fresh, valid answer that the key gave to another site (a phishing page relaying it) is refused:
    // the browser signs the origin it ran on, and the server expects the dashboard's.
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const other = await withAuthenticator(ctx);
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    await other.cdp.send('WebAuthn.addCredential', { authenticatorId: other.authenticatorId, credential: credentials[0]! });
    await other.page.route('**/auth/login', async (route) => {
      // From the moment the key has answered, the server is "another site" as far as origins go.
      if (route.request().postDataJSON()?.securityKey) (s.config as { WEB_URL: string }).WEB_URL = 'http://dashboard.example.test';
      await route.continue();
    });
    try {
      await other.page.goto(base + '/login');
      await other.page.getByLabel('Email').fill(email);
      await other.page.getByLabel('Password').fill(PASSWORD);
      await other.page.getByRole('button', { name: 'Sign in' }).click();
      await other.page.getByRole('button', { name: 'Use a security key' }).click();
      await other.page.getByText('Invalid authentication code').waitFor();
    } finally {
      (s.config as { WEB_URL: string }).WEB_URL = base;
      await ctx.close();
    }
    // Failed key checks count towards the lockout like wrong codes.
    expect(await AuditLog.countDocuments({ action: 'auth.login_failed', 'metadata.reason': 'mfa' })).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it('removing a key, and turning two-factor off, take the keys away', async () => {
    await User.updateOne({ email }, { failedLoginCount: 0, lockedUntil: null });
    await page.goto(base + '/settings?tab=account');
    const list = page.getByRole('list', { name: 'Security keys' });
    await list.getByText(/last used/).waitFor();
    page.once('dialog', (d) => void d.accept());
    await list.getByRole('button', { name: 'Remove' }).click();
    await page.getByText('Test YubiKey').waitFor({ state: 'detached' });
    const required = await app.inject({ method: 'POST', url: `${API_PREFIX}/auth/login`, payload: { email, password: PASSWORD } });
    expect(required.json().error).toMatchObject({ code: 'MFA_REQUIRED', message: 'Enter the code from your authenticator app' });
    expect(required.json().error.context?.securityKey).toBeUndefined();

    // Add it again, then turn two-factor off: the key goes with it.
    await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    await page.getByRole('button', { name: 'Add a security key' }).click();
    await list.getByText('Security key').waitFor();
    const userId = String((await User.findOne({ email }).lean())!._id);
    // (An authenticator code is accepted once per time step, and this test already used the current ones.)
    await User.updateOne({ email }, { $set: { 'mfa.lastStep': null } });
    await s.auth.disableMfa(userId, PASSWORD, totp(secret));
    const after = (await User.findOne({ email }).select('+mfa.securityKeys').lean())!.mfa as { enabled: boolean; securityKeys?: unknown[] };
    expect(after.enabled).toBe(false);
    expect(after.securityKeys).toBeUndefined();
    expect(consoleErrors).toEqual([]);
  }, 90_000);
});
