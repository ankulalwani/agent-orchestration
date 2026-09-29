import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export const newId = () => randomUUID();
export const newCorrelationId = () => `cor_${randomUUID().replace(/-/g, '')}`;

/** Human-friendly device code, e.g. "ABCD-1234" (ambiguous characters removed). */
export function newDeviceCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const b = randomBytes(8);
  const letters = Array.from(b.subarray(0, 4), (x) => alphabet[x % alphabet.length]).join('');
  const nums = Array.from(b.subarray(4, 8), (x) => digits[x % digits.length]).join('');
  return `${letters}-${nums}`;
}

export const newSecretToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
