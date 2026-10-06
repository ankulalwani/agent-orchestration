import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentState } from '@ao/core';
import { assertSafePathArg, baseEnv, classifyText, extractRetryAt } from '../detection.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentInstallation, AgentStartRequest, Invocation, ParseContext } from '../types.js';
import { GATEWAY_KIND, classifyPlainExit, detectExecutable, gatewayLaunch, parsePlainLine, providerEnv, writePromptFile } from './base.js';

/**
 * Adapters for Codex, Gemini CLI, OpenCode and Aider. Their command lines and output formats were
 * checked against the real binaries on 2026-09-27 (versions below): `--help`, and runs without valid
 * credentials, whose output is kept in `fixtures/`. Successful runs were not possible without the
 * user's accounts, so success-path events follow the tools' documentation and are parsed defensively;
 * `resume` is only claimed where the resume command itself was verified.
 *
 * The prompt goes into a file in the task state directory and the agent is told to read it (no
 * command-line length limits, nothing sensitive in process listings).
 */
export const POINTER = (file: string) =>
  `Read the task instructions in the file ${file} and follow them exactly. That file is the complete task description.`;

export const LIMITED: AgentState[] = ['RATE_LIMITED', 'CAPACITY_LIMITED', 'CONTEXT_EXHAUSTED', 'AUTH_REQUIRED', 'NETWORK_ERROR'];

/** HTTP status → agent state, for CLIs that report the provider's status code. */
export function stateForStatus(status: unknown): AgentState | null {
  if (status === 401 || status === 403) return 'AUTH_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503 || status === 529) return 'CAPACITY_LIMITED';
  return null;
}

export function record(ctx: ParseContext, state: AgentState | null, detail: string) {
  if (state) ctx.lastState = state;
  ctx.detail = detail.slice(0, 500);
  ctx.retryAt = extractRetryAt(detail) ?? ctx.retryAt;
}

export function parseJson(line: string): Record<string, any> | null {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Exit handling for JSON-event CLIs: explicit failure events win over the exit code. */
export function classifyJsonExit(code: number | null, signal: string | null, ctx: ParseContext) {
  if (ctx.lastState && LIMITED.includes(ctx.lastState)) return { state: ctx.lastState, detail: ctx.detail ?? undefined, retryAt: ctx.retryAt };
  if (ctx.resultIsError) return { state: 'FAILED' as AgentState, detail: ctx.detail ?? 'The agent reported an error' };
  if (signal) return { state: 'CRASHED' as AgentState, detail: `Terminated by ${signal}` };
  if (code === 0) return { state: 'COMPLETED' as AgentState };
  return classifyPlainExit(code, signal, ctx);
}

export abstract class CliAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly executables: string[];
  protected abstract readonly providers: string[];
  protected abstract args(promptFile: string, pointer: string, req: AgentStartRequest): string[];

  detect(): Promise<AgentInstallation> {
    return detectExecutable(this.executables);
  }

  capabilities(): AgentCapabilities {
    return {
      resume: false,
      assignSessionId: false,
      structuredOutput: false,
      mcp: false,
      instructions: true,
      modelSelection: true,
      interactiveInput: false,
      structuredLimits: false,
      // Its own configuration/login by default (AO_HARNESS_OWN_LOGIN=0 turns that off); add-on models through the worker's gateway.
      nativeLogin: process.env.AO_HARNESS_OWN_LOGIN !== '0',
      gateway: true,
      supportedProviders: this.providers,
      verification: 'binary',
    };
  }

  async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const file = await writePromptFile(req);
    // No `stdin`: the runtime closes it at once. Codex otherwise waits for more input on a piped stdin.
    if (req.provider.kind === GATEWAY_KIND) {
      // Through the model gateway: the harness keeps its own API; only its endpoint, key and model change.
      const gw = gatewayLaunch(this.id, req.provider);
      const gwReq = { ...req, provider: { ...req.provider, modelId: gw.model } };
      return { command: inst.path ?? this.executables[0]!, args: this.withGatewayArgs(this.args(file, POINTER(file), gwReq), gw.args), env: { ...baseEnv(), ...gw.env, ...(req.env ?? {}) } };
    }
    const env = { ...baseEnv(), ...this.directEnv(req), ...(req.env ?? {}) };
    return { command: inst.path ?? this.executables[0]!, args: this.args(file, POINTER(file), req), env };
  }

  /** Environment for the harness's own login or a provider it supports directly. */
  protected directEnv(req: AgentStartRequest): Record<string, string> {
    return providerEnv(req.provider.kind, req.provider.apiKey, req.provider.baseUrl, req.provider.extra);
  }

  /** Where the gateway's extra arguments go: before the last argument (the prompt), e.g. Codex config overrides. */
  protected withGatewayArgs(args: string[], extra: string[]) {
    return extra.length ? [...args.slice(0, -1), ...extra, args[args.length - 1]!] : args;
  }

  parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    return parsePlainLine(line, stream, ctx);
  }

  classifyExit(code: number | null, signal: string | null, ctx: ParseContext): { state: AgentState; detail?: string; retryAt?: number | null } {
    return classifyPlainExit(code, signal, ctx);
  }
}

