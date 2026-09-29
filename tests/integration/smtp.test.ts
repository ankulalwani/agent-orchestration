/**
 * Real SMTP delivery (NOTIFY-002): the production mailer (nodemailer) against a local SMTP server
 * with authentication, instead of the in-memory capture mailer used elsewhere.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer } from 'smtp-server';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { MemoryQueue } from '@ao/queue';
import { createServices, type Services } from '@ao/server';
import { testConfig } from '../helpers.js';

interface Received {
  from: string;
  to: string[];
  raw: string;
  user: string | undefined;
}
const inbox: Received[] = [];
let smtp: SMTPServer;
let port = 0;

beforeAll(async () => {
  await startTestDatabase();
  smtp = new SMTPServer({
    disabledCommands: ['STARTTLS'],
    authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _session, cb) {
      if (auth.username === 'mailer' && auth.password === 'mail-pass') return cb(null, { user: auth.username });
      cb(new Error('Invalid username or password'));
    },
    onData(stream, session, cb) {
      let raw = '';
      stream.on('data', (c) => (raw += c));
      stream.on('end', () => {
        inbox.push({ from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '', to: session.envelope.rcptTo.map((r) => r.address), raw, user: session.user as string | undefined });
        cb();
      });
    },
  });
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  port = (smtp.server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => smtp.close(() => r()));
  await stopTestDatabase();
});

const services = (smtpUrl: string) =>
  createServices(testConfig({ SMTP_URL: smtpUrl, SMTP_FROM: 'Orchestration <noreply@orchestration.test>', WEB_URL: 'https://app.test' }), { queue: new MemoryQueue() });
const waitForMail = async (to: string) => {
  for (let i = 0; i < 50; i++) {
    const m = inbox.find((x) => x.to.includes(to));
    if (m) return m;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no mail for ${to}`);
};
/** Quoted-printable soft line breaks would split long links; undo them for assertions. */
const body = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

describe('SMTP delivery (NOTIFY-002)', () => {
  it('sends registration, password-reset and invitation emails through an authenticated SMTP server', async () => {
    const s: Services = await services(`smtp://mailer:mail-pass@127.0.0.1:${port}`);
    expect((s.mailer as { configured?: boolean }).configured).toBe(true);
    const email = `smtp-${Date.now()}@example.com`;
    const reg = await s.auth.register({ email, password: 'smtp-password-123', name: 'Smtp' });

    const verify = await waitForMail(email);
    expect(verify).toMatchObject({ from: 'noreply@orchestration.test', user: 'mailer' });
    expect(verify.raw).toMatch(/Subject: Verify your email/);
    const token = /verify-email\?token=([A-Za-z0-9_-]+)/.exec(body(verify.raw))![1]!;
    await s.auth.verifyEmail(token); // the emailed link works

    inbox.length = 0;
    await s.auth.requestPasswordReset(email);
    expect(body((await waitForMail(email)).raw)).toContain('https://app.test/reset-password?token=');

    const invitee = `invitee-${Date.now()}@example.com`;
    await s.invitations.addOrInvite({ userId: reg.user.id, organizationId: reg.memberships[0]!.organizationId, role: 'OWNER', correlationId: 't' }, invitee, 'DEVELOPER');
    const inv = await waitForMail(invitee);
    expect(inv.raw).toMatch(/Subject: You're invited to/);
    expect(body(inv.raw)).toContain('https://app.test/invite?token=');
  });

  it('a mail-server outage or rejected login never fails the request, and password reset still answers the same', async () => {
    for (const url of [`smtp://mailer:wrong-pass@127.0.0.1:${port}`, 'smtp://127.0.0.1:1']) {
      const s = await services(url);
      const email = `down-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
      const before = inbox.length;
      const session = await s.auth.register({ email, password: 'down-password-123', name: 'Down' }); // not a 500
      expect(session.user.email).toBe(email);
      // Resolves (no 500) exactly like it does for an unknown address.
      await expect(s.auth.requestPasswordReset(email)).resolves.toBeDefined();
      await expect(s.auth.requestPasswordReset(`unknown-${Date.now()}@example.com`)).resolves.toBeDefined();
      expect(inbox.length).toBe(before);
    }
  });
});
