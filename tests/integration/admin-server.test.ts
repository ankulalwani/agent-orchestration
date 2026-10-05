/** Read-only server settings for platform administrators (SELFHOST-002): access and secret masking. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { errorReporter } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import { settingsView, type Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices, testConfig } from '../helpers.js';

const SECRETS = {
  JWT_SECRET: 'jwt-secret-value-that-is-long-enough-123',
  ENCRYPTION_KEY: 'b'.repeat(64),
  ENCRYPTION_KEYS_PREVIOUS: 'c'.repeat(64),
  OIDC_CLIENT_SECRET: 'oidc-client-secret-value',
  S3_ACCESS_KEY_ID: 's3-access-key-id-value',
  S3_SECRET_ACCESS_KEY: 's3-secret-access-key-value',
  EMBEDDINGS_API_KEY: 'embeddings-api-key-value',
};
const URLS = {
  MONGODB_URI: 'mongodb://dbuser:db-password-value@db.internal:27017/ao',
  REDIS_URL: 'redis://:redis-password-value@cache.internal:6379',
  SMTP_URL: 'smtps://mailer:smtp-password-value@mail.internal:465',
  ERROR_TRACKING_DSN: 'https://dsn-public-key-value@errors.internal/7',
};

let s: Services;
let app: FastifyInstance;
beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices({ ...SECRETS, ...URLS, OIDC_ISSUER: 'https://sso.internal', OIDC_CLIENT_ID: 'client-id-visible', S3_REGION: 'eu-west-1' })).services;
  app = await buildApp(s);
});
afterAll(async () => {
  errorReporter.reset(); // the DSN above configured the global reporter
  await app.close();
  await stopTestDatabase();
});

describe('server settings for administrators', () => {
  it('only platform administrators can see them', async () => {
    const admin = await s.auth.register({ email: `admin-${Date.now()}@example.com`, password: 'admin-password-123', name: 'Admin' }); // first user
    const member = await s.auth.register({ email: `member-${Date.now()}@example.com`, password: 'member-password-123', name: 'Member' });
    expect(admin.user.platformAdmin).toBe(true);
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/admin/server` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/admin/server`, headers: { authorization: `Bearer ${member.accessToken}` } })).statusCode).toBe(403);

    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/admin/server`, headers: { authorization: `Bearer ${admin.accessToken}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const raw = res.body;
    // No secret, and no password inside a URL, appears anywhere in the response.
    for (const v of [...Object.values(SECRETS), 'db-password-value', 'redis-password-value', 'smtp-password-value', 'dsn-public-key-value']) expect(raw).not.toContain(v);
    const get = (k: string) => body.settings.find((x: { key: string }) => x.key === k);
    expect(get('JWT_SECRET')).toMatchObject({ value: 'set', secret: true, group: 'Security' });
    expect(get('ENCRYPTION_KEYS_PREVIOUS')).toMatchObject({ value: 'set (1)', secret: true });
    expect(get('MONGODB_URI').value).toBe('mongodb://dbuser:%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2@db.internal:27017/ao');
    expect(get('SMTP_URL').value).toContain('mailer:');
    expect(get('ERROR_TRACKING_DSN').value).toContain('@errors.internal/7');
    // Non-secret values are shown as they are.
    expect(get('OIDC_CLIENT_ID')).toMatchObject({ value: 'client-id-visible', secret: false, group: 'Sign-in' });
    expect(get('S3_REGION')).toMatchObject({ value: 'eu-west-1', group: 'Storage' });
    // Status summary.
    expect(body.status.database.ok).toBe(true);
    expect(body.status.queue.detail).toMatch(/In-memory/);
    expect(body.status.signIn.detail).toContain('Single sign-on');
    expect(body.status.keyRotation.ok).toBe(false); // a previous key is still configured
  });

  it('every configuration key is listed, with where its value comes from', () => {
    const env = { PORT: '4100' };
    const view = settingsView(testConfig({ PORT: '4100' }), env);
    expect(view.map((v) => v.key)).toEqual(expect.arrayContaining(['PORT', 'MONGODB_URI', 'GOOGLE_CLIENT_SECRET', 'ERROR_TRACKING_DSN', 'FEATURE_FLAGS']));
    expect(view.find((v) => v.key === 'PORT')).toMatchObject({ value: 4100, source: 'environment' });
    expect(view.find((v) => v.key === 'RATE_LIMIT_PER_MINUTE')).toMatchObject({ value: 300, source: 'default', group: 'Limits & scheduling' });
    expect(view.find((v) => v.key === 'GOOGLE_CLIENT_SECRET')).toMatchObject({ value: null, secret: true });
    expect(view.every((v) => v.group !== 'Other')).toBe(true);
  });
});
