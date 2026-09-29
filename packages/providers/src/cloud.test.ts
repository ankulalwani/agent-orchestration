/**
 * Bedrock and Vertex health checks (PROV-003). Signatures are verified independently: Bedrock requests
 * against the AWS SDK's own SigV4 signer (@smithy/signature-v4), Vertex JWT assertions with the
 * service account's public key.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, createHmac, generateKeyPairSync, verify as rsaVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProvider, providerConfigSchema } from './providers.js';
import { parseAwsCredential, resolveAwsCredentials, signAwsRequest } from './cloud-auth.js';

// The AWS SDK ships with the S3 artifact driver; load its SigV4 signer from there
// (@aws-sdk/client-s3 → @aws-sdk/signature-v4-multi-region → @smithy/signature-v4).
const s3Req = createRequire(createRequire(path.resolve('packages/server/package.json')).resolve('@aws-sdk/client-s3'));
const multiRegionReq = createRequire(s3Req.resolve('@aws-sdk/signature-v4-multi-region'));
const { SignatureV4 } = multiRegionReq('@smithy/signature-v4') as { SignatureV4: new (opts: Record<string, unknown>) => { sign(req: unknown, opts: unknown): Promise<{ headers: Record<string, string> }> } };
/** SHA-256 / HMAC-SHA256 in the shape the SDK signer expects (the SigV4 algorithm itself is the SDK's). */
class Sha256 {
  private h: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  constructor(secret?: string | Uint8Array) {
    this.h = secret === undefined ? createHash('sha256') : createHmac('sha256', typeof secret === 'string' ? Buffer.from(secret) : Buffer.from(secret));
  }
  update(data: string | Uint8Array) {
    this.h.update(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data));
  }
  async digest() {
    return new Uint8Array(this.h.digest());
  }
  reset() {}
}

const creds = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

async function sdkSignature(req: { method: string; url: string; headers: Record<string, string>; body?: string; region: string; service: string; credentials: typeof creds & { sessionToken?: string }; now: Date }) {
  const u = new URL(req.url);
  const signer = new SignatureV4({ credentials: req.credentials, region: req.region, service: req.service, sha256: Sha256 });
  const signed = await signer.sign(
    { method: req.method, protocol: u.protocol, hostname: u.hostname, port: u.port ? Number(u.port) : undefined, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...req.headers, host: u.host }, body: req.body },
    { signingDate: req.now },
  );
  return String(signed.headers.authorization);
}

