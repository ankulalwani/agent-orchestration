import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger, newSecretToken } from '@ao/core';
import { GatewayError, collect, estimateTokens, newCallId, openCompletion, type ChatDelta, type ChatRequest, type GatewayTarget, type UpstreamHooks } from './upstream.js';
import { anthropicError, anthropicMessage, anthropicToChat, streamAnthropic } from './anthropic.js';
import { openaiError, responsesObject, responsesToChat, streamResponses } from './responses.js';
import { geminiError, geminiResponse, geminiToChat, streamGemini } from './gemini.js';
import { SseWriter } from './sse.js';

const log = createLogger('gateway');
const MAX_BODY = 64 * 1024 * 1024;

export interface GatewaySessionOptions {
  /** Add-on models to use, in order: the first that answers serves each request. */
  chain: GatewayTarget[];
  /** Model name the harness is told to use (any name works; the chain decides). */
  alias?: string;
  /** The model that served a request, and the ones skipped before it (limit, outage, refusal). */
  onServed?: (target: GatewayTarget, skipped: Array<{ target: GatewayTarget; reason: string }>) => void;
}

export interface GatewaySession {
  /** http://127.0.0.1:<port>; dialects live under /anthropic, /openai/v1 and /gemini. */
  baseUrl: string;
  token: string;
  alias: string;
  close(): void;
}

type Dialect = 'anthropic' | 'openai' | 'gemini';

/**
 * The worker's model gateway: lets any harness use the add-on models. It serves the API each harness
 * speaks (Anthropic Messages for Claude Code, OpenAI Responses for Codex, Gemini for Gemini CLI, OpenAI
 * chat completions for OpenCode and Aider) on the loopback interface, translates to OpenAI-compatible
 * chat completions, and falls back along the session's chain of add-on models. Each agent session gets
 * its own token; without one, nothing is served.
 */
export class ModelGateway {
  private server: http.Server | null = null;
  private port = 0;
  private sessions = new Map<string, GatewaySessionOptions & { alias: string }>();

  constructor(private hooks: Pick<UpstreamHooks, 'isLimited' | 'onLimit' | 'fetchImpl'> = {}) {}

  async open(opts: GatewaySessionOptions): Promise<GatewaySession> {
    await this.start();
    const token = `aogw_${newSecretToken(24)}`;
    const alias = opts.alias ?? 'ao-addon';
    this.sessions.set(token, { ...opts, alias });
    return { baseUrl: `http://127.0.0.1:${this.port}`, token, alias, close: () => void this.sessions.delete(token) };
  }

  private async start() {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        log.warn({ err: String(e) }, 'gateway request failed');
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Gateway error' } }));
        else res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    server.unref();
  }

  async stop() {
    this.sessions.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '');
    const dialect: Dialect = path.startsWith('/anthropic') ? 'anthropic' : path.startsWith('/gemini') ? 'gemini' : 'openai';
    const fail = (status: number, message: string, retryAfterSec: number | null = null) => {
      const body = dialect === 'anthropic' ? anthropicError(status, message) : dialect === 'gemini' ? geminiError(status, message) : openaiError(status, message);
      res.writeHead(status, { 'content-type': 'application/json', ...(retryAfterSec !== null ? { 'retry-after': String(retryAfterSec) } : {}) }).end(JSON.stringify(body));
    };
    const auth = String(req.headers['x-api-key'] ?? req.headers['x-goog-api-key'] ?? '') || String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || (url.searchParams.get('key') ?? '');
    const session = this.sessions.get(auth);
    if (!session) return fail(401, 'Unknown or expired gateway token');

