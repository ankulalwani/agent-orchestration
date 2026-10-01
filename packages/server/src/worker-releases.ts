import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@ao/core';
import { API_PREFIX } from '@ao/contracts';
import type { ServerConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import type { ArtifactStore } from './artifacts.js';
import { audit } from './audit.js';
import type { PlatformActor } from './context.js';
import { readVersioned, updateVersioned } from './runtime-settings.js';

/**
 * Worker releases hosted by the control plane (WORKER-012). The control plane only stores and serves
 * files: releases are signed offline with the publisher's Ed25519 key (scripts/sign-release.mjs), and
 * workers accept a release only if its signature verifies against keys configured on the worker itself.
 * A compromised control plane can therefore withhold updates, but not push its own.
 *
 * Publishing: upload the package (the answer contains the package URL and SHA-256 to sign), sign the
 * manifest with that URL, upload the signed manifest. The newest manifest of a channel is served at
 * /api/v1/worker-releases/<channel>/manifest.json.
 */
export const WORKER_RELEASE_CHANNELS = ['stable', 'beta'] as const;
export type ReleaseChannel = (typeof WORKER_RELEASE_CHANNELS)[number];
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
export const MAX_WORKER_PACKAGE_BYTES = 300 * 1024 * 1024;

const signedManifest = z.object({
  manifest: z.object({
    version: z.string().regex(VERSION),
    channel: z.enum(WORKER_RELEASE_CHANNELS),
    publishedAt: z.string(),
    packageUrl: z.string().url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    minNodeVersion: z.string().optional(),
    notes: z.string().max(10_000).optional(),
  }).passthrough(),
  signature: z.string().min(40).max(200),
  keyId: z.string().min(1).max(100),
});

interface ReleaseIndex {
  /** channel → version → release. */
  releases: Record<string, Record<string, { sha256: string; size: number; uploadedAt: string; manifest: unknown | null; publishedAt: string | null }>>;
  latest: Record<string, string>;
}
const EMPTY: ReleaseIndex = { releases: {}, latest: {} };
const INDEX_KEY = 'worker.releases';

const compareVersions = (a: string, b: string) => {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * Optional server-side signing: an administrator generates Ed25519 keys here, the private half is encrypted
 * at rest (SecretBox) and never leaves the server, and the server signs uploaded packages itself.
 * Trade-off: whoever controls this server (or its ENCRYPTION_KEY and database) can then sign releases that
 * workers trusting these keys accept. Offline signing with WORKER_RELEASE_TRUSTED_KEYS stays available.
 */
interface SigningKeys {
  keys: Record<string, { publicKey: string; encryptedPrivateKey: string; createdAt: string; createdBy: string }>;
  activeKeyId: string | null;
}
const EMPTY_KEYS: SigningKeys = { keys: {}, activeKeyId: null };
const KEYS_KEY = 'worker.signing-keys';
const KEY_ID = /^[A-Za-z0-9._-]{1,100}$/;
const canonical = (m: Record<string, unknown>) => Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]))), 'utf8');

