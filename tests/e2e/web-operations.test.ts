/**
 * Browser E2E for the operations pages: spend budget, schedules, chat channels and insights. The API
 * serves the built dashboard and Chromium drives it. Requires `pnpm --filter @ao/web build` first.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { Membership, Schedule, Task, UsageRecord, mongoose } from '@ao/database';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { cleanupStep, makeServices, makeWorker } from '../helpers.js';

const WEB_DIST = path.resolve('apps/web/dist');
const hasBuild = fs.existsSync(path.join(WEB_DIST, 'index.html'));

let s: Services;
let app: FastifyInstance;
let base: string;
let browser: Browser;
let page: Page;
let fake: http.Server;
let fakeUrl = '';
let organizationId = '';
let userId = '';
let projectId = '';
const chatMessages: unknown[] = [];
const consoleErrors: string[] = [];
const shots = path.resolve('test-results', 'web-operations');

describe.runIf(hasBuild)('operations pages (browser)', () => {
  beforeAll(async () => {
    fs.mkdirSync(shots, { recursive: true });
    await startTestDatabase();
    s = (await makeServices({ RATE_LIMIT_PER_MINUTE: '5000', AUTH_RATE_LIMIT_PER_MINUTE: '1000' })).services;
    app = await buildApp(s, { webDistDir: WEB_DIST });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    (s.config as { WEB_URL: string }).WEB_URL = base;
    (s.config as { PUBLIC_URL: string }).PUBLIC_URL = base;
    fake = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        chatMessages.push(JSON.parse(raw));
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    await page.goto(base + '/register');
    await page.getByLabel('Your name').fill('Ops Tester');
    await page.getByLabel('Email').fill(`ops-${Date.now()}@example.com`);
    await page.getByLabel('Password').fill('ops-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Getting started' }).waitFor();
    const m = (await Membership.findOne({}).lean())!;
    organizationId = String(m.organizationId);
    userId = String(m.userId);
    projectId = (await s.projects.create({ userId, organizationId, role: 'OWNER', correlationId: 'test' }, { name: 'storefront', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id;
  }, 120_000);

  afterAll(async () => {
    await cleanupStep('browser.close', () => browser?.close());
    await cleanupStep('app.close', () => app?.close());
    fake?.close();
    await cleanupStep('stopTestDatabase', () => stopTestDatabase());
  }, 150_000);

  it('spend budget: limits are saved, and a reached limit shows on the overview', async () => {
    await UsageRecord.create({ organizationId, projectId, kind: 'execution', costUsd: 12.5 });
    await page.goto(base + '/settings?tab=policy');
    await page.getByRole('heading', { name: 'Spend budget' }).waitFor();
    await page.getByLabel('Organization, per month (US$)').fill('10');
    await page.getByLabel('Each task (US$)').fill('2.5');
    await page.getByRole('button', { name: 'Save' }).first().click();
    await page.getByText('Budget saved.').waitFor();
    const spend = page.getByRole('table', { name: 'Spend this month' });
    await spend.getByText('125%').waitFor();
    await expect.poll(async () => (await s.orgs.get({ userId, organizationId, role: 'OWNER', correlationId: 't' })).policy).toMatchObject({ budget: { organizationMonthlyUsd: 10, taskUsd: 2.5, projectMonthlyUsd: null } });
    await page.screenshot({ path: path.join(shots, '01-budget.png'), fullPage: true });

    await page.goto(base + '/');
    await page.getByText(/Budget reached for the organization/).waitFor();
  });

  it('schedules: create with a preset, run now, turn off', async () => {
    await page.goto(base + '/schedules');
    await page.getByRole('heading', { name: 'Schedules', exact: true }).waitFor();
    await page.getByLabel('Name').fill('Nightly dependency update');
    await page.getByLabel('Cron expression').fill('not a schedule');
    await page.getByText(/use five fields/).waitFor();
    expect(await page.getByRole('button', { name: 'Create schedule' }).isDisabled()).toBe(true);
    await page.getByLabel('When').selectOption({ label: 'Weekdays at 09:00' });
    await page.getByText(/Next run:/).waitFor();
    await page.getByLabel('Task prompt').fill('Update the dependencies and make the tests pass.');
    await page.getByRole('button', { name: 'Create schedule' }).click();
    const row = page.getByRole('table', { name: 'Scheduled tasks' }).getByRole('row', { name: /Nightly dependency update/ });
    await row.waitFor();
    expect(await Schedule.findOne({}).lean()).toMatchObject({ cron: '0 9 * * mon-fri', enabled: true, task: { title: 'Nightly dependency update', kind: 'code' } });

    await row.getByRole('button', { name: 'Run now' }).click();
    await page.getByText('Task created:').waitFor();
    expect(await Task.findOne({ 'source.kind': 'schedule' }).lean()).toMatchObject({ title: 'Nightly dependency update', originalPrompt: 'Update the dependencies and make the tests pass.' });
    await row.getByText('1 runs').waitFor();
    await page.screenshot({ path: path.join(shots, '02-schedules.png'), fullPage: true });

    await row.getByRole('button', { name: 'Turn off' }).click();
    await row.getByText('off', { exact: true }).waitFor();
    expect((await Schedule.findOne({}).lean())!.nextRunAt).toBeNull();
  });

  it('chat: add a Slack channel, send a test message, link a Slack member ID', async () => {
    await page.goto(base + '/settings');
    await page.getByRole('tab', { name: 'Chat' }).click();
    await page.getByLabel('Name').fill('Slack #agents');
    await page.getByLabel('Incoming webhook URL').fill(`${fakeUrl}/services/T1/B1/x`);
    await page.getByLabel('Signing secret').fill('signing-secret-123');
    await page.getByRole('button', { name: 'Add channel' }).click();
    const row = page.getByRole('table', { name: 'Chat channels' }).getByRole('row', { name: /Slack #agents/ });
    await row.getByText('buttons and commands on').waitFor();
    await row.getByText(/\/api\/v1\/chat\/slack\/[a-f0-9]{24}/).waitFor();
    await row.getByRole('button', { name: 'Send test' }).click();
    await page.getByText('Test message sent to "Slack #agents".').waitFor();
    expect(chatMessages).toHaveLength(1);
    await page.screenshot({ path: path.join(shots, '03-chat.png'), fullPage: true });

    await page.getByRole('tab', { name: 'Your account' }).click();
    await page.getByLabel('Slack member ID').fill('u012ab3cd');
    await page.getByRole('button', { name: 'Save member ID' }).click();
    await expect.poll(async () => (await Membership.findOne({ userId }).lean())!.slackUserId).toBe('U012AB3CD');
  });

  it('insights: figures, the daily chart with a tooltip, and the comparison tables', async () => {
    const finished = (daysAgo: number, status: 'COMPLETED' | 'FAILED', agentId: string, cost: number, remediationCount = 0) => {
      const completedAt = new Date(Date.now() - daysAgo * 86_400_000);
      return { organizationId: new mongoose.Types.ObjectId(organizationId), projectId: new mongoose.Types.ObjectId(projectId), title: 't', originalPrompt: 'p', priority: 'NORMAL', status, agentId, providerId: 'anthropic', modelId: agentId === 'codex' ? 'gpt' : 'haiku', remediationCount, activeMs: 240_000, usage: { costUsd: cost, inputTokens: 0, outputTokens: 0 }, createdBy: new mongoose.Types.ObjectId(userId), correlationId: 'c', createdAt: new Date(completedAt.getTime() - 3_600_000), completedAt };
    };
    await mongoose.connection.db!.collection('tasks').insertMany([
      ...Array.from({ length: 6 }, (_, i) => finished(i % 4, 'COMPLETED', 'claude-code', 1.5, i % 3 === 0 ? 1 : 0)),
      finished(1, 'FAILED', 'claude-code', 2),
      finished(2, 'COMPLETED', 'codex', 0.5),
      finished(5, 'FAILED', 'codex', 1),
    ]);
    await page.goto(base + '/insights');
    await page.getByRole('heading', { name: 'Insights' }).waitFor();
    await page.getByText('78%').first().waitFor(); // 7 of 9 finished tasks completed
    const byAgent = page.getByRole('table', { name: 'Outcomes by agent' });
    await byAgent.getByRole('row', { name: /claude-code/ }).getByText('86%').waitFor();
    await byAgent.getByRole('row', { name: /codex/ }).getByText('50%').waitFor();
    await page.getByRole('table', { name: 'Outcomes by project' }).getByText('storefront').waitFor();

    const chart = page.getByRole('figure', { name: 'Tasks finished per day' });
    const today = chart.locator('.chart-columns .chart-slot').last();
    await today.hover();
    await chart.getByRole('tooltip').getByText(/completed/).waitFor();
    await page.screenshot({ path: path.join(shots, '04-insights.png'), fullPage: true });

    await page.getByLabel('Period').selectOption({ label: 'Last 7 days' });
    await expect.poll(() => chart.locator('.chart-columns .chart-slot').count()).toBe(7);
    // Narrow screens: nothing overflows the page.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(shots, '05-insights-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1360, height: 900 });
  });

  it('templates and attempts: a template fills the new task, and two agents try it', async () => {
    const owner = { userId, organizationId, role: 'OWNER' as const, correlationId: 'test' };
    const agents = ['claude-code', 'codex'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude Code', installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: ['resume'] }));
    await makeWorker(s, owner, projectId, { name: 'w-attempts', agents });

    await page.goto(base + '/templates');
    await page.getByRole('heading', { name: 'Templates', exact: true }).waitFor();
    await page.getByLabel('Name').fill('Upgrade a dependency');
    await page.getByLabel('Task title').fill('Upgrade {{package}} to {{version}}');
    await page.getByLabel('Task prompt').fill('Upgrade {{package}} to {{version}} and fix what breaks.');
    await page.getByText('Asks for: package, version').waitFor();
    await page.getByRole('button', { name: 'Create template' }).click();
    await page.getByRole('table', { name: 'Task templates' }).getByText('Asks for: package, version').waitFor();
    await page.screenshot({ path: path.join(shots, '06-templates.png'), fullPage: true });

    await page.goto(base + '/tasks?new=1');
    const dialog = page.getByRole('dialog', { name: 'New task' });
    await dialog.getByLabel('Start from a template').selectOption({ label: 'Upgrade a dependency' });
    await dialog.getByLabel('Package').fill('zod');
    expect(await dialog.getByRole('button', { name: 'Fill in the task' }).isDisabled()).toBe(true); // version is still missing
    await dialog.getByLabel('Version').fill('4');
    await dialog.getByRole('button', { name: 'Fill in the task' }).click();
    await expect.poll(() => dialog.getByLabel('Title').inputValue()).toBe('Upgrade zod to 4');
    expect(await dialog.getByLabel('What should be done?').inputValue()).toBe('Upgrade zod to 4 and fix what breaks.');

    await dialog.getByLabel('Claude Code').check();
    await dialog.getByLabel('Codex').check();
    await dialog.getByText(/2 attempts: the first that passes verification wins/).waitFor();
    await page.screenshot({ path: path.join(shots, '07-new-task.png') });
    await dialog.getByRole('button', { name: 'Create task' }).click();
    await page.getByRole('heading', { name: 'Upgrade zod to 4' }).waitFor();
    await page.getByRole('heading', { name: 'Attempt 1 of 2' }).waitFor();
    const attempts = page.getByRole('list', { name: 'Attempts' });
    await attempts.getByRole('link', { name: 'codex' }).waitFor();
    expect(await Task.countDocuments({ title: 'Upgrade zod to 4', 'attempt.of': 2 })).toBe(2);
    await page.screenshot({ path: path.join(shots, '08-attempts.png'), fullPage: true });
  });

  it('stacks: an organization stack is created and installed in one step, with a result per package', async () => {
    const owner = { userId, organizationId, role: 'OWNER' as const, correlationId: 'test' };
    const skill = (id: string, extra: object = {}) => ({ id, name: id, version: '1.0.0', type: 'skill', description: `House conventions for ${id} in our web projects.`, skill: { instructions: `Follow ${id}.` }, ...extra });
    const a = await s.capabilities.register(owner, skill('web-conventions'));
    const b = await s.capabilities.register(owner, skill('web-shell-tools', { permissions: ['shell'] }));
    await s.orgs.update(owner, { policy: { capabilities: { blockedPermissions: ['shell'] } } });

    await page.goto(base + '/capabilities');
    await page.getByRole('tab', { name: 'Stacks' }).click();
    await page.getByText('No stacks yet').waitFor();
    await page.getByLabel('Name').fill('Our web stack');
    await expect.poll(() => page.getByLabel('Address').inputValue()).toBe('our-web-stack');
    await page.getByLabel('Packages').fill(`${a.capabilityId}\n${b.capabilityId}`);
    await page.getByRole('button', { name: 'Create stack' }).click();
    const card = page.getByRole('article', { name: 'Our web stack stack' });
    await card.getByText('2 packages').waitFor();
    await card.getByRole('button', { name: 'Install all…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Install Our web stack' });
    await dialog.getByRole('button', { name: 'Install 2 packages' }).click();
    const result = dialog.getByRole('list', { name: 'Result' });
    await result.getByText('installed', { exact: true }).waitFor();
    await result.getByText('not installed').waitFor();
    await result.getByText(/Blocked by organization policy/).waitFor();
    await page.screenshot({ path: path.join(shots, '09-stack-installed.png') });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('tab', { name: 'Installed' }).click();
    await page.getByText(a.capabilityId).waitFor();
    expect(await page.getByText(b.capabilityId).count()).toBe(0);
  });

  it('logged no errors in the browser console', () => {
    expect(consoleErrors.filter((e) => !/Failed to load resource/.test(e))).toEqual([]);
  });
});
