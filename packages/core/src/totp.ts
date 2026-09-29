import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s): what authenticator apps use. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new random 160-bit secret, base32-encoded. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, '0');
}

export const totpStep = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);
export const totp = (secret: string, at = Date.now()) => hotp(secret, totpStep(at));

/**
 * Checks a code against the current step ± `window` (clock drift). Returns the matching step, or
 * null. Callers store the step and reject steps ≤ the last one used, so a code works only once.
 */
export function verifyTotp(secret: string, code: string, opts: { at?: number; window?: number; afterStep?: number | null } = {}): number | null {
  const normalized = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = totpStep(opts.at);
  const window = opts.window ?? 1;
  for (let step = current - window; step <= current + window; step++) {
    if (opts.afterStep != null && step <= opts.afterStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, Buffer.from(normalized))) return step;
  }
  return null;
}

/** `otpauth://` URI that authenticator apps import (usually via QR code). */
export function totpUri(secret: string, account: string, issuer = 'Agent Orchestration') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

/** One-time recovery codes, formatted `xxxxx-xxxxx`. */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const s = base32Encode(randomBytes(7)).toLowerCase().slice(0, 10);
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
export const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/[^a-z2-7]/g, '');
