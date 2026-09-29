/**
 * A fake OpenAI-compatible chat completions server for tests: each test scripts the answers (text,
 * tool calls, or an HTTP error) and can inspect every request. Answers stream like real providers do:
 * text in pieces, tool call arguments in pieces, a finish chunk, a usage chunk and [DONE].
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeAnswer {
  status?: number;
  retryAfter?: number;
  text?: string;
  toolCalls?: Array<{ name: string; arguments: unknown }>;
}
export interface FakeRequest {
  model: string;
  messages: any[];
  tools?: any[];
  stream?: boolean;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export class FakeLlm {
  readonly requests: FakeRequest[] = [];
  private server!: http.Server;
  url = '';
  /** Decides each answer; the default says "ok". */
  handler: (req: FakeRequest) => FakeAnswer = () => ({ text: 'ok' });

  async start() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.method === 'GET' && req.url?.endsWith('/models')) return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
        const body = raw ? JSON.parse(raw) : {};
        const r: FakeRequest = { model: body.model, messages: body.messages ?? [], tools: body.tools, stream: body.stream, headers: req.headers, body };
        this.requests.push(r);
        const a = this.handler(r);
        if (a.status && a.status >= 400) {
          return void res.writeHead(a.status, { 'content-type': 'application/json', ...(a.retryAfter !== undefined ? { 'retry-after': String(a.retryAfter) } : {}) }).end(JSON.stringify({ error: { message: `fake error ${a.status}` } }));
        }
        const id = 'chatcmpl-fake';
        const calls = (a.toolCalls ?? []).map((c, i) => ({ id: `call_fake_${this.requests.length}_${i}`, name: c.name, args: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) }));
        if (!body.stream) {
          return void res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: a.text ?? null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }],
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
            }),
          );
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const chunk = (delta: unknown, finish: string | null = null) => send({ id, object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
        chunk({ role: 'assistant' });
        const text = a.text ?? '';
        for (let i = 0; i < text.length; i += 7) chunk({ content: text.slice(i, i + 7) });
        calls.forEach((c, index) => {
          chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: '' } }] });
          for (let i = 0; i < c.args.length; i += 9) chunk({ tool_calls: [{ index, function: { arguments: c.args.slice(i, i + 9) } }] });
        });
        chunk({}, calls.length ? 'tool_calls' : 'stop');
        if (body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
    return this;
  }

  /** The last message of the request, as text. */
  static lastText(r: FakeRequest) {
    const m = r.messages[r.messages.length - 1];
    return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '');
  }

  close() {
    this.server?.close();
  }
}
