import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { captureError, errorReporter, parseDsn, parseStack, toSentryEnvelope, type ErrorReport } from './error-reporting.js';

let server: http.Server;
let base: string;
const received: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let failNext = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url!, headers: req.headers, body });
      res.writeHead(failNext ? 500 : 200).end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  errorReporter.reset();
  received.length = 0;
  failNext = false;
});

describe('error tracking (OBS-003)', () => {
  it('is off by default: nothing is captured or sent', async () => {
    expect(errorReporter.enabled).toBe(false);
    expect(captureError(new Error('x'))).toBeNull();
    await errorReporter.flush(200);
    expect(received).toHaveLength(0);
  });

  it('parses Sentry DSNs, including self-hosted path prefixes', () => {
    expect(parseDsn('https://abc123@o1.ingest.sentry.io/42')).toMatchObject({ publicKey: 'abc123', envelopeUrl: 'https://o1.ingest.sentry.io/api/42/envelope/' });
    expect(parseDsn('http://k@glitchtip.local:8000/sub/7').envelopeUrl).toBe('http://glitchtip.local:8000/sub/api/7/envelope/');
    expect(() => parseDsn('https://sentry.io/42')).toThrow(/Invalid error-tracking DSN/);
  });

  it('sends a Sentry envelope with auth header, stack frames, tags and correlation id', async () => {
    errorReporter.configure({ service: 'api', dsn: `http://pubkey@${base}/5`, release: '1.2.3', environment: 'test' });
    const id = captureError(new TypeError('boom'), { correlationId: 'corr-12345678', tags: { route: '/tasks/:id', skip: undefined } });
    await errorReporter.flush();
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.url).toBe('/api/5/envelope/');
    expect(r.headers['x-sentry-auth']).toContain('sentry_key=pubkey');
    expect(r.headers['content-type']).toBe('application/x-sentry-envelope');
    const [head, item, payload] = r.body.split('\n');
    expect(JSON.parse(head!)).toMatchObject({ event_id: id });
    expect(JSON.parse(item!)).toMatchObject({ type: 'event', length: Buffer.byteLength(payload!) });
    const event = JSON.parse(payload!);
    expect(event).toMatchObject({ level: 'error', release: '1.2.3', environment: 'test', logger: 'api', tags: { service: 'api', correlation_id: 'corr-12345678', route: '/tasks/:id' } });
    expect(event.tags).not.toHaveProperty('skip');
    expect(event.exception.values[0]).toMatchObject({ type: 'TypeError', value: 'boom' });
    expect(event.exception.values[0].stacktrace.frames.at(-1).filename).toContain('error-reporting.test.ts'); // newest frame last
  });

  it('redacts secrets in messages and context', async () => {
    errorReporter.configure({ service: 'api', webhookUrl: `http://${base}/hook` });
    captureError(new Error('provider rejected sk-ant-api03-abcdefghijklmnop'), { context: { apiKey: 'plain-secret', note: 'Bearer abcdefghijklmnopqrstu' } });
    await errorReporter.flush();
    const report = JSON.parse(received[0]!.body) as ErrorReport;
    expect(received[0]!.body).not.toContain('sk-ant-api03-abcdefghijklmnop');
    expect(received[0]!.body).not.toContain('plain-secret');
    expect(received[0]!.body).not.toContain('abcdefghijklmnopqrstu');
    expect(report.error.message).toContain('[REDACTED]');
  });

  it('rate-limits, and delivery failures never throw', async () => {
    errorReporter.configure({ service: 'worker', webhookUrl: `http://${base}/hook`, maxPerMinute: 3 });
    failNext = true;
    for (let i = 0; i < 5; i++) expect(() => captureError(new Error(`e${i}`))).not.toThrow();
    await errorReporter.flush();
    expect(received).toHaveLength(3);
    expect(errorReporter.dropped).toBe(2);
  });

  it('non-Error values are reported, and listeners receive reports', () => {
    const seen: ErrorReport[] = [];
    errorReporter.onReport((r) => seen.push(r));
    captureError({ weird: true }, { level: 'fatal' });
    expect(seen[0]).toMatchObject({ level: 'fatal', error: { type: 'Error', message: '{"weird":true}' } });
  });

  it('turns V8 stacks into frames and marks library frames', () => {
    const frames = parseStack('Error: x\n    at handler (/app/src/routes.ts:10:5)\n    at /app/node_modules/fastify/lib/x.js:1:2\n    at node:internal/process/task_queues:95:5');
    expect(frames.map((f) => [f.filename, f.in_app])).toEqual([
      ['node:internal/process/task_queues', false],
      ['/app/node_modules/fastify/lib/x.js', false],
      ['/app/src/routes.ts', true],
    ]);
    const envelope = toSentryEnvelope({ id: 'a'.repeat(32), timestamp: new Date().toISOString(), level: 'error', service: 's', release: null, environment: null, host: 'h', error: { type: 'E', message: 'm', stack: null }, correlationId: null, tags: {}, context: {} }, 'https://k@h/1');
    expect(envelope.split('\n')).toHaveLength(3);
  });
});