/**
 * OpenAI Codex CLI, verified with codex-cli 0.157.1:
 *   `codex exec --json --sandbox workspace-write --skip-git-repo-check [-m M] <prompt>`;
 *   resume: `codex exec resume <thread_id> --json -c sandbox_mode="workspace-write" … <prompt>`
 *   (`resume` accepts no `--sandbox`). `--full-auto`, used before, is rejected ("unexpected argument").
 * Observed JSONL: thread.started{thread_id}, turn.started, error{message}, item.completed{item},
 * turn.failed{error.message}. From the docs: item.* with agent_message / command_execution /
 * file_change items and turn.completed{usage}.
 */
export class CodexAdapter extends CliAdapter {
  readonly id = 'codex';
  readonly name = 'OpenAI Codex';
  readonly executables = ['codex'];
  // Codex only speaks the Responses API and takes another endpoint only as a configured model provider:
  // run with OPENAI_BASE_URL for an OpenAI-compatible provider, 0.157.1 still connected to api.openai.com
  // with that provider's key. Those providers (also Ollama and OpenRouter) reach it through the gateway.
  protected readonly providers = ['openai', 'azure-openai'];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), resume: true, structuredOutput: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    const model = req.provider.modelId && req.provider.modelId !== 'default' ? ['--model', req.provider.modelId] : [];
    if (req.resumeSessionId) return ['exec', 'resume', req.resumeSessionId, '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', ...model, pointer];
    return ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...model, pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) return parsePlainLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    switch (msg.type) {
      case 'thread.started':
        if (typeof msg.thread_id === 'string') out.push({ type: 'session', sessionId: msg.thread_id });
        break;
      case 'error': {
        // "Reconnecting... n/5 (…)" retries are progress, not the outcome: only final errors count.
        const text = String(msg.message ?? '');
        out.push({ type: 'output', stream, text });
        if (!/^Reconnecting\.\.\./.test(text)) record(ctx, classifyText(text), text);
        break;
      }
      case 'turn.failed': {
        const text = String(msg.error?.message ?? 'Codex turn failed');
        ctx.resultSeen = true;
        ctx.resultIsError = true;
        record(ctx, classifyText(text), text);
        break;
      }
      case 'turn.completed': {
        ctx.resultSeen = true;
        // A completed turn supersedes transient errors reported before it.
        ctx.resultIsError = false;
        ctx.lastState = null;
        const u = msg.usage ?? {};
        out.push({ type: 'usage', inputTokens: (u.input_tokens ?? 0) + (u.cached_input_tokens ?? 0), outputTokens: u.output_tokens });
        break;
      }
      case 'item.completed': {
        const item = msg.item ?? {};
        if (item.type === 'agent_message' && item.text) out.push({ type: 'message', text: String(item.text) });
        else if (item.type === 'command_execution') out.push({ type: 'tool', name: 'shell', summary: String(item.command ?? '').slice(0, 200) });
        else if (item.type === 'file_change') out.push({ type: 'tool', name: 'edit', summary: (item.changes ?? []).map((c: any) => c.path).join(', ').slice(0, 200) });
        else if (item.type === 'error' && item.message) out.push({ type: 'output', stream, text: String(item.message) });
        break;
      }
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/**
 * Gemini CLI, verified with 0.61.0: `gemini --yolo --skip-trust -o stream-json --session-id <uuid>
 * [-m M] -p <prompt>`. Without `--skip-trust` an unfamiliar project folder silently downgrades YOLO to
 * "default" approval ("the current folder is not trusted"), which stalls headless runs.
 * Observed stream-json: init{session_id}, message{role,content}, result{status:"error",error{message}}.
 * Missing credentials: exit 41 with "Please set an Auth method …" on stderr. Resume by id could not be
 * verified (sessions are only saved after a successful exchange), so it is not claimed.
 */
export class GeminiAdapter extends CliAdapter {
  readonly id = 'gemini';
  readonly name = 'Gemini CLI';
  readonly executables = ['gemini'];
  protected readonly providers = ['google', 'vertex'];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), assignSessionId: true, structuredOutput: true };
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const inv = await super.buildInvocation(req, inst);
    if (req.provider.kind !== GATEWAY_KIND) return inv;
    // Headless Gemini CLI takes its auth type from its settings: a home of its own for this run selects
    // API-key authentication (the key is the gateway token). The user's own Gemini home is not touched.
    const home = path.join(req.stateDir, 'gemini-home', req.taskId);
    await fs.mkdir(path.join(home, '.gemini'), { recursive: true });
    await fs.writeFile(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }), 'utf8');
    return { ...inv, env: { ...inv.env, GEMINI_CLI_HOME: home } };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    const a = ['--yolo', '--skip-trust', '--output-format', 'stream-json', '--session-id', req.sessionId];
    if (req.provider.modelId && req.provider.modelId !== 'default') a.push('--model', req.provider.modelId);
    return [...a, '--prompt', pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) {
      if (/please set an auth method|api key not valid/i.test(line)) record(ctx, 'AUTH_REQUIRED', line);
      return parsePlainLine(line, stream, ctx);
    }
    const out: AgentEvent[] = [];
    switch (msg.type) {
      case 'init':
        if (typeof msg.session_id === 'string') out.push({ type: 'session', sessionId: msg.session_id });
        break;
      case 'message':
        if (msg.role === 'assistant' && msg.content) out.push({ type: 'message', text: String(msg.content) });
        break;
      case 'tool_use':
        out.push({ type: 'tool', name: String(msg.tool_name ?? msg.name ?? 'tool'), summary: JSON.stringify(msg.parameters ?? msg.input ?? {}).slice(0, 200) });
        break;
      case 'result': {
        ctx.resultSeen = true;
        const s = msg.stats ?? {};
        if (s.input_tokens !== undefined || s.output_tokens !== undefined) out.push({ type: 'usage', inputTokens: s.input_tokens, outputTokens: s.output_tokens });
        if (msg.status === 'error') {
          ctx.resultIsError = true;
          const text = String(msg.error?.message ?? 'Gemini reported an error');
          record(ctx, /api key not valid/i.test(text) ? 'AUTH_REQUIRED' : classifyText(text), text);
        }
        break;
      }
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/** Our provider kinds → OpenCode provider ids (`--model <provider>/<model>`). */
const OPENCODE_PROVIDER: Record<string, string> = { 'azure-openai': 'azure', bedrock: 'amazon-bedrock', vertex: 'google-vertex' };

/**
 * OpenCode, verified with 1.18.32: `opencode run --format json --auto [-m provider/model] <message>`.
 * `--auto` auto-approves permissions that are not explicitly denied (otherwise a headless run can
 * block on a permission prompt). Observed JSON: error{sessionID, error{name, data{message,
 * statusCode}}}. `--session <id>` exists but continuing a session was not verified, so resume is not
 * claimed.
 */
export class OpenCodeAdapter extends CliAdapter {
  readonly id: string = 'opencode';
  readonly name: string = 'OpenCode';
  readonly executables: string[] = ['opencode'];
  // No `ollama` or `openai-compatible`: OpenCode has no provider of that name with our endpoint and model
  // ("Model not found" in a real run), so those reach it through the gateway, which configures one.
  protected readonly providers = ['anthropic', 'openai', 'google', 'openrouter', 'azure-openai', 'bedrock'];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), structuredOutput: true };
  }

  protected args(_f: string, pointer: string, req: AgentStartRequest) {
    const a = ['run', '--format', 'json', '--auto'];
    // Through the gateway the model already names its provider (`ao_gateway/<model>`).
    if (req.provider.modelId && req.provider.modelId !== 'default') a.push('--model', req.provider.kind === GATEWAY_KIND ? req.provider.modelId : `${OPENCODE_PROVIDER[req.provider.kind] ?? req.provider.kind}/${req.provider.modelId}`);
    return [...a, pointer];
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    const msg = stream === 'stdout' ? parseJson(line) : null;
    if (!msg) return parsePlainLine(line, stream, ctx);
    const out: AgentEvent[] = [];
    if (typeof msg.sessionID === 'string' && msg.sessionID !== ctx.sessionId) {
      ctx.sessionId = msg.sessionID;
      out.push({ type: 'session', sessionId: msg.sessionID });
    }
    switch (msg.type) {
      case 'error': {
        const data = msg.error?.data ?? {};
        const text = `${msg.error?.name ?? 'Error'}: ${data.message ?? JSON.stringify(msg.error ?? {}).slice(0, 300)}`;
        ctx.resultIsError = true;
        record(ctx, stateForStatus(data.statusCode) ?? classifyText(text), text);
        out.push({ type: 'output', stream, text });
        break;
      }
      case 'text':
        if (msg.part?.text) out.push({ type: 'message', text: String(msg.part.text) });
        break;
      case 'tool_use':
        out.push({ type: 'tool', name: String(msg.part?.tool ?? 'tool'), summary: JSON.stringify(msg.part?.state?.input ?? {}).slice(0, 200) });
        break;
      case 'step_finish': {
        const t = msg.part?.tokens;
        if (t) out.push({ type: 'usage', inputTokens: (t.input ?? 0) + (t.cache?.read ?? 0), outputTokens: t.output, costUsd: typeof msg.part?.cost === 'number' ? msg.part.cost : undefined });
        break;
      }
    }
    return out;
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    return classifyJsonExit(code, signal, ctx);
  }
}

