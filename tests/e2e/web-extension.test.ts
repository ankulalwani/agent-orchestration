/**
 * The web dashboard extension point (docs/PUBLIC_PRIVATE_BOUNDARY.md): a dashboard rendered with a
 * WebExtension (apps/web/test-extension) shows the extension's pages, navigation and banner around the
 * unchanged core dashboard.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

const WEB = path.resolve('apps/web');
const VITE = path.join(WEB, 'node_modules', 'vite', 'bin', 'vite.js');

let app: FastifyInstance;
let browser: Browser;
let base = '';

describe.runIf(fs.existsSync(VITE))('web dashboard extension point (browser)', () => {
  beforeAll(async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-web-ext-'));
    const build = await runCommand(process.execPath, [VITE, 'build', '--config', 'vite.extension-fixture.config.ts', '--logLevel', 'error'], { cwd: WEB, env: { ...process.env, AO_FIXTURE_OUT: out }, timeoutMs: 120_000 });
    if (build.exitCode !== 0) throw new Error(`fixture build failed: ${build.stderr}`);
    await startTestDatabase();
    const s = (await makeServices({ RATE_LIMIT_PER_MINUTE: '5000', AUTH_RATE_LIMIT_PER_MINUTE: '5000' })).services;
    app = await buildApp(s, { webDistDir: out });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await app?.close();
    await stopTestDatabase();
  });

  it('adds routes, navigation (with visibility rules) and a banner to the signed-in layout', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/register');
    await page.getByLabel('Your name').fill('Ext Tester');
    await page.getByLabel('Email').fill(`ext-${Date.now()}@example.com`);
    await page.getByLabel('Password').fill('ext-password-123');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByRole('heading', { name: 'Getting started' }).waitFor();

    const nav = page.getByRole('complementary', { name: 'Main navigation' });
    await expect(nav.getByRole('link', { name: 'Extension page' }).isVisible()).resolves.toBe(true);
    await expect(nav.getByRole('link', { name: 'Owners only' }).isVisible()).resolves.toBe(true); // owner: billing.manage
    await expect(nav.getByRole('link', { name: 'Extension admin' }).isVisible()).resolves.toBe(true); // first user: platform admin
    await expect(page.getByRole('status').filter({ hasText: 'Extension banner' }).isVisible()).resolves.toBe(true);

    await nav.getByRole('link', { name: 'Extension page' }).click();
    await page.getByRole('heading', { name: 'Extension page' }).waitFor();
    await page.getByText('active tasks: 0').waitFor();
    // Core pages are unchanged.
    await nav.getByRole('link', { name: 'Tasks' }).click();
    await page.getByRole('heading', { name: 'Tasks' }).waitFor();
    expect(errors).toEqual([]);
  }, 120_000);
});
