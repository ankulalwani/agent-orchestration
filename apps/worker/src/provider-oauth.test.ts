/**
 * Provider sign-in for model access (PROV-006): OpenRouter's OAuth PKCE flow through the worker's local
 * UI, against a fake OpenRouter that verifies the PKCE challenge like the real service.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WorkerRuntime } from './runtime.js';
import { buildLocalApi } from './local-api.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';

let fake: http.Server;
let api = '';
const challenges = new Map<string, string>(); // code → code_challenge the user "approved"
const issued: string[] = [];
let rt: WorkerRuntime;
let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code: number, json: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      if (req.method === 'POST' && req.url === '/api/v1/auth/keys') {
        const b = JSON.parse(body) as { code: string; code_verifier: string; code_challenge_method: string };
        const expected = challenges.get(b.code);
        challenges.delete(b.code); // codes are single-use
        const actual = createHash('sha256').update(b.code_verifier).digest('base64url');
        if (!expected || b.code_challenge_method !== 'S256' || actual !== expected) return send(403, { error: { message: 'Invalid code or verifier' } });
        const key = `sk-or-v1-issued-${issued.length + 1}`;
        issued.push(key);
        return send(200, { key, user_id: 'user_1' });
      }
      const auth = req.headers.authorization ?? '';
      if (!issued.some((k) => auth === `Bearer ${k}`)) return send(401, { error: { message: 'No auth' } });
      if (req.url === '/api/v1/models') return send(200, { data: [{ id: 'anthropic/claude-sonnet-5', name: 'Sonnet', context_length: 200000 }] });
      if (req.url === '/api/v1/key') return send(200, { data: { usage: 0, limit: null } });
      send(404, {});
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  api = `http://127.0.0.1:${(fake.address() as { port: number }).port}/api/v1`;

  rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-poauth-')));
  rt.config.update({ providers: [{ id: 'or', kind: 'openrouter', name: 'OpenRouter', baseUrl: api, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [], restrictModels: false }] });
  await rt.init();
  app = await buildLocalApi(rt);
  token = await rt.localUiToken();
});
afterAll(async () => {
  await app.close();
  await rt.stop();
  fake.close();
});

const headers = () => ({ host: '127.0.0.1:47821', authorization: `Bearer ${token}` });
/** Starts sign-in; returns the callback path and the challenge the browser would carry to OpenRouter. */
async function start() {
  const r = await app.inject({ method: 'POST', url: '/api/providers/or/oauth/start', headers: headers() });
  expect(r.statusCode).toBe(200);
  const url = new URL(r.json().url);
  expect(url.origin + url.pathname).toBe(new URL(api).origin + '/auth');
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const callback = new URL(url.searchParams.get('callback_url')!);
  expect(callback.origin).toBe('http://127.0.0.1:47821');
  return { callbackPath: callback.pathname, challenge: url.searchParams.get('code_challenge')! };
}
const callback = (p: string, code?: string) => app.inject({ method: 'GET', url: code ? `${p}?code=${code}` : p, headers: { host: '127.0.0.1:47821' } });

describe('provider sign-in (OpenRouter PKCE)', () => {
  it('stores the issued key in the credential store, masked everywhere, and the provider becomes healthy', async () => {
    const { callbackPath, challenge } = await start();
    challenges.set('code-1', challenge); // the user approved on openrouter.ai
    const res = await callback(callbackPath, 'code-1');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Signed in');
    expect(res.body).not.toContain('sk-or-v1-issued-1');
    expect(await rt.credentials.get('provider:or')).toBe('sk-or-v1-issued-1');
    const inv = (await app.inject({ method: 'GET', url: '/api/providers', headers: headers() })).json() as Array<{ id: string; healthy: boolean; credentialMasked: string; models: Array<{ id: string }> }>;
    const or = inv.find((p) => p.id === 'or')!;
    expect(or.healthy).toBe(true);
    expect(or.models.map((m) => m.id)).toContain('anthropic/claude-sonnet-5');
    expect(JSON.stringify(inv)).not.toContain('sk-or-v1-issued-1');
    // The state is single-use.
    expect((await callback(callbackPath, 'code-1')).statusCode).toBe(400);
  });

  it('rejects unknown states, missing codes and a code exchanged with the wrong verifier', async () => {
    expect((await callback('/oauth/provider/callback/made-up-state', 'x')).body).toContain('expired or was already used');
    const a = await start();
    expect((await callback(a.callbackPath)).statusCode).toBe(400);
    const b = await start();
    challenges.set('code-2', createHash('sha256').update('some other verifier').digest('base64url'));
    const r = await callback(b.callbackPath, 'code-2');
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('OpenRouter did not issue a key (HTTP 403: Invalid code or verifier)');
    expect(await rt.credentials.get('provider:or')).toBe('sk-or-v1-issued-1'); // unchanged
  });

  it('starting sign-in needs the local token; other provider kinds are refused', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/providers/or/oauth/start', headers: { host: '127.0.0.1:47821' } })).statusCode).toBe(401);
    rt.config.update((c) => ({ ...c, providers: [...c.providers, { id: 'oa', kind: 'openai', name: 'OpenAI', baseUrl: null, credentialRef: null, useAgentLogin: false, enabled: true, extra: {}, models: [], restrictModels: false }] }));
    const r = await app.inject({ method: 'POST', url: '/api/providers/oa/oauth/start', headers: headers() });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/Sign-in is not available for openai/);
  });
});