/** Aider's provider errors (printed as `litellm.<Name>Error`) → agent states. */
const LITELLM_ERRORS: Record<string, AgentState> = {
  AuthenticationError: 'AUTH_REQUIRED',
  PermissionDeniedError: 'AUTH_REQUIRED',
  RateLimitError: 'RATE_LIMITED',
  ContextWindowExceededError: 'CONTEXT_EXHAUSTED',
  ServiceUnavailableError: 'CAPACITY_LIMITED',
  InternalServerError: 'CAPACITY_LIMITED',
  APIConnectionError: 'NETWORK_ERROR',
  Timeout: 'NETWORK_ERROR',
  NotFoundError: 'FAILED',
  BadRequestError: 'FAILED',
};

/**
 * Aider, verified with 0.86.2. Findings from real runs:
 *   - it exits 0 even when the provider rejects the request, so its `litellm.<Name>Error` lines decide
 *     the outcome;
 *   - by default it edits the project's .gitignore and writes .aider.chat.history.md /
 *     .aider.input.history into the project: `--no-gitignore` plus history files in the state
 *     directory prevent that; its repo-map cache (.aider.tags.cache.v4/) is excluded from Git locally;
 *   - `--analytics-disable` and `--no-check-update` keep it from phoning home.
 * `--no-auto-commits` is essential: the orchestration platform owns Git operations (spec §42).
 */
