/**
 * Browser E2E (spec TEST-004): the API serves the built dashboard; Chromium drives the real UI while a
 * real worker executes the task with the mock agent. Requires `pnpm --filter @ao/web build` first.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { runCommand, totp } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { cleanupStep, makeServices } from '../helpers.js';
import { startFakeIdp, type FakeIdp } from '../fake-idp.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';
const WEB_DIST = path.resolve('apps/web/dist');
const hasBuild = fs.existsSync(path.join(WEB_DIST, 'index.html'));

let s: Services;
let app: FastifyInstance;
let base: string;
let browser: Browser;
let page: Page;
let worker: WorkerRuntime | null = null;
let idp: FakeIdp;
const consoleErrors: string[] = [];
const shots = path.resolve('test-results', 'web');

describe.runIf(hasBuild)('web dashboard (browser)', () => {
  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    await startTestDatabase();
    idp = await startFakeIdp();
    // One browser makes all requests from one address, and every page load refreshes the session
    // (a sign-in route, limited to 20 per minute by default).
    s = (await makeServices({ OIDC_ISSUER: idp.url, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_DISPLAY_NAME: 'Test SSO', RATE_LIMIT_PER_MINUTE: '5000', AUTH_RATE_LIMIT_PER_MINUTE: '1000' })).services;
    app = await buildApp(s, { webDistDir: WEB_DIST });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    // Pairing URLs point at the web app.
    (s.config as { WEB_URL: string }).WEB_URL = base;
    (s.config as { PUBLIC_URL: string }).PUBLIC_URL = base; // OAuth redirect URI
    s.scheduler.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));
  }, 120_000);

  afterAll(async () => {
    await cleanupStep('worker.stop', () => worker?.stop());
    await cleanupStep('browser.close', () => browser?.close());
    await cleanupStep('idp.close', () => idp?.close());
    s?.scheduler.stop();
    await cleanupStep('app.close', () => app?.close());
    await cleanupStep('stopTestDatabase', () => stopTestDatabase());
  }, 150_000);

  it('register → onboarding → pair worker → project → task → live completion → report', async () => {
    await page.goto(base + '/register');
    await page.getByLabel('Your name').fill('Web Tester');
    await page.getByLabel('Email').fill(`web-${Date.now()}@example.com`);
    await page.getByLabel('Password').fill('web-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Getting started' }).waitFor();
    await page.screenshot({ path: path.join(shots, '01-onboarding.png') });

    // Create a project through the wizard.
    await page.getByLabel('Project name').fill('storefront');
    await page.getByRole('button', { name: 'Create project' }).click();
    const projectIdText = await page.locator('code').filter({ hasText: /^[a-f0-9]{24}$/ }).first().textContent();
    const projectId = projectIdText!.trim();

    // A real repo + worker; the worker starts device-code pairing and the user approves it in the UI.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-web-repo-'));
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'w@example.com'], ['config', 'user.name', 'W'], ['config', 'commit.gpgsign', 'false']]) await runCommand('git', a, { cwd: repo });
    fs.writeFileSync(path.join(repo, 'check.js'), "process.exit(require('fs').existsSync('mock-output.txt')?0:1)");
    await runCommand('git', ['add', '.'], { cwd: repo });
    await runCommand('git', ['commit', '-qm', 'init'], { cwd: repo });
    worker = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-web-worker-')), { timeScale: 0.01 });
    worker.config.update({
      enableMockAgent: true,
      projects: [{ projectId, localPath: repo }],
      providers: [{ id: 'mock', kind: 'mock', name: 'Mock', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [{ id: 'scenario:success' }] }],
      policy: { verification: { autoDetect: false, steps: [{ kind: 'test', name: 'check', command: [process.execPath, 'check.js'], required: true, timeoutMs: 20_000 }] } },
    });
    await worker.init();
    const pairing = await worker.beginPairing('self-hosted', base, 'web-worker');

    await page.goto(pairing.verificationUrl!);
    await page.getByText(/You are approving/).waitFor();

    // The install card on this page: desktop app downloads from the project's releases, or the one-line command.
    await page.getByRole('tab', { name: 'Windows' }).click();
    const download = page.getByRole('link', { name: /Windows 10\/11, x64/ });
    expect(await download.getAttribute('href')).toBe(`https://github.com/${s.config.UPDATE_CHECK_REPO}/releases/latest/download/agent-orchestration-worker-windows-x64-setup.exe`);
    await page.getByRole('tab', { name: 'macOS' }).click();
    expect(await page.getByRole('link', { name: /\.dmg/ }).count()).toBe(2);
    await page.getByRole('tab', { name: 'Command line' }).click();
    await page.getByText(/install\/worker\.sh \| sh/).waitFor();
    await page.getByRole('button', { name: 'Approve worker' }).click();
    await page.getByRole('heading', { name: 'web-worker' }).waitFor({ timeout: 20_000 });
    await page.getByText('Online').first().waitFor({ timeout: 20_000 });
    await page.screenshot({ path: path.join(shots, '02-worker.png') });

    // New task from the tasks page.
    await page.goto(base + '/tasks?new=1');
    await page.getByLabel('Title').fill('Add Razorpay');
    await page.getByLabel('What should be done?').fill('Add Razorpay support and tests');
    await page.getByRole('button', { name: 'Create task' }).click();
    await page.getByRole('heading', { name: 'Add Razorpay' }).waitFor();
    // Live update: status reaches Completed without reloading.
    await page.getByText('Completed and verified', { exact: true }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: path.join(shots, '03-task-completed.png'), fullPage: true });

    await page.getByRole('tab', { name: /Verification/ }).click();
    await page.getByText('check').first().waitFor();
    await page.getByRole('tab', { name: 'Git' }).click();
    await page.getByText('mock-output.txt').waitFor();
    await page.getByRole('tab', { name: 'Report' }).click();
    await page.getByText('Implemented the change').first().waitFor();
    await page.getByRole('tab', { name: 'Timeline' }).click();
    await page.getByText('Task Claimed').waitFor();

    await page.goto(base + '/');
    await page.getByText('Completed today').waitFor();
    await page.screenshot({ path: path.join(shots, '04-overview.png'), fullPage: true });
    expect(consoleErrors).toEqual([]);
  }, 180_000);

  it('invite someone without an account → they open the link, create an account and join (ORG-005)', async () => {
    await page.goto(base + '/settings');
    await page.getByRole('tab', { name: 'Members' }).click();
    const email = `invitee-${Date.now()}@example.com`;
    await page.getByLabel('Email').fill(email);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    const url = await page.getByLabel('Invitation link').inputValue();
    await page.getByRole('cell', { name: new RegExp(email) }).waitFor(); // listed as pending
    await page.screenshot({ path: path.join(shots, '06-invite.png'), fullPage: true });

    // The invitee has no session: a fresh browser context.
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const guest = await ctx.newPage();
    guest.on('pageerror', (e) => consoleErrors.push(e.message));
    await guest.goto(url);
    await guest.getByText(new RegExp(`invited ${email}`)).waitFor();
    await guest.getByLabel('Your name').fill('Invited Person');
    await guest.getByLabel('Password').fill('invitee-password-1');
    await guest.getByRole('button', { name: 'Create account and join' }).click();
    await guest.waitForURL(`${base}/`);
    const me = await guest.evaluate(async () => {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'x-client': 'web', 'content-type': 'application/json' }, body: '{}' });
      return r.json();
    });
    expect(me.user.email).toBe(email);
    expect(me.memberships).toHaveLength(1);
    expect(me.memberships[0].role).toBe('DEVELOPER');
    await ctx.close();

    // The inviter now sees them as a member and no pending invitation.
    await page.reload();
    await page.getByRole('tab', { name: 'Members' }).click();
    await page.getByText('Invited Person').waitFor();
    expect(await page.getByText('Pending invitations').count()).toBe(0);
    expect(consoleErrors).toEqual([]);
  }, 90_000);

  it('two-factor authentication: enrol with the QR/setup key, then sign in with a code (AUTH-005)', async () => {
    await page.goto(base + '/settings');
    await page.getByRole('tab', { name: 'Your account' }).click();
    await page.getByRole('button', { name: 'Set up two-factor authentication' }).click();
    await page.getByAltText('QR code for your authenticator app').waitFor();
    const secret = (await page.getByLabel('Setup key').textContent())!.replace(/\s/g, '');
    await page.getByLabel('6-digit code').fill(totp(secret));
    await page.getByRole('button', { name: 'Turn on' }).click();
    const codes = (await page.getByLabel('Recovery codes').textContent())!.trim().split('\n');
    expect(codes).toHaveLength(10);
    await page.getByText('On. Signing in asks for a code').waitFor();
    await page.screenshot({ path: path.join(shots, '07-mfa.png'), fullPage: true });

    const email = (await page.getByText(/^web-\d+@example\.com$/).first().textContent())!;
    const ctx = await browser.newContext();
    const fresh = await ctx.newPage();
    fresh.on('pageerror', (e) => consoleErrors.push(e.message));
    await fresh.goto(base + '/login');
    await fresh.getByLabel('Email').fill(email);
    await fresh.getByLabel('Password').fill('web-password-123');
    await fresh.getByRole('button', { name: 'Sign in' }).click();
    await fresh.getByLabel('Authentication code').fill('000000');
    await fresh.getByRole('button', { name: 'Verify' }).click();
    await fresh.getByText('Invalid authentication code').waitFor();
    await fresh.getByLabel('Authentication code').fill(totp(secret, Date.now() + 30_000)); // the enrolment step is used up
    await fresh.getByRole('button', { name: 'Verify' }).click();
    await fresh.waitForURL(`${base}/`);
    await ctx.close();
    expect(consoleErrors).toEqual([]);
  }, 90_000);

  it('sign in with an OpenID Connect provider: new account, then it shows as connected (AUTH-005)', async () => {
    const email = `sso-${Date.now()}@example.com`;
    idp.nextUser = { sub: `sso-${Date.now()}`, email, email_verified: true, name: 'Sso Person' };
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => consoleErrors.push(e.message));
    await p.goto(base + '/login?next=%2Fsettings%3Ftab%3Daccount');
    await p.getByRole('link', { name: 'Continue with Test SSO' }).click();
    // Real redirects: API → provider → API callback → /oauth/complete → next.
    await p.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 15_000 });
    expect(new URL(p.url()).hash).toBe(''); // the ticket never stays in the address bar
    await p.getByText('Connected accounts').waitFor();
    await p.locator('#main').getByText(email).waitFor();
    await p.getByRole('button', { name: 'Disconnect' }).waitFor();
    await p.screenshot({ path: path.join(shots, '08-sso.png'), fullPage: true });

    // Cancel at the provider → a clear message on the sign-in page.
    await ctx.clearCookies();
    idp.denyNext = true;
    await p.goto(base + '/login');
    await p.getByRole('link', { name: 'Continue with Test SSO' }).click();
    await p.getByText('Sign-in was cancelled.').waitFor();
    await ctx.close();
    expect(consoleErrors).toEqual([]);
  }, 90_000);

  it('server settings page for the platform administrator; secrets never shown (SELFHOST-002)', async () => {
    await page.goto(base + '/');
    await page.getByRole('link', { name: 'Server settings' }).click();
    await page.getByRole('heading', { name: 'Server settings' }).waitFor();
    await page.getByRole('table', { name: 'Server status' }).getByText('Dispatch queue').waitFor();
    await page.getByText('ENCRYPTION_KEY', { exact: true }).waitFor();
    const html = await page.content();
    expect(html).not.toContain(s.config.ENCRYPTION_KEY);
    expect(html).not.toContain(s.config.JWT_SECRET);
    await page.screenshot({ path: path.join(shots, '10-server-settings.png'), fullPage: true });

    // Change a setting in the web app; it applies without a restart. OIDC_* come from the environment here: locked.
    await page.getByRole('button', { name: 'Change ALLOW_REGISTRATION' }).click();
    await page.getByRole('dialog').getByLabel('Value').selectOption('false');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('row', { name: /ALLOW_REGISTRATION false set here/ }).waitFor();
    expect(s.config.ALLOW_REGISTRATION).toBe(false);
    expect(await page.getByRole('button', { name: 'Change OIDC_CLIENT_ID' }).count()).toBe(0);
    await page.getByRole('row', { name: /OIDC_CLIENT_ID .* environment locked/ }).waitFor();
    await page.getByRole('button', { name: 'Change ALLOW_REGISTRATION' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reset to default' }).click();
    await page.getByRole('row', { name: /ALLOW_REGISTRATION true default/ }).waitFor();
    expect(s.config.ALLOW_REGISTRATION).toBe(true);
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it('feature flags page: on for everyone, with an organization exception (CORE-010)', async () => {
    const orgId = (await s.orgs.searchAll())[0]!.id;
    await page.getByRole('link', { name: 'Feature flags' }).click();
    await page.getByRole('heading', { name: 'Feature flags' }).waitFor();
    await page.getByLabel('For all organizations').first().selectOption('on');
    await expect.poll(() => s.features.enabled('plugins.execution', orgId)).toBe(true);
    await page.getByLabel('Organization', { exact: true }).first().selectOption(orgId);
    await page.getByRole('button', { name: 'Turn off' }).first().click();
    await page.getByRole('table', { name: 'Plugin code execution organization exceptions' }).waitFor();
    expect(s.features.enabled('plugins.execution', orgId)).toBe(false);
    await page.screenshot({ path: path.join(shots, '11-feature-flags.png'), fullPage: true });
    await page.getByRole('button', { name: 'Remove' }).click();
    await page.getByLabel('For all organizations').first().selectOption('default');
    await expect.poll(async () => (await s.features.list()).flags[0]!.enabled).toBe(null);
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it('create a personal API token, use it, revoke it', async () => {
    await page.goto(base + '/settings?tab=account');
    await page.getByRole('heading', { name: 'API tokens' }).or(page.getByText('API tokens', { exact: true })).first().waitFor();
    await page.getByLabel('Name', { exact: true }).fill('CI pipeline');
    await page.getByLabel('Role').selectOption('DEVELOPER');
    await page.getByRole('button', { name: 'Create token' }).click();
    const token = (await page.locator('code').filter({ hasText: /^aot_/ }).textContent())!.trim();
    const orgs = await page.evaluate(async (t) => (await fetch('/api/v1/me', { headers: { authorization: `Bearer ${t}` } })).json(), token);
    expect(orgs.memberships).toHaveLength(1);
    expect(orgs.memberships[0].role).toBe('DEVELOPER');
    await page.getByRole('table', { name: 'API tokens' }).getByText('CI pipeline').waitFor();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('table', { name: 'API tokens' }).waitFor({ state: 'detached' });
    expect(await page.evaluate(async (t) => (await fetch('/api/v1/me', { headers: { authorization: `Bearer ${t}` } })).status, token)).toBe(401);
    // The browser logs the expected 401 above as a console error; nothing else may appear.
    expect(consoleErrors.filter((e) => !/status of 401/.test(e))).toEqual([]);
    consoleErrors.length = 0;
  }, 60_000);

  it('integrations: set up a generic webhook in the UI, deliver to it, the task links back (FUT-002)', async () => {
    const { createHmac } = await import('node:crypto');
    await page.goto(base + '/settings');
    await page.getByRole('tab', { name: 'Integrations' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Ticket system');
    await page.getByLabel('Source').selectOption('generic');
    await page.getByLabel('Title template').fill('{{ticket}}');
    await page.getByLabel('Prompt template').fill('Handle ticket {{ticket}}');
    await page.getByRole('button', { name: 'Create integration' }).click();
    const url = await page.getByLabel('Webhook URL').inputValue();
    const secret = await page.getByLabel('Secret').inputValue();
    expect(secret).toMatch(/^whsec_/);
    await page.screenshot({ path: path.join(shots, '12-integrations.png'), fullPage: true });
    const body = JSON.stringify({ ticket: 'OPS-42' });
    const res = await fetch(url.replace(/^https?:\/\/[^/]+/, base), { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` }, body });
    expect(res.status).toBe(201);
    const { taskId } = (await res.json()) as { taskId: string };
    await page.goto(`${base}/tasks/${taskId}`);
    await page.getByRole('heading', { name: 'OPS-42' }).waitFor();
    await page.getByText('from Ticket system').waitFor();
    await page.goto(base + '/settings');
    await page.getByRole('tab', { name: 'Integrations' }).click();
    await page.getByRole('table', { name: 'Integrations' }).getByText(/created task/).waitFor();
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it('plan: the proposed tasks are shown and created with one click (FUT-001)', async () => {
    const { randomUUID } = await import('node:crypto');
    const { makeWorker } = await import('../helpers.js');
    // The organization of the user signed in in the browser (registered in the first test).
    const { Membership, User } = await import('@ao/database');
    const me = (await User.findOne({ email: /^web-/ }).lean())!;
    const ownerM = (await Membership.findOne({ userId: me._id, role: 'OWNER' }).sort({ createdAt: 1 }).lean())!;
    const orgId = String(ownerM.organizationId);
    const actor = { userId: String(me._id), organizationId: orgId, role: 'OWNER' as const, correlationId: 'test' };
    // A project the browser test's real worker doesn't serve, completed by hand.
    const project = await s.projects.create(actor, { name: 'planning', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const { worker: w } = await makeWorker(s, actor, project.id, { name: 'plan-worker' });
    const t = await s.tasks.create(actor, { projectId: project.id, title: 'Plan the orders feature', prompt: 'Orders', kind: 'plan', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w, t.id);
    const tr = (to: string, patch: Record<string, unknown> = {}) => s.tasks.transition(w, t.id, { to: to as never, transitionId: randomUUID(), patch });
    await tr('PREPARING');
    await tr('RUNNING', { agentId: 'mock', providerId: 'mock', modelId: 'mock-1' });
    await tr('VERIFYING', { verificationStatus: 'RUNNING' });
    const plan = { summary: 'Two steps.', tasks: [{ key: 'api', title: 'Orders API', prompt: 'API', dependsOn: [], priority: 'NORMAL' }, { key: 'ui', title: 'Orders page', prompt: 'UI', dependsOn: ['api'], priority: 'NORMAL' }] };
    await tr('COMPLETED', { verificationStatus: 'PASSED', completionReport: { summary: 'Two steps.', requirements: [], implementation: '', filesChanged: [], testsExecuted: [], verification: 'Plan', git: null, knownLimitations: [], remainingWork: [], warnings: [], agentId: 'mock', providerId: 'mock', modelId: 'mock-1', durationMs: 1, recoveryEvents: [], plan } });

    await page.goto(`${base}/tasks/${t.id}`);
    await page.getByRole('tab', { name: /report/i }).click();
    await page.getByRole('table', { name: 'Planned tasks' }).getByText('Orders page').waitFor();
    await page.getByRole('button', { name: 'Create 2 tasks' }).click();
    await page.getByRole('table', { name: 'Planned tasks' }).getByRole('link', { name: 'Orders page' }).waitFor();
    await page.screenshot({ path: path.join(shots, '13-plan.png'), fullPage: true });
    await page.getByRole('table', { name: 'Planned tasks' }).getByRole('link', { name: 'Orders page' }).click();
    await page.getByRole('heading', { name: 'Orders page' }).waitFor();
    await page.getByRole('link', { name: 'a plan' }).waitFor();
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it('server administrator resets someone’s lost two-factor authentication from the Users page', async () => {
    const r = await s.auth.register({ email: `lost-phone-${Date.now()}@example.com`, password: 'lost-phone-123', name: 'Lost Phone' });
    const { secret } = await s.auth.setupMfa(r.user.id);
    await s.auth.enableMfa(r.user.id, totp(secret));
    await page.goto(base + '/admin/users');
    await page.getByLabel('Search users').fill('lost-phone');
    const row = page.getByRole('row', { name: /Lost Phone/ });
    await row.getByRole('button', { name: 'Reset two-factor' }).click();
    await page.getByRole('dialog').getByLabel('Reason').fill('Lost phone; confirmed by a call');
    await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await row.getByText('off').waitFor();
    expect((await s.auth.login(r.user.email, 'lost-phone-123', {})).accessToken).toBeTruthy(); // no code needed now
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it('device sign-in: the link from the CLI/app shows who is asking, and approving signs the device in', async () => {
    const start = (await (await fetch(`${base}/api/v1/auth/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientName: 'agentctl on laptop' }) })).json()) as { userCode: string; pollSecret: string; verificationUrl: string };
    await page.goto(start.verificationUrl.replace(/^https?:\/\/[^/]+/, base));
    await page.getByText('agentctl on laptop').waitFor();
    await page.screenshot({ path: path.join(shots, '14-device-sign-in.png'), fullPage: true });
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.getByText(/Approved\. Go back to the CLI/).waitFor();
    const poll = await (await fetch(`${base}/api/v1/auth/device/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pollSecret: start.pollSecret }) })).json();
    expect(poll.status).toBe('approved');
    expect(consoleErrors).toEqual([]);
  }, 60_000);

  it('works at phone width without horizontal page scroll', async () => {
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // Reuse the session via cookie from the main page context.
    await mobile.context().addCookies(await page.context().cookies());
    await mobile.goto(base + '/tasks');
    await mobile.getByRole('heading', { name: 'Tasks', exact: true }).waitFor();
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    await mobile.getByRole('button', { name: 'Open menu' }).click();
    await mobile.getByRole('link', { name: 'Workers' }).click();
    await mobile.getByRole('heading', { name: 'Workers', exact: true }).waitFor();
    await mobile.screenshot({ path: path.join(shots, '05-mobile.png') });
    await mobile.close();
  }, 60_000);
});
