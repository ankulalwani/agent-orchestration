import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentState } from '@ao/core';
import { assertSafePathArg, baseEnv, classifyText, extractRetryAt } from '../detection.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentInstallation, AgentStartRequest, Invocation, ParseContext } from '../types.js';
import { GATEWAY_KIND, detectExecutable, gatewayLaunch, providerEnv } from './base.js';

/**
 * Claude Code adapter. Contract verified against Claude Code 2.1.281 on 2026-09-27:
 *   - `-p/--print` non-interactive mode; prompt read from stdin when no prompt argument is given
 *   - `--output-format stream-json` requires `--verbose` with `--print` (observed error otherwise)
 *   - `--session-id <uuid>`, `--resume <id>`, `--model <m>`, `--permission-mode <mode>`,
 *     `--mcp-config <file>`, `--allowed-tools <tools...>`, `--max-turns` listed in `--help`
 *   - stream-json lines observed: {type:"system",subtype:"init",session_id}, {type:"rate_limit_event",
 *     rate_limit_info:{status,resetsAt(epoch s),rateLimitType,utilization}}, {type:"assistant",message:{content,usage}},
 *     and a final result object with session_id, total_cost_usd, usage.
 * Anything not in that list is treated as optional and parsed defensively.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';
  readonly executables = ['claude'];

  detect(): Promise<AgentInstallation> {
    return detectExecutable(this.executables).then((inst) => {
      if (inst.installed && process.env.ANTHROPIC_API_KEY) inst.authenticated = true;
      if (inst.installed && inst.authenticated === null) inst.notes.push('Authentication is checked on first run (subscription login or API key)');
      return inst;
    });
  }

  capabilities(): AgentCapabilities {
    return {
      resume: true,
      assignSessionId: true,
      structuredOutput: true,
      mcp: true,
      instructions: true,
      modelSelection: true,
      interactiveInput: false,
      structuredLimits: true,
      // `--add-dir <directories...>` is listed in `claude --help` (2.1.281).
      additionalDirectories: true,
      // Its own login (subscription or configuration) by default (AO_HARNESS_OWN_LOGIN=0 turns that off);
      // add-on models through the gateway.
      nativeLogin: process.env.AO_HARNESS_OWN_LOGIN !== '0',
      gateway: true,
      supportedProviders: ['anthropic', 'bedrock', 'vertex'],
      verification: 'binary',
    };
  }

  async buildInvocation(req: AgentStartRequest, inst: AgentInstallation): Promise<Invocation> {
    const settings = req.settings ?? {};
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const permissionMode = typeof settings.permissionMode === 'string' ? settings.permissionMode : 'acceptEdits';
    if (!/^(acceptEdits|auto|bypassPermissions|manual|dontAsk|plan)$/.test(permissionMode)) throw new Error(`Invalid permission mode ${permissionMode}`);
    args.push('--permission-mode', permissionMode);
    const allowed = Array.isArray(settings.allowedTools) ? (settings.allowedTools as string[]) : [];
    if (allowed.length) args.push('--allowed-tools', ...allowed);
    if (req.provider.modelId && req.provider.modelId !== 'default') args.push('--model', req.provider.modelId);
    for (const dir of req.additionalDirs ?? []) {
      assertSafePathArg(dir);
      args.push('--add-dir', dir);
    }
    if (req.resumeSessionId) args.push('--resume', req.resumeSessionId);
    else args.push('--session-id', req.sessionId);
    if (req.mcpServers?.length) {
      const file = path.join(req.stateDir, 'mcp', `${req.taskId}.json`);
      await fs.mkdir(path.dirname(file), { recursive: true });
      const mcpServers = Object.fromEntries(
        req.mcpServers.map((m) => [
          m.name,
          m.transport === 'stdio' ? { command: m.command![0], args: m.command!.slice(1), env: m.env ?? {} } : { type: m.transport, url: m.url },
        ]),
      );
      await fs.writeFile(file, JSON.stringify({ mcpServers }, null, 2), 'utf8');
      assertSafePathArg(file);
      args.push('--mcp-config', file);
    }
    const gw = req.provider.kind === GATEWAY_KIND ? gatewayLaunch(this.id, req.provider) : null;
    const env = { ...baseEnv(), ...(gw ? gw.env : providerEnv(req.provider.kind, req.provider.apiKey, req.provider.baseUrl, req.provider.extra)), ...(req.env ?? {}) };
    if (req.provider.kind === 'bedrock') env.CLAUDE_CODE_USE_BEDROCK = '1';
    if (req.provider.kind === 'vertex') env.CLAUDE_CODE_USE_VERTEX = '1';
    return { command: inst.path ?? 'claude', args, env, stdin: req.prompt };
  }

  parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    if (stream === 'stderr' || !line.startsWith('{')) {
      const st = classifyText(line);
      if (st) {
        ctx.lastState = st;
        ctx.detail = line.slice(0, 500);
        ctx.retryAt = extractRetryAt(line) ?? ctx.retryAt;
      }
      return [{ type: 'output', stream, text: line }];
    }
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      return [{ type: 'output', stream, text: line }];
    }
    const out: AgentEvent[] = [];
    if (typeof msg.session_id === 'string' && msg.session_id !== ctx.sessionId) out.push({ type: 'session', sessionId: msg.session_id });

    switch (msg.type) {
      case 'system':
        break;
      case 'rate_limit_event': {
        const info = msg.rate_limit_info ?? {};
        const retryAt = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null;
        const status = String(info.status ?? '');
        if (status && !status.startsWith('allowed')) {
          out.push({ type: 'state', state: 'RATE_LIMITED', detail: `Claude ${info.rateLimitType ?? ''} limit reached`.trim(), retryAt });
        } else if (status === 'allowed_warning') {
          // Reported as-is and attributed to Claude Code; the exact meaning of `utilization` is not
          // documented, so it is informational only and never drives recovery decisions.
          const pct = typeof info.utilization === 'number' ? `, reported utilization ${Math.round(info.utilization * 100)}%` : '';
          const resets = retryAt ? `, window resets ${new Date(retryAt).toISOString()}` : '';
          out.push({ type: 'limit_warning', detail: `Claude Code rate-limit warning (${info.rateLimitType ?? 'unknown window'}${pct}${resets})`, retryAt, utilization: info.utilization });
        }
        break;
      }
      case 'assistant': {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text) out.push({ type: 'message', text: String(block.text) });
          if (block.type === 'tool_use') out.push({ type: 'tool', name: String(block.name), summary: summarizeToolInput(block.input) });
        }
        break;
      }
      case 'result':
      default: {
        const isResult = msg.type === 'result' || ('total_cost_usd' in msg && 'session_id' in msg);
        if (!isResult) break;
        ctx.resultSeen = true;
        ctx.resultIsError = Boolean(msg.is_error) || (typeof msg.subtype === 'string' && msg.subtype !== 'success');
        const u = msg.usage ?? {};
        out.push({
          type: 'usage',
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          outputTokens: u.output_tokens,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        });
        if (ctx.resultIsError) {
          const text = [msg.subtype, msg.result, msg.error].filter(Boolean).join(': ');
          const st = classifyText(String(text)) ?? (msg.subtype === 'error_max_turns' ? 'FAILED' : null);
          if (st) {
            ctx.lastState = st;
            ctx.detail = String(text).slice(0, 500);
            ctx.retryAt = extractRetryAt(String(text)) ?? ctx.retryAt;
          } else {
            ctx.detail = String(text).slice(0, 500);
          }
        }
        if (typeof msg.result === 'string' && msg.result) out.push({ type: 'message', text: msg.result });
      }
    }
    return out;
  }

  classifyExit(code: number | null, signal: string | null, ctx: ParseContext): { state: AgentState; detail?: string; retryAt?: number | null } {
    const limited = ['RATE_LIMITED', 'CAPACITY_LIMITED', 'CONTEXT_EXHAUSTED', 'AUTH_REQUIRED', 'NETWORK_ERROR'] as AgentState[];
    if (ctx.lastState && limited.includes(ctx.lastState)) return { state: ctx.lastState, detail: ctx.detail ?? undefined, retryAt: ctx.retryAt };
    if (code === 0 && ctx.resultSeen && !ctx.resultIsError) return { state: 'COMPLETED' };
    if (signal) return { state: 'CRASHED', detail: `Terminated by ${signal}` };
    if (ctx.resultSeen && ctx.resultIsError) return { state: 'FAILED', detail: ctx.detail ?? 'Agent reported an error' };
    const tail = ctx.recentText.slice(-10).join('\n');
    const st = classifyText(tail);
    if (st) return { state: st, detail: tail.slice(-500), retryAt: extractRetryAt(tail) };
    if (code === 0) return { state: 'FAILED', detail: 'Agent exited without a result message' };
    return { state: 'CRASHED', detail: `Exited with code ${code}` };
  }
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const s = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description;
  return typeof s === 'string' ? s.slice(0, 200) : '';
}
