/**
 * One-click worker install: the control plane serves the install scripts and a bootstrap. The bootstrap is
 * run for real against a live server with a release package built the way scripts/package-worker.mjs does,
 * with a stand-in installer that records how it was called.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, sign } from 'node:crypto';
import * as tar from 'tar';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { canonicalManifest, type ReleaseManifest } from '../../apps/worker/src/updater.js';
import { makeServices } from '../helpers.js';

const run = promisify(execFile);
const publisher = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const publicPem = publisher.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const WIN = process.platform === 'win32';

let s: Services;
let app: FastifyInstance;
let base: string;
let admin: string;
let tmp: string;
let bootstrap: string;

const signWith = (key: typeof publisher, manifest: ReleaseManifest, keyId = 'release-2026') => ({ manifest, signature: sign(null, canonicalManifest(manifest), key.privateKey).toString('base64'), keyId });
const adminFetch = (url: string, init: RequestInit) => fetch(`${base}${API_PREFIX}${url}`, { ...init, headers: { authorization: `Bearer ${admin}`, ...(init.headers as Record<string, string> | undefined) } });

/** A worker package laid out like scripts/package-worker.mjs --tarball: one top-level `worker` folder. */
async function buildPackage(version: string, withInstaller = true) {
  const root = path.join(tmp, `pkg-${version}-${withInstaller}`);
  const worker = path.join(root, 'worker');
  fs.mkdirSync(path.join(worker, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(worker, 'dist', 'main.js'), '// worker');
  fs.writeFileSync(path.join(worker, 'VERSION'), version + '\n');
  // A path over 100 characters forces a tar extended header.
  const deep = path.join(worker, 'node_modules', 'a'.repeat(60), 'b'.repeat(60), 'index.js');
  fs.mkdirSync(path.dirname(deep), { recursive: true });
  fs.writeFileSync(deep, 'module.exports = 1');
  if (withInstaller) {
    const dir = path.join(worker, 'installers', WIN ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
    fs.mkdirSync(dir, { recursive: true });
    if (WIN) fs.writeFileSync(path.join(dir, 'install-worker.ps1'), 'Set-Content -Path $env:AO_TEST_ARGS -Value ($args -join "|"); if ($env:AO_TEST_FAIL) { exit 3 }\r\n');
    else fs.writeFileSync(path.join(dir, 'install-worker.sh'), '#!/usr/bin/env bash\necho "$*" > "$AO_TEST_ARGS"\n[ -z "${AO_TEST_FAIL:-}" ] || exit 3\n', { mode: 0o755 });
  }
  const file = path.join(root, 'worker.tgz');
  tar.c({ gzip: true, file, cwd: root, portable: true, sync: true }, ['worker']);
  return fs.readFileSync(file);
}

async function publishRelease(channel: string, version: string, pkg: Buffer, key: typeof publisher) {
  const up = await adminFetch(`/admin/worker-releases/${channel}/${version}/package`, { method: 'PUT', headers: { 'content-type': 'application/gzip' }, body: pkg });
  expect(up.status).toBe(200);
  const u = (await up.json()) as { sha256: string; packageUrl: string };
  const manifest: ReleaseManifest = { version, channel: channel as 'stable' | 'beta', publishedAt: new Date().toISOString(), packageUrl: u.packageUrl, sha256: u.sha256, minNodeVersion: '20.0.0', notes: '' };
  const res = await adminFetch(`/admin/worker-releases/${channel}/manifest`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signWith(key, manifest)) });
  expect(res.status).toBe(200);
}

