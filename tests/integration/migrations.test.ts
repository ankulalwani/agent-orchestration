import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { MIGRATIONS, ensureIndexes, mongoose, runMigrations, type Migration } from '@ao/database';

beforeAll(startTestDatabase);
afterAll(stopTestDatabase);

describe('migrations (DB-005)', () => {
  it('baseline migrations were applied on connect', async () => {
    const ids = (await mongoose.connection.db!.collection('_migrations').find({}).toArray()).map((d) => d._id);
    expect(ids).toEqual(expect.arrayContaining(['0001-baseline', '0002-task-counters']));
  });

  it('0003 upgrades a database that still has the old non-unique identity index', async () => {
    const users = mongoose.connection.db!.collection('users');
    const m3 = MIGRATIONS.find((m) => m.id === '0003-unique-identities')!;
    // Recreate the pre-upgrade state: old index, no new one.
    await users.dropIndex('identity_unique');
    await users.createIndex({ 'identities.provider': 1, 'identities.subject': 1 }, { sparse: true });
    await m3.up(mongoose.connection.db!);
    await ensureIndexes();
    const idx = (await users.indexes()).find((i) => i.name === 'identity_unique');
    expect(idx).toMatchObject({ unique: true });
    expect((await users.indexes()).some((i) => i.name === 'identities.provider_1_identities.subject_1')).toBe(false);
    await m3.up(mongoose.connection.db!); // idempotent
  });

  it('applies in order, once, and backfills data', async () => {
    const order: string[] = [];
    const ms: Migration[] = [
      { id: '9002-b', description: 'b', up: async () => void order.push('b') },
      { id: '9001-a', description: 'a', up: async (db) => void (order.push('a'), await db.collection('tasks').insertOne({ title: 'legacy' })) },
    ];
    expect((await runMigrations(ms)).applied).toEqual(['9001-a', '9002-b']);
    expect(order).toEqual(['a', 'b']);
    expect((await runMigrations(ms)).applied).toEqual([]); // idempotent
    await runMigrations(); // 0002 backfill is already recorded; re-running built-ins is a no-op
  });

  it('respects a lock held by another instance and takes over an expired one', async () => {
    const col = mongoose.connection.db!.collection('_migrations');
    await col.insertOne({ _id: '__lock__' as never, owner: 'other', expiresAt: new Date(Date.now() + 60_000) });
    const m: Migration[] = [{ id: '9100-x', description: 'x', up: async () => {} }];
    expect(await runMigrations(m)).toMatchObject({ skipped: 'locked' });
    await col.updateOne({ _id: '__lock__' as never }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    expect((await runMigrations(m)).applied).toEqual(['9100-x']);
  });
});
