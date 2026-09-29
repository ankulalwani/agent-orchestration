import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { providerEnv } from './adapters/base.js';
import { ClaudeCodeAdapter, MockAgentAdapter, AiderAdapter, CodexAdapter, GeminiAdapter, OpenCodeAdapter, classifyText, extractRetryAt, startAgentSession, baseEnv, defaultAgentManager, type AgentEvent, type ParseContext } from './index.js';

const ctx = (): ParseContext => ({ sessionId: null, lastState: null, retryAt: null, detail: null, resultSeen: false, resultIsError: false, recentText: [] });

describe('Claude Code parser (lines captured from Claude Code 2.1.281)', () => {
  const a = new ClaudeCodeAdapter();
  const init = '{"type":"system","subtype":"init","cwd":"C:\\\\tmp","session_id":"6ae01963-909f-4be8-a8b9-8b1b9362db1f","tools":["Bash"]}';
  const warn = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1790494200,"rateLimitType":"five_hour","utilization":0.93,"isUsingOverage":false},"session_id":"6ae01963-909f-4be8-a8b9-8b1b9362db1f"}';
  const assistant = '{"type":"assistant","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]},"session_id":"6ae01963-909f-4be8-a8b9-8b1b9362db1f"}';
  const result = '{"type":"result","subtype":"success","is_error":false,"duration_api_ms":2653,"result":"ok","session_id":"6ae01963-909f-4be8-a8b9-8b1b9362db1f","total_cost_usd":0.1005826,"usage":{"input_tokens":2,"cache_creation_input_tokens":11828,"cache_read_input_tokens":24588,"output_tokens":4}}';

  it('extracts session, messages, tools, usage and completion', () => {
    const c = ctx();
    const ev = [init, warn, assistant, result].flatMap((l) => a.parseLine(l, 'stdout', c));
    expect(ev).toContainEqual({ type: 'session', sessionId: '6ae01963-909f-4be8-a8b9-8b1b9362db1f' });
    expect(ev).toContainEqual(expect.objectContaining({ type: 'limit_warning', retryAt: 1790494200_000, utilization: 0.93 }));
    expect(ev).toContainEqual({ type: 'tool', name: 'Bash', summary: 'npm test' });
    expect(ev).toContainEqual(expect.objectContaining({ type: 'usage', costUsd: 0.1005826, outputTokens: 4 }));
    expect(a.classifyExit(0, null, c).state).toBe('COMPLETED');
  });

  it('a rejected rate_limit_event → RATE_LIMITED with the reported reset time', () => {
    const c = ctx();
    const ev = a.parseLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1790494200,"rateLimitType":"five_hour"}}', 'stdout', c);
    expect(ev).toContainEqual(expect.objectContaining({ type: 'state', state: 'RATE_LIMITED', retryAt: 1790494200_000 }));
    for (const e of ev) if (e.type === 'state') c.lastState = e.state, (c.retryAt = e.retryAt ?? null);
    expect(a.classifyExit(1, null, c)).toMatchObject({ state: 'RATE_LIMITED', retryAt: 1790494200_000 });
  });

  it('error results are classified (context, auth) and exit without result is not success', () => {
    const c1 = ctx();
    a.parseLine('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Prompt is too long","session_id":"s","total_cost_usd":0}', 'stdout', c1);
    expect(a.classifyExit(1, null, c1).state).toBe('CONTEXT_EXHAUSTED');
    const c2 = ctx();
    a.parseLine('Invalid API key · Please run /login', 'stderr', c2);
    expect(a.classifyExit(1, null, c2).state).toBe('AUTH_REQUIRED');
    expect(a.classifyExit(0, null, ctx()).state).toBe('FAILED');
  });

  it('builds a shell-free invocation with prompt on stdin and verified flags', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cc-'));
    const inv = await a.buildInvocation(
      { taskId: 't', cwd: dir, prompt: 'do "things" & more', provider: { providerId: 'anthropic', kind: 'anthropic', modelId: 'sonnet', apiKey: 'sk-ant-test-key-123456' }, sessionId: randomUUID(), stateDir: dir, mcpServers: [{ name: 'fs', transport: 'stdio', command: ['node', 'srv.js'] }] },
      { installed: true, path: 'claude', version: '2.1.281', authenticated: null, notes: [] },
    );
    expect(inv.args.slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
    expect(inv.args).toContain('--session-id');
    expect(inv.args).toContain('--mcp-config');
    expect(inv.args.join(' ')).not.toContain('things'); // prompt never on the command line
    expect(inv.stdin).toContain('do "things" & more');
    expect(inv.env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-123456');
    expect(inv.args).not.toContain('--add-dir');
  });

  it('gives the other repositories of a multi-repository project as --add-dir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cc-'));
    const web = path.join(dir, 'web app');
    const req = { taskId: 't', cwd: dir, prompt: 'P', provider: { providerId: 'anthropic', kind: 'anthropic', modelId: 'default' }, sessionId: randomUUID(), stateDir: dir, additionalDirs: [web, path.join(dir, 'docs')] };
    const inst = { installed: true, path: 'claude', version: '2.1.281', authenticated: null, notes: [] };
    const inv = await a.buildInvocation(req, inst);
    expect(inv.args.join('\u0000')).toContain(['--add-dir', web, '--add-dir', path.join(dir, 'docs')].join('\u0000'));
    expect(a.capabilities().additionalDirectories).toBe(true);
    // Paths that cannot be passed safely are refused rather than passed on.
    await expect(a.buildInvocation({ ...req, additionalDirs: [path.join(dir, 'a&b')] }, inst)).rejects.toThrow(/cannot be passed safely/);
  });
});

