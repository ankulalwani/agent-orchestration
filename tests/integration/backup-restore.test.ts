/**
 * Backup/restore drill (DEPLOY-003) with the real MongoDB Database Tools, following
 * docs/self-hosting/backup-restore.md: mongodump → lose the database → mongorestore → restart → verify.
 * Runs when mongodump/mongorestore are available (AO_TEST_MONGO_TOOLS or .tools/mongotools/…/bin).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, Secret, Task, TaskEvent, User, ensureIndexes, mongoose, runMigrations } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import { expireLease, makeOwner, makeServices, makeWorker } from '../helpers.js';

function toolsBin(): string | null {
  if (process.env.AO_TEST_MONGO_TOOLS) return process.env.AO_TEST_MONGO_TOOLS;
  const root = path.resolve('.tools/mongotools');
  if (!fs.existsSync(root)) return null;
  const dir = fs.readdirSync(root).map((d) => path.join(root, d, 'bin')).find((b) => fs.existsSync(path.join(b, process.platform === 'win32' ? 'mongodump.exe' : 'mongodump')));
  return dir ?? null;
}
const BIN = toolsBin();
const execFileAsync = promisify(execFile);
const exe = (name: string) => path.join(BIN!, process.platform === 'win32' ? `${name}.exe` : name);
/**
 * Run a Database Tools command; on failure, show what the tool said. Asynchronous on purpose: the
 * test mongod is a child of this process and logs through a pipe that this event loop drains — a
 * blocking execFileSync lets that pipe fill, mongod stalls, and mongorestore times out.
 */
