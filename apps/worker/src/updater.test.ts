import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Updater, canonicalManifest, verifyManifest, type ReleaseManifest } from './updater.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const trusted = { release1: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
const pkg = Buffer.from('fake package contents');
const manifest: ReleaseManifest = {
  version: '0.2.0',
  channel: 'stable',
  publishedAt: '2026-09-27T00:00:00Z',
  packageUrl: 'https://updates.example/worker-0.2.0.tgz',
  sha256: createHash('sha256').update(pkg).digest('hex'),
  minNodeVersion: '20.0.0',
  notes: '',
};
const signed = (m: ReleaseManifest, key = privateKey, keyId = 'release1') => ({ manifest: m, keyId, signature: sign(null, canonicalManifest(m), key).toString('base64') });

describe('signed worker updates (spec §66)', () => {
  it('accepts a correctly signed manifest', () => {
    expect(verifyManifest(signed(manifest), trusted).version).toBe('0.2.0');
  });

  it('rejects tampered manifests, untrusted keys and wrong signers', () => {
    const s = signed(manifest);
    expect(() => verifyManifest({ ...s, manifest: { ...manifest, packageUrl: 'https://evil.example/x.tgz' } }, trusted)).toThrow(/invalid/);
    expect(() => verifyManifest({ ...s, keyId: 'unknown' }, trusted)).toThrow(/untrusted/);
    const other = generateKeyPairSync('ed25519').privateKey;
    expect(() => verifyManifest(signed(manifest, other), trusted)).toThrow(/invalid/);
  });

  it('stages only packages whose checksum matches; never executes', async () => {
    const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-upd-'));
    const serve = (body: Buffer) => (async (url: string | URL | Request) => new Response(String(url).endsWith('.json') ? JSON.stringify(signed(manifest)) : body)) as typeof fetch;
    const u = new Updater({ currentVersion: '0.1.0', manifestUrl: 'https://updates.example/stable.json', trustedKeys: trusted, stagingDir, fetchImpl: serve(pkg) });
    const check = await u.check();
    expect(check.updateAvailable).toBe(true);
    const file = await u.stage(check.latest!);
    expect(fs.readFileSync(file)).toEqual(pkg);

    const tampered = new Updater({ currentVersion: '0.1.0', manifestUrl: 'https://updates.example/stable.json', trustedKeys: trusted, stagingDir, fetchImpl: serve(Buffer.from('malicious')) });
    await expect(tampered.stage(manifest)).rejects.toThrow(/checksum/);
  });

  it('release script output verifies with the worker verifier', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-sign-'));
    const script = path.resolve('scripts/sign-release.mjs');
    execFileSync(process.execPath, [script, 'keygen', 'k1'], { cwd: dir });
    fs.writeFileSync(path.join(dir, 'pkg.tgz'), pkg);
    const out = execFileSync(process.execPath, [script, 'sign', 'k1.private.pem', 'k1', 'pkg.tgz', '0.3.0', 'https://updates.example/w.tgz'], { cwd: dir }).toString();
    const pub = fs.readFileSync(path.join(dir, 'k1.public.pem'), 'utf8');
    expect(verifyManifest(JSON.parse(out), { k1: pub }).sha256).toBe(manifest.sha256);
  });
});
