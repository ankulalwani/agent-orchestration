import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { PLUGIN_HOOKS, createLogger, pluginHookResultSchemas, type PluginHook } from '@ao/core';

const log = createLogger('plugins');

/** A plugin capability as delivered with a task claim. */
export interface PluginSpec {
  id: string;
  version: string;
  name: string;
  permissions: string[];
  plugin: { hooks: string[]; source?: string; sha256?: string; timeoutMs?: number; memoryMb?: number };
  /** Configuration values; secret references are resolved only for plugins with `secrets.read`. */
  config: Record<string, unknown>;
}

export interface HookOutcome {
  pluginId: string;
  version: string;
  hook: PluginHook;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  logs: string[];
  sha256: string;
}

const MAX_LOG_LINES = 200;
const MAX_LOG_LINE = 2000;

/**
 * Node.js versions with a stable permission model (`--permission`, repeatable `--allow-fs-*`).
 * Older versions refuse to run plugins rather than run them unrestricted.
 */
export function pluginRuntimeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split('.').map(Number) as [number, number];
  return major > 22 || (major === 22 && minor >= 13);
}

/**
 * Runs plugin hooks (CAP-012) in a separate Node.js process under the permission model:
 * - file system: the plugin's own folder (read) and data folder (read/write); the project only with
 *   `filesystem.project.read|write`; everything only with `filesystem.read|write`;
 * - child processes and worker threads: only with `process.execute` or `shell` (child processes then
 *   run without restrictions: that permission is effectively full access);
 * - network: blocked in-process (sockets, HTTP, fetch, WebSocket, DNS, UDP, listening) unless the
 *   plugin has `network.outbound`;
 * - native addons, WASI, `process.binding` and the inspector are unavailable;
 * - an empty environment (no worker credentials), a memory cap and a time limit per hook.
 */
export class PluginRunner {
  private readonly bootstrap: string;

  constructor(
    private readonly root: string,
    private readonly nodePath = process.execPath,
  ) {
    fs.mkdirSync(root, { recursive: true });
    this.bootstrap = path.join(root, 'bootstrap.mjs');
    fs.writeFileSync(this.bootstrap, BOOTSTRAP);
  }

  implements(spec: PluginSpec, hook: PluginHook) {
    return Boolean(spec.plugin.source) && spec.plugin.hooks.includes(hook);
  }

