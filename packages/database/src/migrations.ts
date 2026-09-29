import mongoose from 'mongoose';
import { createLogger, repositoryKey, repositoryName, sanitizeRepositoryName } from '@ao/core';

const log = createLogger('migrations');

/**
 * Data migrations (spec §69 database/migrations). Applied in id order, each at most once, recorded in
 * `_migrations`. A lease-style lock ensures only one API instance migrates at a time; a crashed
 * instance's lock expires. Migrations must be idempotent (they may be retried after a crash).
 */
export interface Migration {
  id: string; // e.g. "0002-add-task-foo" — sorted lexicographically
  description: string;
  up(db: mongoose.mongo.Db): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001-baseline',
    description: 'Baseline schema (indexes are created by ensureIndexes)',
    async up() {},
  },
  {
    id: '0002-task-counters',
    description: 'Backfill task counters added after the first schema version',
    async up(db) {
      for (const field of ['remediationCount', 'contextResetCount', 'limitHitCount', 'restartCount', 'retryCount', 'activeMs']) {
        await db.collection('tasks').updateMany({ [field]: { $exists: false } }, { $set: { [field]: 0 } });
      }
    },
  },
  {
    id: '0003-unique-identities',
    description: 'Replace the non-unique external-identity index with a unique one (OAuth sign-in)',
    async up(db) {
      const users = db.collection('users');
      const existing = await users.indexes().catch(() => []);
      if (existing.some((i) => i.name === 'identities.provider_1_identities.subject_1')) await users.dropIndex('identities.provider_1_identities.subject_1');
    },
  },
  {
    id: '0004-project-repositories',
    description: 'Give every project a primary repository (from repositoryUrl) and tie worker paths to it',
    async up(db) {
      const projects = db.collection('projects');
      for await (const p of projects.find({ $or: [{ repositories: { $exists: false } }, { repositories: { $size: 0 } }] })) {
        const repo = {
          _id: new mongoose.Types.ObjectId(),
          name: repositoryName(p.repositoryUrl, sanitizeRepositoryName(String(p.name ?? 'repository'))),
          key: repositoryKey(p.repositoryUrl),
          url: p.repositoryUrl ?? null,
          defaultBranch: p.defaultBranch ?? 'main',
          primary: true,
          source: 'manual',
          github: null,
        };
        const workerPaths = ((p.workerPaths ?? []) as Array<Record<string, unknown>>).map((w) => ({ ...w, repositoryId: w.repositoryId ?? repo._id }));
        // Conditional on the state read, so a retry after a crash never adds a second primary repository.
        await projects.updateOne({ _id: p._id, $or: [{ repositories: { $exists: false } }, { repositories: { $size: 0 } }] }, { $set: { repositories: [repo], workerPaths } });
      }
    },
  },
];

const LOCK_ID = '__lock__';

export async function runMigrations(migrations: Migration[] = MIGRATIONS, opts: { lockTtlMs?: number; owner?: string } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');
  const col = db.collection<{ _id: string; appliedAt?: Date; description?: string; owner?: string; expiresAt?: Date }>('_migrations');
  const owner = opts.owner ?? `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  // Acquire (or take over an expired) lock atomically.
  let lock;
  try {
    lock = await col.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ expiresAt: { $lt: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + (opts.lockTtlMs ?? 5 * 60_000)) } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (e: any) {
    if (e?.code === 11000) return { applied: [] as string[], skipped: 'locked' as const };
    throw e;
  }
  if (!lock) return { applied: [] as string[], skipped: 'locked' as const };
  const applied: string[] = [];
  try {
    const done = new Set((await col.find({ _id: { $ne: LOCK_ID } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
    for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
      if (done.has(m.id)) continue;
      log.info({ id: m.id }, 'applying migration');
      await m.up(db);
      await col.insertOne({ _id: m.id, appliedAt: new Date(), description: m.description });
      applied.push(m.id);
    }
  } finally {
    await col.deleteOne({ _id: LOCK_ID, owner });
  }
  return { applied, skipped: null };
}
