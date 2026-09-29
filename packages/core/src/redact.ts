/**
 * Secret redaction (spec §59, §112, §116, §120).
 * Applied to logs, task events, error context and command lines.
 */

const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|api[-_]?key|apikey|authorization|auth|credential|private[-_]?key|cookie|session[-_]?id|refresh)/i;

/** Known credential shapes. Order matters: more specific first. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-(proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / OpenRouter
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /gh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /(:\/\/[^:/\s]+:)[^@/\s]+(@)/g, // credentials in URLs
];

export const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (match, g1?: string, g2?: string) => {
      if (typeof g1 === 'string' && typeof g2 === 'string' && match.startsWith(g1) && match.endsWith(g2)) {
        return `${g1}${REDACTED}${g2}`;
      }
      if (typeof g1 === 'string' && /^Bearer/i.test(g1)) return `${g1}${REDACTED}`;
      return REDACTED;
    });
  }
  // key=value / key: value forms, e.g. "API_KEY=abc123", "--token abc"
  out = out.replace(
    /\b([A-Za-z0-9_-]*(?:PASSWORD|SECRET|TOKEN|API_?KEY)[A-Za-z0-9_-]*)(\s*[=:]\s*)("?)([^\s"']{4,})\3/gi,
    (_m, k: string, sep: string, q: string) => `${k}${sep}${q}${REDACTED}${q}`,
  );
  return out;
}

/** Deep-redacts any JSON-like value. Keys that look secret have their values replaced entirely. */
export function redact<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value === 'string') return redactString(value) as T;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]' as T;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, seen)) as T;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Only string values are treated as potential secrets; numbers such as `outputTokens` are metrics.
    if (SECRET_KEY_PATTERN.test(k) && typeof v === 'string') {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, seen);
    }
  }
  return out as T;
}

/** Mask for display after initial entry (spec §120): keeps a recognisable prefix and last 4 chars. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••••••';
  const prefixMatch = /^(sk-ant-|sk-or-v1-|sk-proj-|sk-|AIza|ghp_|github_pat_)/.exec(secret);
  const prefix = prefixMatch?.[1] ?? '';
  return `${prefix}${'•'.repeat(12)}${secret.slice(-4)}`;
}
