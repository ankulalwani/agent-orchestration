import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentState } from '@ao/core';
import { assertSafePathArg, classifyText } from '../detection.js';
import type { AgentCapabilities, AgentEvent, AgentInstallation, AgentStartRequest, Invocation, ParseContext } from '../types.js';
import { GATEWAY_KIND, classifyPlainExit, parsePlainLine, providerEnv } from './base.js';
import { CliAdapter, LIMITED, OpenCodeAdapter, classifyJsonExit, parseJson, record, stateForStatus } from './doc-adapters.js';

/**
 * Adapters for Cursor Agent, GitHub Copilot CLI, Kiro, Qwen Code, Kimi Code, Grok, Trae Agent, Amp,
 * Factory Droid, Auggie, Crush, Cline, Kilo Code, Pi, Continue, Qoder, CodeBuddy and Mistral Vibe.
 *
 * Checked on 2026-10-06 against the installed binaries (versions below), the same way as the adapters in
 * doc-adapters.ts: `--help`, and a headless run without credentials through the flags used here, whose
 * output is kept in `fixtures/`. Harnesses that accept another model endpoint were also run through the
 * worker's model gateway against a fake model (tests/e2e/gateway-agents.test.ts), which shows their
 * success-path events. For the others a successful run needs the vendor's account, so success-path
 * events follow the vendor's documentation and are parsed defensively. Kiro has no Windows build and was
 * written from its documentation only (`verification: 'documentation'`).
 *
 * `resume` is claimed nowhere here: no resume command could be verified without an account.
 */

/** How these CLIs say "sign in first"; `classifyText` only knows the provider-style wordings. */
const AUTH_RE = /(authentication[_ ](required|failed)|no auth(entication)? (information|provided|type)|not (signed|logged) in|need to sign in|no api key found|no providers configured|no model configured|please (log|sign) in|starting login flow|setup cancelled)/i;

const classify = (text: string): AgentState | null => (AUTH_RE.test(text) ? 'AUTH_REQUIRED' : classifyText(text));

/** A line that is not a JSON event: forwarded, and checked for a sign-in message. */
function parseTextLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
  const events = parsePlainLine(line, stream, ctx);
  if (AUTH_RE.test(line)) record(ctx, 'AUTH_REQUIRED', line);
  return events;
}

function fail(ctx: ParseContext, text: string, state: AgentState | null = classify(text)) {
  ctx.resultIsError = true;
  record(ctx, state, text);
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 200) : '';
  const i = input as Record<string, unknown>;
  const s = i.command ?? i.cmd ?? i.file_path ?? i.filePath ?? i.path ?? i.pattern ?? i.url ?? i.description;
  return typeof s === 'string' ? s.slice(0, 200) : JSON.stringify(input).slice(0, 200);
}

function session(msg: Record<string, any>, ctx: ParseContext, out: AgentEvent[], id: unknown = msg.session_id ?? msg.sessionId ?? msg.sessionID) {
  if (typeof id === 'string' && id && id !== ctx.sessionId) {
    ctx.sessionId = id;
    out.push({ type: 'session', sessionId: id });
  }
}

/**
 * The stream-json dialect Claude Code introduced, which Cursor Agent, Qwen Code, Amp, Factory Droid,
 * Qoder and CodeBuddy also emit (observed for each: `system/init` and `result`, or an `error` line):
 * system{init, session_id}, assistant{message.content[text | tool_use]}, result{is_error, subtype,
 * usage, result | error | errors}. Cursor adds tool_call{subtype, tool_call}; Droid adds
 * message{role, text}, tool_call{toolName, parameters}, completion{finalText} and error{message}.
 */
