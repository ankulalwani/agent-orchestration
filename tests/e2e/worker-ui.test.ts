/** Browser test of the worker local UI (spec §12, §51, §120). Requires `pnpm --filter @ao/worker-ui build`. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import type { FastifyInstance } from 'fastify';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { buildLocalApi } from '../../apps/worker/src/local-api.js';

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
    await browser?.close();
    await app?.close();
    await rt?.stop();
  });

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
});