async function runBootstrap(args: string[], env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const argsFile = path.join(home, 'installer-args.txt');
  try {
    const r = await run(process.execPath, [bootstrap, '--server', base, ...args], { env: { ...process.env, AO_WORKER_HOME: path.join(home, 'data'), AO_TEST_ARGS: argsFile, ...env }, timeout: 120_000 });
    return { code: 0, output: r.stdout + r.stderr, home, argsFile };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}`, home, argsFile };
  }
}

beforeAll(async () => {
  await startTestDatabase();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-install-'));
  s = (await makeServices({ ARTIFACT_DIR: path.join(tmp, 'artifacts'), WORKER_RELEASE_TRUSTED_KEYS: JSON.stringify({ 'release-2026': publicPem }) })).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  (s.config as { PUBLIC_URL: string }).PUBLIC_URL = base;
  admin = (await s.auth.register({ email: `admin-${Date.now()}@example.com`, password: 'admin-password-123', name: 'Admin' })).accessToken;
  bootstrap = path.join(tmp, 'bootstrap.mjs');
  fs.writeFileSync(bootstrap, await (await fetch(`${base}${API_PREFIX}/install/bootstrap.mjs`)).text());
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('one-click worker install', () => {
  it('serves scripts for this server, public, with the server URL filled in', async () => {
    const sh = await fetch(`${base}${API_PREFIX}/install/worker.sh`);
    expect(sh.status).toBe(200);
    const shText = await sh.text();
    expect(shText).toContain(`SERVER='${base}'`);
    expect(shText).not.toContain('__AO_SERVER__');
    expect(shText).toContain('</dev/null');
    const ps = await (await fetch(`${base}${API_PREFIX}/install/worker.ps1`)).text();
    expect(ps).toContain(`$Server = '${base}'`);
    expect(ps).not.toContain('__AO_SERVER__');
    const cmds = (await (await fetch(`${base}${API_PREFIX}/install/commands`)).json()) as Record<string, string>;
    expect(cmds.windows).toBe(`irm ${base}/api/v1/install/worker.ps1 | iex`);
    expect(cmds.linux).toBe(`curl -fsSL ${base}/api/v1/install/worker.sh | sh`);
  });

  it('refuses a PUBLIC_URL that could break out of the script quoting', async () => {
    const original = s.config.PUBLIC_URL;
    (s.config as { PUBLIC_URL: string }).PUBLIC_URL = "http://x.example/'; rm -rf ~ #";
    try {
      expect((await fetch(`${base}${API_PREFIX}/install/worker.sh`)).status).toBe(500);
    } finally {
      (s.config as { PUBLIC_URL: string }).PUBLIC_URL = original;
    }
  });

  it('config lists the trusted keys and the latest release', async () => {
    const cfg = (await (await fetch(`${base}${API_PREFIX}/install/config`)).json()) as { latest: string | null; trustedKeys: Record<string, string> };
    expect(cfg.latest).toBeNull();
    expect(Object.keys(cfg.trustedKeys).sort()).toEqual(['ao-release-1', 'release-2026']); // the project key is always listed
  });

  it('says what is missing when nothing is published', async () => {
    const r = await runBootstrap([]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/no worker release on the stable channel/);
  });

  it('downloads, verifies, unpacks, trusts the keys and runs the installer with the pairing server', async () => {
    await publishRelease('stable', '0.2.0', await buildPackage('0.2.0'), publisher);
    const r = await runBootstrap([]);
    expect(r.output).toContain('worker 0.2.0, signed by release-2026');
    expect(r.code, r.output).toBe(0);
    const called = fs.readFileSync(r.argsFile, 'utf8');
    expect(called).toContain(WIN ? '-PairServer' : '--pair-server');
    expect(called).toContain(base);
    expect(called).toMatch(WIN ? /-SourceDir/ : /--source/);
    const config = JSON.parse(fs.readFileSync(path.join(r.home, 'data', 'config.json'), 'utf8'));
    expect(config.updates.trustedKeys['release-2026']).toBe(publicPem);
    expect(config.version).toBe(1);
  });

  it('--no-pair leaves pairing out and a failing installer fails the bootstrap', async () => {
    const r = await runBootstrap(['--no-pair'], { AO_TEST_FAIL: '1' });
    expect(r.code).toBe(3);
    expect(fs.readFileSync(r.argsFile, 'utf8')).not.toMatch(/pair-server|PairServer/i);
  });

  it('keys already trusted by the worker are kept', async () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-keep-'));
    fs.mkdirSync(path.join(home, 'data'));
    fs.writeFileSync(path.join(home, 'data', 'config.json'), JSON.stringify({ version: 1, name: 'mine', updates: { trustedKeys: { other: 'PEM' } } }));
    const r = await run(process.execPath, [bootstrap, '--server', base], { env: { ...process.env, AO_WORKER_HOME: path.join(home, 'data'), AO_TEST_ARGS: path.join(home, 'a.txt') } });
    expect(r.stdout).toContain('Installing');
    const config = JSON.parse(fs.readFileSync(path.join(home, 'data', 'config.json'), 'utf8'));
    expect(config.name).toBe('mine');
    expect(Object.keys(config.updates.trustedKeys).sort()).toEqual(['ao-release-1', 'other', 'release-2026']);
  });

  it('a release signed with another key is refused and nothing is installed', async () => {
    await publishRelease('beta', '0.3.0', await buildPackage('0.3.0'), attacker); // the server cannot tell; the installer can
    const r = await runBootstrap(['--channel', 'beta']);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/signature is invalid/);
    expect(fs.existsSync(r.argsFile)).toBe(false);
    expect(fs.existsSync(path.join(r.home, 'data', 'config.json'))).toBe(false);
  });

  it('a package without an installer inside is explained', async () => {
    await publishRelease('stable', '0.2.1', await buildPackage('0.2.1', false), publisher);
    const r = await runBootstrap([]);
    expect(r.code).toBe(1);
    expect(r.output).toMatch(/no installer inside/);
  });

  it('refuses a release signed with a key the server does not list (only the project key remains)', async () => {
    const keys = s.config.WORKER_RELEASE_TRUSTED_KEYS;
    (s.config as { WORKER_RELEASE_TRUSTED_KEYS: Record<string, string> }).WORKER_RELEASE_TRUSTED_KEYS = {};
    try {
      const r = await runBootstrap([]);
      expect(r.code).toBe(1);
      expect(r.output).toMatch(/does not list as trusted/);
    } finally {
      (s.config as { WORKER_RELEASE_TRUSTED_KEYS: Record<string, string> }).WORKER_RELEASE_TRUSTED_KEYS = keys;
    }
  });
});