function parseClaudeDialect(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
  const msg = stream === 'stdout' ? parseJson(line) : null;
  if (!msg) return parseTextLine(line, stream, ctx);
  const out: AgentEvent[] = [];
  session(msg, ctx, out);
  switch (msg.type) {
    case 'assistant': {
      const content = msg.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type === 'text' && block.text) out.push({ type: 'message', text: String(block.text) });
        if (block.type === 'tool_use') out.push({ type: 'tool', name: String(block.name), summary: summarize(block.input) });
      }
      // Qoder marks a refused turn on the assistant message itself (`error: "authentication_failed"`).
      if (typeof msg.error === 'string') fail(ctx, `${msg.error}: ${(Array.isArray(content) ? content : []).map((b: any) => b.text ?? '').join(' ')}`);
      break;
    }
    case 'message':
      if (msg.role === 'assistant' && (msg.text || typeof msg.content === 'string')) out.push({ type: 'message', text: String(msg.text ?? msg.content) });
      break;
    case 'tool_call': {
      if (msg.subtype && msg.subtype !== 'started') break;
      const call = msg.tool_call && typeof msg.tool_call === 'object' ? Object.entries(msg.tool_call)[0] : null;
      if (call) out.push({ type: 'tool', name: String(call[0]).replace(/ToolCall$/, ''), summary: summarize((call[1] as any)?.args) });
      else out.push({ type: 'tool', name: String(msg.toolName ?? msg.name ?? 'tool'), summary: summarize(msg.parameters ?? msg.input) });
      break;
    }
    case 'error': {
      const text = String(msg.message ?? msg.error?.message ?? msg.error ?? 'The agent reported an error');
      fail(ctx, text);
      out.push({ type: 'output', stream, text });
      break;
    }
    case 'completion':
      ctx.resultSeen = true;
      if (msg.finalText) out.push({ type: 'message', text: String(msg.finalText) });
      break;
    case 'result': {
      ctx.resultSeen = true;
      ctx.resultIsError = Boolean(msg.is_error) || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
      const u = msg.usage ?? {};
      if (u.input_tokens !== undefined || u.output_tokens !== undefined) {
        out.push({ type: 'usage', inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), outputTokens: u.output_tokens, costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined });
      }
      if (ctx.resultIsError) {
        const parts = [msg.error?.message ?? (typeof msg.error === 'string' ? msg.error : null), ...(Array.isArray(msg.errors) ? msg.errors : []), msg.result, msg.subtype];
        fail(ctx, parts.filter(Boolean).join(': ') || 'The agent reported an error');
      } else {
        // A successful result supersedes transient errors reported before it.
        ctx.lastState = null;
        if (typeof msg.result === 'string' && msg.result) out.push({ type: 'message', text: msg.result });
      }
      break;
    }
  }
  return out;
}

/** Base for the Claude-dialect CLIs: structured output, and an exit that trusts the reported result. */
abstract class ClaudeDialectAdapter extends CliAdapter {
  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), structuredOutput: true };
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    return parseClaudeDialect(line, stream, ctx);
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

const model = (req: AgentStartRequest, flag = '--model') => (req.provider.modelId && req.provider.modelId !== 'default' ? [flag, req.provider.modelId] : []);

/** The project's other repositories as repeated `<flag> <dir>` arguments. */
function dirs(req: AgentStartRequest, flag = '--add-dir') {
  return (req.additionalDirs ?? []).flatMap((d) => {
    assertSafePathArg(d);
    return [flag, d];
  });
}

/** Capabilities of a CLI that only runs on its vendor's account: no direct providers, no gateway. */
const ownAccountOnly = { supportedProviders: [] as string[], gateway: false };

async function writeStateFile(req: AgentStartRequest, folder: string, name: string, content: string) {
  const file = path.join(req.stateDir, folder, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600 });
  assertSafePathArg(file);
  return file;
}

/**
 * Cursor Agent, verified with 2026.10.01: `cursor-agent -p --output-format stream-json --force --trust
 * [--model M] [--add-dir D] <prompt>`. `--force` runs commands without asking and `--trust` skips the
 * workspace trust prompt; without them a headless run waits. It only talks to Cursor's own service
 * (login, or CURSOR_API_KEY from the project's environment). Without credentials: exit 1 with
 * "Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY …" on stderr.
 * The installer also provides the same program as `agent`; only the unambiguous name is searched.
 */
export class CursorAdapter extends ClaudeDialectAdapter {
  readonly id = 'cursor';
  readonly name = 'Cursor Agent';
  readonly executables = ['cursor-agent'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, additionalDirectories: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['-p', '--output-format', 'stream-json', '--force', '--trust', ...model(req), ...dirs(req), pointer];
  }
}

/** Our provider kinds → Copilot CLI's custom-provider types (`copilot help providers`). */
const COPILOT_PROVIDER_TYPE: Record<string, string> = { openai: 'openai', 'openai-compatible': 'openai', ollama: 'openai', anthropic: 'anthropic', 'azure-openai': 'azure' };
const COPILOT_DEFAULT_URL: Record<string, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com' };

/**
 * GitHub Copilot CLI, verified with 1.0.92: `copilot --allow-all-tools --no-ask-user --no-auto-update
 * --no-color --output-format json [--model M] [--add-dir D] -p <prompt>`. `--allow-all-tools` is
 * "required for non-interactive mode"; `--no-ask-user` keeps it from waiting for an answer.
 * Its own login is GitHub (stored login, or COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN). Other models
 * go through its custom-provider variables (COPILOT_PROVIDER_BASE_URL, _TYPE, _API_KEY, COPILOT_MODEL),
 * which need no GitHub login. Without credentials: exit 1, "No authentication information found." on
 * stderr. JSONL events observed through the gateway: assistant.message{data.content, toolRequests},
 * tool.execution_start{data.toolName, arguments} and a final result{sessionId, exitCode}.
 */
