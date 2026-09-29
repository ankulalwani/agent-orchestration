import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderManager, createProvider, providerConfigSchema } from './index.js';

let server: http.Server;
let base = '';
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
let mode: 'ok' | '429' | '500' = 'ok';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url!, headers: req.headers });
    if (mode === '429') {
      res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' });
      return res.end('{"error":"rate limited sk-ant-api03-SHOULDBEREDACTED00"}');
    }
    if (mode === '500') {
      res.writeHead(500);
      return res.end('boom');
    }
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }));
    if (req.url === '/models') return res.end(JSON.stringify({ data: [{ id: 'gpt-x' }] }));
    if (req.url!.startsWith('/models?pageSize')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-x', displayName: 'Gemini X', inputTokenLimit: 1000000 }] }));
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3' }] }));
    if (req.url === '/key') return res.end(JSON.stringify({ data: { usage: 1.5, limit: 10, limit_remaining: 8.5 } }));
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const cfg = (kind: string, extra: Record<string, unknown> = {}) => providerConfigSchema.parse({ id: kind, kind, name: kind, baseUrl: base, ...extra });

describe('providers', () => {
  it('uses documented auth headers and parses model lists', async () => {
    mode = 'ok';
    seen.length = 0;
    expect((await createProvider(cfg('anthropic'), 'sk-ant-k').listModels())[0]).toMatchObject({ id: 'claude-x', name: 'Claude X' });
    expect(seen[0]!.headers['x-api-key']).toBe('sk-ant-k');
    expect(seen[0]!.headers['anthropic-version']).toBe('2023-06-01');
    expect((await createProvider(cfg('openai'), 'sk-o').listModels())[0]!.id).toBe('gpt-x');
    expect(seen[1]!.headers.authorization).toBe('Bearer sk-o');
    expect((await createProvider(cfg('google'), 'AIzaK').listModels())[0]).toMatchObject({ id: 'gemini-x', contextWindow: 1000000 });
    expect(seen[2]!.headers['x-goog-api-key']).toBe('AIzaK');
    expect((await createProvider(cfg('ollama'), null).listModels())[0]!.id).toBe('llama3');
  });

  it('merges manual model metadata and reports unsupported operations honestly', async () => {
    mode = 'ok';
    const p = createProvider(cfg('openai', { models: [{ id: 'gpt-x', costTier: 'high' }] }), 'k');
    expect((await p.listModels())[0]).toMatchObject({ id: 'gpt-x', costTier: 'high' });
    expect(await p.getUsage()).toMatchObject({ supported: false });
    // Without resolvable AWS credentials, Bedrock falls back to the declared models (never calls AWS).
    const saved = { ...process.env };
    try {
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;
      process.env.AWS_SHARED_CREDENTIALS_FILE = 'ao-no-such-credentials-file';
      const bedrock = createProvider(providerConfigSchema.parse({ id: 'br', kind: 'bedrock', name: 'Bedrock', models: [{ id: 'anthropic.claude' }] }), null);
      expect(await bedrock.listModels()).toEqual([{ id: 'anthropic.claude' }]);
      expect(bedrock.capabilities.health).toBe(true); // SigV4-signed checks (cloud.test.ts)
    } finally {
      process.env = saved;
    }
  });

  it('OpenRouter usage via its key endpoint', async () => {
    mode = 'ok';
    const u = await createProvider(cfg('openrouter'), 'sk-or-v1-x').getUsage();
    expect(u).toMatchObject({ supported: true, usedUsd: 1.5, limitUsd: 10 });
  });

  it('health check surfaces 429 Retry-After and redacts error bodies', async () => {
    mode = '429';
    const h = await createProvider(cfg('anthropic'), 'k').healthCheck();
    expect(h.healthy).toBe(false);
    expect(h.limitedUntil).toBeGreaterThan(Date.now() + 100_000);
    expect(h.error).not.toContain('SHOULDBEREDACTED');
  });
});

describe('ProviderManager', () => {
  const creds = { get: async (ref: string) => (ref === 'anthropic-key' ? 'sk-ant-api03-secretvalue1234' : null) };

  it('masks credentials and supports multiple providers', async () => {
    mode = 'ok';
    const m = new ProviderManager(creds, { minCheckIntervalMs: 60_000 });
    await m.configure([cfg('anthropic', { credentialRef: 'anthropic-key' }), cfg('ollama')]);
    await m.refresh(true);
    const inv = m.inventory();
    expect(inv).toHaveLength(2);
    expect(inv[0]!.credentialMasked).toBe('sk-ant-••••••••••••1234');
    expect(JSON.stringify(inv)).not.toContain('secretvalue');
  });

  it('does not poll again before the interval, and backs off on failure', async () => {
    mode = 'ok';
    const m = new ProviderManager(creds, { minCheckIntervalMs: 60_000 });
    await m.configure([cfg('ollama')]);
    seen.length = 0;
    await m.refresh();
    const n = seen.length;
    await m.refresh();
    await m.refresh();
    expect(seen.length).toBe(n); // no extra polling
    mode = '500';
    await m.refresh(true);
    expect(m.get('ollama')!.healthy).toBe(false);
    expect(m.get('ollama')!.nextCheckAt).toBeGreaterThan(Date.now() + 30_000);
  });

  it('tracks limits without inventing reset times', async () => {
    const m = new ProviderManager(creds);
    await m.configure([cfg('ollama')]);
    m.markLimited('ollama', null);
    expect(m.isLimited('ollama')).toBe(true);
    expect(m.inventory()[0]!.limitedUntil).toBeNull();
    m.markLimited('ollama', Date.now() - 1);
    expect(m.isLimited('ollama')).toBe(false);
  });
});
