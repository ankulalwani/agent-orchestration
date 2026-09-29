/**
 * Platform administrators on installations where the public signs up first: FIRST_USER_IS_PLATFORM_ADMIN=false
 * and the `platform-admin` command. Also: organization notices can be sent by email.
 */
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, User, mongoose } from '@ao/database';
import { makeServices } from '../helpers.js';

let uri = '';
beforeAll(async () => {
  const base = await startTestDatabase();
  uri = base.replace(/\/?$/, '/') + mongoose.connection.name;
});
afterAll(stopTestDatabase);

describe('platform administrators', () => {
  it('the first account is not an administrator when FIRST_USER_IS_PLATFORM_ADMIN=false', async () => {
    await User.deleteMany({});
    const { services } = await makeServices({ FIRST_USER_IS_PLATFORM_ADMIN: 'false' });
    const r = await services.auth.register({ email: 'first-customer@example.com', password: 'customer-password-1', name: 'First' });
    expect(r.user.platformAdmin).toBe(false);
  });

  it('the first account is an administrator by default (self-hosted bootstrap)', async () => {
    await User.deleteMany({});
    const { services } = await makeServices();
    const r = await services.auth.register({ email: 'installer@example.com', password: 'installer-password-1', name: 'Installer' });
    expect(r.user.platformAdmin).toBe(true);
  });

  it('`platform-admin <email>` grants and `--revoke` removes the role, audited', async () => {
    const { services } = await makeServices();
    await services.auth.register({ email: 'staff@example.com', password: 'staff-password-123', name: 'Staff' });
    const run = (...args: string[]) =>
      runCommand(process.execPath, ['--import', 'tsx', path.resolve('apps/api/src/main.ts'), 'platform-admin', ...args], {
        env: { ...process.env, MONGODB_URI: uri, JWT_SECRET: 'x'.repeat(40), ENCRYPTION_KEY: 'a'.repeat(64), LOG_LEVEL: 'silent' },
        timeoutMs: 60_000,
      });
    const granted = await run('Staff@Example.com');
    expect(granted.exitCode, granted.stderr).toBe(0);
    expect((await User.findOne({ email: 'staff@example.com' }).lean())?.platformAdmin).toBe(true);
    const revoked = await run('staff@example.com', '--revoke');
    expect(revoked.exitCode, revoked.stderr).toBe(0);
    expect((await User.findOne({ email: 'staff@example.com' }).lean())?.platformAdmin).toBe(false);
    expect(await AuditLog.countDocuments({ action: { $in: ['user.platform_admin_granted', 'user.platform_admin_revoked'] } })).toBe(2);
    const missing = await run('nobody@example.com');
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('must sign up first');
  }, 120_000);
});

describe('organization notices', () => {
  it('are delivered in-app to the chosen roles and by email when asked', async () => {
    const { services, sent } = await makeServices();
    const r = await services.auth.register({ email: `owner-${Date.now()}@example.com`, password: 'owner-password-123', name: 'Owner' });
    const orgId = r.memberships[0]!.organizationId;
    await services.notifications.notify({ organizationId: orgId, type: 'organization.notice', title: 'Your trial ends in 3 days', body: 'Choose a plan.', roles: ['OWNER'], email: true });
    expect(sent.find((m) => m.subject === 'Your trial ends in 3 days')?.to).toBe(r.user.email);
    await services.notifications.notify({ organizationId: orgId, type: 'organization.notice', title: 'In-app only', roles: ['OWNER'] });
    expect(sent.some((m) => m.subject === 'In-app only')).toBe(false);
  });
});
