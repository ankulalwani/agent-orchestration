/**
 * The model gateway's upstream side: OpenAI-compatible chat completions, the one API every add-on
 * provider offers. A request goes to the first add-on model of the chain that answers; a limit (429),
 * an outage (5xx, timeout, connection error) or a refusal of the request (4xx, e.g. an unknown model or
 * no tool support) moves it to the next one, but only before anything was streamed to the harness.
 */

export interface GatewayTarget {
  providerId: string;
  /** Provider name for messages. */
  name: string;
  /** Chat completions base URL (…/chat/completions is appended). */
  baseUrl: string;
  apiKey: string | null;
  model: string;
  kind: string;
}

/** OpenAI chat completions request (the gateway's common format). */
export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  response_format?: unknown;
  stream?: boolean;
  [k: string]: unknown;
}
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ChatContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One streamed piece of the answer, normalized. */
export type ChatDelta =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; index: number; id?: string; name?: string; arguments?: string }
  | { kind: 'finish'; reason: string }
  | { kind: 'usage'; input: number; output: number };

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
  }
}

export interface UpstreamHooks {
  isLimited?: (providerId: string) => boolean;
  /** A provider reported a limit (retryAt: epoch ms, null when unknown). */
  onLimit?: (target: GatewayTarget, retryAt: number | null, detail: string) => void;
  /** The request is answered by `target`; `skipped` are the targets tried before it. */
  onServed?: (target: GatewayTarget, skipped: Array<{ target: GatewayTarget; reason: string }>) => void;
  fetchImpl?: typeof fetch;
}

/** Providers known to accept `stream_options` (usage in streams); others may reject unknown fields. */
const STREAM_USAGE_KINDS = new Set(['openai', 'openrouter', 'deepseek', 'groq', 'nvidia-nim']);

function retryAfter(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, n);
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, Math.round((d - Date.now()) / 1000)) : null;
}

/** Opens a streamed completion on the first target of the chain that accepts the request. */
export async function openCompletion(chain: GatewayTarget[], req: ChatRequest, hooks: UpstreamHooks = {}, signal?: AbortSignal): Promise<{ target: GatewayTarget; deltas: AsyncGenerator<ChatDelta> }> {
  const f = hooks.fetchImpl ?? fetch;
  const skipped: Array<{ target: GatewayTarget; reason: string }> = [];
  let limitSeen: { retryAfterSec: number | null } | null = null;
  for (const target of chain) {
    if (hooks.isLimited?.(target.providerId)) {
      skipped.push({ target, reason: 'limited' });
      continue;
    }
    const body = { ...req, model: target.model, stream: true, ...(STREAM_USAGE_KINDS.has(target.kind) ? { stream_options: { include_usage: true } } : {}) };
    let res: Response;
    try {
      res = await f(`${target.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
          ...(target.kind === 'openrouter' ? { 'x-title': 'Agent Orchestrator' } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      skipped.push({ target, reason: `unreachable (${(e as Error).message})` });
      continue;
    }
    if (res.ok && res.body) {
      hooks.onServed?.(target, skipped);
      return { target, deltas: parseChatStream(res) };
    }
    const text = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 429) {
      const after = retryAfter(res);
      // Report the soonest known reset: that's when the first add-on model can answer again.
      const known: number[] = [after, limitSeen?.retryAfterSec ?? null].filter((x): x is number => x !== null);
      limitSeen = { retryAfterSec: known.length ? Math.min(...known) : null };
      hooks.onLimit?.(target, after !== null ? Date.now() + after * 1000 : null, text);
      skipped.push({ target, reason: `limit reached (HTTP 429)` });
    } else skipped.push({ target, reason: `HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}` });
  }
  const summary = skipped.map((s) => `${s.target.name}/${s.target.model}: ${s.reason}`).join('; ') || 'no add-on models are configured';
  // All limited: report a limit, so the harness (and the worker) treat it as one and don't just fail.
  if (limitSeen || (skipped.length && skipped.every((s) => s.reason === 'limited' || s.reason.startsWith('limit')))) throw new GatewayError(429, `All add-on models are at their limit: ${summary}`, limitSeen?.retryAfterSec ?? null);
  throw new GatewayError(502, `No add-on model accepted the request: ${summary}`);
}

/** Server-sent events of an OpenAI-compatible chat completion → normalized deltas. */
export async function* parseChatStream(res: Response): AsyncGenerator<ChatDelta> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finished = false;
  const handle = function* (data: string): Generator<ChatDelta> {
    if (data === '[DONE]') return;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new GatewayError(502, `Upstream error: ${chunk.error.message ?? JSON.stringify(chunk.error).slice(0, 300)}`);
    for (const choice of chunk.choices ?? []) {
      const d = choice.delta ?? choice.message ?? {};
      if (typeof d.content === 'string' && d.content) yield { kind: 'text', text: d.content };
      // Streams give an index per call; some providers send each call whole, without one.
      for (const [i, tc] of (d.tool_calls ?? []).entries()) {
        yield { kind: 'tool', index: typeof tc.index === 'number' ? tc.index : i, id: tc.id || undefined, name: tc.function?.name || undefined, arguments: tc.function?.arguments ?? undefined };
      }
      if (choice.finish_reason) {
        finished = true;
        yield { kind: 'finish', reason: choice.finish_reason };
      }
    }
    if (chunk.usage) yield { kind: 'usage', input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
  };
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('event-stream')) {
    // A provider that ignored `stream: true` and answered with one JSON object.
    const text = await new Response(res.body).text();
    yield* handle(text);
    if (!finished) yield { kind: 'finish', reason: 'stop' };
    return;
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line.startsWith('data:')) yield* handle(line.slice(5).trim());
    }
  }
  if (buf.startsWith('data:')) yield* handle(buf.slice(5).trim());
  if (!finished) yield { kind: 'finish', reason: 'stop' };
}

/** The whole answer, for harnesses that asked for a non-streamed response. */
export async function collect(deltas: AsyncGenerator<ChatDelta>) {
  let text = '';
  const tools: Array<{ id: string; name: string; arguments: string }> = [];
  let finish = 'stop';
  const usage = { input: 0, output: 0 };
  for await (const d of deltas) {
    if (d.kind === 'text') text += d.text;
    else if (d.kind === 'tool') {
      const t = (tools[d.index] ??= { id: d.id ?? newCallId(), name: '', arguments: '' });
      if (d.id) t.id = d.id;
      if (d.name && !t.name) t.name = d.name;
      if (d.arguments) t.arguments += d.arguments;
    } else if (d.kind === 'finish') finish = d.reason;
    else {
      usage.input = d.input;
      usage.output = d.output;
    }
  }
  return { text, tools: tools.filter(Boolean), finish, usage };
}

let callCounter = 0;
export function newCallId(prefix = 'call') {
  return `${prefix}_${Date.now().toString(36)}${(++callCounter).toString(36)}`;
}

/** Rough token estimate (≈4 characters per token) for count-tokens endpoints. */
export function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value ?? '').length / 4);
}
