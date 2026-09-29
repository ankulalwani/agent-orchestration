import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, keyId } from './crypto.js';

const k = () => randomBytes(32).toString('hex');

describe('SecretBox key rotation (SEC-007)', () => {
  it('encrypts with the current key and records its id', () => {
    const key = k();
    const box = new SecretBox(key);
    const c = box.encrypt('s3cr3t');
    expect(c.startsWith(`v2.${keyId(Buffer.from(key, 'hex'))}.`)).toBe(true);
    expect(box.isCurrent(c)).toBe(true);
    expect(box.decrypt(c)).toBe('s3cr3t');
    expect(box.encrypt('s3cr3t')).not.toBe(c); // random IV
  });

  it('a new key decrypts old values only while the old key is listed as previous', () => {
    const [oldKey, newKey] = [k(), k()];
    const c = new SecretBox(oldKey).encrypt('value');
    const rotated = new SecretBox(newKey, [oldKey]);
    expect(rotated.decrypt(c)).toBe('value');
    expect(rotated.isCurrent(c)).toBe(false);
    expect(rotated.isCurrent(rotated.encrypt('value'))).toBe(true);
    expect(() => new SecretBox(newKey).decrypt(c)).toThrow(/ENCRYPTION_KEYS_PREVIOUS/);
  });

  it('reads legacy v1 values (no key id) with any configured key', () => {
    const [oldKey, newKey] = [k(), k()];
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(oldKey, 'hex'), iv);
    const ct = Buffer.concat([cipher.update('legacy', 'utf8'), cipher.final()]);
    const v1 = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    expect(new SecretBox(newKey, [oldKey]).decrypt(v1)).toBe('legacy');
    expect(() => new SecretBox(newKey).decrypt(v1)).toThrow(/No configured key/);
  });

  it('rejects tampered ciphertext and malformed keys', () => {
    const box = new SecretBox(k());
    const c = box.encrypt('value').split('.');
    c[4] = Buffer.from('tampered').toString('base64url');
    expect(() => box.decrypt(c.join('.'))).toThrow();
    expect(() => new SecretBox(k(), ['short'])).toThrow(/ENCRYPTION_KEYS_PREVIOUS/);
  });
});