export class AiderAdapter extends CliAdapter {
  readonly id = 'aider';
  readonly name = 'Aider';
  readonly executables = ['aider'];
  protected readonly providers = ['openai', 'anthropic', 'google', 'openrouter', 'ollama', 'openai-compatible', 'azure-openai', 'bedrock'];

  override capabilities(): AgentCapabilities {
    return { ...super.capabilities(), gitExcludes: ['.aider*'] };
  }

  protected args(file: string, _p: string, req: AgentStartRequest) {
    const history = (name: string) => {
      const p = path.join(req.stateDir, 'aider', `${req.taskId}.${name}`);
      assertSafePathArg(p);
      return p;
    };
    const a = [
      '--message-file', file,
      '--yes-always', '--no-auto-commits', '--no-gitignore',
      '--no-pretty', '--no-stream', '--no-fancy-input',
      '--analytics-disable', '--no-check-update', '--no-show-release-notes',
      '--chat-history-file', history('chat.md'),
      '--input-history-file', history('input.txt'),
    ];
    if (req.provider.modelId && req.provider.modelId !== 'default') {
      // litellm picks the API from the prefix; without one it does not know an OpenAI-compatible endpoint's model.
      const prefix = req.provider.kind === 'openrouter' ? 'openrouter/' : req.provider.kind === 'ollama' ? 'ollama_chat/' : req.provider.kind === 'openai-compatible' ? 'openai/' : '';
      a.push('--model', prefix + req.provider.modelId);
    }
    return a;
  }

  override async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    await fs.mkdir(path.join(req.stateDir, 'aider'), { recursive: true });
    return super.buildInvocation(req, inst);
  }

  override parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    if (/\blitellm\.\w+/.test(line)) {
      const name = Object.keys(LITELLM_ERRORS).find((k) => line.includes(`litellm.${k}`));
      record(ctx, name ? LITELLM_ERRORS[name]! : 'FAILED', line);
      ctx.resultIsError = true;
      return [{ type: 'output', stream, text: line }];
    }
    return parsePlainLine(line, stream, ctx);
  }

  override classifyExit(code: number | null, signal: string | null, ctx: ParseContext) {
    // Exit 0 does not mean success for Aider (see above).
    if (ctx.resultIsError) {
      if (ctx.lastState && LIMITED.includes(ctx.lastState)) return { state: ctx.lastState, detail: ctx.detail ?? undefined, retryAt: ctx.retryAt };
      return { state: 'FAILED' as AgentState, detail: ctx.detail ?? 'The provider rejected the request' };
    }
    return classifyPlainExit(code, signal, ctx);
  }
}
