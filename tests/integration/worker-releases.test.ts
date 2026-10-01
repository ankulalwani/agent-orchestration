/**
 * Worker releases hosted by the control plane (WORKER-012): a platform administrator uploads a package
 * and a manifest signed offline; workers fetch both from the control plane and verify them against
 * keys they trust locally. The control plane can't make a worker accept a release it signed itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

  it('a paired worker uses its control plane as the release source by default; trust stays local', async () => {
    const rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rel-worker-')));
    rt.config.update({ connectionMode: 'self-hosted', controlPlaneUrl: base, updates: { ...rt.config.get().updates, channel: 'beta' } });
    await rt.init();
    try {
      expect(rt.updates.manifestUrl()).toBe(`${base}/api/v1/worker-releases/beta/manifest.json`);
      expect(rt.updates.unsupportedReason()).toMatch(/No release signing key is trusted/);
      rt.config.update((c) => ({ ...c, updates: { ...c.updates, manifestUrl: 'https://releases.example/m.json' } }));
      expect(rt.updates.manifestUrl()).toBe('https://releases.example/m.json');
    } finally {
      await rt.stop();
    }
  });
});
