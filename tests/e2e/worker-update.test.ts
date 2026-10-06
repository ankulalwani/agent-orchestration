/**
 * Worker self-update (WORKER-012, D-017) with real processes: the launcher supervising fake versions
 * (update, crash-before-confirm rollback, hang rollback, restart with backoff), and installation of a
 * real signed .tgz package.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as tar from 'tar';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readInstallState, writeInstallState, type InstallState } from '../../apps/worker/src/install-state.js';
import { confirmInstalledVersion, installStagedUpdate, canonicalManifest, Updater, type ReleaseManifest } from '../../apps/worker/src/updater.js';

const LAUNCHER = path.resolve('apps/worker/src/launcher.ts');

/**
 * A fake worker version. Behaviours (one per start, in order; the last repeats):
 * - `update:<v>`: install version v (pending), exit 75 — what a real worker does after applyAvailable();
 * - `confirm`: confirm itself, then exit 0;
 * - `crash`: exit 1 immediately; `hang`: never confirm, never exit; `ok`: exit 0.
 */
function fakeVersion(installDir: string, version: string, behaviours: string[]) {
  const dir = path.join(installDir, 'app', version, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'app', version, 'VERSION'), version);
  fs.writeFileSync(
    path.join(dir, 'main.js'),
    `const fs = require('fs'), path = require('path');
const inst = process.env.AO_INSTALL_DIR, v = process.env.AO_WORKER_VERSION;
const log = path.join(inst, 'runs.log');
const n = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith(v + ' ')).length : 0;
const b = ${JSON.stringify(behaviours)}; const what = b[Math.min(n, b.length - 1)];
fs.appendFileSync(log, v + ' ' + what + '\\n');
const state = () => JSON.parse(fs.readFileSync(path.join(inst, 'state.json'), 'utf8'));
const save = (s) => fs.writeFileSync(path.join(inst, 'state.json'), JSON.stringify(s));
if (what.startsWith('update:')) { const to = what.slice(7), s = state(); save({ ...s, previous: s.current, current: to, pending: { version: to, from: s.current, since: new Date().toISOString() } }); process.exit(75); }
if (what === 'confirm') { const s = state(); if (s.pending && s.pending.version === v) save({ ...s, pending: null }); process.exit(0); }
if (what === 'crash') process.exit(1);
if (what === 'hang') setInterval(() => {}, 1000);
if (what === 'ok') process.exit(0);
`.replace(/^\s+/gm, ''),
  );
}

function install(state: Partial<InstallState> & { current: string }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-upd-inst-'));
  writeInstallState(dir, { version: 1, previous: null, pending: null, bad: [], ...state });
  return dir;
}

function runLauncher(installDir: string, env: Record<string, string> = {}, timeoutMs = 60_000) {
  return new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', LAUNCHER], { env: { ...process.env, AO_INSTALL_DIR: installDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => (p.kill(), reject(new Error(`launcher did not exit:\n${out}`))), timeoutMs);
    p.on('exit', (code) => (clearTimeout(t), resolve({ code, out })));
  });
}
const runs = (dir: string) => fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n');

