import type { ServerResponse } from 'node:http';

/** Writes server-sent events to a response (headers are sent with the first event). */
export class SseWriter {
  private started = false;
  constructor(private res: ServerResponse) {}

  private start() {
    if (this.started) return;
    this.started = true;
    this.res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  }

  /** `event: <name>` + data (Anthropic and Responses streams name their events). */
  event(name: string, data: unknown) {
    this.start();
    this.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Data-only event (OpenAI chat and Gemini streams). */
  data(data: unknown) {
    this.start();
    this.res.write(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  }

  get headersSent() {
    return this.started;
  }

  end() {
    this.start();
    this.res.end();
  }
}
