import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import * as tar from 'tar';
import { z } from 'zod';
import { AppError, compareVersions } from '@ao/core';
import { readInstallState, versionDir, writeInstallState } from './install-state.js';

/**
 * Worker updates (spec §66). A release manifest is signed with the publisher's Ed25519 key; the worker
 * trusts only the public keys it ships with (or that an administrator configured). Nothing is staged
 * unless the manifest signature and the package SHA-256 both verify — unsigned or tampered updates are
 * never executed.
 */
export const releaseManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  channel: z.enum(['stable', 'beta']),
  publishedAt: z.string(),
  packageUrl: z.string().url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  minNodeVersion: z.string().default('20.0.0'),
  notes: z.string().max(10_000).default(''),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const signedManifestSchema = z.object({ manifest: releaseManifestSchema, signature: z.string(), keyId: z.string() });
export type SignedManifest = z.infer<typeof signedManifestSchema>;

/** Canonical bytes that are signed: stable key order, no whitespace. */
export function canonicalManifest(m: ReleaseManifest): Buffer {
  const keys = Object.keys(m).sort() as Array<keyof ReleaseManifest>;
  return Buffer.from(JSON.stringify(Object.fromEntries(keys.map((k) => [k, m[k]]))), 'utf8');
}

/** Verify a signed manifest against trusted Ed25519 public keys (PEM, by key id). */
export function verifyManifest(signed: unknown, trustedKeys: Record<string, string>): ReleaseManifest {
  const s = signedManifestSchema.parse(signed);
  const pem = trustedKeys[s.keyId];
  if (!pem) throw new AppError('FORBIDDEN', `Update signed with an untrusted key (${s.keyId})`);
  const ok = verify(null, canonicalManifest(s.manifest), createPublicKey(pem), Buffer.from(s.signature, 'base64'));
  if (!ok) throw new AppError('FORBIDDEN', 'Update manifest signature is invalid');
  return s.manifest;
}

/**
 * Installs a verified, staged package as a new version and makes it current, pending confirmation
 * (D-017). The launcher starts it on the next restart and rolls back if it never confirms.
 */
export function installStagedUpdate(installDir: string, stagedFile: string, manifest: ReleaseManifest) {
  const state = readInstallState(installDir);
  if (state.bad.includes(manifest.version)) throw new AppError('CONFLICT', `Version ${manifest.version} failed before and was rolled back; it will not be installed again automatically`);
  if (compareVersions(manifest.version, state.current) <= 0) throw new AppError('CONFLICT', `Version ${manifest.version} is not newer than the installed ${state.current}`);
  const dest = versionDir(installDir, manifest.version);
  const tmp = `${dest}.partial-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    // node-tar, not the OS tar (Windows' bsdtar crashed on real packages). It refuses absolute paths
    // and `..` entries by default, so a package cannot write outside `tmp`.
    tar.x({ file: stagedFile, cwd: tmp, sync: true, strict: true });
    // Accept packages with files at the root or inside one top-level folder.
    const entries = fs.readdirSync(tmp);
    const root = fs.existsSync(path.join(tmp, 'dist', 'main.js')) ? tmp : entries.length === 1 ? path.join(tmp, entries[0]!) : tmp;
    if (!fs.existsSync(path.join(root, 'dist', 'main.js'))) throw new AppError('VALIDATION_FAILED', 'The update package has no dist/main.js');
    const packaged = fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() : null;
    if (packaged !== manifest.version) throw new AppError('VALIDATION_FAILED', `The package contains version ${packaged ?? '(none)'}, the manifest says ${manifest.version}`);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(root, dest);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  writeInstallState(installDir, { ...state, previous: state.current, current: manifest.version, pending: { version: manifest.version, from: state.current, since: new Date().toISOString() } });
}

/**
 * Called by a newly started version once it runs correctly: clears the pending mark and removes
 * versions other than this one and the previous (kept for a manual rollback).
 */
export function confirmInstalledVersion(installDir: string, version: string): boolean {
  const state = readInstallState(installDir);
  if (state.pending?.version !== version) return false;
  writeInstallState(installDir, { ...state, pending: null });
  const keep = new Set([version, state.previous].filter(Boolean));
  const appDir = path.join(installDir, 'app');
  for (const d of fs.existsSync(appDir) ? fs.readdirSync(appDir) : []) {
    if (!keep.has(d) && !d.includes('.partial-')) fs.rmSync(path.join(appDir, d), { recursive: true, force: true });
  }
  return true;
}

export interface UpdateCheck {
  currentVersion: string;
  latest: ReleaseManifest | null;
  updateAvailable: boolean;
}

export class Updater {
  constructor(
    private opts: {
      currentVersion: string;
      manifestUrl: string | null;
      trustedKeys: Record<string, string>;
      stagingDir: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  async check(): Promise<UpdateCheck> {
    if (!this.opts.manifestUrl) throw new AppError('VALIDATION_FAILED', 'No update source is configured');
    const res = await this.fetch(this.opts.manifestUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new AppError('PROVIDER_ERROR', `Update check failed: HTTP ${res.status}`, { retryable: true });
    const manifest = verifyManifest(await res.json(), this.opts.trustedKeys);
    return { currentVersion: this.opts.currentVersion, latest: manifest, updateAvailable: compareVersions(manifest.version, this.opts.currentVersion) > 0 };
  }

  /** Download and verify the package; returns the staged file path. Never executes anything. */
  async stage(manifest: ReleaseManifest): Promise<string> {
    if (compareVersions(process.versions.node, manifest.minNodeVersion) < 0) throw new AppError('VALIDATION_FAILED', `Update requires Node.js ${manifest.minNodeVersion}+`);
    const res = await this.fetch(manifest.packageUrl, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new AppError('PROVIDER_ERROR', `Download failed: HTTP ${res.status}`, { retryable: true });
    const data = Buffer.from(await res.arrayBuffer());
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== manifest.sha256) throw new AppError('FORBIDDEN', 'Downloaded package does not match the signed checksum');
    fs.mkdirSync(this.opts.stagingDir, { recursive: true });
    const file = path.join(this.opts.stagingDir, `worker-${manifest.version}.tgz`);
    fs.writeFileSync(file, data);
    fs.writeFileSync(file + '.manifest.json', JSON.stringify(manifest, null, 2));
    return file;
  }
}