describe('launcher (real processes)', () => {
  it('switches to the updated version, which confirms itself', async () => {
    const dir = install({ current: '1.0.0' });
    fakeVersion(dir, '1.0.0', ['update:2.0.0']);
    fakeVersion(dir, '2.0.0', ['confirm']);
    const r = await runLauncher(dir);
    expect(r.code).toBe(0);
    expect(runs(dir)).toEqual(['1.0.0 update:2.0.0', '2.0.0 confirm']);
    expect(readInstallState(dir)).toMatchObject({ current: '2.0.0', previous: '1.0.0', pending: null, bad: [] });
  });

  it('rolls back when the new version crashes before confirming, and marks it bad', async () => {
    const dir = install({ current: '1.0.0' });
    fakeVersion(dir, '1.0.0', ['update:2.0.0', 'ok']);
    fakeVersion(dir, '2.0.0', ['crash']);
    const r = await runLauncher(dir);
    expect(r.code).toBe(0);
    expect(runs(dir)).toEqual(['1.0.0 update:2.0.0', '2.0.0 crash', '1.0.0 ok']);
    expect(readInstallState(dir)).toMatchObject({ current: '1.0.0', pending: null, bad: ['2.0.0'] });
    expect(r.out).toMatch(/rolling back to 1\.0\.0/);
  });

  it('rolls back a new version that hangs without confirming', async () => {
    const dir = install({ current: '1.0.0' });
    fakeVersion(dir, '1.0.0', ['update:2.0.0', 'ok']);
    fakeVersion(dir, '2.0.0', ['hang']);
    const r = await runLauncher(dir, { AO_UPDATE_CONFIRM_TIMEOUT_MS: '2000' });
    expect(runs(dir)).toEqual(['1.0.0 update:2.0.0', '2.0.0 hang', '1.0.0 ok']);
    expect(readInstallState(dir)).toMatchObject({ current: '1.0.0', bad: ['2.0.0'] });
    expect(r.out).toMatch(/did not confirm/);
  });

  it('restarts a crashed (already confirmed) version with a delay instead of rolling back', async () => {
    const dir = install({ current: '1.0.0' });
    fakeVersion(dir, '1.0.0', ['crash', 'ok']);
    const t0 = Date.now();
    const r = await runLauncher(dir);
    expect(r.code).toBe(0);
    expect(runs(dir)).toEqual(['1.0.0 crash', '1.0.0 ok']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900); // backoff
    expect(readInstallState(dir)).toMatchObject({ current: '1.0.0', bad: [] });
  });
});