export class CopilotAdapter extends CliAdapter {
  readonly id = 'copilot';
  readonly name = 'GitHub Copilot CLI';
  readonly executables = ['copilot'];
  protected readonly providers = Object.keys(COPILOT_PROVIDER_TYPE);

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), structuredOutput: true, additionalDirectories: true };
  }

  protected override directEnv(req: AgentStartRequest): Record<string, string> {
    const p = req.provider;
    const type = COPILOT_PROVIDER_TYPE[p.kind];
    if (!type) return {};
    const base = p.baseUrl ?? COPILOT_DEFAULT_URL[p.kind];
    if (!base) return {};
    // Ollama serves its OpenAI-compatible API under /v1.
    const url = p.kind === 'ollama' && !/\/v1\/?$/.test(base) ? `${base.replace(/\/+$/, '')}/v1` : base;
    return { COPILOT_PROVIDER_BASE_URL: url, COPILOT_PROVIDER_TYPE: type, ...(p.apiKey ? { COPILOT_PROVIDER_API_KEY: p.apiKey } : {}), ...(p.modelId && p.modelId !== 'default' ? { COPILOT_MODEL: p.modelId } : {}) };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['--allow-all-tools', '--no-ask-user', '--no-auto-update', '--no-color', '--output-format', 'json', ...model(req), ...dirs(req), '-p', pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) return parseTextLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    const d = msg.data ?? {};
    session(msg, ctx, out, d.sessionId ?? msg.sessionId);
    switch (msg.type) {
      case 'assistant.message':
        if (d.content) out.push({ type: 'message', text: String(d.content) });
        break;
      case 'tool.execution_start':
        out.push({ type: 'tool', name: String(d.toolName ?? 'tool'), summary: summarize(d.arguments) });
        break;
      case 'session.error': {
        const text = String(d.message ?? 'Copilot reported an error');
        fail(ctx, text, stateForStatus(d.statusCode) ?? classify(text));
        out.push({ type: 'output', stream, text });
        break;
      }
      case 'result':
        ctx.resultSeen = true;
        if (typeof msg.exitCode === 'number' && msg.exitCode !== 0) ctx.resultIsError = true;
        else if (!ctx.resultIsError) ctx.lastState = null;
        break;
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/**
 * Kiro CLI, from its documentation (kiro.dev/docs/cli/headless, read 2026-10-06; there is no Windows
 * build to run): `kiro-cli chat --no-interactive --trust-all-tools [--model M] <prompt>`. Headless runs
 * sign in with KIRO_API_KEY (from the project's environment) or the stored login. Output is treated as
 * text; exit 1 is its general failure, including authentication.
 */
export class KiroAdapter extends CliAdapter {
  readonly id = 'kiro';
  readonly name = 'Kiro CLI';
  readonly executables = ['kiro-cli'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, verification: 'documentation' };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['chat', '--no-interactive', '--trust-all-tools', ...model(req), pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    return stream === 'stderr' ? parseTextLine(line, stream, ctx) : parsePlainLine(line, stream, ctx);
  }
}

/**
 * Qwen Code, verified with 0.25.0: `qwen --yolo --output-format stream-json --session-id <uuid> [-m M]
 * [--add-dir D] <prompt>` (the prompt is positional; `-p` is deprecated). It has no default login:
 * without `--auth-type` a headless run ends with "No auth type is selected". An OpenAI-compatible
 * endpoint is `--auth-type openai` with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL, which is also
 * how it uses the model gateway; `--auth-type` is left out for its own login so its settings decide.
 */
export class QwenAdapter extends ClaudeDialectAdapter {
  readonly id = 'qwen';
  readonly name = 'Qwen Code';
  readonly executables = ['qwen'];
  protected readonly providers = ['openai', 'openai-compatible'];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), assignSessionId: true, additionalDirectories: true };
  }

  protected override directEnv(req: AgentStartRequest): Record<string, string> {
    const p = req.provider;
    return { QWEN_CODE_SUPPRESS_YOLO_WARNING: '1', ...providerEnv(p.kind, p.apiKey, p.baseUrl, p.extra), ...(this.providers.includes(p.kind) && p.modelId !== 'default' ? { OPENAI_MODEL: p.modelId } : {}) };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    const auth = this.providers.includes(req.provider.kind) ? ['--auth-type', 'openai'] : [];
    return ['--yolo', '--output-format', 'stream-json', '--session-id', req.sessionId, ...auth, ...model(req), ...dirs(req), pointer];
  }
}