export class WorkerReleaseService {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: ArtifactStore,
    private readonly box: SecretBox,
  ) {}

  // ── Server-held signing keys ───────────────────────────────────────────────
  async listKeys() {
    const { keys, activeKeyId } = (await readVersioned<SigningKeys>(KEYS_KEY, EMPTY_KEYS)).data;
    return Object.entries(keys).map(([keyId, k]) => ({ keyId, publicKey: k.publicKey, createdAt: k.createdAt, active: keyId === activeKeyId }));
  }

  /** Public keys the install script and workers should trust: the operator's (environment) plus generated ones. */
  async trustedKeys(): Promise<Record<string, string>> {
    const generated = Object.fromEntries((await this.listKeys()).map((k) => [k.keyId, k.publicKey]));
    return { ...generated, ...this.config.WORKER_RELEASE_TRUSTED_KEYS };
  }

  /** Generates a key pair and makes it the signing key. Earlier keys stay trusted so older releases still verify. */
  async generateKey(actor: PlatformActor, requestedId?: string) {
    const keyId = requestedId?.trim() || `release-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;
    if (!KEY_ID.test(keyId)) throw new AppError('VALIDATION_FAILED', 'Key id may use letters, digits, ".", "_" and "-" (up to 100 characters)');
    if (this.config.WORKER_RELEASE_TRUSTED_KEYS[keyId]) throw new AppError('CONFLICT', 'That key id is already configured in the environment');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const entry = {
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      encryptedPrivateKey: this.box.encrypt(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
      createdAt: new Date().toISOString(),
      createdBy: actor.userId,
    };
    await updateVersioned<SigningKeys>(KEYS_KEY, EMPTY_KEYS, (cur) => {
      if (cur.keys[keyId]) throw new AppError('CONFLICT', `Key ${keyId} already exists`);
      cur.keys[keyId] = entry;
      cur.activeKeyId = keyId;
      return cur;
    });
    await audit(actor, 'worker_release.key.generate', { type: 'worker_release_key', id: keyId }, {});
    return { keyId, publicKey: entry.publicKey };
  }

  async activateKey(actor: PlatformActor, keyId: string) {
    await updateVersioned<SigningKeys>(KEYS_KEY, EMPTY_KEYS, (cur) => {
      if (!cur.keys[keyId]) throw new AppError('NOT_FOUND', 'Unknown signing key');
      cur.activeKeyId = keyId;
      return cur;
    });
    await audit(actor, 'worker_release.key.activate', { type: 'worker_release_key', id: keyId }, {});
    return this.listKeys();
  }

  /** Deletes a key. The active key can't be deleted; workers that trusted it will refuse releases signed with it. */
  async deleteKey(actor: PlatformActor, keyId: string) {
    await updateVersioned<SigningKeys>(KEYS_KEY, EMPTY_KEYS, (cur) => {
      if (!cur.keys[keyId]) throw new AppError('NOT_FOUND', 'Unknown signing key');
      if (cur.activeKeyId === keyId) throw new AppError('CONFLICT', 'Make another key active before deleting this one');
      delete cur.keys[keyId];
      return cur;
    });
    await audit(actor, 'worker_release.key.delete', { type: 'worker_release_key', id: keyId }, {});
    return this.listKeys();
  }

  /** Signs the uploaded package's manifest with the active server key and publishes it. */
  async signAndPublish(actor: PlatformActor, channel: string, version: string, notes?: string) {
    this.check(channel, version);
    const keys = (await readVersioned<SigningKeys>(KEYS_KEY, EMPTY_KEYS)).data;
    const keyId = keys.activeKeyId;
    if (!keyId || !keys.keys[keyId]) throw new AppError('VALIDATION_FAILED', 'Generate a signing key first');
    const uploaded = (await readVersioned<ReleaseIndex>(INDEX_KEY, EMPTY)).data.releases[channel]?.[version];
    if (!uploaded) throw new AppError('VALIDATION_FAILED', `Upload the package for ${version} first`);
    const manifest = {
      version,
      channel,
      publishedAt: new Date().toISOString(),
      packageUrl: this.packageUrl(channel, version),
      sha256: uploaded.sha256,
      minNodeVersion: '20.0.0',
      notes: notes ?? '',
    };
    const signature = sign(null, canonical(manifest), createPrivateKey(this.box.decrypt(keys.keys[keyId]!.encryptedPrivateKey))).toString('base64');
    return this.publish(actor, channel, { manifest, signature, keyId });
  }

  private check(channel: string, version: string): asserts channel is ReleaseChannel {
    if (!(WORKER_RELEASE_CHANNELS as readonly string[]).includes(channel)) throw new AppError('VALIDATION_FAILED', 'Channel must be stable or beta');
    if (!VERSION.test(version)) throw new AppError('VALIDATION_FAILED', 'Version must be semver (x.y.z)');
  }

  packageUrl(channel: string, version: string) {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}${API_PREFIX}/worker-releases/${channel}/${version}/package.tgz`;
  }

  async uploadPackage(actor: PlatformActor, channel: string, version: string, body: Buffer) {
    this.check(channel, version);
    if (!body.length) throw new AppError('VALIDATION_FAILED', 'The package is empty');
    if (body[0] !== 0x1f || body[1] !== 0x8b) throw new AppError('VALIDATION_FAILED', 'The package must be a .tgz (gzip) file');
    const sha256 = createHash('sha256').update(body).digest('hex');
    await this.store.put(`worker-releases/${channel}/${version}/package.tgz`, body, 'application/gzip');
    await updateVersioned<ReleaseIndex>(INDEX_KEY, EMPTY, (cur) => {
      (cur.releases[channel] ??= {})[version] = { sha256, size: body.length, uploadedAt: new Date().toISOString(), manifest: null, publishedAt: null };
      return cur;
    });
    await audit(actor, 'worker_release.upload', { type: 'worker_release', id: `${channel}/${version}` }, { sha256, size: body.length });
    return { channel, version, sha256, size: body.length, packageUrl: this.packageUrl(channel, version), sign: `node scripts/sign-release.mjs sign <keyId>.private.pem <keyId> <package.tgz> ${version} ${this.packageUrl(channel, version)} ${channel}` };
  }

  /**
   * Publishes a signed manifest for an uploaded package. The signature itself is checked by workers; here
   * the manifest must describe exactly the uploaded package at this server's URL.
   */
  async publish(actor: PlatformActor, channel: string, raw: unknown) {
    const parsed = signedManifest.safeParse(raw);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', `Not a signed release manifest: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    const { manifest } = parsed.data;
    this.check(channel, manifest.version);
    if (manifest.channel !== channel) throw new AppError('VALIDATION_FAILED', `The manifest is for the ${manifest.channel} channel`);
    const index = await readVersioned<ReleaseIndex>(INDEX_KEY, EMPTY);
    const uploaded = index.data.releases[channel]?.[manifest.version];
    if (!uploaded) throw new AppError('VALIDATION_FAILED', `Upload the package for ${manifest.version} first`);
    if (manifest.sha256 !== uploaded.sha256) throw new AppError('VALIDATION_FAILED', 'The manifest checksum does not match the uploaded package');
    if (manifest.packageUrl !== this.packageUrl(channel, manifest.version)) throw new AppError('VALIDATION_FAILED', `The manifest must point to ${this.packageUrl(channel, manifest.version)}`);
    await updateVersioned<ReleaseIndex>(INDEX_KEY, EMPTY, (cur) => {
      const r = cur.releases[channel]![manifest.version]!;
      r.manifest = parsed.data;
      r.publishedAt = new Date().toISOString();
      const latest = cur.latest[channel];
      if (!latest || compareVersions(manifest.version, latest) >= 0) cur.latest[channel] = manifest.version;
      return cur;
    });
    await audit(actor, 'worker_release.publish', { type: 'worker_release', id: `${channel}/${manifest.version}` }, { keyId: parsed.data.keyId });
    return this.list();
  }

  async list() {
    const index = (await readVersioned<ReleaseIndex>(INDEX_KEY, EMPTY)).data;
    return WORKER_RELEASE_CHANNELS.map((channel) => ({
      channel,
      latest: index.latest[channel] ?? null,
      manifestUrl: `${this.config.PUBLIC_URL.replace(/\/+$/, '')}${API_PREFIX}/worker-releases/${channel}/manifest.json`,
      releases: Object.entries(index.releases[channel] ?? {})
        .map(([version, r]) => ({ version, sha256: r.sha256, size: r.size, uploadedAt: r.uploadedAt, publishedAt: r.publishedAt, keyId: (r.manifest as { keyId?: string } | null)?.keyId ?? null }))
        .sort((a, b) => compareVersions(b.version, a.version)),
    }));
  }

  /** Public: the newest published signed manifest of a channel. */
  async manifest(channel: string) {
    if (!(WORKER_RELEASE_CHANNELS as readonly string[]).includes(channel)) throw new AppError('NOT_FOUND', 'Unknown channel');
    const index = (await readVersioned<ReleaseIndex>(INDEX_KEY, EMPTY)).data;
    const latest = index.latest[channel];
    const m = latest ? index.releases[channel]?.[latest]?.manifest : null;
    if (!m) throw new AppError('NOT_FOUND', 'No release has been published on this channel');
    return m;
  }

  /** Public: a package, only once its manifest is published. */
  async package(channel: string, version: string) {
    if (!(WORKER_RELEASE_CHANNELS as readonly string[]).includes(channel) || !VERSION.test(version)) throw new AppError('NOT_FOUND', 'Unknown release');
    const index = (await readVersioned<ReleaseIndex>(INDEX_KEY, EMPTY)).data;
    if (!index.releases[channel]?.[version]?.publishedAt) throw new AppError('NOT_FOUND', 'Unknown release');
    const file = await this.store.get(`worker-releases/${channel}/${version}/package.tgz`);
    if (!file) throw new AppError('NOT_FOUND', 'Release package missing from storage');
    return file.body;
  }
}
