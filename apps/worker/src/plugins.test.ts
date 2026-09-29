/**
 * Plugin sandbox (CAP-012): real plugin processes under the Node.js permission model. Each test runs
 * plugin code that tries to reach something it was not granted.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PluginRunner, pluginRuntimeSupported, type PluginSpec } from './plugins.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plugins-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plugin-project-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-plugin-outside-'));
fs.writeFileSync(path.join(project, 'README.md'), 'project readme');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret');
const runner = new PluginRunner(root);
let server: http.Server;
let url = '';

beforeAll(async () => {
  server = http.createServer((_req, res) => res.end('pong'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => server.close());

const spec = (source: string, extra: Partial<PluginSpec> & { hooks?: string[]; timeoutMs?: number; memoryMb?: number } = {}): PluginSpec => ({
  id: extra.id ?? 'test-plugin',
  version: '1.0.0',
  name: 'Test plugin',
  permissions: extra.permissions ?? [],
  config: extra.config ?? {},
  plugin: { hooks: extra.hooks ?? ['task.prepare', 'task.verify', 'task.completed'], source, sha256: createHash('sha256').update(source).digest('hex'), timeoutMs: extra.timeoutMs ?? 20_000, memoryMb: extra.memoryMb },
});
/** A plugin whose prepare hook returns what `body` evaluates to, as instructions (JSON). */
const probe = (body: string) => `export async function prepare(ctx) { const r = await (async () => { ${body} })(); return { instructions: JSON.stringify(r) }; }`;
const tryIt = (expr: string) => `try { return 'ok:' + String(await (${expr})).slice(0, 60); } catch (e) { return 'denied:' + (e.code ?? e.message); }`;
const run = async (s: PluginSpec, context: Record<string, unknown> = {}) => runner.run(s, 'task.prepare', { task: { id: 't1' }, ...context }, { projectDir: project });
const answer = async (s: PluginSpec) => {
  const o = await run(s);
  expect(o.error).toBeUndefined();
  return JSON.parse((o.result as { instructions: string }).instructions) as string;
};