async function tool(name: string, args: string[]) {
  try {
    await execFileAsync(exe(name), args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const out = String((e as { stderr?: string }).stderr ?? e);
    const lines = out.split('\n').filter((l) => /failed|error/i.test(l));
    throw new Error(`${name} failed: ${(lines.length ? lines.join('\n') : out).slice(0, 2000)}`);
  }
}

describe.runIf(BIN)('backup and restore drill (real mongodump / mongorestore)', () => {
  let uri = '';
  let s: Services;

  beforeAll(async () => {
    uri = await startTestDatabase();
    // Same ENCRYPTION_KEY before and after, as the runbook requires.
    s = (await makeServices({ ENCRYPTION_KEY: 'a'.repeat(64) })).services;
  }, 60_000);
  afterAll(stopTestDatabase);

  it('restores everything the application needs, and the control plane works on the restored data', async () => {
    const db = mongoose.connection.name;
    // ── Realistic data ──────────────────────────────────────────────────────────────────────
    const { actor, auth } = await makeOwner(s, 'drill');
    const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: 'Use pnpm' });
    await s.queries.putSecret(actor, 'PAYMENT_API_KEY', 'pay-live-drill-value-1234');
    const mfaUser = await s.auth.register({ email: `mfa-drill-${Date.now()}@example.com`, password: 'drill-password-123', name: 'M' });
    const { secret } = await s.auth.setupMfa(mfaUser.user.id);
    await s.auth.enableMfa(mfaUser.user.id, totp(secret));
    const w = await makeWorker(s, actor, project.id);
    const done = await s.tasks.create(actor, { projectId: project.id, title: 'finished before the backup', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.action(actor, done.id, { action: 'cancel' });
    const running = await s.tasks.create(actor, { projectId: project.id, title: 'running during the backup', prompt: 'p', priority: 'HIGH', dependencies: [], requirements: {}, capabilityIds: [] });
    await s.tasks.claim(w.worker, running.id);
    await s.tasks.transition(w.worker, running.id, { to: 'PREPARING', transitionId: randomUUID(), patch: {} });
    const checkpoint = { taskId: running.id, phase: 'implement', completedSteps: ['a', 'b'], remainingSteps: ['c'], changedFiles: ['x.ts'], testsRun: [], knownIssues: [], nextAction: 'c', createdAt: new Date().toISOString() };
    await s.tasks.transition(w.worker, running.id, { to: 'RUNNING', transitionId: randomUUID(), patch: { lastCheckpoint: checkpoint } });
    const before = {
      users: await User.countDocuments(),
      tasks: await Task.countDocuments(),
      events: await TaskEvent.countDocuments(),
      audit: await AuditLog.countDocuments(),
    };

    // ── Backup (docs: mongodump --archive --gzip --db …) ─────────────────────────────────────
    const archive = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-backup-')), `backup-${Date.now()}.archive.gz`);
    await tool('mongodump', ['--uri', uri, '--db', db, `--archive=${archive}`, '--gzip']);
    expect(fs.statSync(archive).size).toBeGreaterThan(1000);

    // ── A separate-database test restore first, as the runbook recommends ────────────────────
    const scratch = `${db}_restore_check`;
    await tool('mongorestore', ['--uri', uri, `--archive=${archive}`, '--gzip', `--nsFrom=${db}.*`, `--nsTo=${scratch}.*`]);
    const scratchDb = mongoose.connection.client.db(scratch);
    expect(await scratchDb.collection('tasks').countDocuments()).toBe(before.tasks);
    await scratchDb.dropDatabase();

    // ── Disaster: the database is gone ───────────────────────────────────────────────────────
    await mongoose.connection.db!.dropDatabase();
    expect(await User.countDocuments()).toBe(0);

    // ── Restore (docs: mongorestore --archive --gzip --drop) and "restart the control plane" ──
    await tool('mongorestore', ['--uri', uri, `--archive=${archive}`, '--gzip', '--drop']);
    await runMigrations();
    await ensureIndexes();
    const restored = (await makeServices({ ENCRYPTION_KEY: 'a'.repeat(64) })).services;

    // ── Everything is back ──────────────────────────────────────────────────────────────────
    expect({ users: await User.countDocuments(), tasks: await Task.countDocuments(), events: await TaskEvent.countDocuments(), audit: await AuditLog.countDocuments() }).toEqual(before);
    // Sign-in works (password hashes), including two-factor accounts (encrypted TOTP secret).
    expect((await restored.auth.login(auth.user.email, 'correct-horse-battery')).user.id).toBe(auth.user.id);
    await expect(restored.auth.login(mfaUser.user.email, 'drill-password-123')).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
    expect((await restored.auth.login(mfaUser.user.email, 'drill-password-123', {}, totp(secret, Date.now() + 30_000))).user.id).toBe(mfaUser.user.id);
    // Organization secrets decrypt with the same ENCRYPTION_KEY.
    const sec = await Secret.findOne({ name: 'PAYMENT_API_KEY' }).select('+valueEnc').lean();
    expect(restored.box.decrypt(sec!.valueEnc)).toBe('pay-live-drill-value-1234');
    // Unique indexes are in force again.
    await expect(restored.auth.register({ email: auth.user.email, password: 'another-password-1', name: 'Dup' })).rejects.toMatchObject({ code: 'CONFLICT' });
    // Timeline and project data survived.
    const restoredActor: Actor = { ...actor };
    expect((await restored.tasks.events(restoredActor, done.id, { limit: 100 })).items.length).toBeGreaterThan(0);
    expect((await restored.projects.get(restoredActor, project.id)).knowledge).toBe('Use pnpm');
    // The task that was running during the backup is recovered by lease expiry, from its checkpoint.
    await expireLease(running.id);
    expect(await restored.tasks.sweepExpiredLeases()).toBe(1);
    const recovered = await restored.tasks.get(restoredActor, running.id);
    expect(recovered.status).toBe('QUEUED');
    expect(recovered.lastCheckpoint?.completedSteps).toEqual(['a', 'b']);
    // And the control plane keeps working: new work can be created on the restored data.
    const fresh = await restored.tasks.create(restoredActor, { projectId: project.id, title: 'after restore', prompt: 'p', priority: 'NORMAL', dependencies: [], requirements: {}, capabilityIds: [] });
    expect(fresh.status).toBe('QUEUED');
  }, 120_000);
});
