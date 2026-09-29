/**
 * S3 artifact storage (VERIFY-004 / STORE-001) against a real S3-compatible server: SeaweedFS
 * (`weed server -s3`). Runs when the binary is available: AO_TEST_SEAWEED or .tools/seaweed/weed.exe.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeOwner, makeServices, makeWorker } from '../helpers.js';

const WEED = process.env.AO_TEST_SEAWEED ?? path.resolve('.tools/seaweed/weed.exe');
const s3sdk = createRequire(path.resolve('packages/server/package.json'))('@aws-sdk/client-s3') as typeof import('@aws-sdk/client-s3');

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

let weed: ChildProcess;
let endpoint = '';
let dataDir = '';
const creds = { accessKeyId: 'ao-test-key', secretAccessKey: 'ao-test-secret-123' };

describe.runIf(fs.existsSync(WEED))('S3 artifact storage against SeaweedFS', () => {
  let s: Services;
  let app: FastifyInstance;

  beforeAll(async () => {
    await startTestDatabase();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-s3-'));
    const cfg = path.join(dataDir, 's3.json');
    fs.writeFileSync(cfg, JSON.stringify({ identities: [{ name: 'ao', credentials: [{ accessKey: creds.accessKeyId, secretKey: creds.secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }));
    // Ports well below 55535 so the implied gRPC ports (+10000) are valid.
    const pick = async () => {
      for (;;) {
        const p = await freePort();
        if (p < 50000) return p;
      }
    };
    const [s3, master, volume, filer] = [await pick(), await pick(), await pick(), await pick()];
    weed = spawn(WEED, ['server', `-dir=${dataDir}`, '-ip=127.0.0.1', `-master.port=${master}`, `-volume.port=${volume}`, `-filer.port=${filer}`, '-s3', `-s3.port=${s3}`, `-s3.config=${cfg}`], { stdio: 'ignore' });
    endpoint = `http://127.0.0.1:${s3}`;
    const client = new s3sdk.S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: creds });
    for (let i = 0; ; i++) {
      try {
        await client.send(new s3sdk.CreateBucketCommand({ Bucket: 'ao-artifacts' }));
        break;
      } catch (e) {
        if (i > 120) throw e;
        await new Promise((r) => setTimeout(r, 500)); // SeaweedFS is still starting
      }
    }
    s = (await makeServices({ S3_ENDPOINT: endpoint, S3_BUCKET: 'ao-artifacts', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: creds.accessKeyId, S3_SECRET_ACCESS_KEY: creds.secretAccessKey })).services;
    app = await buildApp(s);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    weed?.kill();
    await stopTestDatabase();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('a worker uploads a screenshot and a user downloads it; the object lives in the bucket', async () => {
    expect(s.artifacts.driver).toBe('s3');
    const { actor, auth } = await makeOwner(s);
    const project = await s.projects.create(actor, { name: 'p', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const w = await makeWorker(s, actor, project.id);
    const task = await s.tasks.create(actor, { projectId: project.id, title: 't', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w.worker, task.id);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200_000, 7)]);
    const up = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/worker/tasks/${task.id}/artifacts`,
      headers: { authorization: `Bearer ${w.credential}` },
      payload: { name: 'screenshot.png', contentType: 'image/png', data: png.toString('base64') },
    });
    expect(up.statusCode).toBe(200);
    const key = up.json().key as string;

    // Straight from the S3 server: proves the bytes are in the bucket, not on local disk.
    const client = new s3sdk.S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: creds });
    const obj = await client.send(new s3sdk.GetObjectCommand({ Bucket: 'ao-artifacts', Key: key }));
    expect(obj.ContentType).toBe('image/png');
    expect(Buffer.from(await obj.Body!.transformToByteArray()).equals(png)).toBe(true);

    const name = key.split('/').pop()!;
    const down = await app.inject({ method: 'GET', url: `${API_PREFIX}/orgs/${actor.organizationId}/tasks/${task.id}/artifacts/${name}`, headers: { authorization: `Bearer ${auth.accessToken}` } });
    expect(down.statusCode).toBe(200);
    expect(down.headers['content-type']).toBe('image/png');
    expect(down.rawPayload.equals(png)).toBe(true);

    const missing = await app.inject({ method: 'GET', url: `${API_PREFIX}/orgs/${actor.organizationId}/tasks/${task.id}/artifacts/nope.png`, headers: { authorization: `Bearer ${auth.accessToken}` } });
    expect(missing.statusCode).toBe(404);
  });

  it('wrong S3 credentials fail loudly as a server error, never as "not found"', async () => {
    const { services: bad } = await makeServices({ S3_ENDPOINT: endpoint, S3_BUCKET: 'ao-artifacts', S3_ACCESS_KEY_ID: 'wrong', S3_SECRET_ACCESS_KEY: 'wrong-secret-123' });
    const key = `${'a'.repeat(24)}/${'b'.repeat(24)}/x.txt`;
    await expect(bad.artifacts.put(key, Buffer.from('x'), 'text/plain')).rejects.toThrow();
    await expect(bad.artifacts.get(key)).rejects.toThrow();
  });
});
