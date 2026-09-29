/**
 * QA route discovery (FUT-004, spec §76) in real Chromium: the verification step starts the app, visits
 * the start page, pages found through links and file-based routes, and reports every broken page.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VerificationEngine } from '../../packages/verification/src/index.js';

let hasPlaywright = true;
try {
  await import('playwright');
} catch {
  hasPlaywright = false;
}

// Inside the repository so the project resolves the repository's Playwright installation.
const root = path.resolve('.tmp-qa', `qa-${Date.now()}`);
afterAll(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));

const APP = `
const http = require('http');
const page = (body, script = '') => '<!doctype html><title>t</title><body>' + body + script + '</body>';
const routes = {
  '/': page('<a href="/about">About</a> <a href="/shop">Shop</a> <a href="/logout">Log out</a> <a href="https://example.com/">out</a>'),
  '/about': page('<a href="/team">Team</a>'),
  '/team': page('Team'),
  '/shop': page('Shop', '<script>console.error("TypeError: cart is undefined")</script>'),
  '/pricing': page('Pricing', '<script>throw new Error("price table crashed")</script>'),
  '/logout': page('Logged out'),
};
http.createServer((req, res) => {
  const body = routes[req.url];
  if (!body) { res.writeHead(500, { 'content-type': 'text/html' }); return res.end('<h1>Server error</h1>'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(body);
}).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('app listening'));
`;

async function freePort() {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as net.AddressInfo).port;
  await new Promise((r) => srv.close(r));
  return port;
}

describe.runIf(hasPlaywright)('QA route discovery', () => {
  it('starts the app, finds pages through links and file routes, and reports each broken one', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"shop","private":true}');
    fs.writeFileSync(path.join(root, 'server.js'), APP);
    // File-based routes: /pricing is linked from nowhere; /missing does not exist on the server.
    for (const f of ['app/pricing/page.tsx', 'app/missing/page.tsx', 'app/posts/[id]/page.tsx']) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), 'export default function P() { return null; }');
    }
    const port = await freePort();
    const shots: string[] = [];
    const engine = new VerificationEngine(root, { artifacts: { put: async (name) => (shots.push(name), `key-${name}`) } });
    const run = await engine.run(
      [{ kind: 'browser', name: 'qa', required: true, timeoutMs: 90_000, url: `http://127.0.0.1:${port}/`, start: { command: [process.execPath, 'server.js'], readyTimeoutMs: 20_000, env: { PORT: String(port) } }, discover: { maxPages: 20, maxDepth: 3, paths: [], exclude: ['/logout'] } }],
      1,
    );
    const step = run.steps[0]!;
    expect(step.status, step.outputTail).toBe('failed');
    const report = step.outputTail!;
    expect(report).toMatch(/Visited 6 page\(s\); 3 with problems/);
    expect(report).toMatch(/✓ \/ \(200, start\)/);
    expect(report).toMatch(/✓ \/about \(200, link\)/);
    expect(report).toMatch(/✓ \/team \(200, link\)/); // two links deep
    expect(report).toMatch(/✗ \/shop \(200, link\)\n\s+console: TypeError: cart is undefined/);
    expect(report).toMatch(/✗ \/pricing \(200, routes\)\n\s+pageerror: price table crashed/);
    expect(report).toMatch(/✗ \/missing \(500, routes\)(\n {4}.*)*\n {4}HTTP 500/);
    expect(report).not.toContain('/logout');
    expect(report).not.toContain('example.com');
    expect(report).not.toContain('/posts');
    expect(shots).toEqual(['screenshot.png', expect.stringMatching(/^screenshot-\d+\.png$/), expect.stringMatching(/^screenshot-\d+\.png$/), expect.stringMatching(/^screenshot-\d+\.png$/)]);

    // The app was stopped after the step.
    await expect(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
  }, 120_000);

  it('fails with the app output when the app does not come up', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'crash.js'), 'console.error("Error: Cannot find module \\"express\\""); process.exit(1);');
    const engine = new VerificationEngine(root);
    const run = await engine.run([{ kind: 'browser', name: 'qa', required: true, timeoutMs: 30_000, url: 'http://127.0.0.1:1/', start: { command: [process.execPath, 'crash.js'], readyTimeoutMs: 10_000, env: {} } }], 1);
    expect(run.steps[0]).toMatchObject({ status: 'failed', reason: expect.stringMatching(/The app exited \(code 1\)/) });
    expect(run.steps[0]!.outputTail).toContain('Cannot find module');
  }, 60_000);
});
