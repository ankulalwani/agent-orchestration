import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, User } from '@ao/database';

describe('database smoke', () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  it('connects, builds indexes, enforces unique email and immutable audit', async () => {
    await User.create({ email: 'a@x.io', name: 'A', passwordHash: 'h' });
    await expect(User.create({ email: 'A@x.io', name: 'B', passwordHash: 'h' })).rejects.toThrow(/duplicate/i);
    const a = await AuditLog.create({ actorType: 'system', action: 'test' });
    await expect(AuditLog.updateOne({ _id: a._id }, { action: 'x' })).rejects.toThrow(/immutable/);
    await expect(AuditLog.deleteOne({ _id: a._id })).rejects.toThrow(/immutable/);
  });
});
