import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac, sign as rsaSign } from 'node:crypto';
import { AppError } from '@ao/core';

// ── AWS Signature Version 4 ───────────────────────────────────────────────────────────────────────

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();
/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs an HTTP request with AWS SigV4 (header-based). Returns the headers to send, including
 * `authorization` and `x-amz-date`. Non-S3 services: path segments are URI-encoded twice.
 */
export function signAwsRequest(req: { method: string; url: string; headers?: Record<string, string>; body?: string; region: string; service: string; credentials: AwsCredentials; now?: Date }): Record<string, string> {
  const url = new URL(req.url);
  const now = req.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const date = amzDate.slice(0, 8);
  const body = req.body ?? '';
  const headers: Record<string, string> = { ...(req.headers ?? {}), host: url.host, 'x-amz-date': amzDate };
  if (req.credentials.sessionToken) headers['x-amz-security-token'] = req.credentials.sessionToken;

  const canonicalUri =
    url.pathname
      .split('/')
      .map((seg) => (req.service === 's3' ? rfc3986(decodeURIComponent(seg)) : rfc3986(rfc3986(decodeURIComponent(seg)))))
      .join('/') || '/';
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const lower = Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')] as const);
  lower.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalHeaders = lower.map(([k, v]) => `${k}:${v}\n`).join('');
  const signedHeaders = lower.map(([k]) => k).join(';');
  const canonicalRequest = [req.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, sha256hex(body)].join('\n');

  const scope = `${date}/${req.region}/${req.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${req.credentials.secretAccessKey}`, date), req.region), req.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${req.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

/** Parses a stored AWS credential: JSON `{accessKeyId, secretAccessKey, sessionToken?}` or `KEY_ID:SECRET[:TOKEN]`. */
export function parseAwsCredential(value: string | null | undefined): AwsCredentials | null {
  if (!value) return null;
  const v = value.trim();
  if (v.startsWith('{')) {
    try {
      const j = JSON.parse(v) as Record<string, string>;
      const accessKeyId = j.accessKeyId ?? j.aws_access_key_id ?? j.AccessKeyId;
      const secretAccessKey = j.secretAccessKey ?? j.aws_secret_access_key ?? j.SecretAccessKey;
      if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey, sessionToken: j.sessionToken ?? j.aws_session_token ?? j.SessionToken };
    } catch {
      return null;
    }
    return null;
  }
  const [accessKeyId, secretAccessKey, sessionToken] = v.split(':');
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined } : null;
}

/**
 * Credentials for health checks, in the order the AWS CLI/SDKs use for static keys: the credential
 * stored for this provider, the AWS_* environment variables, then the shared credentials file profile.
 * SSO, process and instance credentials are not resolved here (the agent still can); null then.
 */
export function resolveAwsCredentials(stored: string | null, profile?: string, env: NodeJS.ProcessEnv = process.env): { credentials: AwsCredentials; source: string } | null {
  const fromStore = parseAwsCredential(stored);
  if (fromStore) return { credentials: fromStore, source: 'worker credential store' };
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined }, source: 'environment' };
  }
  const file = env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), '.aws', 'credentials');
  const name = profile ?? env.AWS_PROFILE ?? 'default';
  try {
    const ini = parseIni(fs.readFileSync(file, 'utf8'));
    const p = ini[name];
    if (p?.aws_access_key_id && p.aws_secret_access_key) {
      return { credentials: { accessKeyId: p.aws_access_key_id, secretAccessKey: p.aws_secret_access_key, sessionToken: p.aws_session_token }, source: `profile "${name}"` };
    }
  } catch {
    /* no shared credentials file */
  }
  return null;
}

function parseIni(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = /^\[(?:profile\s+)?([^\]]+)\]$/.exec(line);
    if (s) {
      section = out[s[1]!.trim()] ??= {};
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (kv && section) section[kv[1]!.trim().toLowerCase()] = kv[2]!.trim();
  }
  return out;
}

// ── Google OAuth 2.0 (service account JWT / authorized user refresh token) ──────────────────────

export type GoogleCredential =
  | { type: 'service_account'; client_email: string; private_key: string; token_uri?: string; project_id?: string }
  | { type: 'authorized_user'; client_id: string; client_secret: string; refresh_token: string; quota_project_id?: string; token_uri?: string };

/** Parses a Google credential JSON (service-account key or gcloud application-default credentials). */
export function parseGoogleCredential(value: string | null | undefined): GoogleCredential | null {
  if (!value) return null;
  try {
    const j = JSON.parse(value) as Record<string, string>;
    if (j.type === 'service_account' && j.client_email && j.private_key) return j as unknown as GoogleCredential;
    if (j.type === 'authorized_user' && j.client_id && j.client_secret && j.refresh_token) return j as unknown as GoogleCredential;
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * A Google credential for health checks: the one stored for this provider, the file named by
 * GOOGLE_APPLICATION_CREDENTIALS, then gcloud's application-default credentials file.
 */
export function resolveGoogleCredential(stored: string | null, env: NodeJS.ProcessEnv = process.env): { credential: GoogleCredential; source: string } | null {
  const fromStore = parseGoogleCredential(stored);
  if (fromStore) return { credential: fromStore, source: 'worker credential store' };
  const adc =
    process.platform === 'win32'
      ? path.join(env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud', 'application_default_credentials.json')
      : path.join(env.CLOUDSDK_CONFIG ?? path.join(os.homedir(), '.config', 'gcloud'), 'application_default_credentials.json');
  for (const [file, source] of [
    [env.GOOGLE_APPLICATION_CREDENTIALS, 'GOOGLE_APPLICATION_CREDENTIALS'],
    [adc, 'gcloud application-default credentials'],
  ] as const) {
    if (!file) continue;
    try {
      const c = parseGoogleCredential(fs.readFileSync(file, 'utf8'));
      if (c) return { credential: c, source };
    } catch {
      /* not there */
    }
  }
  return null;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Exchanges a Google credential for an access token (scope cloud-platform). */
export async function googleAccessToken(cred: GoogleCredential, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<{ accessToken: string; expiresAt: number }> {
  const tokenUri = cred.token_uri ?? 'https://oauth2.googleapis.com/token';
  let body: URLSearchParams;
  if (cred.type === 'service_account') {
    const iat = Math.floor(now / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: cred.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: tokenUri, iat, exp: iat + 3600 }));
    const signature = b64url(rsaSign('RSA-SHA256', Buffer.from(`${header}.${claims}`), cred.private_key));
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` });
  } else {
    body = new URLSearchParams({ grant_type: 'refresh_token', client_id: cred.client_id, client_secret: cred.client_secret, refresh_token: cred.refresh_token });
  }
  const res = await fetchImpl(tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new AppError('UNAUTHENTICATED', `Google token exchange failed: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  return { accessToken: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
}
