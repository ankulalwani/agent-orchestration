/** Exponential backoff with full jitter (spec §14, §28, §108). */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  // "Equal jitter": half fixed, half random — never zero, never above cap.
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Parse an HTTP Retry-After header (seconds or HTTP-date). Returns an absolute epoch ms or null.
 * Never invents a time when the header is absent or malformed (spec §28).
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return now + Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : date;
}

export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { attempts: number; baseMs: number; maxMs: number; isRetryable?: (e: unknown) => boolean; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      if (opts.isRetryable && !opts.isRetryable(e)) throw e;
      if (attempt < opts.attempts - 1) await sleep(backoffDelay(attempt, opts.baseMs, opts.maxMs));
    }
  }
  throw lastErr;
}
