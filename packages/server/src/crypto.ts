import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, o, (e, k) => (e ? rej(e) : res(k))));

/** Password hashing (decision D-004). Format: scrypt$N$r$p$salt$hash (base64url). */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A dummy hash so login timing doesn't reveal whether an email exists. */
export const DUMMY_PASSWORD_HASH = `scrypt$${N}$${R}$${P}$${randomBytes(16).toString('base64url')}$${randomBytes(64).toString('base64url')}`;

function parseKey(keyMaterial: string, label: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(keyMaterial) ? Buffer.from(keyMaterial, 'hex') : Buffer.from(keyMaterial, 'base64');
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes (64 hex chars or 44 base64 chars)`);
  return key;
}

/** Short, non-secret key identifier stored with each ciphertext so the right key can be chosen. */
export const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/**
 * AES-256-GCM encryption for control-plane secrets at rest (spec §59), with key rotation.
 * Format: `v2.<keyId>.<iv>.<tag>.<ciphertext>`. New values use the current key; previous keys only
 * decrypt. Legacy `v1` values (no key id) are tried against every key.
 */
export class SecretBox {
  private current: Buffer;
  readonly currentKeyId: string;
  private keys = new Map<string, Buffer>();

  constructor(keyMaterial: string, previousKeys: string[] = []) {
    this.current = parseKey(keyMaterial, 'ENCRYPTION_KEY');
    this.currentKeyId = keyId(this.current);
    this.keys.set(this.currentKeyId, this.current);
    for (const k of previousKeys) {
      const key = parseKey(k, 'ENCRYPTION_KEYS_PREVIOUS entry');
      if (!this.keys.has(keyId(key))) this.keys.set(keyId(key), key);
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.current, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v2', this.currentKeyId, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts[0] === 'v2' && parts.length === 5) {
      const key = this.keys.get(parts[1]!);
      if (!key) throw new Error(`No key configured for key id ${parts[1]}. Add the old key to ENCRYPTION_KEYS_PREVIOUS.`);
      return open(key, parts[2]!, parts[3]!, parts[4]!);
    }
    if (parts[0] === 'v1' && parts.length === 4) {
      for (const key of this.keys.values()) {
        try {
          return open(key, parts[1]!, parts[2]!, parts[3]!);
        } catch {
          /* try the next key */
        }
      }
      throw new Error('No configured key decrypts this value. Add the old key to ENCRYPTION_KEYS_PREVIOUS.');
    }
    throw new Error('Unsupported ciphertext');
  }

  /** True when the value is already encrypted with the current key. */
  isCurrent(payload: string) {
    return payload.startsWith(`v2.${this.currentKeyId}.`);
  }
}

function open(key: Buffer, iv: string, tag: string, ct: string) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