describe('Codex / Gemini / OpenCode / Aider (checked against the real CLIs; output in adapters/fixtures)', () => {
  const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'adapters', 'fixtures', name), 'utf8').split(/\r?\n/).filter(Boolean);
  const run = (a: { parseLine: (l: string, s: 'stdout' | 'stderr', c: ParseContext) => AgentEvent[]; classifyExit: (code: number | null, sig: string | null, c: ParseContext) => { state: string } }, lines: string[], code: number, stream: 'stdout' | 'stderr' = 'stdout') => {
    const c = ctx();
    const events = lines.flatMap((l) => {
      c.recentText.push(l);
      return a.parseLine(l, stream, c);
    });
    return { events, exit: a.classifyExit(code, null, c) };
  };
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-'));
  const inst = (p: string) => ({ installed: true, path: p, version: '1', authenticated: null, notes: [] });

  it('Codex: session from thread.started; a 401 turn failure is AUTH_REQUIRED, not a crash', () => {
    const { events, exit } = run(new CodexAdapter(), fixture('codex-0.157.1-unauthenticated.jsonl'), 1);
    expect(events[0]).toMatchObject({ type: 'session' });
    expect(exit.state).toBe('AUTH_REQUIRED');
  });

  it('Codex: transient "Reconnecting…" errors do not override a completed turn', () => {
    const lines = ['{"type":"thread.started","thread_id":"t1"}', '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 429 Too Many Requests)"}', '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"done"}}', '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":5,"output_tokens":3}}'];
    const { events, exit } = run(new CodexAdapter(), lines, 0);
    expect(exit.state).toBe('COMPLETED');
    expect(events).toContainEqual({ type: 'message', text: 'done' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'usage', inputTokens: 15, outputTokens: 3 }));
  });

  it('Codex: exec flags the current CLI accepts (no --full-auto), and resume by thread id', async () => {
    const base = { taskId: 't', cwd: dir(), prompt: 'P', provider: { providerId: 'openai', kind: 'openai', modelId: 'gpt-5' }, sessionId: 's1', stateDir: dir() };
    const a = await new CodexAdapter().buildInvocation(base, inst('codex'));
    expect(a.args.slice(0, 6)).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--model']);
    expect(a.args).not.toContain('--full-auto');
    expect(a.stdin).toBeUndefined(); // stdin is closed, or Codex waits for more input
    const r = await new CodexAdapter().buildInvocation({ ...base, resumeSessionId: 'thread-9' }, inst('codex'));
    expect(r.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-9']);
    expect(r.args).not.toContain('--sandbox'); // not accepted by `exec resume`
    expect(new CodexAdapter().capabilities()).toMatchObject({ verification: 'binary', resume: true, structuredOutput: true });
  });

  it('Gemini: invalid key → AUTH_REQUIRED; missing auth (exit 41) → AUTH_REQUIRED; trust is skipped', async () => {
    const r1 = run(new GeminiAdapter(), fixture('gemini-0.61.0-invalid-key.jsonl'), 144);
    // The real stdout starts with a non-JSON line ("Rename failed with EPERM, retrying…"): tolerated.
    expect(r1.events[0]).toMatchObject({ type: 'output' });
    expect(r1.events).toContainEqual({ type: 'session', sessionId: '11111111-2222-4333-8444-555555555555' });
    expect(r1.exit.state).toBe('AUTH_REQUIRED');
    expect(run(new GeminiAdapter(), fixture('gemini-0.61.0-no-auth.stderr.txt'), 41, 'stderr').exit.state).toBe('AUTH_REQUIRED');
    const inv = await new GeminiAdapter().buildInvocation({ taskId: 't', cwd: dir(), prompt: 'P', provider: { providerId: 'google', kind: 'google', modelId: 'default' }, sessionId: 'our-uuid', stateDir: dir() }, inst('gemini'));
    expect(inv.args).toEqual(expect.arrayContaining(['--yolo', '--skip-trust', '--output-format', 'stream-json']));
    expect(inv.args[inv.args.indexOf('--session-id') + 1]).toBe('our-uuid');
  });

  it('OpenCode: 401 error event → AUTH_REQUIRED with its session id; provider ids mapped', async () => {
    const { events, exit } = run(new OpenCodeAdapter(), fixture('opencode-1.18.32-invalid-key.jsonl'), 1);
    expect(events[0]).toMatchObject({ type: 'session' });
    expect(exit.state).toBe('AUTH_REQUIRED');
    const base = { taskId: 't', cwd: dir(), prompt: 'P', sessionId: 's', stateDir: dir() };
    const bedrock = await new OpenCodeAdapter().buildInvocation({ ...base, provider: { providerId: 'b', kind: 'bedrock', modelId: 'anthropic.claude' } }, inst('opencode'));
    expect(bedrock.args).toEqual(expect.arrayContaining(['run', '--format', 'json', '--auto', '--model', 'amazon-bedrock/anthropic.claude']));
  });

  it('Aider: exit code 0 with a provider error is NOT success; it cannot touch .gitignore or write history into the repo', async () => {
    const lines = fixture('aider-0.86.2-invalid-key.txt');
    expect(run(new AiderAdapter(), lines, 0).exit.state).toBe('AUTH_REQUIRED');
    expect(run(new AiderAdapter(), ['litellm.NotFoundError: AnthropicException - model: nope'], 0).exit.state).toBe('FAILED');
    expect(run(new AiderAdapter(), ['Applied edit to a.txt'], 0).exit.state).toBe('COMPLETED');

    const state = dir();
    const req = { taskId: 't', cwd: dir(), prompt: 'P', provider: { providerId: 'o', kind: 'openrouter', modelId: 'x/y' }, sessionId: 's1', stateDir: state };
    const inv = await new AiderAdapter().buildInvocation(req, inst('aider'));
    expect(inv.args).toEqual(expect.arrayContaining(['--no-auto-commits', '--no-gitignore', '--analytics-disable', '--no-check-update', 'openrouter/x/y']));
    expect(inv.args[inv.args.indexOf('--chat-history-file') + 1]!.startsWith(state)).toBe(true);
    expect(fs.readFileSync(inv.args[inv.args.indexOf('--message-file') + 1]!, 'utf8')).toBe('P');
    expect(new AiderAdapter().capabilities().gitExcludes).toEqual(['.aider*']);
  });
});