describe('installing a signed package', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const trusted = { k1: publicKey.export({ type: 'spki', format: 'pem' }).toString() };

  function makePackage(version: string, packagedVersion = version) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-upd-pkg-'));
    fs.mkdirSync(path.join(src, 'worker', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(src, 'worker', 'dist', 'main.js'), 'console.log("new worker")');
    fs.writeFileSync(path.join(src, 'worker', 'VERSION'), `${packagedVersion}\n`);
    const tgz = path.join(src, `worker-${version}.tgz`);
    tar.c({ gzip: true, file: tgz, cwd: src, sync: true }, ['worker']);
    const data = fs.readFileSync(tgz);
    const manifest: ReleaseManifest = { version, channel: 'stable', publishedAt: new Date().toISOString(), packageUrl: `https://updates.example/worker-${version}.tgz`, sha256: createHash('sha256').update(data).digest('hex'), minNodeVersion: '20.0.0', notes: '' };
    const signed = { manifest, keyId: 'k1', signature: sign(null, canonicalManifest(manifest), privateKey).toString('base64') };
    return { data, manifest, signed };
  }
  const serving = (p: ReturnType<typeof makePackage>) => (async (url: string | URL | Request) => new Response(String(url).endsWith('.json') ? JSON.stringify(p.signed) : new Uint8Array(p.data))) as typeof fetch;

  it('downloads, verifies, unpacks as a new version (pending) and cleans up old versions on confirmation', async () => {
    const dir = install({ current: '1.0.0', previous: '0.9.0' });
    for (const v of ['0.8.0', '0.9.0', '1.0.0']) fakeVersion(dir, v, ['ok']);
    const pkg = makePackage('1.1.0');
    const u = new Updater({ currentVersion: '1.0.0', manifestUrl: 'https://updates.example/stable.json', trustedKeys: trusted, stagingDir: path.join(dir, 'staging'), fetchImpl: serving(pkg) });
    const check = await u.check();
    expect(check.updateAvailable).toBe(true);
    installStagedUpdate(dir, await u.stage(check.latest!), check.latest!);

    expect(readInstallState(dir)).toMatchObject({ current: '1.1.0', previous: '1.0.0', pending: { version: '1.1.0', from: '1.0.0' } });
    expect(fs.readFileSync(path.join(dir, 'app', '1.1.0', 'dist', 'main.js'), 'utf8')).toContain('new worker');
    expect(fs.readdirSync(path.join(dir, 'app')).filter((d) => d.includes('partial'))).toEqual([]);

    expect(confirmInstalledVersion(dir, '1.1.0')).toBe(true);
    expect(readInstallState(dir).pending).toBeNull();
    expect(fs.readdirSync(path.join(dir, 'app')).sort()).toEqual(['1.0.0', '1.1.0']); // current + previous kept
  });

  it('a package with ../ paths cannot write outside the install directory', () => {
    const dir = install({ current: '1.0.0' });
    fakeVersion(dir, '1.0.0', ['ok']);
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-upd-evil-'));
    fs.mkdirSync(path.join(src, 'pkg', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(src, 'pkg', 'dist', 'main.js'), '');
    fs.writeFileSync(path.join(src, 'pkg', 'VERSION'), '2.0.0');
    fs.writeFileSync(path.join(src, 'escaped.txt'), 'pwned');
    const evil = path.join(src, 'evil.tgz');
    // Entries: pkg/… plus pkg/../../../escaped.txt (preservePaths keeps the traversal in the archive).
    tar.c({ gzip: true, file: evil, cwd: path.join(src, 'pkg'), sync: true, preservePaths: true }, ['dist', 'VERSION', '../escaped.txt']);
    const target = path.join(path.dirname(dir), 'escaped.txt');
    fs.rmSync(target, { force: true });
    expect(() => installStagedUpdate(dir, evil, { version: '2.0.0', channel: 'stable', publishedAt: '', packageUrl: 'https://x/y.tgz', sha256: 'a'.repeat(64), minNodeVersion: '20.0.0', notes: '' })).toThrow();
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'app', 'escaped.txt'))).toBe(false);
    expect(readInstallState(dir).current).toBe('1.0.0');
  });

  it('refuses older, rolled-back and mislabelled packages', async () => {
    const dir = install({ current: '1.0.0', bad: ['1.2.0'] });
    fakeVersion(dir, '1.0.0', ['ok']);
    const stage = async (p: ReturnType<typeof makePackage>) => {
      const u = new Updater({ currentVersion: '0.0.1', manifestUrl: 'https://updates.example/stable.json', trustedKeys: trusted, stagingDir: path.join(dir, 'staging'), fetchImpl: serving(p) });
      return u.stage(p.manifest);
    };
    const older = makePackage('0.9.0');
    expect(() => installStagedUpdate(dir, 'unused', older.manifest)).toThrow(/not newer/);
    const bad = makePackage('1.2.0');
    expect(() => installStagedUpdate(dir, 'unused', bad.manifest)).toThrow(/rolled back/);
    const liar = makePackage('1.3.0', '6.6.6'); // signed manifest says 1.3.0, package says otherwise
    await expect(stage(liar).then((f) => installStagedUpdate(dir, f, liar.manifest))).rejects.toThrow(/contains version 6\.6\.6/);
    expect(readInstallState(dir)).toMatchObject({ current: '1.0.0', pending: null });
    expect(fs.existsSync(path.join(dir, 'app', '1.3.0'))).toBe(false);
  });
});

describe('launcher started by the desktop app', () => {
  it('stops its worker and exits when the app is gone', async () => {
    const dir = install({ current: '1.0.0' });
    fakeVersion(dir, '1.0.0', ['hang']);
    // The process id of a process that has ended stands in for a desktop app that crashed.
    const gone = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => gone.on('exit', resolve));
    const r = await runLauncher(dir, { AO_SUPERVISOR_PID: String(gone.pid) }, 30_000);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/the desktop app is gone/);
    expect(runs(dir)).toEqual(['1.0.0 hang']); // not restarted
  }, 40_000);
});
