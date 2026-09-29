import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { createLogger } from './logger.js';
import { redact } from './redact.js';

/**
 * Error-tracking hooks (spec §61). Off unless configured: no outbound call is made by default
 * (spec §127). Destinations:
 * - `dsn`: a Sentry-compatible DSN (Sentry, GlitchTip, …), sent as an envelope over HTTPS without an SDK;
 * - `webhookUrl`: any endpoint that accepts a JSON `ErrorReport`;
 * - `onReport`: in-process listeners, for embedders such as the hosted service.
 * Reports are redacted, rate-limited, sent in the background, and never throw.
 */
export interface ErrorReport {
  id: string;
  timestamp: string;
  level: 'error' | 'fatal';
  service: string;
  release: string | null;
  environment: string | null;
  host: string;
  error: { type: string; message: string; stack: string | null };
  correlationId: string | null;
  tags: Record<string, string>;
  context: Record<string, unknown>;
}

export interface ErrorReportingOptions {
  service: string;
  dsn?: string | null;
  webhookUrl?: string | null;
  release?: string | null;
  environment?: string | null;
  /** Maximum reports sent per minute; the rest are counted and dropped. */
  maxPerMinute?: number;
}

export interface CaptureContext {
  level?: 'error' | 'fatal';
  correlationId?: string | null;
  tags?: Record<string, string | undefined | null>;
  context?: Record<string, unknown>;
}

type Sender = (report: ErrorReport) => Promise<void>;

const log = createLogger('error-reporting');
const SEND_TIMEOUT_MS = 5000;

class ErrorReporter {
  private opts: ErrorReportingOptions | null = null;
  private senders: Sender[] = [];
  private listeners = new Set<(r: ErrorReport) => void>();
  private windowStart = 0;
  private sentInWindow = 0;
  private inFlight = new Set<Promise<void>>();
  dropped = 0;

  configure(opts: ErrorReportingOptions) {
    this.opts = opts;
    this.senders = [];
    if (opts.dsn) this.senders.push(sentrySender(parseDsn(opts.dsn)));
    if (opts.webhookUrl) this.senders.push(webhookSender(opts.webhookUrl));
  }

  get enabled() {
    return this.senders.length > 0 || this.listeners.size > 0;
  }

  onReport(fn: (r: ErrorReport) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  capture(err: unknown, ctx: CaptureContext = {}): string | null {
    if (!this.enabled) return null;
    try {
      const now = Date.now();
      if (now - this.windowStart >= 60_000) {
        this.windowStart = now;
        this.sentInWindow = 0;
      }
      if (this.sentInWindow >= (this.opts?.maxPerMinute ?? 30)) {
        this.dropped++;
        return null;
      }
      this.sentInWindow++;
      const report = buildReport(err, ctx, this.opts);
      for (const l of this.listeners) {
        try {
          l(report);
        } catch {
          /* a listener must not break reporting */
        }
      }
      for (const send of this.senders) {
        const p = send(report)
          .catch((e) => log.warn({ err: String(e) }, 'error report could not be delivered'))
          .finally(() => this.inFlight.delete(p));
        this.inFlight.add(p);
      }
      return report.id;
    } catch {
      return null;
    }
  }

  /** Waits for reports being sent (e.g. before exiting after a crash). */
  async flush(timeoutMs = SEND_TIMEOUT_MS) {
    await Promise.race([Promise.allSettled([...this.inFlight]), new Promise((r) => setTimeout(r, timeoutMs).unref?.())]);
  }

  /** For tests. */
  reset() {
    this.opts = null;
    this.senders = [];
    this.listeners.clear();
    this.sentInWindow = 0;
    this.windowStart = 0;
    this.dropped = 0;
  }
}

/** Process-wide reporter; configure once at startup. */
export const errorReporter = new ErrorReporter();
export const captureError = (err: unknown, ctx?: CaptureContext) => errorReporter.capture(err, ctx);

/** Reports crashes (uncaught exceptions, unhandled rejections), then lets the process exit as before. */
export function installCrashReporting(onFatal: (err: unknown) => void) {
  const handle = (err: unknown) => {
    captureError(err, { level: 'fatal' });
    void errorReporter.flush(2000).finally(() => onFatal(err));
  };
  process.on('uncaughtException', handle);
  process.on('unhandledRejection', handle);
}

function buildReport(err: unknown, ctx: CaptureContext, opts: ErrorReportingOptions | null): ErrorReport {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : safeString(err));
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.tags ?? {})) if (v !== undefined && v !== null) tags[k] = String(v);
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string') tags.code ??= code;
  return redact({
    id: randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    level: ctx.level ?? 'error',
    service: opts?.service ?? 'unknown',
    release: opts?.release ?? null,
    environment: opts?.environment ?? null,
    host: os.hostname(),
    error: { type: e.name || 'Error', message: e.message, stack: e.stack ?? null },
    correlationId: ctx.correlationId ?? null,
    tags,
    context: ctx.context ?? {},
  }) as ErrorReport;
}

function safeString(v: unknown) {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

async function post(url: string, body: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

function webhookSender(url: string): Sender {
  return (r) => post(url, JSON.stringify(r), { 'content-type': 'application/json' });
}

export interface ParsedDsn {
  dsn: string;
  publicKey: string;
  envelopeUrl: string;
}

/** `https://<publicKey>@<host>[/<path>]/<projectId>` → envelope endpoint. */
export function parseDsn(dsn: string): ParsedDsn {
  const u = new URL(dsn);
  const segments = u.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!u.username || !projectId || !/^https?:$/.test(u.protocol)) throw new Error('Invalid error-tracking DSN (expected https://<key>@<host>/<project>)');
  const prefix = segments.length ? `/${segments.join('/')}` : '';
  return { dsn, publicKey: u.username, envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/` };
}

/** Sentry envelope format (one `event` item). */
export function toSentryEnvelope(r: ErrorReport, dsn: string): string {
  const event = {
    event_id: r.id,
    timestamp: r.timestamp,
    level: r.level,
    platform: 'node',
    logger: r.service,
    server_name: r.host,
    release: r.release ?? undefined,
    environment: r.environment ?? undefined,
    exception: { values: [{ type: r.error.type, value: r.error.message, stacktrace: r.error.stack ? { frames: parseStack(r.error.stack) } : undefined }] },
    tags: { service: r.service, ...(r.correlationId ? { correlation_id: r.correlationId } : {}), ...r.tags },
    extra: r.context,
  };
  const payload = JSON.stringify(event);
  return [JSON.stringify({ event_id: r.id, sent_at: new Date().toISOString(), dsn }), JSON.stringify({ type: 'event', length: Buffer.byteLength(payload) }), payload].join('\n');
}

function sentrySender(d: ParsedDsn): Sender {
  return (r) =>
    post(d.envelopeUrl, toSentryEnvelope(r, d.dsn), {
      'content-type': 'application/x-sentry-envelope',
      'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${d.publicKey}, sentry_client=agent-orchestrator/1.0`,
    });
}

/** V8 stack lines → Sentry frames (oldest first, as Sentry expects). */
export function parseStack(stack: string) {
  const frames: Array<{ function?: string; filename: string; lineno?: number; colno?: number; in_app: boolean }> = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const filename = m[2]!;
    frames.push({ function: m[1], filename, lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|node:internal|^node:/.test(filename) });
  }
  return frames.reverse();
}