/**
 * Kimi Code, verified with 2.1.1 (the successor of the Python `kimi-cli`, which now only prints that it
 * is no longer maintained): `kimi --output-format stream-json [-m M] [--add-dir D] -p <prompt>`. Prompt
 * mode cannot be combined with `--yolo` or `--auto` ("Cannot combine --prompt with --auto"). Without a
 * login: exit 1, "No model configured. Run `kimi` and use /login to sign in …" on stderr.
 * Observed stream-json: {role:"meta", type:"system.version"}; other lines carry a role and content.
 */
export class KimiAdapter extends CliAdapter {
  readonly id = 'kimi';
  readonly name = 'Kimi Code';
  readonly executables = ['kimi'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, structuredOutput: true, additionalDirectories: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['--output-format', 'stream-json', ...model(req), ...dirs(req), '-p', pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) return parseTextLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    session(msg, ctx, out);
    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : (Array.isArray(msg.content) ? msg.content : []).map((b: any) => (b.type === 'text' ? b.text : '')).join('');
      if (text) out.push({ type: 'message', text });
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) out.push({ type: 'tool', name: String(call.function?.name ?? call.name ?? 'tool'), summary: String(call.function?.arguments ?? '').slice(0, 200) });
    } else if (msg.type === 'error' || msg.role === 'error') {
      const text = String(msg.message ?? msg.content ?? 'Kimi reported an error');
      fail(ctx, text);
      out.push({ type: 'output', stream, text });
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/**
 * Grok CLI (xAI), verified with 1.0.46: `grok --prompt-file <file> --output-format streaming-json
 * --always-approve --session-id <uuid> [-m M]`. The prompt file is read by the CLI itself. It signs in
 * with its stored login or XAI_API_KEY (from the project's environment). Without credentials: exit 1
 * and one line {type:"error", message:"Not signed in. …"}. `streaming-json` is one ACP session update
 * per line (agent_message_chunk, tool_call, …), which is how a successful run is read.
 */
export class GrokAdapter extends CliAdapter {
  readonly id = 'grok';
  readonly name = 'Grok CLI';
  readonly executables = ['grok'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, structuredOutput: true, assignSessionId: true };
  }

  protected args(file: string, _p: string, req: AgentStartRequest) {
    return ['--prompt-file', file, '--output-format', 'streaming-json', '--always-approve', '--session-id', req.sessionId, ...model(req)];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) return parseTextLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    session(msg, ctx, out);
    if (msg.type === 'error') {
      const text = String(msg.message ?? 'Grok reported an error');
      fail(ctx, text);
      return [...out, { type: 'output', stream, text }];
    }
    const u = msg.update ?? msg.params?.update ?? msg;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        // Chunks of one message: forwarded as output, since the end of a message is not marked.
        if (u.content?.type === 'text' && u.content.text) out.push({ type: 'output', stream, text: String(u.content.text) });
        break;
      case 'tool_call':
        out.push({ type: 'tool', name: String(u.kind ?? 'tool'), summary: String(u.title ?? '').slice(0, 200) });
        break;
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/** Our provider kinds → Trae Agent provider names (its configuration file's `provider`). */
// Its `openai` provider speaks the Responses API without streaming; `openrouter` is its OpenAI chat
// completions client with a base URL, which is what OpenAI-compatible endpoints and the gateway serve.
const TRAE_PROVIDER: Record<string, string> = { openai: 'openai', 'openai-compatible': 'openrouter', anthropic: 'anthropic', google: 'google', openrouter: 'openrouter', ollama: 'ollama', [GATEWAY_KIND]: 'openrouter' };

/**
 * Trae Agent (ByteDance, open source), verified with 0.1.0: `trae-cli run --file <prompt file>
 * --working-dir <dir> --config-file <yaml> --trajectory-file <file> --console-type simple`. It has no
 * login of its own: every run needs a configuration file naming a provider and model ("Config file not
 * found" otherwise), which the adapter writes into the state directory. The key travels in the
 * provider's `<PROVIDER>_API_KEY` variable, not in the file. Its trajectory file would otherwise be
 * written into the project. Output is text.
 */
export class TraeAdapter extends CliAdapter {
  readonly id = 'trae';
  readonly name = 'Trae Agent';
  readonly executables = ['trae-cli'];
  protected readonly providers = ['openai', 'openai-compatible', 'anthropic', 'google', 'openrouter', 'ollama'];

  override capabilities(): AgentCapabilities {
    // No login of its own: it always needs a provider.
    return { ...super.capabilities(), nativeLogin: false };
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const p = req.provider;
    const provider = TRAE_PROVIDER[p.kind];
    if (!provider) throw new Error(`Trae Agent cannot use the provider kind ${p.kind}; give it an add-on model`);
    const gateway = p.kind === GATEWAY_KIND;
    const baseUrl = gateway ? `${(p.baseUrl ?? '').replace(/\/+$/, '')}/openai/v1` : p.baseUrl;
    const q = (s: string) => JSON.stringify(s); // YAML accepts JSON strings
    const config = [
      'agents:',
      '  trae_agent:',
      '    enable_lakeview: false',
      '    model: ao_model',
      '    max_steps: 200',
      '    tools: [bash, str_replace_based_edit_tool, sequentialthinking, task_done]',
      'model_providers:',
      `  ${provider}:`,
      // Replaced by the provider's API key variable at run time; never written to disk.
      '    api_key: "from-environment"',
      `    provider: ${provider}`,
      ...(baseUrl ? [`    base_url: ${q(baseUrl)}`] : []),
      'models:',
      '  ao_model:',
      `    model_provider: ${provider}`,
      `    model: ${q(p.modelId)}`,
      '    max_tokens: 8192',
      '    temperature: 0.5',
      '    top_p: 1',
      '    top_k: 0',
      '    max_retries: 3',
      '    parallel_tool_calls: true',
      '',
    ].join('\n');
    const file = await writeStateFile(req, 'trae', `${req.taskId}.yaml`, config);
    const trajectory = path.join(req.stateDir, 'trae', `${req.taskId}-${req.sessionId}.trajectory.json`);
    assertSafePathArg(trajectory);
    assertSafePathArg(req.cwd);
    const inv = await super.buildInvocation(req, inst);
    const key = `${provider.toUpperCase()}_API_KEY`;
    const env = { ...inv.env, ...(p.apiKey ? { [key]: p.apiKey } : {}), ...(baseUrl ? { [`${provider.toUpperCase()}_BASE_URL`]: baseUrl } : {}), PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    return { ...inv, args: [...inv.args, '--config-file', file, '--trajectory-file', trajectory], env };
  }

  protected args(file: string, _p: string, req: AgentStartRequest) {
    return ['run', '--file', file, '--working-dir', req.cwd, '--console-type', 'simple'];
  }

  protected override withGatewayArgs(args: string[]) {
    return args;
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    // It exits 0 whatever happened: its summary table ("Success │ ❌ No") and error rows decide.
    const events = parsePlainLine(line, stream, ctx);
    const error = /^[│|]\s*Error\s*[│|]\s*(?:❌\s*)?(.+?)\s*[│|]?$/.exec(line.trim()) ?? /^Error:\s*(.+)$/.exec(line.trim());
    if (error) fail(ctx, error[1]!);
    else if (/Success\s*[│|]\s*❌/.test(line)) ctx.resultIsError = true;
    else if (/Success\s*[│|]\s*✅/.test(line)) {
      ctx.resultIsError = false;
      ctx.lastState = null;
    }
    return events;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    if (ctx.resultIsError && code === 0) {
      if (ctx.lastState && LIMITED.includes(ctx.lastState)) return { state: ctx.lastState, detail: ctx.detail ?? undefined, retryAt: ctx.retryAt };
      return { state: 'FAILED' as AgentState, detail: ctx.detail ?? 'Trae Agent reported an error' };
    }
    return classifyPlainExit(code, signal, ctx);
  }
}

/**
 * Amp (Sourcegraph), verified with the 2026-10-06 build: `amp --no-notifications --no-ide --no-color
 * --settings-file <file> --stream-json -x <prompt>`. Command confirmations are switched off through the
 * settings key `amp.dangerouslyAllowAll` (there is no flag), in a settings file of its own for the run.
 * `--stream-json` is "Claude Code-compatible stream JSON". It only talks to Amp's service: AMP_API_KEY
 * (from the project's environment) or the stored login. Without either it starts a browser login and
 * waits ("No API key found. Starting login flow..."): that line is reported as AUTH_REQUIRED.
 */
export class AmpAdapter extends ClaudeDialectAdapter {
  readonly id = 'amp';
  readonly name = 'Amp';
  readonly executables = ['amp'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    // The model follows Amp's agent mode; there is no model flag.
    return { ...super.capabilities(), ...ownAccountOnly, modelSelection: false };
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const settings = await writeStateFile(req, 'amp', `${req.taskId}.settings.json`, JSON.stringify({ 'amp.dangerouslyAllowAll': true }));
    const inv = await super.buildInvocation(req, inst);
    return { ...inv, args: ['--settings-file', settings, ...inv.args] };
  }

  protected args(_f: string, pointer: string) {
    return ['--no-notifications', '--no-ide', '--no-color', '--stream-json', '-x', pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const events = super.parseLine(line, stream, ctx);
    // The login flow waits for a browser: say so at once instead of leaving it to hang detection.
    if (/starting login flow/i.test(line)) events.push({ type: 'state', state: 'AUTH_REQUIRED', detail: 'Amp is not signed in: run `amp login` on the worker or set AMP_API_KEY' });
    return events;
  }
}

/**
 * Factory Droid, verified with 0.233.0: `droid exec --output-format stream-json --auto <level> [-m M]
 * -f <prompt file>`. Without `--auto` it is read-only; `medium` (the default here, adapter setting
 * `autonomy`: low | medium | high) allows edits, builds and local Git but no push. It signs in with the
 * stored login or FACTORY_API_KEY (from the project's environment). Observed without credentials:
 * system{init, session_id, tools} then error{message:"Error: Authentication failed. …"}, exit 1.
 */
export class DroidAdapter extends ClaudeDialectAdapter {
  readonly id = 'droid';
  readonly name = 'Factory Droid';
  readonly executables = ['droid'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly };
  }

  protected args(file: string, _p: string, req: AgentStartRequest) {
    const autonomy = typeof req.settings?.autonomy === 'string' ? req.settings.autonomy : 'medium';
    if (!/^(low|medium|high)$/.test(autonomy)) throw new Error(`Invalid autonomy level ${autonomy}`);
    return ['exec', '--output-format', 'stream-json', '--auto', autonomy, ...model(req, '-m'), '-f', file];
  }
}

/**
 * Auggie (Augment Code), verified with 0.36.0: `auggie --print --output-format json [-m M]
 * [--add-workspace D] --instruction-file <prompt file>`. Print mode skips the indexing confirmation.
 * It signs in with the stored login or AUGMENT_SESSION_AUTH (from the project's environment). Without
 * credentials: exit 1, "No auth provided. Please log in with `auggie login` …" on stderr. The JSON
 * output is one object at the end ({result, is_error, session_id}).
 */
export class AuggieAdapter extends ClaudeDialectAdapter {
  readonly id = 'auggie';
  readonly name = 'Auggie';
  readonly executables = ['auggie'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, additionalDirectories: true };
  }

  protected args(file: string, _p: string, req: AgentStartRequest) {
    return ['--print', '--output-format', 'json', ...model(req), ...dirs(req, '--add-workspace'), '--instruction-file', file];
  }
}

/**
 * Crush (Charm), verified with 0.97.1: `crush run --quiet [-m M] <prompt>`. A non-interactive run
 * approves its own tool calls. It reads provider keys from the environment (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY, …) or its own configuration; with none: exit 1,
 * "No providers configured". Add-on models reach it through a configuration of its own for the run
 * (CRUSH_GLOBAL_CONFIG) with an OpenAI-compatible provider. Output is text; `.crush/` (its session
 * data in the project) is hidden from Git.
 */
export class CrushAdapter extends CliAdapter {
  readonly id = 'crush';
  readonly name = 'Crush';
  readonly executables = ['crush'];
  protected readonly providers = ['anthropic', 'openai', 'google', 'openrouter'];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), gitExcludes: ['.crush'] };
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const inv = await super.buildInvocation(req, inst);
    if (req.provider.kind !== GATEWAY_KIND) return inv;
    const m = req.provider.modelId;
    const config = {
      providers: { ao_gateway: { name: 'Agent Orchestration add-on models', type: 'openai-compat', base_url: `${(req.provider.baseUrl ?? '').replace(/\/+$/, '')}/openai/v1`, api_key: '$AO_GATEWAY_KEY', models: [{ id: m, name: m, context_window: 128000, default_max_tokens: 8192 }] } },
      models: { large: { model: m, provider: 'ao_gateway' }, small: { model: m, provider: 'ao_gateway' } },
    };
    const file = await writeStateFile(req, path.join('crush', req.taskId), 'crush.json', JSON.stringify(config));
    return { ...inv, env: { ...inv.env, CRUSH_GLOBAL_CONFIG: path.dirname(file), CRUSH_DISABLE_PROVIDER_AUTO_UPDATE: '1' } };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    const m = req.provider.modelId && req.provider.modelId !== 'default' ? ['--model', req.provider.kind === GATEWAY_KIND ? `ao_gateway/${req.provider.modelId}` : req.provider.modelId] : [];
    return ['run', '--quiet', ...m, pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    return stream === 'stderr' ? parseTextLine(line, stream, ctx) : parsePlainLine(line, stream, ctx);
  }
}