describe('AWS SigV4 (checked against the AWS SDK signer and the AWS test suite)', () => {
  it('reproduces the official AWS SigV4 test vector "get-vanilla"', () => {
    const h = signAwsRequest({ method: 'GET', url: 'https://example.amazonaws.com/', region: 'us-east-1', service: 'service', credentials: creds, now: new Date('2015-08-30T12:36:00Z') });
    expect(h.authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  const now = new Date('2026-09-27T12:34:56Z');
  it.each([
    ['GET', 'https://bedrock.us-east-1.amazonaws.com/foundation-models', undefined, undefined],
    ['GET', 'https://bedrock.eu-west-3.amazonaws.com/foundation-models?byProvider=anthropic&byOutputModality=TEXT', undefined, undefined],
    ['POST', 'https://bedrock-runtime.us-west-2.amazonaws.com/model/abc/invoke', '{"prompt":"hi"}', undefined],
    ['GET', 'https://bedrock.us-east-1.amazonaws.com/foundation-models', undefined, 'session-token-xyz'],
  ])('%s %s', async (method, url, body, sessionToken) => {
    const region = new URL(url).hostname.split('.')[1]!;
    const service = new URL(url).hostname.startsWith('bedrock-runtime') ? 'bedrock' : 'bedrock';
    const c = { ...creds, ...(sessionToken ? { sessionToken } : {}) };
    const headers = { 'content-type': 'application/json', 'x-amz-content-sha256': createHash('sha256').update(body ?? '').digest('hex') };
    const ours = signAwsRequest({ method, url, headers, body, region, service, credentials: c, now });
    expect(ours.authorization).toBe(await sdkSignature({ method, url, headers, body, region, service, credentials: c, now }));
  });

  it('parses stored keys and resolves profiles from a credentials file', () => {
    expect(parseAwsCredential('AKID:SECRET:TOKEN')).toEqual({ accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN' });
    expect(parseAwsCredential('{"accessKeyId":"A","secretAccessKey":"S"}')).toMatchObject({ accessKeyId: 'A', secretAccessKey: 'S' });
    expect(parseAwsCredential('nonsense')).toBeNull();
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-aws-')), 'credentials');
    fs.writeFileSync(file, '[default]\naws_access_key_id = D1\naws_secret_access_key = DS\n\n[work]\naws_access_key_id=W1\naws_secret_access_key=WS\naws_session_token=WT\n');
    expect(resolveAwsCredentials(null, 'work', { AWS_SHARED_CREDENTIALS_FILE: file })).toMatchObject({ credentials: { accessKeyId: 'W1', sessionToken: 'WT' }, source: 'profile "work"' });
    expect(resolveAwsCredentials(null, undefined, { AWS_SHARED_CREDENTIALS_FILE: file })?.credentials.accessKeyId).toBe('D1');
    expect(resolveAwsCredentials(null, undefined, { AWS_ACCESS_KEY_ID: 'E1', AWS_SECRET_ACCESS_KEY: 'ES', AWS_SHARED_CREDENTIALS_FILE: file })?.source).toBe('environment');
    expect(resolveAwsCredentials('K:S', undefined, { AWS_ACCESS_KEY_ID: 'E1', AWS_SECRET_ACCESS_KEY: 'ES' })?.source).toBe('worker credential store');
    expect(resolveAwsCredentials(null, undefined, { AWS_SHARED_CREDENTIALS_FILE: path.join(file, 'missing') })).toBeNull();
  });
});

/** A fake Bedrock endpoint that accepts only requests whose signature the AWS SDK signer reproduces. */
function fakeBedrock(expectedCreds: typeof creds, opts: { status?: number } = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const amz = h['x-amz-date']!;
    const now = new Date(Date.UTC(+amz.slice(0, 4), +amz.slice(4, 6) - 1, +amz.slice(6, 8), +amz.slice(9, 11), +amz.slice(11, 13), +amz.slice(13, 15)));
    const region = new URL(url).hostname.split('.')[1]!;
    const { authorization, host: _h, 'x-amz-date': _d, ...rest } = h;
    const expected = await sdkSignature({ method: 'GET', url, headers: { ...rest, 'x-amz-date': amz }, region, service: 'bedrock', credentials: expectedCreds, now });
    if (authorization !== expected) return new Response(JSON.stringify({ message: 'The request signature we calculated does not match the signature you provided.' }), { status: 403 });
    if (opts.status) return new Response(JSON.stringify({ message: 'ThrottlingException' }), { status: opts.status, headers: { 'retry-after': '30' } });
    return new Response(JSON.stringify({ modelSummaries: [{ modelId: 'anthropic.claude-sonnet-4-5', modelName: 'Claude Sonnet 4.5' }, { modelId: 'amazon.nova-pro-v1:0', modelName: 'Nova Pro' }] }), { status: 200 });
  }) as typeof fetch;
}

describe('Bedrock provider', () => {
  const config = providerConfigSchema.parse({ id: 'bedrock', kind: 'bedrock', name: 'Bedrock', extra: { region: 'us-east-1' }, models: [{ id: 'anthropic.claude-sonnet-4-5', costTier: 'high' }] });

  it('signed ListFoundationModels: healthy, and the live model list merged with declared metadata', async () => {
    const p = createProvider(config, 'AKIDEXAMPLE:wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', fakeBedrock(creds));
    const h = await p.healthCheck();
    expect(h).toMatchObject({ healthy: true });
    expect(h.latencyMs).not.toBeNull();
    const models = await p.listModels();
    expect(models).toContainEqual({ id: 'anthropic.claude-sonnet-4-5', name: 'Claude Sonnet 4.5', costTier: 'high' });
    expect(models.map((m) => m.id)).toContain('amazon.nova-pro-v1:0');
  });

  it('a wrong secret is unhealthy (signature rejected), throttling reports the limit', async () => {
    expect(await createProvider(config, 'AKIDEXAMPLE:wrong-secret', fakeBedrock(creds)).healthCheck()).toMatchObject({ healthy: false, error: expect.stringMatching(/HTTP 403.*signature/) });
    const limited = await createProvider(config, 'AKIDEXAMPLE:wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', fakeBedrock(creds, { status: 429 })).healthCheck();
    expect(limited).toMatchObject({ healthy: false, limitedUntil: expect.any(Number) });
  });

  it('without any resolvable credentials it defers to the agent instead of claiming a failure', async () => {
    const saved = { ...process.env };
    try {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      process.env.AWS_SHARED_CREDENTIALS_FILE = path.join(os.tmpdir(), 'ao-no-such-credentials-file');
      const p = createProvider(config, null, (async () => {
        throw new Error('must not call AWS without credentials');
      }) as unknown as typeof fetch);
      expect(await p.healthCheck()).toMatchObject({ healthy: true, error: expect.stringMatching(/agent resolves them/) });
      expect((await p.listModels()).map((m) => m.id)).toEqual(['anthropic.claude-sonnet-4-5']);
    } finally {
      process.env = saved;
    }
  });
});

describe('Vertex provider', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { type: 'service_account', client_email: 'orchestrator@proj-1.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.example.test/token', project_id: 'proj-1' };

  /** Fake Google: verifies the JWT assertion with the service account's public key, then the bearer token. */
  function fakeGoogle(calls: string[]): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url === sa.token_uri) {
        const form = new URLSearchParams(String(init?.body));
        const [h, c, sig] = form.get('assertion')!.split('.');
        const valid = rsaVerify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig!, 'base64url'));
        const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
        if (!valid || claims.iss !== sa.client_email || claims.aud !== sa.token_uri || form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
          return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }), { status: 400 });
        }
        return new Response(JSON.stringify({ access_token: 'ya29.test-token', expires_in: 3600, token_type: 'Bearer' }), { status: 200 });
      }
      const auth = (init?.headers as Record<string, string>)?.authorization;
      if (auth !== 'Bearer ya29.test-token') return new Response('{"error":{"code":401}}', { status: 401 });
      if (url.endsWith('/v1/projects/proj-1/locations/europe-west1')) return new Response(JSON.stringify({ name: 'projects/proj-1/locations/europe-west1', locationId: 'europe-west1' }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 403, message: 'Vertex AI API has not been used in project other-proj before or it is disabled.' } }), { status: 403 });
    }) as typeof fetch;
  }
  const cfg = (extra: Record<string, string>) => providerConfigSchema.parse({ id: 'vertex', kind: 'vertex', name: 'Vertex', extra, models: [{ id: 'claude-sonnet-4-5@20250929' }] });

  it('service-account token exchange + project location check → healthy; the token is reused', async () => {
    const calls: string[] = [];
    const p = createProvider(cfg({ region: 'europe-west1' }), JSON.stringify(sa), fakeGoogle(calls));
    expect(await p.healthCheck()).toMatchObject({ healthy: true });
    expect(calls).toEqual([sa.token_uri, 'https://europe-west1-aiplatform.googleapis.com/v1/projects/proj-1/locations/europe-west1']);
    await p.healthCheck();
    expect(calls.filter((c) => c === sa.token_uri)).toHaveLength(1);
    expect((await p.listModels()).map((m) => m.id)).toEqual(['claude-sonnet-4-5@20250929']);
  });

  it('a wrong key, or a project without Vertex AI, is unhealthy with the reason', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(await createProvider(cfg({ region: 'europe-west1' }), JSON.stringify({ ...sa, private_key: other }), fakeGoogle([])).healthCheck()).toMatchObject({ healthy: false, error: expect.stringMatching(/Invalid JWT Signature/) });
    expect(await createProvider(cfg({ region: 'europe-west1', project: 'other-proj' }), JSON.stringify(sa), fakeGoogle([])).healthCheck()).toMatchObject({ healthy: false, error: expect.stringMatching(/HTTP 403.*not been used in project other-proj/) });
  });
});