    // Model lists: the session's alias is the one model.
    if (req.method === 'GET') {
      if (/\/models$/.test(path)) {
        if (dialect === 'anthropic') return json(res, { data: [{ id: session.alias, type: 'model', display_name: 'Add-on models', created_at: new Date().toISOString() }], has_more: false, first_id: session.alias, last_id: session.alias });
        if (dialect === 'gemini') return json(res, { models: [{ name: `models/${session.alias}`, displayName: 'Add-on models', supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'] }] });
        return json(res, { object: 'list', data: [{ id: session.alias, object: 'model', created: 0, owned_by: 'agent-orchestration' }] });
      }
      return fail(404, `Not found: ${path}`);
    }
    if (req.method !== 'POST') return fail(405, 'Method not allowed');
    const body = await readJson(req);
    if (body === undefined) return fail(400, 'Invalid JSON body');

    const hooks: UpstreamHooks = { ...this.hooks, onServed: session.onServed };
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const run = async (chat: ChatRequest, stream: boolean, write: (d: AsyncGenerator<ChatDelta>, out: SseWriter) => Promise<void>, whole: (d: AsyncGenerator<ChatDelta>) => Promise<unknown>) => {
      let deltas: AsyncGenerator<ChatDelta>;
      try {
        ({ deltas } = await openCompletion(session.chain, chat, hooks, controller.signal));
      } catch (e) {
        if (e instanceof GatewayError) return fail(e.status, e.message, e.retryAfterSec);
        throw e;
      }
      if (!stream) return json(res, await whole(deltas));
      const out = new SseWriter(res);
      try {
        await write(deltas, out);
      } catch (e) {
        // Once streaming, the error can only be reported inside the stream.
        const message = (e as Error).message;
        if (dialect === 'anthropic') out.event('error', anthropicError(502, message));
        else out.data(dialect === 'gemini' ? geminiError(502, message) : openaiError(502, message));
      }
      out.end();
    };

    if (dialect === 'anthropic') {
      if (path.endsWith('/messages/count_tokens')) return json(res, { input_tokens: estimateTokens(body) });
      if (!path.endsWith('/messages')) return fail(404, `Not found: ${path}`);
      const model = String(body.model ?? session.alias);
      return run(anthropicToChat(body), Boolean(body.stream), (d, out) => streamAnthropic(d, out, model), (d) => anthropicMessage(d, model));
    }
    if (dialect === 'gemini') {
      const m = /\/models\/([^/:]+):(\w+)$/.exec(path);
      if (!m) return fail(404, `Not found: ${path}`);
      const [, model, action] = m;
      if (action === 'countTokens') return json(res, { totalTokens: estimateTokens(body.contents ?? body) });
      if (action !== 'generateContent' && action !== 'streamGenerateContent') return fail(404, `Unsupported method ${action}`);
      return run(geminiToChat(body), action === 'streamGenerateContent', (d, out) => streamGemini(d, out, model!), (d) => geminiResponse(d, model!));
    }
    if (path.endsWith('/responses')) {
      const { req: chat, ctx } = responsesToChat(body);
      const model = String(body.model ?? session.alias);
      return run(chat, body.stream !== false, (d, out) => streamResponses(d, out, model, ctx), (d) => responsesObject(d, model, ctx));
    }
    if (path.endsWith('/chat/completions')) {
      const { model: _m, stream: _s, stream_options: _o, ...chat } = body;
      const model = String(body.model ?? session.alias);
      return run(chat as ChatRequest, Boolean(body.stream), (d, out) => streamChat(d, out, model), (d) => chatCompletion(d, model));
    }
    return fail(404, `Not found: ${path}`);
  }
}

function json(res: http.ServerResponse, data: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(c as Buffer);
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    return undefined;
  }
}

/** OpenAI chat completions (OpenCode, Aider): the upstream answer re-sent as chunks under the harness's model name. */
async function streamChat(deltas: AsyncGenerator<ChatDelta>, out: SseWriter, model: string) {
  const id = newCallId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: unknown, finish: string | null = null, extra: object = {}) => out.data({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
  chunk({ role: 'assistant', content: '' });
  let finish = 'stop';
  let usage: { input: number; output: number } | null = null;
  const started = new Set<number>();
  for await (const d of deltas) {
    if (d.kind === 'text') chunk({ content: d.text });
    else if (d.kind === 'tool') {
      const first = !started.has(d.index);
      started.add(d.index);
      chunk({ tool_calls: [{ index: d.index, ...(first ? { id: d.id ?? newCallId(), type: 'function' } : {}), function: { ...(first ? { name: d.name ?? 'tool' } : {}), arguments: d.arguments ?? '' } }] });
    } else if (d.kind === 'finish') finish = d.reason;
    else usage = { input: d.input, output: d.output };
  }
  chunk({}, started.size ? 'tool_calls' : finish);
  if (usage) out.data({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: usage.input, completion_tokens: usage.output, total_tokens: usage.input + usage.output } });
  out.data('[DONE]');
}

async function chatCompletion(deltas: AsyncGenerator<ChatDelta>, model: string) {
  const r = await collect(deltas);
  return {
    id: newCallId('chatcmpl'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: r.text || null, ...(r.tools.length ? { tool_calls: r.tools.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}) }, finish_reason: r.tools.length ? 'tool_calls' : r.finish }],
    usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
  };
}
