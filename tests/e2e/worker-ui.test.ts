/** Browser test of the worker local UI (spec §12, §51, §120). Requires `pnpm --filter @ao/worker-ui build`. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { buildLocalApi } from '../../apps/worker/src/local-api.js';
import { cleanupStep } from '../helpers.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';
const UI = path.resolve('apps/worker-ui/dist');

describe.runIf(fs.existsSync(path.join(UI, 'index.html')))('worker local UI (browser)', () => {
  let rt: WorkerRuntime;
  let app: FastifyInstance;
  let browser: Browser;
  let url: string;

  beforeAll(async () => {
    rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wui-')));
    await rt.init();
    app = await buildLocalApi(rt, { uiDir: UI });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await cleanupStep('browser.close', () => browser?.close());
    await cleanupStep('app.close', () => app?.close());
    await cleanupStep('worker.stop', () => rt?.stop());
  }, 90_000);

  it('refuses to work without the token link', async () => {
    const page = await browser.newPage();
    await page.goto(url + '/');
    await page.getByText('Open the worker UI from the worker').waitFor();
    await page.close();
  });

  it('dashboard, provider credential entry (masked), diagnostics, no console errors', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}/#token=${await rt.localUiToken()}`);
    await page.getByText('This worker is not connected to a control plane yet').waitFor();
    expect(page.url()).not.toContain('token='); // token removed from the address bar

    await page.getByRole('button', { name: 'AI models' }).click();
    await page.getByLabel('Provider', { exact: true }).selectOption('openrouter');
    await page.getByLabel('Base URL').fill('http://127.0.0.1:9/api/v1');
    await page.getByLabel('Models', { exact: true }).fill('anthropic/claude-x');
    await page.getByLabel('API key', { exact: true }).fill('sk-or-v1-browsersecret1234567');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('sk-or-v1-••••••••••••4567').waitFor();
    expect(await page.content()).not.toContain('browsersecret');
    expect(fs.readFileSync(rt.config.file, 'utf8')).not.toContain('browsersecret');
    // Listed models are the ones used; what happens on a harness limit is chosen here.
    expect(rt.config.get().providers.find((p) => p.id === 'openrouter')).toMatchObject({ restrictModels: true, models: [{ id: 'anthropic/claude-x' }] });
    await page.getByLabel(/Switch to add-on models automatically/).check();
    await expect.poll(() => rt.config.get().addons.onHarnessLimit).toBe('switch');

    await page.getByRole('button', { name: 'Connection' }).click();
    await page.getByText('My self-hosted server').waitFor();
    await page.getByRole('button', { name: 'Diagnostics' }).click();
    await page.getByText('Node.js').waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.resolve('test-results', 'web', '06-worker-ui-diagnostics.png'), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it('MCP servers: saved servers are health-checked; only healthy ones are advertised (CAP-011)', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${url}/#token=${await rt.localUiToken()}`);
    await page.getByRole('button', { name: 'MCP Servers' }).click();
    const server = path.resolve('tests/fixtures/mcp-server.mjs');
    await page.getByLabel('MCP servers JSON').fill(
      JSON.stringify([
        { id: 'good-mcp', name: 'Good', transport: 'stdio', command: [process.execPath, server, 'stdio'] },
        { id: 'broken-mcp', name: 'Broken', transport: 'stdio', command: [process.execPath, server, 'crash'] },
      ]),
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/Not advertised until they pass the health check: broken-mcp/).waitFor({ timeout: 30_000 });
    const health = page.getByRole('list', { name: 'MCP server health' });
    await health.getByText('test-mcp · 2 tools').waitFor();
    await health.getByText(/GITHUB_TOKEN/).waitFor();
    expect(rt.mcp.healthyTags()).toEqual(['mcp:good-mcp']);
    await page.screenshot({ path: path.resolve('test-results', 'web', '09-worker-ui-mcp.png'), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it('shows no desktop controls in a browser', async () => {
    const page = await browser.newPage();
    await page.goto(`${url}/#token=${await rt.localUiToken()}`);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.getByLabel('Projects folder').waitFor();
    expect(await page.getByRole('button', { name: 'Browse…' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByLabel('Worker name').waitFor();
    expect(await page.getByLabel(/Start the worker when I sign in/).count()).toBe(0);
    await page.close();
  }, 60_000);

  it('inside the desktop app: folder chooser, start at login, the log window, outside links in the browser', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Stands in for the desktop app (apps/desktop): records the commands the page calls.
    await page.addInitScript((folder) => {
      const state = { calls: [] as Array<{ command: string; args: unknown }>, autostart: false };
      (window as unknown as { __desktop: typeof state }).__desktop = state;
      (window as unknown as { __TAURI__: unknown }).__TAURI__ = {
        core: {
          invoke: async (command: string, args?: { enabled?: boolean }) => {
            state.calls.push({ command, args });
            if (command === 'pick_folder') return folder;
            if (command === 'autostart_get') return state.autostart;
            if (command === 'autostart_set') return ((state.autostart = !!args?.enabled), true);
            return null;
          },
        },
      };
    }, UI);
    const calls = (command: string) => page.evaluate((c) => (window as unknown as { __desktop: { calls: Array<{ command: string; args: Record<string, unknown> }> } }).__desktop.calls.filter((x) => x.command === c), command);
    await page.goto(`${url}/#token=${await rt.localUiToken()}`);

    // Before connecting: the choices for this computer, saved at once.
    await page.getByRole('button', { name: 'Connection' }).click();
    await page.getByRole('heading', { name: 'On this computer' }).waitFor();
    await page.getByRole('button', { name: 'Choose the projects folder…' }).click();
    await expect.poll(() => rt.config.get().projectsRoot).toBe(UI);
    await page.getByText(UI, { exact: true }).waitFor();

    // In the forms, the chosen folder goes into the field.
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    const projectsFolder = page.getByLabel('Projects folder');
    await projectsFolder.waitFor();
    await projectsFolder.locator('xpath=..').getByRole('button', { name: 'Browse…' }).click();
    await expect.poll(() => projectsFolder.inputValue()).toBe(UI);
    await page.getByRole('button', { name: 'Add a folder…' }).click();
    await expect.poll(() => page.getByLabel('Folders to scan').inputValue()).toBe(UI);
    expect((await calls('pick_folder')).length).toBe(3);

    await page.getByRole('button', { name: 'Settings' }).click();
    const atLogin = page.getByLabel(/Start the worker when I sign in/);
    await atLogin.check();
    await expect.poll(async () => (await calls('autostart_set')).at(-1)?.args).toEqual({ enabled: true });
    expect(await atLogin.isChecked()).toBe(true);

    await page.getByRole('button', { name: 'Logs' }).click();
    await page.getByRole('button', { name: 'Open the worker log' }).click();
    await expect.poll(async () => (await calls('open_logs')).length).toBe(1);

    await page.getByRole('button', { name: 'Updates', exact: true }).click();
    await page.getByRole('button', { name: 'Check for app updates…' }).click();
    await expect.poll(async () => (await calls('check_app_update')).length).toBe(1);

    // A link that leaves the UI is handed to the app (which opens the browser); the page does not navigate.
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = 'https://orchestration.example.com/workers/approve?code=ABCD-1234';
      a.target = '_blank';
      a.textContent = 'outside link';
      document.body.append(a);
      window.open('https://openrouter.example.com/auth', '_blank', 'noopener');
    });
    await page.getByText('outside link').click();
    await expect.poll(async () => (await calls('open_external')).map((c) => c.args.url)).toEqual(['https://openrouter.example.com/auth', 'https://orchestration.example.com/workers/approve?code=ABCD-1234']);
    expect(page.url().startsWith(url)).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);
});