/**
 * Cline CLI, verified with 3.0.68: `cline --json --auto-approve true [-m M] <prompt>` (a prompt
 * argument runs in act mode). It uses the provider configured with `cline auth` (Cline's own account
 * by default). Observed JSON lines: hook_event, agent_event{event{type, …}} and a final
 * run_result{finishReason, usage, text}; an unauthorized run ends with
 * agent_event{event{type:"error", errorClass:"auth"}}, run_result{finishReason:"error"} and exit 1.
 */
export class ClineAdapter extends CliAdapter {
  readonly id = 'cline';
  readonly name = 'Cline';
  readonly executables = ['cline'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, structuredOutput: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['--json', '--auto-approve', 'true', ...model(req), pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = parseJson(line);
    if (!msg) return parseTextLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    session(msg, ctx, out, msg.taskId);
    const e = msg.event ?? {};
    if (msg.type === 'agent_event' && e.type === 'error') {
      const text = String(e.error?.message ?? 'Cline reported an error');
      fail(ctx, text, e.errorClass === 'auth' ? 'AUTH_REQUIRED' : classify(text));
      out.push({ type: 'output', stream, text });
    } else if (msg.type === 'agent_event' && (e.type === 'tool_call_start' || e.type === 'tool_start')) {
      out.push({ type: 'tool', name: String(e.toolName ?? e.name ?? 'tool'), summary: summarize(e.input ?? e.args) });
    } else if (msg.type === 'run_result') {
      ctx.resultSeen = true;
      const u = msg.usage ?? {};
      out.push({ type: 'usage', inputTokens: (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), outputTokens: u.outputTokens, costUsd: typeof u.totalCost === 'number' ? u.totalCost : undefined, model: typeof msg.model?.id === 'string' ? msg.model.id : undefined });
      if (msg.finishReason === 'error') {
        // The error event before it already says why; keep its classification.
        ctx.resultIsError = true;
        if (!ctx.detail && msg.text) record(ctx, classify(String(msg.text)), String(msg.text));
      } else {
        ctx.resultIsError = false;
        ctx.lastState = null;
        if (msg.text) out.push({ type: 'message', text: String(msg.text) });
      }
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/**
 * Kilo Code CLI, verified with 7.8.3. It is built on OpenCode and keeps its command line and JSON
 * events (`kilo run --format json --auto [-m provider/model] <message>`; observed: the same
 * error{sessionID, error{name, data{message, statusCode}}} line), so it reuses that adapter. Its own
 * configuration variable is KILO_CONFIG_CONTENT.
 */
export class KiloAdapter extends OpenCodeAdapter {
  override readonly id: string = 'kilo';
  override readonly name: string = 'Kilo Code';
  override readonly executables: string[] = ['kilo', 'kilocode'];
}

/** Our provider kinds → Pi provider names (`--provider`). */
const PI_PROVIDER: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', google: 'google', openrouter: 'openrouter', bedrock: 'amazon-bedrock' };

/**
 * Pi coding agent, verified with 0.73.1: `pi -p --mode json [--provider P] [--model M] <prompt>`. It has
 * no permission prompts. Provider keys come from the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY, …) or its own login; with none: exit 1, "No API key found for the selected model."
 * Add-on models reach it through a `models.json` in an agent folder of its own for the run
 * (PI_CODING_AGENT_DIR). JSON mode starts with {type:"session", id}; see `parseLine` for the rest.
 */
export class PiAdapter extends CliAdapter {
  readonly id = 'pi';
  readonly name = 'Pi';
  readonly executables = ['pi'];
  protected readonly providers = Object.keys(PI_PROVIDER);

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), structuredOutput: true };
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const inv = await super.buildInvocation(req, inst);
    if (req.provider.kind !== GATEWAY_KIND) return inv;
    const models = { providers: { ao_gateway: { baseUrl: `${(req.provider.baseUrl ?? '').replace(/\/+$/, '')}/openai/v1`, api: 'openai-completions', apiKey: 'AO_GATEWAY_KEY', compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: req.provider.modelId }] } } };
    const file = await writeStateFile(req, path.join('pi', req.taskId), 'models.json', JSON.stringify(models));
    return { ...inv, env: { ...inv.env, PI_CODING_AGENT_DIR: path.dirname(file), PI_SKIP_VERSION_CHECK: '1' } };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    const provider = req.provider.kind === GATEWAY_KIND ? 'ao_gateway' : PI_PROVIDER[req.provider.kind];
    return ['-p', '--mode', 'json', ...(provider ? ['--provider', provider] : []), ...model(req), pointer];
  }

  protected override withGatewayArgs(args: string[]) {
    return args;
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) return parseTextLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    if (msg.type === 'session') session(msg, ctx, out, msg.id);
    else if (msg.type === 'tool_execution_start') out.push({ type: 'tool', name: String(msg.toolName ?? 'tool'), summary: summarize(msg.args) });
    else if (msg.type === 'message_end' && msg.message?.role === 'assistant') {
      const m = msg.message;
      for (const block of Array.isArray(m.content) ? m.content : []) if (block.type === 'text' && block.text) out.push({ type: 'message', text: String(block.text) });
      const u = m.usage;
      if (u) out.push({ type: 'usage', inputTokens: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), outputTokens: u.output, costUsd: typeof u.cost?.total === 'number' ? u.cost.total : undefined, model: typeof m.model === 'string' ? m.model : undefined });
      if (m.stopReason === 'error' || m.errorMessage) fail(ctx, String(m.errorMessage ?? 'Pi reported an error'));
      else if (m.stopReason === 'stop') {
        ctx.resultSeen = true;
        ctx.resultIsError = false;
        ctx.lastState = null;
      }
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/**
 * Continue CLI, verified with 1.5.47: `cn -p --auto --format json <prompt>` (`--auto` allows all tools).
 * It uses the assistant configured in its own login or configuration; `--model` takes a hub slug, not a
 * model id, so the model is not chosen here. Without a login or configuration: exit 1 and
 * {"status":"error","message":…} on stderr. The JSON output is one object at the end.
 */
