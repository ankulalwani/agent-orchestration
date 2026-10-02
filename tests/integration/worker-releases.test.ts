/**
 * Worker releases hosted by the control plane (WORKER-012): a platform administrator uploads a package
 * and a manifest signed offline; workers fetch both from the control plane and verify them against
 * keys they trust locally. The control plane can't make a worker accept a release it signed itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { Updater, canonicalManifest, type ReleaseManifest } from '../../apps/worker/src/updater.js';
import { WorkerRuntime } from '../../apps/worker/src/runtime.js';
import { makeServices } from '../helpers.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';
let s: Services;
let app: FastifyInstance;
let base: string;
let admin: string;
let member: string;
const publisher = generateKeyPairSync('ed25519');
const attacker = generateKeyPairSync('ed25519');
const trusted = { 'release-2026': publisher.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const pkg = gzipSync(Buffer.from('pretend tarball of worker 0.2.0'));

beforeAll(async () => {
  await startTestDatabase();
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-releases-'));
  s = (await makeServices({ ARTIFACT_DIR: artifactDir })).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  (s.config as { PUBLIC_URL: string }).PUBLIC_URL = base;
  admin = (await s.auth.register({ email: `admin-${Date.now()}@example.com`, password: 'admin-password-123', name: 'Admin' })).accessToken;
  member = (await s.auth.register({ email: `m-${Date.now()}@example.com`, password: 'member-password-123', name: 'M' })).accessToken;
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

const signWith = (key: typeof publisher, manifest: ReleaseManifest, keyId = 'release-2026') => ({ manifest, signature: sign(null, canonicalManifest(manifest), key.privateKey).toString('base64'), keyId });
const uploadPackage = (token: string, body: Buffer, channel = 'stable', version = '0.2.0') =>
  fetch(`${base}${API_PREFIX}/admin/worker-releases/${channel}/${version}/package`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' }, body });
const publish = (token: string, channel: string, doc: unknown) =>
  fetch(`${base}${API_PREFIX}/admin/worker-releases/${channel}/manifest`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(doc) });

describe('worker releases hosted by the control plane', () => {
  it('only platform administrators upload and publish; packages must be gzip', async () => {
    expect((await uploadPackage(member, pkg)).status).toBe(403);
    expect((await uploadPackage('aot_x', pkg)).status).toBe(401);
    expect((await uploadPackage(admin, Buffer.from('not gzip'))).status).toBe(400);
    expect((await uploadPackage(admin, pkg, 'nightly')).status).toBe(400);
  });

  it('publish: the manifest must match the uploaded package and this server’s URL; then workers can fetch it', async () => {
    const up = await uploadPackage(admin, pkg);
    expect(up.status).toBe(200);
    const u = (await up.json()) as { sha256: string; packageUrl: string; sign: string };
    expect(u.packageUrl).toBe(`${base}/api/v1/worker-releases/stable/0.2.0/package.tgz`);
    expect(u.sign).toContain(u.packageUrl);
    // Not downloadable before it is published.
    expect((await fetch(u.packageUrl)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/worker-releases/stable/manifest.json`)).status).toBe(404);

    const manifest: ReleaseManifest = { version: '0.2.0', channel: 'stable', publishedAt: new Date().toISOString(), packageUrl: u.packageUrl, sha256: u.sha256, minNodeVersion: '20.0.0', notes: 'Faster startup' };
    expect((await publish(admin, 'stable', signWith(publisher, { ...manifest, sha256: '0'.repeat(64) }))).status).toBe(400);
    expect((await publish(admin, 'stable', signWith(publisher, { ...manifest, packageUrl: 'https://elsewhere.example/p.tgz' }))).status).toBe(400);
    expect((await publish(admin, 'beta', signWith(publisher, manifest))).status).toBe(400);
    expect((await publish(member, 'stable', signWith(publisher, manifest))).status).toBe(403);
    const ok = await publish(admin, 'stable', signWith(publisher, manifest));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(((await ok.json()) as Array<{ channel: string; latest: string }>).find((c) => c.channel === 'stable')!.latest).toBe('0.2.0');

    // A worker that trusts the publisher's key finds, downloads and verifies the release.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stage-'));
    const updater = new Updater({ currentVersion: '0.1.0', manifestUrl: `${base}/api/v1/worker-releases/stable/manifest.json`, trustedKeys: trusted, stagingDir });
    const check = await updater.check();
    expect(check).toMatchObject({ updateAvailable: true, latest: { version: '0.2.0', notes: 'Faster startup' } });
    const file = await updater.stage(check.latest!);
    expect(fs.readFileSync(file)).toEqual(pkg);
  });

  it('a release signed with a key the worker does not trust is refused, even from its own control plane', async () => {
    const up = await (await uploadPackage(admin, gzipSync(Buffer.from('evil')), 'stable', '9.9.9')).json() as { sha256: string; packageUrl: string };
    const manifest: ReleaseManifest = { version: '9.9.9', channel: 'stable', publishedAt: new Date().toISOString(), packageUrl: up.packageUrl, sha256: up.sha256, minNodeVersion: '20.0.0', notes: '' };
    expect((await publish(admin, 'stable', signWith(attacker, manifest))).status).toBe(200); // the server can't tell
    const updater = new Updater({ currentVersion: '0.1.0', manifestUrl: `${base}/api/v1/worker-releases/stable/manifest.json`, trustedKeys: trusted, stagingDir: os.tmpdir() });
    await expect(updater.check()).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Update manifest signature is invalid' });
  });

  it('server-held keys: generate in admin, sign and publish in one call, workers verify with the public key', async () => {
    const api = (token: string, method: string, p: string, body?: unknown) =>
      fetch(`${base}${API_PREFIX}${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await api(member, 'POST', '/admin/worker-release-keys', {})).status).toBe(403);
    expect((await api(admin, 'POST', '/admin/worker-releases/stable/99.0.0/sign', {})).status).toBe(400); // no key yet
    const gen = (await (await api(admin, 'POST', '/admin/worker-release-keys', { keyId: 'server-key' })).json()) as Array<{ keyId: string; publicKey: string; active: boolean }>;
    expect(gen).toEqual([expect.objectContaining({ keyId: 'server-key', active: true })]);
    expect(JSON.stringify(gen)).not.toContain('PRIVATE');
    expect((await api(admin, 'DELETE', '/admin/worker-release-keys/server-key')).status).toBe(409); // active

    expect((await uploadPackage(admin, pkg, 'stable', '99.0.0')).status).toBe(200);
    const done = await api(admin, 'POST', '/admin/worker-releases/stable/99.0.0/sign', { notes: 'Signed here' });
    expect(done.status, await done.clone().text()).toBe(200);
    const updater = new Updater({ currentVersion: '0.1.0', manifestUrl: `${base}/api/v1/worker-releases/stable/manifest.json`, trustedKeys: { 'server-key': gen[0]!.publicKey }, stagingDir: os.tmpdir() });
    expect(await updater.check()).toMatchObject({ updateAvailable: true, latest: { version: '99.0.0', notes: 'Signed here' } });
    const settings = (await (await fetch(`${base}${API_PREFIX}/install/config`)).json()) as { trustedKeys: Record<string, string> };
    expect(settings.trustedKeys['server-key']).toBe(gen[0]!.publicKey);
  });

  it('CI: the publish token uploads, signs and publishes in one call; wrong or unset tokens are refused', async () => {
    const token = 'ci-token-'.padEnd(40, 'x');
    const put = (bearer: string, version: string) =>
      fetch(`${base}${API_PREFIX}/admin/worker-releases/stable/${version}/package?sign=true`, { method: 'PUT', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/gzip' }, body: pkg });
    expect((await put(token, '100.0.0')).status).toBe(401); // token not configured yet
    (s.config as { RELEASE_PUBLISH_TOKEN?: string }).RELEASE_PUBLISH_TOKEN = token;
    expect((await put('wrong-'.padEnd(40, 'x'), '100.0.0')).status).toBe(401);
    const ok = await put(token, '100.0.0');
    expect(ok.status, await ok.clone().text()).toBe(200);
    const manifest = (await (await fetch(`${base}/api/v1/worker-releases/stable/manifest.json`)).json()) as { manifest: { version: string } };
    expect(manifest.manifest.version).toBe('100.0.0');
    (s.config as { RELEASE_PUBLISH_TOKEN?: string }).RELEASE_PUBLISH_TOKEN = undefined;
  });

  it('a paired worker uses its control plane as the release source by default; trust stays local', async () => {
    const rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rel-worker-')));
    rt.config.update({ connectionMode: 'self-hosted', controlPlaneUrl: base, updates: { ...rt.config.get().updates, channel: 'beta' } });
    await rt.init();
    try {
      expect(rt.updates.manifestUrl()).toBe(`${base}/api/v1/worker-releases/beta/manifest.json`);
      expect(Object.keys(rt.updates.trustedKeys())).toContain('ao-release-1'); // the project key is trusted by default
      expect(rt.updates.unsupportedReason()).toMatch(/not started by the installed launcher/);
      rt.config.update((c) => ({ ...c, updates: { ...c.updates, manifestUrl: 'https://releases.example/m.json' } }));
      expect(rt.updates.manifestUrl()).toBe('https://releases.example/m.json');
    } finally {
      await rt.stop();
    }
  });
});

describe('official releases fetched from GitHub ("Update workers")', () => {
  const realFetch = globalThis.fetch;
  const gh = 'https://github.com/ankulalwani/agent-orchestration/releases/download';
  const files = new Map<string, Buffer>();
  let releases: unknown[] = [];
  let githubPackagesGone = false;
  const api = (token: string, method: string, p: string) => fetch(`${base}${API_PREFIX}${p}`, { method, headers: { authorization: `Bearer ${token}` } });
  const addRelease = (version: string, opts: { signer?: typeof publisher; pkgBytes?: Buffer; signedBytes?: Buffer; prerelease?: boolean } = {}) => {
    const bytes = opts.pkgBytes ?? gzipSync(Buffer.from(`worker ${version}`));
    const manifest: ReleaseManifest = { version, channel: opts.prerelease ? 'beta' : 'stable', publishedAt: new Date().toISOString(), packageUrl: `${gh}/v${version}/worker-${version}.tgz`, sha256: createHash('sha256').update(opts.signedBytes ?? bytes).digest('hex'), minNodeVersion: '20.0.0', notes: `notes ${version}` };
    files.set(`${gh}/v${version}/manifest.json`, Buffer.from(JSON.stringify(signWith(opts.signer ?? publisher, manifest))));
    files.set(`${gh}/v${version}/worker-${version}.tgz`, bytes);
    releases.unshift({ tag_name: `v${version}`, draft: false, prerelease: Boolean(opts.prerelease), html_url: `https://github.com/ankulalwani/agent-orchestration/releases/tag/v${version}`, assets: [`manifest.json`, `worker-${version}.tgz`].map((name) => ({ name, browser_download_url: `${gh}/v${version}/${name}` })) });
    return bytes;
  };

  beforeAll(() => {
    (s.config as { WORKER_RELEASE_TRUSTED_KEYS: Record<string, string> }).WORKER_RELEASE_TRUSTED_KEYS = trusted;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/')) return Promise.resolve(new Response(JSON.stringify(releases)));
      if (url.startsWith('https://github.com/')) {
        const f = files.get(url);
        return Promise.resolve(f && !(githubPackagesGone && url.includes('/v200.0.0/worker-')) ? new Response(f) : new Response('gone', { status: 404 }));
      }
      return realFetch(input, init);
    });
  });
  afterAll(() => vi.unstubAllGlobals());

  it('imports the project release, serves the upstream signature unchanged, and workers can fetch it from this server', async () => {
    const bytes = addRelease('200.0.0');
    expect((await api(member, 'GET', '/admin/worker-releases/stable/upstream')).status).toBe(403);
    expect((await api(member, 'POST', '/admin/worker-releases/stable/sync')).status).toBe(403);
    const check = (await (await api(admin, 'GET', '/admin/worker-releases/stable/upstream')).json()) as { latest: string; available: boolean };
    expect(check).toMatchObject({ latest: '200.0.0', available: true });

    const done = await api(admin, 'POST', '/admin/worker-releases/stable/sync');
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'imported', version: '200.0.0' });
    expect(((await (await api(admin, 'GET', '/admin/worker-releases/stable/upstream')).json()) as { available: boolean }).available).toBe(false);
    expect(await (await api(admin, 'POST', '/admin/worker-releases/stable/sync')).json()).toMatchObject({ status: 'up-to-date' });

    githubPackagesGone = true;
    // The manifest is the one the project signed (its packageUrl still points at GitHub); the worker's own check passes.
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-stage-up-'));
    const updater = new Updater({
      currentVersion: '0.1.0', manifestUrl: `${base}/api/v1/worker-releases/stable/manifest.json`, trustedKeys: trusted, stagingDir,
      mirrorUrls: (m) => [`${base}/api/v1/worker-releases/${m.channel}/${m.version}/package.tgz`],
    });
    const found = await updater.check();
    expect(found.latest).toMatchObject({ version: '200.0.0', packageUrl: `${gh}/v200.0.0/worker-200.0.0.tgz` });
    // GitHub's copy of 200.0.0 is unreachable in this test; the control plane's mirror serves it, and the signed checksum still gates it.
    expect(fs.readFileSync(await updater.stage(found.latest!))).toEqual(bytes);
  });

  it('refuses a release signed with an untrusted key, or whose package does not match the signed checksum', async () => {
    addRelease('200.0.1', { signer: attacker });
    const forged = await api(admin, 'POST', '/admin/worker-releases/stable/sync');
    expect(forged.status).toBe(403);
    releases.shift();
    addRelease('200.0.2', { signedBytes: gzipSync(Buffer.from('what was signed')) });
    const swapped = await api(admin, 'POST', '/admin/worker-releases/stable/sync');
    expect(swapped.status).toBe(403);
    expect(await swapped.text()).toMatch(/signed checksum/);
    const served = (await (await fetch(`${base}/api/v1/worker-releases/stable/manifest.json`)).json()) as { manifest: { version: string } };
    expect(['200.0.0']).toContain(served.manifest.version); // nothing from the refused releases is served
  });

  it('the beta channel includes pre-releases; stable ignores them', async () => {
    releases = [];
    addRelease('4.0.0-beta.1', { prerelease: true });
    expect(((await (await api(admin, 'GET', '/admin/worker-releases/stable/upstream')).json()) as { latest: string | null }).latest).toBeNull();
    expect(((await (await api(admin, 'GET', '/admin/worker-releases/beta/upstream')).json()) as { latest: string }).latest).toBe('4.0.0-beta.1');
    expect(await (await api(admin, 'POST', '/admin/worker-releases/beta/sync')).json()).toMatchObject({ status: 'imported', version: '4.0.0-beta.1' });
  });
});
