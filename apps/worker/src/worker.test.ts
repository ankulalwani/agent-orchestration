import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WorkerRuntime } from './runtime.js';
import { buildLocalApi } from './local-api.js';
import { EventBuffer } from './event-buffer.js';
import { createCredentialStore } from './credentials.js';

process.env.AO_CREDENTIAL_BACKEND = 'file';

describe('worker local API security (spec §12)', () => {
  let rt: WorkerRuntime;
  let app: FastifyInstance;
  let token: string;
  beforeAll(async () => {
    rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-wl-')));
    await rt.init();
    app = await buildLocalApi(rt);
    token = await rt.localUiToken();
  });
  afterAll(async () => {
    await app.close();
    await rt.stop();
  });

  const inject = (url: string, headers: Record<string, string> = {}, method: 'GET' | 'POST' | 'PUT' | 'OPTIONS' = 'GET', payload?: unknown) =>
    app.inject({ method, url, headers: { host: '127.0.0.1:47821', ...headers }, payload: payload as never });

  it('requires the local token', async () => {
    expect((await inject('/api/status')).statusCode).toBe(401);
    expect((await inject('/api/status', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    const ok = await inject('/api/status', { authorization: `Bearer ${token}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().credentialBackend).toBe('encrypted-file');
  });

  it('offers no hosted service unless the build configures one (AO_HOSTED_URL or a HOSTED_URL file)', async () => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await inject('/api/status', auth)).json().hostedUrl).toBeNull();
    const r = await inject('/api/connect', { ...auth, 'content-type': 'application/json' }, 'POST', { mode: 'hosted' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('no hosted service');
  });

  it('rejects foreign Host headers (DNS rebinding) and CORS preflights', async () => {
    expect((await inject('/api/status', { host: 'evil.example:47821', authorization: `Bearer ${token}` })).statusCode).toBe(403);
    expect((await inject('/api/status', { origin: 'http://evil.example' }, 'OPTIONS')).statusCode).toBe(403);
  });

  it('stores provider credentials securely and only returns them masked', async () => {
    const auth = { authorization: `Bearer ${token}` };
    await inject('/api/providers/openrouter', auth, 'PUT', { kind: 'openrouter', name: 'OpenRouter', baseUrl: 'http://127.0.0.1:9/', models: [{ id: 'm' }] });
    const r = await inject('/api/providers/openrouter/credential', auth, 'POST', { value: 'sk-or-v1-supersecretvalue9876' });
    expect(r.json().masked).toBe('sk-or-v1-••••••••••••9876');
    const list = await inject('/api/providers', auth);
    expect(list.body).not.toContain('supersecret');
    expect(fs.readFileSync(rt.config.file, 'utf8')).not.toContain('supersecret');
    expect(await rt.credentials.get('provider:openrouter')).toBe('sk-or-v1-supersecretvalue9876');
  });

  it('validates project mappings and runs diagnostics', async () => {
    const auth = { authorization: `Bearer ${token}` };
    expect((await inject('/api/projects', auth, 'PUT', [{ projectId: 'a'.repeat(24), localPath: 'relative/path' }])).statusCode).toBe(400);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-proj-'));
    expect((await inject('/api/projects', auth, 'PUT', [{ projectId: 'a'.repeat(24), localPath: dir }])).statusCode).toBe(200);
    const diag = (await inject('/api/diagnostics', auth)).json() as Array<{ id: string; status: string }>;
    expect(diag.find((d) => d.id === 'node')?.status).toBe('ok');
    expect(diag.find((d) => d.id === 'control-plane')?.status).toBe('warn');
    expect(diag.find((d) => d.id === `project:${'a'.repeat(24)}`)?.status).toBe('warn'); // not a git repo
  });
});

describe('credential store', () => {
  it('encrypted file store never writes plaintext', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cred-'));
    const s = await createCredentialStore(dir, { forceFile: true });
    await s.set('k', 'plaintext-secret-value');
    expect(await s.get('k')).toBe('plaintext-secret-value');
    for (const f of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir, f)).toString('utf8')).not.toContain('plaintext-secret-value');
    await s.delete('k');
    expect(await s.get('k')).toBeNull();
  });

  it('copies credentials from the encrypted file to the OS store once it is available, one time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cred-'));
    const file = await createCredentialStore(dir, { forceFile: true });
    await file.set('worker-credential', 'paired-secret');
    await file.set('provider:x', 'from-file');

    // A stand-in OS store that already holds one of the names.
    const os_ = new Map<string, string>([['provider:x', 'from-os']]);
    const keyring = {
      Entry: class {
        constructor(_service: string, private account: string) {}
        getPassword() {
          return os_.get(this.account) ?? null;
        }
        setPassword(v: string) {
          os_.set(this.account, v);
        }
        deletePassword() {
          return os_.delete(this.account);
        }
      },
    };
    const first = await createCredentialStore(dir, { keyring });
    expect(first.backend).toBe('os-keyring');
    expect(await first.get('worker-credential')).toBe('paired-secret');
    expect(await first.get('provider:x')).toBe('from-os'); // the OS store wins
    expect(fs.existsSync(path.join(dir, 'credentials.enc'))).toBe(true); // kept for a rollback

    // A credential removed afterwards does not come back from the file on the next start.
    await first.delete('worker-credential');
    const second = await createCredentialStore(dir, { keyring });
    expect(await second.get('worker-credential')).toBeNull();
  });
});

describe('event buffer (spec §107)', () => {
  it('persists across restarts, keeps order, and survives failed sends', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-buf-'));
    const b1 = new EventBuffer(dir, () => 'w1');
    b1.push('t1', 'AgentStarted', { token: 'sk-ant-api03-SHOULDNOTPERSIST' });
    b1.push('t1', 'AgentOutput', { lines: ['a'] });
    await expect(b1.flush(async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline');
    expect(b1.size).toBe(2);
    expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).not.toContain('SHOULDNOTPERSIST');

    // Simulated restart: a new buffer instance recovers pending events and continues the sequence.
    const b2 = new EventBuffer(dir, () => 'w1');
    expect(b2.size).toBe(2);
    const e3 = b2.push('t1', 'AgentExited', {});
    expect(e3.sequence).toBe(3);
    const sent: number[] = [];
    await b2.flush(async (batch) => void sent.push(...batch.map((e) => e.sequence)));
    expect(sent).toEqual([1, 2, 3]);
    expect(b2.size).toBe(0);
    expect(new EventBuffer(dir, () => 'w1').size).toBe(0);
  });

  it('a flush called while another runs waits and also sends events added meanwhile', async () => {
    const b = new EventBuffer(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-buf2-')), () => 'w1');
    b.push('t1', 'AgentStarted', {});
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = async (batch: Array<{ type: string }>) => {
      if (!sent.length) await gate; // the first batch is slow
      sent.push(...batch.map((e) => e.type));
    };
    const background = b.flush(send);
    b.push('t1', 'FallbackStarted', {}); // produced while the background flush is still sending
    let secondDone = false;
    const explicit = b.flush(send).then(() => (secondDone = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(secondDone).toBe(false); // does not return early while a flush is in progress
    release();
    await Promise.all([background, explicit]);
    expect(sent).toEqual(['AgentStarted', 'FallbackStarted']);
    expect(b.size).toBe(0);
  });
});

describe('Git hosting accounts for pull requests (GIT-004)', () => {
  it('stores the token in the credential store, shows it masked, and survives saving other settings', async () => {
    const rt = new WorkerRuntime(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-gh-')));
    await rt.init();
    const app = await buildLocalApi(rt);
    const headers = { host: '127.0.0.1:47821', authorization: `Bearer ${await rt.localUiToken()}` };
    try {
      const put = await app.inject({ method: 'PUT', url: '/api/git-hosting/GitHub.com', headers, payload: { kind: 'github', token: 'ghp_worker_token_value' } });
      expect(put.statusCode, put.body).toBe(200);
      expect(put.body).not.toContain('ghp_worker_token_value');
      expect(put.json()).toEqual([{ host: 'github.com', kind: 'github', apiBaseUrl: 'https://api.github.com', tokenMasked: expect.stringMatching(/•|\*/) }]);
      expect(await rt.credentials.get('git-hosting:github.com')).toBe('ghp_worker_token_value');
      expect(JSON.stringify(rt.config.get())).not.toContain('ghp_worker_token_value');
      // Enterprise hosts need their API URL.
      expect((await app.inject({ method: 'PUT', url: '/api/git-hosting/github.example.com', headers, payload: { kind: 'github', token: 'ghp_enterprise_x' } })).statusCode).toBe(400);
      // Saving the settings form (which sends git author fields) keeps the accounts.
      await app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { git: { authorName: 'Bot' } } });
      expect(rt.config.get().git).toMatchObject({ authorName: 'Bot', hosting: [{ host: 'github.com' }] });
      await app.inject({ method: 'DELETE', url: '/api/git-hosting/github.com', headers });
      expect(await rt.credentials.get('git-hosting:github.com')).toBeNull();
      expect(rt.config.get().git.hosting).toEqual([]);
    } finally {
      await app.close();
      await rt.stop();
    }
  });
});