  async run(spec: PluginSpec, hook: PluginHook, context: Record<string, unknown>, opts: { projectDir: string }): Promise<HookOutcome> {
    const started = Date.now();
    const source = spec.plugin.source ?? '';
    const sha256 = createHash('sha256').update(source).digest('hex');
    const outcome = (x: Partial<HookOutcome>): HookOutcome => ({ pluginId: spec.id, version: spec.version, hook, ok: false, durationMs: Date.now() - started, logs: [], sha256, ...x });
    if (!pluginRuntimeSupported()) return outcome({ error: `Plugins need Node.js 22.13 or later on the worker (this worker runs ${process.versions.node})` });
    if (!source) return outcome({ error: 'The plugin has no code' });
    if (spec.plugin.sha256 && spec.plugin.sha256 !== sha256) return outcome({ error: 'Plugin code does not match its registered checksum; not run' });

    // Code is written once per version and checksum; plugins can't modify their own code.
    const dir = path.join(this.root, safe(spec.id), `${safe(spec.version)}-${sha256.slice(0, 12)}`);
    const entry = path.join(dir, 'plugin.mjs');
    const data = path.join(this.root, safe(spec.id), 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    if (!fs.existsSync(entry) || createHash('sha256').update(fs.readFileSync(entry)).digest('hex') !== sha256) fs.writeFileSync(entry, source);

    const perms = new Set(spec.permissions);
    const has = (...p: string[]) => p.some((x) => perms.has(x));
    const all = (p: string) => [p, path.join(p, '*')];
    const read = [this.bootstrap, ...all(dir), ...all(data)];
    const write = [...all(data)];
    if (has('filesystem.read', 'filesystem.write')) read.push('*');
    else if (has('filesystem.project.read', 'filesystem.project.write')) read.push(...all(opts.projectDir));
    if (has('filesystem.write')) write.push('*');
    else if (has('filesystem.project.write')) write.push(...all(opts.projectDir));
    const execArgv = [
      '--permission',
      ...read.map((p) => `--allow-fs-read=${p}`),
      ...write.map((p) => `--allow-fs-write=${p}`),
      ...(has('process.execute', 'shell') ? ['--allow-child-process', '--allow-worker'] : []),
      `--max-old-space-size=${spec.plugin.memoryMb ?? 256}`,
    ];
    // No inherited environment: the worker's own variables can hold credentials.
    const env: NodeJS.ProcessEnv = has('process.execute', 'shell') ? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } : {};

    const logs: string[] = [];
    const addLog = (text: string) => {
      for (const line of text.split(/\r?\n/)) {
        if (line && logs.length < MAX_LOG_LINES) logs.push(line.slice(0, MAX_LOG_LINE));
      }
    };
    const timeoutMs = spec.plugin.timeoutMs ?? 30_000;
    return await new Promise<HookOutcome>((resolve) => {
      let settled = false;
      let message: { type: 'result'; result: unknown } | { type: 'error'; error: string } | null = null;
      const child = fork(this.bootstrap, [], { execPath: this.nodePath, execArgv, env, cwd: data, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'json' });
      const done = (x: Partial<HookOutcome>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (child.exitCode === null) child.kill('SIGKILL');
        resolve(outcome({ ...x, logs }));
      };
      const timer = setTimeout(() => done({ error: `Timed out after ${timeoutMs} ms` }), timeoutMs);
      child.stdout!.on('data', (d: Buffer) => addLog(d.toString('utf8')));
      child.stderr!.on('data', (d: Buffer) => addLog(d.toString('utf8')));
      child.on('message', (m: { type: string; text?: string; result?: unknown; error?: string }) => {
        if (m.type === 'log' && typeof m.text === 'string') addLog(m.text);
        else if (m.type === 'result' || m.type === 'error') message = m as typeof message;
      });
      child.on('error', (e) => done({ error: `Could not start the plugin process: ${e.message}` }));
      child.on('exit', (code, signal) => {
        if (message?.type === 'result') {
          const parsed = pluginHookResultSchemas[hook].safeParse(message.result ?? {});
          if (!parsed.success) return done({ error: `Invalid result from ${hook}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(result)'} ${i.message}`).join('; ')}` });
          return done({ ok: true, result: parsed.data });
        }
        if (message?.type === 'error') return done({ error: message.error.slice(0, 4000) });
        const oom = logs.some((l) => /heap out of memory|Allocation failed/i.test(l));
        done({ error: oom ? `Ran out of memory (limit ${spec.plugin.memoryMb ?? 256} MB)` : `Plugin process exited (${signal ?? `code ${code}`}) without a result` });
      });
      child.send({ entry, hook, context: { ...context, config: spec.config }, allowNetwork: has('network.outbound') }, (e) => {
        if (e) done({ error: `Could not send the task to the plugin: ${e.message}` });
      });
    }).then((o) => {
      if (!o.ok) log.warn({ plugin: spec.id, hook, err: o.error }, 'plugin hook failed');
      return o;
    });
  }
}

export function isPluginHook(h: string): h is PluginHook {
  return (PLUGIN_HOOKS as readonly string[]).includes(h);
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_');

/**
 * Runs inside the plugin process, before any plugin code: removes network access unless permitted,
 * loads the plugin and calls the hook. Plain JavaScript, written next to the plugins at startup.
 */
const BOOTSTRAP = String.raw`
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { format } from 'node:util';
import { pathToFileURL } from 'node:url';

function blockNetwork() {
  const deny = (what) => () => {
    const e = new Error('Network access is not permitted for this plugin (' + what + '). Declare the "network.outbound" permission.');
    e.code = 'ERR_ACCESS_DENIED';
    throw e;
  };
  const lock = (obj, key, what) => Object.defineProperty(obj, key, { value: deny(what), writable: false, configurable: false });
  lock(net.Socket.prototype, 'connect', 'socket');
  lock(net.Server.prototype, 'listen', 'listen');
  for (const k of ['connect', 'createConnection']) lock(net, k, 'net.' + k);
  lock(tls, 'connect', 'tls.connect');
  lock(dgram, 'createSocket', 'udp');
  for (const m of [http, https]) for (const k of ['request', 'get']) lock(m, k, 'http');
  lock(http2, 'connect', 'http2');
  for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'reverse']) {
    lock(dns, k, 'dns');
    lock(dns.promises, k, 'dns');
  }
  lock(dns, 'Resolver', 'dns');
  lock(dns.promises, 'Resolver', 'dns');
  lock(globalThis, 'fetch', 'fetch');
  lock(globalThis, 'WebSocket', 'WebSocket');
  lock(globalThis, 'EventSource', 'EventSource');
}

const send = (m) => new Promise((r) => process.send(m, () => r()));
process.once('message', async (msg) => {
  try {
    if (!msg.allowNetwork) blockNetwork();
    const mod = await import(pathToFileURL(msg.entry).href);
    const name = msg.hook.split('.').pop();
    const fn = mod[name] ?? mod.default?.[name] ?? mod.default?.[msg.hook];
    if (typeof fn !== 'function') throw new Error('The plugin does not export a "' + name + '" function for ' + msg.hook);
    const ctx = { ...msg.context, log: (...a) => void process.send({ type: 'log', text: format(...a) }) };
    const result = await fn(ctx);
    await send({ type: 'result', result: result === undefined ? null : JSON.parse(JSON.stringify(result)) });
    process.exit(0);
  } catch (e) {
    await send({ type: 'error', error: String((e && e.stack) || e) });
    process.exit(1);
  }
});
`;
