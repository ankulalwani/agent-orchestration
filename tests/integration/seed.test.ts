/** Demo data for a new installation (DB-005), as a function and as the API's `seed-demo` command. */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '@ao/core';
import { mongoose } from '@ao/database';
import { clearDatabase, startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { seedDemo, type Services } from '@ao/server';
import { makeServices } from '../helpers.js';

let s: Services;
let uri: string;
beforeAll(async () => {
  uri = await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);

describe('seed-demo', () => {
  it('creates an administrator, an organization, a project and a skill, only in an empty database', async () => {
    await clearDatabase();
    const r = await seedDemo(s, { email: 'admin@demo.test', password: 'demo-password-1' });
    const login = await s.auth.login('admin@demo.test', 'demo-password-1', {});
    expect(login.user.platformAdmin).toBe(true);
    const actor = { userId: r.userId, organizationId: r.organizationId, role: 'OWNER' as const, correlationId: 't' };
    expect((await s.projects.get(actor, r.projectId)).knowledge).toContain('Run the tests');
    expect((await s.capabilities.list(actor)).map((c) => c.capabilityId)).toContain('conventional-commits');
    await expect(seedDemo(s, { email: 'other@demo.test', password: 'demo-password-2' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await clearDatabase();
    await expect(seedDemo(s, { email: 'x@demo.test', password: 'short' })).rejects.toThrow(/at least 10/);
  });

  it('runs as `seed-demo` against a real database', async () => {
    const db = `seed_cmd_${Date.now()}`;
    const base = uri.replace(/\/?(\?.*)?$/, '');
    const r = await runCommand(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'apps/api/src/main.ts', 'seed-demo'], {
      timeoutMs: 90_000,
      env: { ...process.env, MONGODB_URI: `${base}/${db}`, JWT_SECRET: 'j'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(64), SEED_ADMIN_EMAIL: 'cmd@demo.test', SEED_ADMIN_PASSWORD: 'demo-password-3', NODE_ENV: 'test' },
    });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('Demo data created. Sign in as cmd@demo.test');
    const users = await mongoose.connection.client.db(db).collection('users').find().toArray();
    expect(users.map((u) => u.email)).toEqual(['cmd@demo.test']);
    const again = await runCommand(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'apps/api/src/main.ts', 'seed-demo'], {
      timeoutMs: 90_000,
      env: { ...process.env, MONGODB_URI: `${base}/${db}`, JWT_SECRET: 'j'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(64), SEED_ADMIN_EMAIL: 'cmd2@demo.test', SEED_ADMIN_PASSWORD: 'demo-password-4', NODE_ENV: 'test' },
    });
    expect(again.exitCode).not.toBe(0);
    expect(again.stdout + again.stderr).toMatch(/already has users/);

    // The other one-off command, reencrypt-secrets, runs through the same dispatch.
    const reenc = await runCommand(process.execPath, [path.resolve('node_modules/tsx/dist/cli.mjs'), 'apps/api/src/main.ts', 'reencrypt-secrets'], {
      timeoutMs: 90_000,
      env: { ...process.env, MONGODB_URI: `${base}/${db}`, JWT_SECRET: 'j'.repeat(40), ENCRYPTION_KEY: 'e'.repeat(64), NODE_ENV: 'test' },
    });
    expect(reenc.exitCode, reenc.stderr).toBe(0);
    expect(reenc.stdout).toContain('All secrets use the current key');
  }, 120_000);
});
