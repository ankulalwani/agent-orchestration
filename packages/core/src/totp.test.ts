import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newRecoveryCodes, normalizeRecoveryCode, totp, totpUri, verifyTotp } from './totp.js';

// RFC 6238 Appendix B test secret ("12345678901234567890", SHA-1).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vectors (last 6 digits)', () => {
    for (const [t, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']] as const) {
      expect(totp(RFC_SECRET, t * 1000)).toBe(expected);
    }
    expect(hotp(RFC_SECRET, 0)).toBe('755224'); // RFC 4226 vector
  });

  it('round-trips base32', () => {
    const b = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
    expect(base32Decode(base32Encode(b))).toEqual(b);
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('accepts ±1 step of drift, rejects others, and never accepts a step twice', () => {
    const at = 1_700_000_000_000;
    const now = verifyTotp(RFC_SECRET, totp(RFC_SECRET, at), { at });
    expect(now).not.toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at - 30_000), { at })).toBe(now! - 1);
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at - 90_000), { at })).toBeNull();
    expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, at), { at, afterStep: now })).toBeNull(); // replay
    expect(verifyTotp(RFC_SECRET, '12345', { at })).toBeNull();
    expect(verifyTotp(RFC_SECRET, `${totp(RFC_SECRET, at).slice(0, 3)} ${totp(RFC_SECRET, at).slice(3)}`, { at })).toBe(now);
  });

  it('builds otpauth URIs and unique recovery codes', () => {
    expect(totpUri('ABC', 'a@b.c')).toBe('otpauth://totp/Agent%20Orchestration%3Aa%40b.c?secret=ABC&issuer=Agent%20Orchestration&algorithm=SHA1&digits=6&period=30');
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    expect(normalizeRecoveryCode(` ${codes[0]!.toUpperCase()} `)).toBe(codes[0]!.replace('-', ''));
  });
});
