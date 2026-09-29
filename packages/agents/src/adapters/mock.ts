import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentState } from '@ao/core';
import { baseEnv } from '../detection.js';
import type { AgentAdapter, AgentCapabilities, AgentEvent, AgentInstallation, AgentStartRequest, Invocation, ParseContext } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_AGENT_SCRIPT = path.resolve(here, '../mock/mock-agent.mjs');

/**
 * Deterministic mock agent (decision D-010). Scenario chosen per model id or AO_MOCK_SCENARIO:
 * success, rate_limit, context, crash, hang, input, fail, auth, slow, flaky (crash once then succeed).
 * Speaks a tiny JSON-lines protocol so recovery paths are testable without paid AI usage.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly id = 'mock';
  readonly name = 'Mock Agent (testing)';
  readonly executables = [process.execPath];

  async detect(): Promise<AgentInstallation> {
    return { installed: true, path: process.execPath, version: '1.0.0', authenticated: true, notes: ['Testing agent; disabled unless explicitly enabled'] };
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
      additionalDirectories: true,
      // Tests opt in to the mock's "own login" (provider native:mock); by default it has none.
      nativeLogin: process.env.AO_MOCK_NATIVE_LOGIN === '1',
      gateway: true,
      supportedProviders: ['mock'],
      verification: 'binary',
      gitExcludes: ['.mock-cache/'],
    };
  }

  async buildInvocation(req: AgentStartRequest): Promise<Invocation> {
    // On its own login the scenario comes from AO_MOCK_NATIVE_SCENARIO, so tests can make only that one hit a limit.
    const nativeScenario = req.provider.kind === 'native' ? process.env.AO_MOCK_NATIVE_SCENARIO : undefined;
    const scenario = String(nativeScenario ?? req.settings?.scenario ?? process.env.AO_MOCK_SCENARIO ?? (req.provider.modelId.startsWith('scenario:') ? req.provider.modelId.slice(9) : 'success'));
    // Through the model gateway: the mock asks it one question (OpenAI chat) and records the answer.
    const gateway: Record<string, string> = req.provider.kind === 'gateway' ? { AO_MOCK_GATEWAY_URL: req.provider.baseUrl ?? '', AO_MOCK_GATEWAY_KEY: req.provider.apiKey ?? '', AO_MOCK_GATEWAY_MODEL: req.provider.modelId } : {};
    return {
      command: process.execPath,
      args: [MOCK_AGENT_SCRIPT],
      env: {
        ...baseEnv(),
        AO_MOCK_SCENARIO: scenario,
        ...gateway,
        AO_MOCK_SESSION: req.resumeSessionId ?? req.sessionId,
        AO_MOCK_TASK: req.taskId,
        AO_MOCK_STATE_DIR: req.stateDir,
        // The provider key the worker hands to agents, so scenarios can react to expired credentials.
        ...(req.provider.apiKey ? { AO_MOCK_API_KEY: req.provider.apiKey } : {}),
        // Which MCP servers the agent was given (tests assert unhealthy ones are left out).
        AO_MOCK_MCP_SERVERS: (req.mcpServers ?? []).map((m) => m.name).join(','),
        // The project's other repositories: the mock changes a file in each of them too.
        ...(req.additionalDirs?.length ? { AO_MOCK_EXTRA_DIRS: req.additionalDirs.join(path.delimiter) } : {}),
        ...(typeof req.settings?.delayMs === 'number' ? { AO_MOCK_DELAY_MS: String(req.settings.delayMs) } : {}),
        ...(typeof req.settings?.retryAtOffsetMs === 'number' ? { AO_MOCK_RETRY_AT: String(Date.now() + req.settings.retryAtOffsetMs) } : {}),
        ...(req.env ?? {}),
      },
      stdin: req.prompt,
    };
  }

  parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[] {
    if (stream === 'stderr' || !line.startsWith('{')) return [{ type: 'output', stream, text: line }];
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      return [{ type: 'output', stream, text: line }];
    }
    switch (m.t) {
      case 'session':
        return [{ type: 'session', sessionId: m.id }];
      case 'say':
        return [{ type: 'message', text: m.text }];
      case 'tool':
        return [{ type: 'tool', name: m.name, summary: m.summary ?? '' }];
      case 'limit':
        ctx.lastState = 'RATE_LIMITED';
        ctx.retryAt = m.retryAt ?? null;
        ctx.detail = 'Mock provider limit';
        return [{ type: 'state', state: 'RATE_LIMITED', retryAt: m.retryAt ?? null, detail: 'Mock provider limit' }];
      case 'context':
        ctx.lastState = 'CONTEXT_EXHAUSTED';
        return [{ type: 'state', state: 'CONTEXT_EXHAUSTED', detail: 'Mock context exhausted' }];
      case 'auth':
        ctx.lastState = 'AUTH_REQUIRED';
        return [{ type: 'state', state: 'AUTH_REQUIRED', detail: 'Mock auth required' }];
      case 'ask':
        return [{ type: 'input_request', question: m.question }];
      case 'usage':
        return [{ type: 'usage', inputTokens: m.in, outputTokens: m.out, costUsd: m.cost }];
      case 'result':
        ctx.resultSeen = true;
        ctx.resultIsError = Boolean(m.error);
        return m.text ? [{ type: 'message', text: m.text }] : [];
      default:
        return [{ type: 'output', stream, text: line }];
    }
  }

  classifyExit(code: number | null, signal: string | null, ctx: ParseContext): { state: AgentState; detail?: string; retryAt?: number | null } {
    if (ctx.lastState && ['RATE_LIMITED', 'CONTEXT_EXHAUSTED', 'AUTH_REQUIRED'].includes(ctx.lastState)) return { state: ctx.lastState, detail: ctx.detail ?? undefined, retryAt: ctx.retryAt };
    if (code === 0 && ctx.resultSeen && !ctx.resultIsError) return { state: 'COMPLETED' };
    if (ctx.resultIsError) return { state: 'FAILED', detail: 'Mock agent reported failure' };
    if (signal) return { state: 'CRASHED', detail: `Terminated by ${signal}` };
    return { state: 'CRASHED', detail: `Exited with code ${code}` };
  }
}