describe('provider environment for agents', () => {
  it('Bedrock: a stored key becomes AWS_* variables; Vertex: project and region for Claude Code', () => {
    expect(providerEnv('bedrock', 'AKID:SECRET:TOKEN', null, { region: 'eu-west-1', profile: 'work' })).toEqual({ AWS_REGION: 'eu-west-1', AWS_PROFILE: 'work', AWS_ACCESS_KEY_ID: 'AKID', AWS_SECRET_ACCESS_KEY: 'SECRET', AWS_SESSION_TOKEN: 'TOKEN' });
    expect(providerEnv('bedrock', null, null, { region: 'eu-west-1' })).toEqual({ AWS_REGION: 'eu-west-1' }); // SSO/profile: agent resolves
    expect(providerEnv('vertex', null, null, { project: 'proj-1', region: 'us-east5' })).toEqual({ ANTHROPIC_VERTEX_PROJECT_ID: 'proj-1', GOOGLE_CLOUD_PROJECT: 'proj-1', CLOUD_ML_REGION: 'us-east5' });
  });
});

describe('text classification', () => {
  it.each([
    ['Error: 429 Too Many Requests', 'RATE_LIMITED'],
    ["You've hit your usage limit", 'RATE_LIMITED'],
    ['This model maximum context length is 128000 tokens', 'CONTEXT_EXHAUSTED'],
    ['overloaded_error', 'CAPACITY_LIMITED'],
    ['Error: invalid x-api-key', 'AUTH_REQUIRED'],
    ['fetch failed ECONNRESET', 'NETWORK_ERROR'],
    ['All 42 tests passed', null],
  ])('%s → %s', (text, state) => expect(classifyText(text)).toBe(state));

  it('extracts only explicit retry times', () => {
    expect(extractRetryAt('please try again in 30 seconds', 0)).toBe(30_000);
    expect(extractRetryAt('retry after 2 minutes', 0)).toBe(120_000);
    expect(extractRetryAt('limit resets at 2026-01-01T10:00:00Z')).toBe(Date.parse('2026-01-01T10:00:00Z'));
    expect(extractRetryAt('rate limited, try later')).toBeNull();
  });

  it('agent env is an allowlist (no unrelated secrets leak to agents)', () => {
    const env = baseEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', HOME: '/h' });
    expect(env.PATH).toBe('/bin');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('runtime with mock agent', () => {
  const mock = new MockAgentAdapter();
  async function run(scenario: string, opts: Parameters<typeof startAgentSession>[4] = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-rt-'));
    const inst = await mock.detect();
    const req = { taskId: 't1', cwd: dir, prompt: 'go', provider: { providerId: 'mock', kind: 'mock', modelId: 'm' }, sessionId: randomUUID(), stateDir: path.join(dir, '.agent-orchestration'), settings: { scenario } };
    const session = startAgentSession(mock, inst, req, await mock.buildInvocation(req), opts);
    const events: AgentEvent[] = [];
    for await (const e of session.events) events.push(e);
    return { session, events, exit: await session.done, dir };
  }

  it('success', async () => {
    const r = await run('success');
    expect(r.exit.state).toBe('COMPLETED');
    expect(r.events.some((e) => e.type === 'session')).toBe(true);
    expect(fs.existsSync(path.join(r.dir, 'mock-output.txt'))).toBe(true);
  });
  it('rate limit', async () => expect((await run('rate_limit')).exit.state).toBe('RATE_LIMITED'));
  it('context exhaustion', async () => expect((await run('context')).exit.state).toBe('CONTEXT_EXHAUSTED'));
  it('crash', async () => expect((await run('crash')).exit.state).toBe('CRASHED'));
  it('auth', async () => expect((await run('auth')).exit.state).toBe('AUTH_REQUIRED'));
  it('input request', async () => expect((await run('input')).events.some((e) => e.type === 'input_request')).toBe(true));

  it('detects a hang with evidence and can be stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-hang-'));
    const inst = await mock.detect();
    const req = { taskId: 't', cwd: dir, prompt: 'go', provider: { providerId: 'mock', kind: 'mock', modelId: 'm' }, sessionId: randomUUID(), stateDir: path.join(dir, '.ao'), settings: { scenario: 'hang' } };
    let evidence: unknown = null;
    const s = startAgentSession(mock, inst, req, await mock.buildInvocation(req), {
      hangTimeoutMs: 400,
      sampleIntervalMs: 100,
      onHangSuspected: (e) => {
        evidence = e;
        void s.stop();
      },
    });
    const exit = await s.done;
    expect(evidence).toMatchObject({ lastOutput: expect.any(Array) });
    expect(exit.state).toBe('STOPPED');
  });

  it('reports a missing binary as INSTALLATION_NOT_FOUND', async () => {
    const inst = await mock.detect();
    const dir = os.tmpdir();
    const req = { taskId: 't', cwd: dir, prompt: '', provider: { providerId: 'mock', kind: 'mock', modelId: 'm' }, sessionId: 's', stateDir: dir };
    const s = startAgentSession(mock, inst, req, { command: path.join(dir, 'definitely-missing-binary-xyz'), args: [], env: baseEnv() });
    expect((await s.done).state).toBe('INSTALLATION_NOT_FOUND');
  });

  it('manager inventory lists all adapters and detects claude on this machine if installed', async () => {
    const inv = await defaultAgentManager({ enableMock: true }).inventory();
    expect(inv.map((a) => a.id)).toEqual(['claude-code', 'codex', 'gemini', 'opencode', 'aider', 'mock']);
    expect(inv.find((a) => a.id === 'mock')!.installed).toBe(true);
  }, 60_000);
});
