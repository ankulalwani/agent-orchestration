import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { providerEnv } from './adapters/base.js';
import { AmpAdapter, AuggieAdapter, ClineAdapter, CodeBuddyAdapter, ContinueAdapter, CopilotAdapter, CrushAdapter, CursorAdapter, DroidAdapter, GrokAdapter, KiloAdapter, KimiAdapter, KiroAdapter, PiAdapter, QoderAdapter, QwenAdapter, TraeAdapter, VibeAdapter, GATEWAY_KIND, type AgentAdapter } from './index.js';
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

describe('Cursor, Copilot, Kiro, Qwen, Kimi, Grok, Trae and the other added CLIs (output of the real CLIs in adapters/fixtures)', () => {
  const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'adapters', 'fixtures', name), 'utf8').split(/\r?\n/).filter(Boolean);
  const run = (a: AgentAdapter, lines: string[], code: number, stream: 'stdout' | 'stderr' = 'stdout') => {
    const c = ctx();
    const events = lines.flatMap((l) => {
      c.recentText.push(l);
      return a.parseLine(l, stream, c);
    });
    return { events, exit: a.classifyExit(code, null, c) };
  };
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-'));
  const inst = (p: string) => ({ installed: true, path: p, version: '1', authenticated: null, notes: [] });
  const request = (provider: { providerId: string; kind: string; modelId: string; apiKey?: string; baseUrl?: string } = { providerId: 'native:x', kind: 'native', modelId: 'default' }) => ({ taskId: 't', cwd: dir(), prompt: 'P', provider, sessionId: 'our-uuid', stateDir: dir() });
  const gateway = { providerId: 'addon', kind: GATEWAY_KIND, modelId: 'ao-addon', apiKey: 'session-token', baseUrl: 'http://127.0.0.1:4000' };

  // Each CLI run without credentials: [agent, adapter, fixture, exit code, stream]. None may count as success.
  it.each<[string, AgentAdapter, string, number, 'stdout' | 'stderr']>([
    ['Cursor Agent', new CursorAdapter(), 'cursor-2026.10.01-no-auth.stderr.txt', 1, 'stderr'],
    ['Copilot CLI', new CopilotAdapter(), 'copilot-1.0.92-no-auth.stderr.txt', 1, 'stderr'],
    ['Qwen Code', new QwenAdapter(), 'qwen-0.25.0-no-auth.jsonl', 1, 'stdout'],
    ['Kimi Code', new KimiAdapter(), 'kimi-2.1.1-no-model.stderr.txt', 1, 'stderr'],
    ['Grok', new GrokAdapter(), 'grok-1.0.46-no-auth.jsonl', 1, 'stdout'],
    ['Droid', new DroidAdapter(), 'droid-0.233.0-no-auth.jsonl', 1, 'stdout'],
    ['Auggie', new AuggieAdapter(), 'auggie-0.36.0-no-auth.stderr.txt', 1, 'stderr'],
    ['Crush', new CrushAdapter(), 'crush-0.97.1-no-providers.stderr.txt', 1, 'stderr'],
    ['Cline', new ClineAdapter(), 'cline-3.0.68-unauthorized.jsonl', 1, 'stdout'],
    ['Kilo Code', new KiloAdapter(), 'kilo-7.8.3-no-auth.jsonl', 1, 'stdout'],
    ['Pi', new PiAdapter(), 'pi-0.73.1-no-key.stderr.txt', 1, 'stderr'],
    ['Continue', new ContinueAdapter(), 'continue-1.5.47-no-auth.stderr.txt', 1, 'stderr'],
    ['Qoder', new QoderAdapter(), 'qoder-1.1.65-no-auth.jsonl', 1, 'stdout'],
    // These two exit 0 without a login: the output decides, not the exit code.
    ['CodeBuddy', new CodeBuddyAdapter(), 'codebuddy-2.161.4-no-auth.jsonl', 0, 'stdout'],
    ['Mistral Vibe', new VibeAdapter(), 'vibe-2.2.1-no-key.txt', 0, 'stdout'],
  ])('%s without credentials → AUTH_REQUIRED', (_name, adapter, file, code, stream) => {
    expect(run(adapter, fixture(file), code, stream).exit.state).toBe('AUTH_REQUIRED');
  });

  it('Amp: its browser login flow is reported as AUTH_REQUIRED at once; confirmations are off through a settings file', async () => {
    const { events } = run(new AmpAdapter(), fixture('amp-2026.10.06-login-flow.txt'), 1);
    expect(events).toContainEqual(expect.objectContaining({ type: 'state', state: 'AUTH_REQUIRED' }));
    const inv = await new AmpAdapter().buildInvocation(request(), inst('amp'));
    expect(JSON.parse(fs.readFileSync(inv.args[inv.args.indexOf('--settings-file') + 1]!, 'utf8'))).toEqual({ 'amp.dangerouslyAllowAll': true });
    expect(inv.args.slice(-3, -1)).toEqual(['--stream-json', '-x']);
  });

  it('Claude-dialect stream (Qwen through the gateway): session, tool, message, usage and completion', () => {
    const { events, exit } = run(new QwenAdapter(), fixture('qwen-0.25.0-gateway.jsonl'), 0);
    expect(events[0]).toMatchObject({ type: 'session' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'write_file' }));
    expect(events).toContainEqual({ type: 'message', text: 'Created hello.txt. Done.' });
    expect(exit.state).toBe('COMPLETED');
    // Cursor's tool calls and Droid's messages use their own event shapes.
    const cursor = run(new CursorAdapter(), ['{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}},"session_id":"s1"}', '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s1"}'], 0);
    expect(cursor.events).toContainEqual({ type: 'tool', name: 'shell', summary: 'npm test' });
    expect(cursor.exit.state).toBe('COMPLETED');
    const droid = run(new DroidAdapter(), ['{"type":"message","role":"assistant","text":"working"}', '{"type":"completion","finalText":"done","session_id":"s2"}'], 0);
    expect(droid.events).toEqual(expect.arrayContaining([{ type: 'message', text: 'working' }, { type: 'session', sessionId: 's2' }, { type: 'message', text: 'done' }]));
  });

  it('Copilot: gateway run parsed; custom-provider variables for the gateway and for direct providers', async () => {
    const { events, exit } = run(new CopilotAdapter(), fixture('copilot-1.0.92-gateway.jsonl'), 0);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'create' }));
    expect(events).toContainEqual({ type: 'message', text: 'Created hello.txt. Done.' });
    expect(events).toContainEqual({ type: 'session', sessionId: '7732ba63-53e3-4ea6-8c3c-f4feea58bc00' });
    expect(exit.state).toBe('COMPLETED');
    const a = new CopilotAdapter();
    const gw = await a.buildInvocation(request(gateway), inst('copilot'));
    expect(gw.env).toMatchObject({ COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:4000/openai/v1', COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: 'session-token', COPILOT_MODEL: 'ao-addon' });
    expect(gw.args).toEqual(expect.arrayContaining(['--allow-all-tools', '--no-ask-user', '--output-format', 'json']));
    expect(gw.args.at(-2)).toBe('-p');
    const direct = await a.buildInvocation(request({ providerId: 'a', kind: 'anthropic', modelId: 'claude-sonnet-5', apiKey: 'sk-ant' }), inst('copilot'));
    expect(direct.env).toMatchObject({ COPILOT_PROVIDER_TYPE: 'anthropic', COPILOT_PROVIDER_BASE_URL: 'https://api.anthropic.com', COPILOT_PROVIDER_API_KEY: 'sk-ant', COPILOT_MODEL: 'claude-sonnet-5' });
    const ollama = await a.buildInvocation(request({ providerId: 'o', kind: 'ollama', modelId: 'qwen3', baseUrl: 'http://localhost:11434' }), inst('copilot'));
    expect(ollama.env.COPILOT_PROVIDER_BASE_URL).toBe('http://localhost:11434/v1');
    // Its own login: nothing injected.
    expect((await a.buildInvocation(request(), inst('copilot'))).env).not.toHaveProperty('COPILOT_PROVIDER_BASE_URL');
  });

  it('Qwen: our session id, --auth-type only for an OpenAI-compatible endpoint', async () => {
    const a = new QwenAdapter();
    const own = await a.buildInvocation(request(), inst('qwen'));
    expect(own.args.slice(0, 5)).toEqual(['--yolo', '--output-format', 'stream-json', '--session-id', 'our-uuid']);
    expect(own.args).not.toContain('--auth-type');
    const gw = await a.buildInvocation(request(gateway), inst('qwen'));
    expect(gw.args).toEqual(expect.arrayContaining(['--auth-type', 'openai', '--model', 'ao-addon']));
    expect(gw.args.filter((x) => x === '--auth-type')).toHaveLength(1);
    expect(gw.env).toMatchObject({ OPENAI_BASE_URL: 'http://127.0.0.1:4000/openai/v1', OPENAI_API_KEY: 'session-token', OPENAI_MODEL: 'ao-addon' });
    const direct = await a.buildInvocation(request({ providerId: 'c', kind: 'openai-compatible', modelId: 'm1', apiKey: 'k', baseUrl: 'https://llm.example/v1' }), inst('qwen'));
    expect(direct.args).toEqual(expect.arrayContaining(['--auth-type', 'openai']));
    expect(direct.env).toMatchObject({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://llm.example/v1', OPENAI_MODEL: 'm1' });
  });

  it('Pi: gateway run parsed; add-on models through a models.json of its own', async () => {
    const { events, exit } = run(new PiAdapter(), fixture('pi-0.73.1-gateway.jsonl'), 0);
    expect(events[0]).toMatchObject({ type: 'session' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', name: 'write' }));
    expect(events).toContainEqual({ type: 'message', text: 'Created hello.txt. Done.' });
    expect(exit.state).toBe('COMPLETED');
    const inv = await new PiAdapter().buildInvocation(request(gateway), inst('pi'));
    expect(inv.args).toEqual(expect.arrayContaining(['-p', '--mode', 'json', '--provider', 'ao_gateway', '--model', 'ao-addon']));
    const models = JSON.parse(fs.readFileSync(path.join(inv.env.PI_CODING_AGENT_DIR!, 'models.json'), 'utf8'));
    expect(models.providers.ao_gateway).toMatchObject({ baseUrl: 'http://127.0.0.1:4000/openai/v1', apiKey: 'AO_GATEWAY_KEY', models: [{ id: 'ao-addon' }] });
    expect(inv.env.AO_GATEWAY_KEY).toBe('session-token'); // the key itself is not written to disk
  });

  it('Trae: exit code 0 is decided by its summary; the configuration file holds no key', async () => {
    const a = new TraeAdapter();
    expect(run(a, fixture('trae-0.1.0-gateway.txt'), 0).exit.state).toBe('COMPLETED');
    expect(run(a, ['│ Error       │ ❌ Error code: 401 - invalid api key                     ', '│ Success          │ ❌ No                                 │'], 0).exit.state).toBe('AUTH_REQUIRED');
    expect(run(a, ['│ Success          │ ❌ No                                 │'], 0).exit.state).toBe('FAILED');
    expect(a.capabilities().nativeLogin).toBe(false);
    const inv = await a.buildInvocation(request(gateway), inst('trae-cli'));
    const config = fs.readFileSync(inv.args[inv.args.indexOf('--config-file') + 1]!, 'utf8');
    expect(config).toContain('provider: openrouter');
    expect(config).toContain('base_url: "http://127.0.0.1:4000/openai/v1"');
    expect(config).not.toContain('session-token');
    expect(inv.env.OPENROUTER_API_KEY).toBe('session-token');
    expect(inv.args.slice(0, 2)).toEqual(['run', '--file']);
    expect(fs.readFileSync(inv.args[2]!, 'utf8')).toBe('P');
    await expect(a.buildInvocation(request(), inst('trae-cli'))).rejects.toThrow(/cannot use the provider kind native/);
  });

  it('Kilo Code and Crush: their own configuration for add-on models', async () => {
    const kilo = await new KiloAdapter().buildInvocation(request(gateway), inst('kilo'));
    expect(JSON.parse(kilo.env.KILO_CONFIG_CONTENT!).provider.ao_gateway.options.baseURL).toBe('http://127.0.0.1:4000/openai/v1');
    expect(kilo.env).not.toHaveProperty('OPENCODE_CONFIG_CONTENT');
    expect(kilo.args).toEqual(expect.arrayContaining(['run', '--format', 'json', '--auto', '--model', 'ao_gateway/ao-addon']));
    const crush = await new CrushAdapter().buildInvocation(request(gateway), inst('crush'));
    const config = JSON.parse(fs.readFileSync(path.join(crush.env.CRUSH_GLOBAL_CONFIG!, 'crush.json'), 'utf8'));
    expect(config.providers.ao_gateway).toMatchObject({ type: 'openai-compat', base_url: 'http://127.0.0.1:4000/openai/v1', api_key: '$AO_GATEWAY_KEY' });
    expect(crush.args.slice(0, 4)).toEqual(['run', '--quiet', '--model', 'ao_gateway/ao-addon']);
    expect(new CrushAdapter().capabilities().gitExcludes).toEqual(['.crush']);
  });

  it('command lines the CLIs accepted, and what each adapter claims', async () => {
    const args = async (a: AgentAdapter, exe: string, extra: { additionalDirs?: string[] } = {}) => (await a.buildInvocation({ ...request({ providerId: 'native:x', kind: 'native', modelId: 'm1' }), ...extra }, inst(exe))).args;
    const other = path.join(dir(), 'web');
    expect((await args(new CursorAdapter(), 'cursor-agent', { additionalDirs: [other] })).slice(0, -1)).toEqual(['-p', '--output-format', 'stream-json', '--force', '--trust', '--model', 'm1', '--add-dir', other]);
    expect((await args(new KiroAdapter(), 'kiro-cli')).slice(0, -1)).toEqual(['chat', '--no-interactive', '--trust-all-tools', '--model', 'm1']);
    // Kimi's prompt mode refuses --yolo and --auto.
    const kimi = await args(new KimiAdapter(), 'kimi');
    expect(kimi.slice(0, 4)).toEqual(['--output-format', 'stream-json', '--model', 'm1']);
    expect(kimi).not.toContain('--auto');
    const grok = await args(new GrokAdapter(), 'grok');
    expect(fs.readFileSync(grok[grok.indexOf('--prompt-file') + 1]!, 'utf8')).toBe('P');
    expect(grok).toEqual(expect.arrayContaining(['--output-format', 'streaming-json', '--always-approve', '--session-id', 'our-uuid']));
    expect((await args(new DroidAdapter(), 'droid')).slice(0, 7)).toEqual(['exec', '--output-format', 'stream-json', '--auto', 'medium', '-m', 'm1']);
    await expect(new DroidAdapter().buildInvocation({ ...request(), settings: { autonomy: 'yolo' } }, inst('droid'))).rejects.toThrow(/Invalid autonomy/);
    expect((await args(new AuggieAdapter(), 'auggie')).slice(0, 3)).toEqual(['--print', '--output-format', 'json']);
    expect((await args(new ClineAdapter(), 'cline')).slice(0, 3)).toEqual(['--json', '--auto-approve', 'true']);
    expect((await args(new ContinueAdapter(), 'cn')).slice(0, 4)).toEqual(['-p', '--auto', '--format', 'json']);
    expect((await args(new QoderAdapter(), 'qodercli')).slice(0, 6)).toEqual(['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--session-id', 'our-uuid']);
    expect((await args(new CodeBuddyAdapter(), 'codebuddy')).slice(0, 4)).toEqual(['-p', '--output-format', 'stream-json', '-y']);
    expect((await args(new VibeAdapter(), 'vibe')).slice(0, 3)).toEqual(['--output', 'streaming', '-p']);
    // No prompt on a command line: only the pointer to the prompt file, or the file itself.
    for (const a of defaultAgentManager().list().filter((x) => x.id !== 'claude-code' && x.id !== 'trae')) expect((await a.buildInvocation({ ...request(), prompt: 'do "things" & more' }, inst(a.executables[0]!))).args.join(' '), a.id).not.toContain('things');

    expect(new KiroAdapter().capabilities().verification).toBe('documentation');
    for (const a of [new CursorAdapter(), new KiroAdapter(), new KimiAdapter(), new GrokAdapter(), new AmpAdapter(), new DroidAdapter(), new AuggieAdapter(), new ClineAdapter(), new ContinueAdapter(), new QoderAdapter(), new CodeBuddyAdapter(), new VibeAdapter()]) {
      expect(a.capabilities(), a.id).toMatchObject({ gateway: false, supportedProviders: [], resume: false });
    }
    for (const a of [new CopilotAdapter(), new QwenAdapter(), new TraeAdapter(), new CrushAdapter(), new KiloAdapter(), new PiAdapter()]) expect(a.capabilities().gateway, a.id).toBe(true);
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
    expect(inv.map((a) => a.id)).toEqual(['claude-code', 'codex', 'gemini', 'opencode', 'aider', 'cursor', 'copilot', 'kiro', 'qwen', 'kimi', 'grok', 'trae', 'amp', 'droid', 'auggie', 'crush', 'cline', 'kilo', 'pi', 'continue', 'qoder', 'codebuddy', 'vibe', 'mock']);
    expect(inv.find((a) => a.id === 'mock')!.installed).toBe(true);
  }, 60_000);
});
