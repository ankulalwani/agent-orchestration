import { describe, expect, it } from 'vitest';
import { maskSecret, redact, redactString, REDACTED } from './redact.js';
import { AppError } from './errors.js';

describe('secret redaction', () => {
  it.each([
    ['anthropic', 'key sk-ant-api03-abcdefghijklmnop1234'],
    ['openai', 'OPENAI sk-proj-abcdefghijklmnopqrstuvwx'],
    ['openrouter', 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123'],
    ['google', 'AIzaSyA1234567890abcdefghijklmnopqrstu'],
    ['github', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['aws', 'AKIAABCDEFGHIJKLMNOP'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'],
  ])('redacts %s tokens', (_name, input) => {
    const out = redactString(input);
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(/abcdefghijklmnop|ABCDEFGHIJKLMNOP|1234567890abc/);
  });

  it('redacts bearer headers, URL credentials and KEY=value', () => {
    expect(redactString('Authorization: Bearer abcdef1234567890xyz')).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(redactString('https://user:hunter2@example.com/repo.git')).toBe(`https://user:${REDACTED}@example.com/repo.git`);
    expect(redactString('ANTHROPIC_API_KEY=plainvalue123')).toBe(`ANTHROPIC_API_KEY=${REDACTED}`);
    expect(redactString('DB_PASSWORD: "s3cret!!"')).toContain(REDACTED);
  });

  it('leaves ordinary text alone', () => {
    const s = 'Ran 42 tests in src/checkout; token count 1200';
    expect(redactString(s)).toBe(s);
  });

  it('deep-redacts objects by key and value', () => {
    const out = redact({ apiKey: 'abc', nested: { password: 'p', note: 'sk-ant-api03-zzzzzzzzzzzzzzzz' }, ok: true, list: ['x'] });
    expect(out).toEqual({ apiKey: REDACTED, nested: { password: REDACTED, note: REDACTED }, ok: true, list: ['x'] });
  });

  it('keeps numeric usage metrics whose keys mention tokens', () => {
    expect(redact({ inputTokens: 1200, outputTokens: 34, accessToken: 'abc' })).toEqual({ inputTokens: 1200, outputTokens: 34, accessToken: REDACTED });
  });

  it('handles circular structures', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('masks secrets for display', () => {
    expect(maskSecret('sk-ant-api03-abcdefgh1234')).toBe('sk-ant-••••••••••••1234');
    expect(maskSecret('short')).toBe('••••••••');
  });

  it('AppError never carries secrets', () => {
    const e = new AppError('PROVIDER_ERROR', 'failed with sk-ant-api03-abcdefghijklmnop', { context: { token: 'xyz12345' } });
    expect(e.message).not.toContain('abcdefghijklmnop');
    expect(JSON.stringify(e.toJSON())).not.toContain('xyz12345');
    expect(e.toJSON()).not.toHaveProperty('stack');
  });
});