describe.runIf(pluginRuntimeSupported())('plugin sandbox', () => {
  it('runs a hook, validates its result, and passes the context and configuration', async () => {
    const o = await runner.run(spec(`export function verify(ctx) { ctx.log('checking', ctx.task.id); return { checks: [{ name: 'lint-' + ctx.config.level, passed: false, summary: 'bad' }] }; }`, { config: { level: 'strict' } }), 'task.verify', { task: { id: 'task-9' } }, { projectDir: project });
    expect(o).toMatchObject({ ok: true, result: { checks: [{ name: 'lint-strict', passed: false, summary: 'bad' }] } });
    expect(o.logs).toContain('checking task-9');
    const bad = await runner.run(spec(`export function verify() { return { checks: [{ passed: 'yes' }] }; }`), 'task.verify', {}, { projectDir: project });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Invalid result/);
    const missing = await runner.run(spec(`export function other() {}`), 'task.verify', {}, { projectDir: project });
    expect(missing.error).toMatch(/does not export a "verify" function/);
  });

  it('cannot read or write files outside what it was granted', async () => {
    const readOutside = tryIt(`(await import('node:fs')).readFileSync(${JSON.stringify(path.join(outside, 'secret.txt'))}, 'utf8')`);
    const readProject = tryIt(`(await import('node:fs')).readFileSync(${JSON.stringify(path.join(project, 'README.md'))}, 'utf8')`);
    const writeProject = tryIt(`(await import('node:fs')).writeFileSync(${JSON.stringify(path.join(project, 'plugin-wrote.txt'))}, 'x')`);
    const writeOwnData = tryIt(`(await import('node:fs')).writeFileSync('state.json', '{}')`);
    const none = spec(probe(`const out = []; for (const f of [${[readOutside, readProject, writeProject, writeOwnData].map((a) => `async () => { ${a} }`).join(', ')}]) out.push(await f()); return out;`));
    const results = await run(none);
    expect(results.result).toBeDefined();
    const [a, b, c, d] = JSON.parse((results.result as { instructions: string }).instructions);
    expect(a).toBe('denied:ERR_ACCESS_DENIED');
    expect(b).toBe('denied:ERR_ACCESS_DENIED');
    expect(c).toBe('denied:ERR_ACCESS_DENIED');
    expect(d).toMatch(/^ok:/); // its own data folder
    expect(fs.existsSync(path.join(project, 'plugin-wrote.txt'))).toBe(false);

    const reader = spec(none.plugin.source!, { id: 'project-reader', permissions: ['filesystem.project.read'] });
    const [a2, b2, c2] = JSON.parse(((await run(reader)).result as { instructions: string }).instructions);
    expect([a2, b2, c2]).toEqual(['denied:ERR_ACCESS_DENIED', 'ok:project readme', 'denied:ERR_ACCESS_DENIED']);

    const writer = spec(none.plugin.source!, { id: 'project-writer', permissions: ['filesystem.project.write'] });
    const [a3, , c3] = JSON.parse(((await run(writer)).result as { instructions: string }).instructions);
    expect(a3).toBe('denied:ERR_ACCESS_DENIED');
    expect(c3).toMatch(/^ok:/);
    expect(fs.existsSync(path.join(project, 'plugin-wrote.txt'))).toBe(true);
  });

  it('has no network access unless it declares network.outbound', async () => {
    const attempts = [
      `fetch(${JSON.stringify(url)}).then((r) => r.text())`,
      `new Promise((res, rej) => (await_http()).get(${JSON.stringify(url)}, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(b)); }).on('error', rej))`,
      `new Promise((res, rej) => { const s = new (await_net()).Socket(); s.on('error', rej); s.connect(${new URL(url).port}, '127.0.0.1', () => { s.destroy(); res('connected'); }); })`,
      `(await_dns()).promises.lookup('localhost')`,
      `new Promise((res, rej) => { const srv = (await_net()).createServer(); srv.on('error', rej); srv.listen(0, () => { srv.close(); res('listening'); }); })`,
      `Promise.resolve().then(() => process.binding('tcp_wrap'))`,
    ];
    const prelude = `const m = { http: await import('node:http'), net: await import('node:net'), dns: await import('node:dns') }; const await_http = () => m.http.default; const await_net = () => m.net.default; const await_dns = () => m.dns.default;`;
    const body = `${prelude} const out = []; for (const f of [${attempts.map((a) => `async () => { ${tryIt(a)} }`).join(', ')}]) out.push(await f()); return out;`;
    const denied = JSON.parse(((await run(spec(probe(body), { id: 'offline' }))).result as { instructions: string }).instructions) as string[];
    expect(denied.every((r) => r === 'denied:ERR_ACCESS_DENIED'), JSON.stringify(denied)).toBe(true);

    const allowed = JSON.parse(((await run(spec(probe(body), { id: 'online', permissions: ['network.outbound'] }))).result as { instructions: string }).instructions) as string[];
    expect(allowed.slice(0, 3)).toEqual(['ok:pong', 'ok:pong', 'ok:connected']);
    expect(allowed[5]).toBe('denied:ERR_ACCESS_DENIED'); // process.binding stays unavailable
  });

  it('cannot start processes or threads without process.execute, and sees no worker environment', async () => {
    process.env.AO_TEST_WORKER_SECRET = 'worker-only-secret';
    const body = `const out = []; out.push(await (async () => { ${tryIt(`(await import('node:child_process')).execFileSync(process.execPath, ['-e', 'console.log(1)']).toString().trim()`)} })()); out.push(await (async () => { ${tryIt(`new (await import('node:worker_threads')).Worker('1', { eval: true })`)} })()); out.push(String(process.env.AO_TEST_WORKER_SECRET)); return out;`;
    const [child, thread, secret] = JSON.parse(((await run(spec(probe(body), { id: 'no-exec' }))).result as { instructions: string }).instructions) as string[];
    expect(child).toBe('denied:ERR_ACCESS_DENIED');
    expect(thread).toBe('denied:ERR_ACCESS_DENIED');
    expect(secret).toBe('undefined');
    const [child2] = JSON.parse(((await run(spec(probe(body), { id: 'exec', permissions: ['process.execute'] }))).result as { instructions: string }).instructions) as string[];
    expect(child2).toBe('ok:1');
    delete process.env.AO_TEST_WORKER_SECRET;
  });

  it('is stopped at its time and memory limits, and a crash is reported, not thrown', async () => {
    const slow = await run(spec(`export async function prepare() { await new Promise(() => setInterval(() => {}, 1000)); }`, { id: 'slow', timeoutMs: 1500 }));
    expect(slow).toMatchObject({ ok: false, error: 'Timed out after 1500 ms' });
    const hungry = await run(spec(`export function prepare() { const a = []; for (;;) a.push(new Array(1e6).fill(Math.random())); }`, { id: 'hungry', memoryMb: 64 }));
    expect(hungry.ok).toBe(false);
    expect(hungry.error).toMatch(/memory|exited/);
    const thrower = await run(spec(`export function prepare() { throw new Error('plugin bug'); }`, { id: 'thrower' }));
    expect(thrower.ok).toBe(false);
    expect(thrower.error).toContain('plugin bug');
  }, 60_000);

  it('refuses code that does not match its registered checksum', async () => {
    const s = spec(`export function prepare() { return {}; }`, { id: 'tampered' });
    s.plugin.source += '\n// changed';
    expect((await run(s)).error).toMatch(/checksum/);
  });
});
