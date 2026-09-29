import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '@ao/core';
import { API_PREFIX } from '@ao/contracts';
import type { ServerConfig } from './config.js';
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

export class WorkerReleaseService {
  constructor(
    private readonly config: ServerConfig,
    private readonly store: ArtifactStore,
  ) {}

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
