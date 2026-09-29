import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { errorReporter, type ErrorReport } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import { buildApp } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

let collector: http.Server;
let app: FastifyInstance;
const reports: ErrorReport[] = [];

beforeAll(async () => {
  await startTestDatabase();
  collector = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      reports.push(JSON.parse(body));
      res.end();
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  const { services } = await makeServices({ ERROR_TRACKING_WEBHOOK_URL: `http://127.0.0.1:${(collector.address() as { port: number }).port}/errors` });
  app = await buildApp(services, {
    extend: (a) => {
      a.get(`${API_PREFIX}/test/boom/:id`, async () => {
        throw new Error('database exploded token=abcd1234efgh');
      });
    },
  });
});
afterAll(async () => {
  errorReporter.reset();
  await app.close();
  await new Promise<void>((r) => collector.close(() => r()));
  await stopTestDatabase();
});

describe('API error tracking (OBS-003)', () => {
  it('reports unexpected 5xx errors with the correlation id the client sees, and not client errors', async () => {
    const res = await app.inject({ method: 'GET', url: `${API_PREFIX}/test/boom/123?secret=abc` });
    expect(res.statusCode).toBe(500);
    const correlationId = res.headers['x-correlation-id'];
    expect(res.json().error.message).not.toContain('exploded'); // details never leak to clients

    // 4xx responses (validation, auth, not found) are not errors worth tracking.
    expect((await app.inject({ method: 'GET', url: `${API_PREFIX}/me` })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: `${API_PREFIX}/auth/login`, payload: { email: 'nope' } })).statusCode).toBe(400);

    await errorReporter.flush();
    expect(reports).toHaveLength(1);
    const r = reports[0]!;
    expect(r).toMatchObject({ service: 'api', environment: 'test', correlationId, tags: { component: 'http', method: 'GET', route: `${API_PREFIX}/test/boom/:id` } });
    expect(r.error.message).toBe('database exploded token=[REDACTED]');
    expect(JSON.stringify(r)).not.toContain('secret=abc'); // the raw URL is never included
  });
});
