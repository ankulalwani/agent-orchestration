import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { makeServices } from '../helpers.js';

beforeAll(startTestDatabase);
afterAll(stopTestDatabase);

describe('email verification (AUTH-004)', () => {
  it('blocks login until the emailed link is used when verification is required', async () => {
    const { services: s, sent } = await makeServices({ REQUIRE_EMAIL_VERIFICATION: 'true' });
    const email = `verify-${Date.now()}@example.com`;
    await s.auth.register({ email, password: 'verify-password-1', name: 'V' });
    await expect(s.auth.login(email, 'verify-password-1')).rejects.toThrow(/verify your email/);
    const mail = sent.find((m) => m.to === email && /Verify your email/.test(m.subject))!;
    const token = /token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    await s.auth.verifyEmail(token);
    expect((await s.auth.login(email, 'verify-password-1')).user.emailVerified).toBe(true);
    await expect(s.auth.verifyEmail(token)).rejects.toThrow(/invalid or has expired/); // single use
  });
});
