import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@ao/core';
import type { ServerConfig } from './config.js';

/**
 * Artifact storage (spec §62): screenshots, reports, logs and other large files are kept out of MongoDB.
 * Drivers: S3-compatible (AWS S3, MinIO, …) when S3_BUCKET is set, otherwise a local directory.
 */
export interface ArtifactStore {
  readonly driver: 's3' | 'filesystem';
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
}

/** Task artifacts: <organization>/<task>/<file>; worker releases: worker-releases/<channel>/<version>/<file>. */
const SAFE_KEY = /^(?:[a-f0-9]{24}\/[a-f0-9]{24}|worker-releases\/(?:stable|beta)\/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/[A-Za-z0-9._-]{1,200}$/;
export function assertSafeKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes('..')) throw new AppError('VALIDATION_FAILED', 'Invalid artifact key');
}

export class FsArtifactStore implements ArtifactStore {
  readonly driver = 'filesystem' as const;
  constructor(private root: string) {}
  private file(key: string) {
    assertSafeKey(key);
    return path.join(path.resolve(this.root), ...key.split('/'));
  }
  async put(key: string, body: Buffer, contentType: string) {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, body);
    await fs.writeFile(f + '.type', contentType);
  }
  async get(key: string) {
    const f = this.file(key);
    try {
      return { body: await fs.readFile(f), contentType: (await fs.readFile(f + '.type', 'utf8').catch(() => 'application/octet-stream')).trim() };
    } catch {
      return null;
    }
  }
}

export class S3ArtifactStore implements ArtifactStore {
  readonly driver = 's3' as const;
  private client: Promise<any>;
  constructor(private cfg: ServerConfig) {
    this.client = import('@aws-sdk/client-s3').then(
      (m) =>
        new m.S3Client({
          region: cfg.S3_REGION,
          endpoint: cfg.S3_ENDPOINT,
          forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
          credentials: cfg.S3_ACCESS_KEY_ID ? { accessKeyId: cfg.S3_ACCESS_KEY_ID, secretAccessKey: cfg.S3_SECRET_ACCESS_KEY ?? '' } : undefined,
        }),
    );
  }
  async put(key: string, body: Buffer, contentType: string) {
    assertSafeKey(key);
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client).send(new PutObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    assertSafeKey(key);
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const r = await (await this.client).send(new GetObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
      return { body: Buffer.from(await r.Body.transformToByteArray()), contentType: r.ContentType ?? 'application/octet-stream' };
    } catch (e: any) {
      if (e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }
}

export function createArtifactStore(cfg: ServerConfig): ArtifactStore {
  return cfg.S3_BUCKET ? new S3ArtifactStore(cfg) : new FsArtifactStore(cfg.ARTIFACT_DIR);
}

export const ALLOWED_ARTIFACT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/json', 'text/markdown', 'video/webm', 'application/zip'];
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
