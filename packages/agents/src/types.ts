import type { AgentState } from '@ao/core';

/**
 * Agent adapter contract (spec §7). Adapters are *declarative*: they describe how to invoke an agent
 * and how to interpret its output. The shared AgentRuntime owns process lifecycle, streaming,
 * hang detection and termination, so no adapter re-implements those.
 */

export interface AgentInstallation {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** true/false when determinable without a paid call; null = unknown. */
  authenticated: boolean | null;
  notes: string[];
}

export interface AgentCapabilities {
  /** Can continue a previous session by id. */
  resume: boolean;
  /** Can be told the session id up front. */
  assignSessionId: boolean;
  /** Emits machine-readable streaming events. */
  structuredOutput: boolean;
  /** Supports MCP server configuration. */
  mcp: boolean;
  /** Accepts extra instructions (used for skills). */
  instructions: boolean;
  modelSelection: boolean;
  /** Can receive more input on stdin while running. */
  interactiveInput: boolean;
  /** Reports structured rate-limit information. */
  structuredLimits: boolean;
  /**
   * Can work in directories besides its working directory (AgentStartRequest.additionalDirs). Required
   * for projects with several repositories, which the agent sees side by side.
   */
  additionalDirectories?: boolean;
  /**
   * Can run on its own login and model choice (provider `native:<id>`, model `default`): the default
   * target, which needs no provider configuration.
   */
  nativeLogin?: boolean;
  /** Can use add-on models through the worker's model gateway (provider kind `gateway` in the binding). */
  gateway?: boolean;
  /**
   * Paths the CLI creates inside the project that are not part of the work (caches, histories). The
   * worker hides them from Git locally (.git/info/exclude) so they are never committed.
   */
  gitExcludes?: string[];
  /** Provider kinds this agent can drive. */
  supportedProviders: string[];
  /** Whether the adapter's CLI contract was verified against an installed binary (vs documentation only). */
  verification: 'binary' | 'documentation';
}

/**
 * Credentials/endpoint for the provider chosen for this session. Never logged.
 * - kind `native`: the harness runs on its own login; nothing is injected.
 * - kind `gateway`: the worker's model gateway; `baseUrl` is its root (dialects under /anthropic,
 *   /openai/v1, /gemini), `apiKey` the session token, `modelId` the name to ask for.
 */
export interface ProviderBinding {
  providerId: string;
  kind: string;
  modelId: string;
  apiKey?: string | null;
  baseUrl?: string | null;
  /** Additional provider-specific settings, e.g. Azure deployment or AWS region. */
  extra?: Record<string, string>;
}

export interface McpServerSpec {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string[];
  url?: string;
  env?: Record<string, string>;
}

export interface AgentStartRequest {
  taskId: string;
  cwd: string;
  /** Full prompt (execution wrapper output). Delivered via stdin or file — never via a shell string. */
  prompt: string;
  provider: ProviderBinding;
  /** Our session id (UUID). Passed to agents that support assigning it. */
  sessionId: string;
  /** Resume a prior agent session (only if capabilities().resume). */
  resumeSessionId?: string | null;
  mcpServers?: McpServerSpec[];
  /** Directory for per-task scratch files (prompt file, MCP config). Inside the project state dir. */
  stateDir: string;
  /** Adapter-specific settings from worker config (e.g. permission mode). */
  settings?: Record<string, unknown>;
  /** Extra environment (project env profile, resolved secrets). */
  env?: Record<string, string>;
  /** The project's other repositories, which the agent may read and change (only if capabilities().additionalDirectories). */
  additionalDirs?: string[];
}

export interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Written to stdin then stdin is closed (unless interactiveInput). */
  stdin?: string;
  keepStdinOpen?: boolean;
}

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; name: string; summary: string }
  | { type: 'state'; state: AgentState; detail?: string; retryAt?: number | null }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number; model?: string }
  | { type: 'input_request'; question: string }
  | { type: 'limit_warning'; detail: string; retryAt?: number | null; utilization?: number }
  | { type: 'exit'; code: number | null; signal: string | null; state: AgentState; detail?: string; retryAt?: number | null; durationMs: number };

/** Per-session scratch state an adapter can use while parsing. */
export interface ParseContext {
  sessionId: string | null;
  lastState: AgentState | null;
  retryAt: number | null;
  detail: string | null;
  resultSeen: boolean;
  resultIsError: boolean;
  recentText: string[];
}

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  /** Executable names searched on PATH. */
  readonly executables: string[];
  detect(): Promise<AgentInstallation>;
  capabilities(installation?: AgentInstallation): AgentCapabilities;
  buildInvocation(req: AgentStartRequest, installation: AgentInstallation): Promise<Invocation>;
  /** Interpret one line of stdout/stderr. Return normalized events (possibly none). */
  parseLine(line: string, stream: 'stdout' | 'stderr', ctx: ParseContext): AgentEvent[];
  /** Map process exit to a normalized terminal state. */
  classifyExit(code: number | null, signal: string | null, ctx: ParseContext): { state: AgentState; detail?: string; retryAt?: number | null };
  /** Format user input for agents with interactiveInput. */
  formatInput?(input: string): string;
}
