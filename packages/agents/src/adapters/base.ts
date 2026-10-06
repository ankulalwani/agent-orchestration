import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentState } from '@ao/core';
import { assertSafePathArg, classifyText, detectVersion, extractRetryAt, which } from '../detection.js';
import type { AgentEvent, AgentInstallation, AgentStartRequest, ParseContext, ProviderBinding } from '../types.js';
import { parseAwsCredential } from '@ao/providers';

export async function detectExecutable(executables: string[], versionArgs = ['--version']): Promise<AgentInstallation> {
  for (const exe of executables) {
    const p = which(exe);
    if (p) {
      const version = await detectVersion(p, versionArgs);
      return { installed: true, path: p, version, authenticated: null, notes: version ? [] : ['Version could not be determined'] };
    }
  }
  return { installed: false, path: null, version: null, authenticated: null, notes: [`None of ${executables.join(', ')} found on PATH`] };
}

/** Write the prompt to a file inside the task state dir; returns a path safe to pass as an argument. */
export async function writePromptFile(req: AgentStartRequest): Promise<string> {
  const dir = path.join(req.stateDir, 'prompts');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${req.taskId}-${req.sessionId}.md`);
  await fs.writeFile(file, req.prompt, 'utf8');
  assertSafePathArg(file);
  return file;
}

/**
 * Generic line parser for agents without a verified structured format: forward output and classify
 * error-looking lines conservatively.
 */
export function parsePlainLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
  const events: AgentEvent[] = [{ type: 'output', stream, text: line }];
  const errorish = stream === 'stderr' || /\b(error|failed|exception|limit|denied)\b/i.test(line);
  if (errorish) {
    const state = classifyText(line);
    if (state) {
      ctx.lastState = state;
      ctx.detail = line.slice(0, 500);
      const retryAt = extractRetryAt(line);
      if (retryAt) ctx.retryAt = retryAt;
    }
  }
  return events;
}

/** Exit classification shared by plain-output adapters. */
export function classifyPlainExit(code: number | null, signal: string | null, ctx: ParseContext): { state: AgentState; detail?: string; retryAt?: number | null } {
  const tail = ctx.recentText.slice(-20).join('\n');
  const fromTail = classifyText(tail);
  if (code === 0) {
    // Some CLIs exit 0 after reporting a limit; trust the explicit signal.
    if (ctx.lastState && ['RATE_LIMITED', 'CAPACITY_LIMITED', 'CONTEXT_EXHAUSTED', 'AUTH_REQUIRED'].includes(ctx.lastState)) {
      return { state: ctx.lastState, detail: ctx.detail ?? undefined, retryAt: ctx.retryAt };
    }
    return { state: 'COMPLETED' };
  }
  if (signal) return { state: 'CRASHED', detail: `Terminated by ${signal}` };
  const state = ctx.lastState && ctx.lastState !== 'RUNNING' ? ctx.lastState : fromTail;
  if (state) return { state, detail: ctx.detail ?? tail.slice(-500), retryAt: ctx.retryAt ?? extractRetryAt(tail) };
  return { state: 'CRASHED', detail: `Exited with code ${code}: ${tail.slice(-500)}` };
}

/** Provider kind of the worker's model gateway in a ProviderBinding (see types.ts). */
export const GATEWAY_KIND = 'gateway';

/**
 * How each harness is pointed at the model gateway: environment and extra arguments. The gateway serves
 * each harness the API it speaks, so the harness itself is unchanged; only its endpoint and key are.
 */
export function gatewayLaunch(agentId: string, p: ProviderBinding): { env: Record<string, string>; args: string[]; model: string } {
  const root = (p.baseUrl ?? '').replace(/\/+$/, '');
  const token = p.apiKey ?? '';
  const model = p.modelId;
  switch (agentId) {
    case 'claude-code':
      return {
        env: {
          ANTHROPIC_BASE_URL: `${root}/anthropic`,
          ANTHROPIC_AUTH_TOKEN: token,
          ANTHROPIC_API_KEY: '',
          // Every model Claude Code picks by itself (fast model, subagents, …) goes to the add-on models too.
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          ANTHROPIC_SMALL_FAST_MODEL: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        args: [],
        model,
      };
    case 'codex':
      // Codex only speaks the Responses API to custom providers (wire_api "chat" is no longer supported).
      return {
        env: { AO_GATEWAY_KEY: token },
        // Unquoted: a value that isn't valid TOML is taken as a string, and quotes can't pass Windows .cmd shims.
        args: [
          '-c', 'model_provider=ao_gateway',
          '-c', 'model_providers.ao_gateway.name=ao_gateway',
          '-c', `model_providers.ao_gateway.base_url=${root}/openai/v1`,
          '-c', 'model_providers.ao_gateway.env_key=AO_GATEWAY_KEY',
          '-c', 'model_providers.ao_gateway.wire_api=responses',
        ],
        model,
      };
    case 'gemini':
      // API-key authentication with the Gemini API at another address. (Its "gateway" auth type is
      // rejected in headless runs by 0.61, so the adapter also selects the API-key type in a settings file.)
      return { env: { GOOGLE_GEMINI_BASE_URL: `${root}/gemini`, GEMINI_API_KEY: token, GOOGLE_API_KEY: '', GOOGLE_GENAI_USE_VERTEXAI: 'false', GOOGLE_GENAI_USE_GCA: 'false' }, args: [], model };
    case 'opencode':
    case 'kilo':
      return {
        env: {
          // Kilo Code is built on OpenCode and reads the same configuration under its own variable.
          [agentId === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT']: JSON.stringify({
            provider: { ao_gateway: { npm: '@ai-sdk/openai-compatible', name: 'Agent Orchestration add-on models', options: { baseURL: `${root}/openai/v1`, apiKey: token }, models: { [model]: { name: model, tool_call: true } } } },
          }),
        },
        args: [],
        model: `ao_gateway/${model}`,
      };
    case 'copilot':
      // Its custom-provider mode (`copilot help providers`): OpenAI chat completions, no GitHub login needed.
      return { env: { COPILOT_PROVIDER_BASE_URL: `${root}/openai/v1`, COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_API_KEY: token, COPILOT_MODEL: model }, args: [], model };
    case 'qwen':
      return { env: { OPENAI_BASE_URL: `${root}/openai/v1`, OPENAI_API_KEY: token, OPENAI_MODEL: model, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' }, args: ['--auth-type', 'openai'], model };
    case 'aider':
      return { env: { OPENAI_API_BASE: `${root}/openai/v1`, OPENAI_API_KEY: token }, args: [], model: `openai/${model}` };
    default:
      return { env: { AO_GATEWAY_URL: root, AO_GATEWAY_KEY: token }, args: [], model };
  }
}

export function providerEnv(kind: string, apiKey?: string | null, baseUrl?: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const set = (k: string, v?: string | null) => {
    if (v) env[k] = v;
  };
  switch (kind) {
    case 'anthropic':
      set('ANTHROPIC_API_KEY', apiKey);
      set('ANTHROPIC_BASE_URL', baseUrl);
      break;
    case 'openai':
      set('OPENAI_API_KEY', apiKey);
      set('OPENAI_BASE_URL', baseUrl);
      break;
    case 'azure-openai':
      set('AZURE_OPENAI_API_KEY', apiKey);
      set('AZURE_OPENAI_ENDPOINT', baseUrl);
      break;
    case 'google':
      set('GEMINI_API_KEY', apiKey);
      set('GOOGLE_API_KEY', apiKey);
      break;
    case 'openrouter':
      set('OPENROUTER_API_KEY', apiKey);
      break;
    case 'ollama':
      set('OLLAMA_HOST', baseUrl);
      set('OLLAMA_API_BASE', baseUrl);
      break;
    case 'openai-compatible':
      set('OPENAI_API_KEY', apiKey);
      set('OPENAI_BASE_URL', baseUrl);
      set('OPENAI_API_BASE', baseUrl);
      break;
    case 'bedrock': {
      set('AWS_REGION', extra.region);
      set('AWS_PROFILE', extra.profile);
      // A key stored on the worker (`KEY_ID:SECRET[:TOKEN]` or JSON) is handed over as AWS_* variables.
      const aws = parseAwsCredential(apiKey);
      if (aws) {
        set('AWS_ACCESS_KEY_ID', aws.accessKeyId);
        set('AWS_SECRET_ACCESS_KEY', aws.secretAccessKey);
        set('AWS_SESSION_TOKEN', aws.sessionToken);
      }
      break;
    }
    case 'vertex':
      // Names read by Claude Code on Vertex; Google credentials come from the agent's gcloud/ADC setup.
      set('ANTHROPIC_VERTEX_PROJECT_ID', extra.project);
      set('GOOGLE_CLOUD_PROJECT', extra.project);
      set('CLOUD_ML_REGION', extra.region);
      break;
  }
  return { ...env };
}