export class ContinueAdapter extends CliAdapter {
  readonly id = 'continue';
  readonly name = 'Continue CLI';
  readonly executables = ['cn'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, modelSelection: false };
  }

  protected args(_f: string, pointer: string) {
    return ['-p', '--auto', '--format', 'json', pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = parseJson(line);
    if (!msg) return parseTextLine(line, stream, ctx);
    if (msg.status === 'error') {
      const text = String(msg.message ?? 'Continue reported an error');
      // Its message for a missing login names no cause ("The request failed and the interceptors …").
      fail(ctx, text, classify(text) ?? (/interceptors did not return/.test(text) ? 'AUTH_REQUIRED' : null));
      return [{ type: 'output', stream, text }];
    }
    const text = msg.response ?? msg.message;
    return typeof text === 'string' && text ? [{ type: 'message', text }] : [{ type: 'output', stream, text: line }];
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/**
 * Qoder CLI, verified with 1.1.65: `qodercli -p --output-format stream-json
 * --dangerously-skip-permissions --session-id <uuid> [-m M] [--add-dir D] <prompt>`. It only talks to
 * Qoder's service (stored login). Observed without a login: system{init}, assistant{error:
 * "authentication_failed", "Not logged in · Please run /login"} and result{subtype:"success",
 * is_error:true}, exit 1.
 */
export class QoderAdapter extends ClaudeDialectAdapter {
  readonly id = 'qoder';
  readonly name = 'Qoder CLI';
  readonly executables = ['qodercli'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, assignSessionId: true, additionalDirectories: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['-p', '--output-format', 'stream-json', '--dangerously-skip-permissions', '--session-id', req.sessionId, ...model(req), ...dirs(req), pointer];
  }
}

/**
 * CodeBuddy Code (Tencent), verified with 2.161.4: `codebuddy -p --output-format stream-json -y
 * --session-id <uuid> [--model M] [--add-dir D] <prompt>` (`-y` is --dangerously-skip-permissions).
 * It only talks to CodeBuddy's service (stored login). Without a login it exits 0 after
 * result{subtype:"error_during_execution", is_error:true, errors:["Authentication required. …"]}:
 * the result decides, not the exit code.
 */
export class CodeBuddyAdapter extends ClaudeDialectAdapter {
  readonly id = 'codebuddy';
  readonly name = 'CodeBuddy Code';
  readonly executables = ['codebuddy'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, assignSessionId: true, additionalDirectories: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    return ['-p', '--output-format', 'stream-json', '-y', '--session-id', req.sessionId, ...model(req), ...dirs(req), pointer];
  }
}

/**
 * Mistral Vibe, verified with 2.2.1: `vibe --output streaming -p <prompt>` (programmatic mode approves
 * all tools). The model comes from its own configuration (`~/.vibe/config.toml`); the key from its
 * configuration or MISTRAL_API_KEY (from the project's environment). Without a key it opens its setup
 * screen and exits 0 with "Setup cancelled.", which must not count as success. `streaming` is one JSON
 * message per line ({role, content, tool_calls}).
 */
export class VibeAdapter extends CliAdapter {
  readonly id = 'vibe';
  readonly name = 'Mistral Vibe';
  readonly executables = ['vibe'];
  protected readonly providers: string[] = [];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), ...ownAccountOnly, structuredOutput: true, modelSelection: false };
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const inv = await super.buildInvocation(req, inst);
    return { ...inv, env: { ...inv.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } };
  }

  protected args(_f: string, pointer: string) {
    return ['--output', 'streaming', '-p', pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) {
      if (/setup cancelled|MissingAPIKeyError/i.test(line)) fail(ctx, line, 'AUTH_REQUIRED');
      return parsePlainLine(line, stream, ctx);
    }
    const out: AgentEvent[] = [];
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string' && msg.content) out.push({ type: 'message', text: msg.content });
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) out.push({ type: 'tool', name: String(call.function?.name ?? 'tool'), summary: String(call.function?.arguments ?? '').slice(0, 200) });
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}
