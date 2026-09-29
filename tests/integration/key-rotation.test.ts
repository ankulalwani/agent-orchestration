import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { Secret } from '@ao/database';
import { SecretBox, reencryptSecrets } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

beforeAll(startTestDatabase);
afterAll(stopTestDatabase);

describe('ENCRYPTION_KEY rotation (SEC-007)', () => {
  it('re-encrypts every secret with the new key; the old key is then no longer needed', async () => {
    const oldKey = randomBytes(32).toString('hex');
    const newKey = randomBytes(32).toString('hex');
    const { services: s } = await makeServices({ ENCRYPTION_KEY: oldKey });
    const { actor } = await makeOwner(s);
    await s.queries.putSecret(actor, 'PAYMENT_API_KEY', 'pay-live-value-1');
    await s.queries.putSecret(actor, 'DB_PASSWORD', 'db-value-2');
    // A value no configured key can read: reported and left untouched.
    await Secret.create({ organizationId: actor.organizationId, name: 'ORPHAN', valueEnc: new SecretBox(randomBytes(32).toString('hex')).encrypt('x'), masked: '••••' });
    const orphanBefore = (await Secret.findOne({ name: 'ORPHAN' }).select('+valueEnc').lean())!.valueEnc;

    const rotating = new SecretBox(newKey, [oldKey]);
    const r = await reencryptSecrets(rotating);
    expect(r).toMatchObject({ reencrypted: 2, alreadyCurrent: 0 });
    expect(r.failed.map((f) => f.name)).toEqual(['ORPHAN']);
    expect((await Secret.findOne({ name: 'ORPHAN' }).select('+valueEnc').lean())!.valueEnc).toBe(orphanBefore);

    // Only the new key is needed now.
    const onlyNew = new SecretBox(newKey);
    const values = Object.fromEntries(
      (await Secret.find({ name: { $ne: 'ORPHAN' } }).select('+valueEnc').lean()).map((x) => [x.name, onlyNew.decrypt(x.valueEnc)]),
    );
    expect(values).toEqual({ PAYMENT_API_KEY: 'pay-live-value-1', DB_PASSWORD: 'db-value-2' });

    // Idempotent.
    expect(await reencryptSecrets(rotating)).toMatchObject({ reencrypted: 0, alreadyCurrent: 2 });
  });

  it('services use ENCRYPTION_KEYS_PREVIOUS from configuration', async () => {
    const [oldKey, newKey] = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')];
    const { services: s } = await makeServices({ ENCRYPTION_KEY: newKey, ENCRYPTION_KEYS_PREVIOUS: ` ${oldKey} , ` });
    expect(s.box.decrypt(new SecretBox(oldKey).encrypt('v'))).toBe('v');
    expect(s.config.ENCRYPTION_KEYS_PREVIOUS).toEqual([oldKey]);
  });
});
