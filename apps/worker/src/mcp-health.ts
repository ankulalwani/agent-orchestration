import { killTree, safeSpawn } from '@ao/core';
import { baseEnv } from '@ao/agents';

/**
 * MCP server health check (spec §117, CAP-011): performs the real protocol handshake — `initialize`,
 * `notifications/initialized`, `tools/list` — over stdio, Streamable HTTP or legacy SSE, then disconnects.
 * A server that starts but can't complete the handshake is unhealthy, so a worker never advertises or
 * hands an agent an MCP server that doesn't work.
 */
export interface McpTarget {
  id: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpHealth {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  serverName?: string;
  serverVersion?: string;
  protocolVersion?: string;
  toolCount?: number;
  error?: string;
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'agent-orchestration-worker', version: process.env.AO_WORKER_VERSION ?? '0.2.0' };

type Rpc = { jsonrpc: '2.0'; id?: number; method?: string; params?: unknown; result?: any; error?: { code: number; message: string } };
const request = (id: number, method: string, params: unknown = {}): Rpc => ({ jsonrpc: '2.0', id, method, params });
const notification = (method: string): Rpc => ({ jsonrpc: '2.0', method });

function rpcError(r: Rpc | undefined, what: string): never {
  throw new Error(r?.error ? `${what}: ${r.error.message} (code ${r.error.code})` : `${what}: no response`);
}

export async function checkMcpServer(t: McpTarget, timeoutMs = 10_000): Promise<McpHealth> {
  const started = Date.now();
  const done = (h: Omit<McpHealth, 'checkedAt' | 'latencyMs'>): McpHealth => ({ ...h, checkedAt: new Date().toISOString(), latencyMs: Date.now() - started });
  let cleanup: () => void = () => undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const session = t.transport === 'stdio' ? stdioSession(t) : t.transport === 'http' ? httpSession(t) : sseSession(t);
    cleanup = session.close;
    const handshake = (async () => {
      const init = await session.call(request(1, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }));
      if (!init?.result) rpcError(init, 'initialize failed');
      await session.notify(notification('notifications/initialized'));
      const tools = await session.call(request(2, 'tools/list'));
      if (!tools?.result) rpcError(tools, 'tools/list failed');
      return done({
        ok: true,
        serverName: init.result.serverInfo?.name,
        serverVersion: init.result.serverInfo?.version,
        protocolVersion: init.result.protocolVersion,
        toolCount: Array.isArray(tools.result.tools) ? tools.result.tools.length : 0,
      });
    })();
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no complete handshake within ${timeoutMs} ms`)), timeoutMs)));
    return await Promise.race([handshake, timeout, session.failed]);
  } catch (e) {
    return done({ ok: false, error: (e as Error).message.slice(0, 500) });
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

interface Session {
  call(msg: Rpc): Promise<Rpc | undefined>;
  notify(msg: Rpc): Promise<void>;
  /** Rejects if the transport dies (process exit, stream error). */
  failed: Promise<never>;
  close(): void;
}

/** stdio: newline-delimited JSON-RPC on the process's stdin/stdout. */
function stdioSession(t: McpTarget): Session {
  if (!t.command?.length) throw new Error('stdio MCP server has no command');
  const [cmd, ...args] = t.command;
  const child = safeSpawn(cmd!, args, { cwd: t.cwd, env: { ...baseEnv(), ...(t.env ?? {}) }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map<number, (r: Rpc) => void>();
  let buf = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue; // servers may log to stdout; ignore non-JSON
      try {
        const msg = JSON.parse(line) as Rpc;
        if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
      } catch {
        /* not JSON-RPC */
      }
    }
  });
  child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  child.stdin!.on('error', () => undefined);
  const failed = new Promise<never>((_, reject) => {
    child.once('error', (e) => reject(new Error(`could not start: ${e.message}`)));
    child.once('exit', (code, signal) => reject(new Error(`exited (${code ?? signal}) before completing the handshake${stderr.trim() ? `: ${stderr.trim().split('\n').pop()}` : ''}`)));
  });
  failed.catch(() => undefined);
  return {
    call: (msg) =>
      new Promise((resolve) => {
        pending.set(msg.id!, resolve);
        child.stdin!.write(JSON.stringify(msg) + '\n');
      }),
    notify: async (msg) => void child.stdin!.write(JSON.stringify(msg) + '\n'),
    failed,
    close: () => {
      child.removeAllListeners('exit');
      killTree(child);
    },
  };
}

/** Streamable HTTP: POST JSON-RPC; the reply is JSON or a text/event-stream carrying it. */
function httpSession(t: McpTarget): Session {
  if (!t.url) throw new Error('http MCP server has no url');
  let sessionId: string | null = null;
  const ctrl = new AbortController();
  const post = async (msg: Rpc) => {
    const res = await fetch(t.url!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(msg),
      signal: ctrl.signal,
    });
    sessionId = res.headers.get('mcp-session-id') ?? sessionId;
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} from ${t.url}`);
    return res;
  };
  return {
    async call(msg) {
      const res = await post(msg);
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        for await (const data of sseData(res.body!)) {
          const m = JSON.parse(data) as Rpc;
          if (m.id === msg.id) return m;
        }
        return undefined;
      }
      return (await res.json()) as Rpc;
    },
    notify: async (msg) => void (await post(msg)).body?.cancel(),
    failed: new Promise<never>(() => undefined),
    close: () => {
      if (sessionId) void fetch(t.url!, { method: 'DELETE', headers: { 'mcp-session-id': sessionId } }).catch(() => undefined);
      ctrl.abort();
    },
  };
}

/** Legacy HTTP+SSE: GET the event stream, learn the POST endpoint, replies arrive on the stream. */
function sseSession(t: McpTarget): Session {
  if (!t.url) throw new Error('sse MCP server has no url');
  const ctrl = new AbortController();
  const pending = new Map<number, (r: Rpc) => void>();
  let endpoint: (url: string) => void;
  const endpointUrl = new Promise<string>((r) => (endpoint = r));
  const stream = (async () => {
    const res = await fetch(t.url!, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${t.url}`);
    for await (const data of sseData(res.body!, (event, d) => event === 'endpoint' && endpoint(new URL(d, t.url).toString()))) {
      try {
        const m = JSON.parse(data) as Rpc;
        if (typeof m.id === 'number') pending.get(m.id)?.(m);
      } catch {
        /* ignore */
      }
    }
    throw new Error('event stream ended before the handshake');
  })();
  const failed = stream.then(() => new Promise<never>(() => undefined));
  failed.catch(() => undefined);
  const post = async (msg: Rpc) => {
    const res = await fetch(await endpointUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg), signal: ctrl.signal });
    if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} posting to the SSE endpoint`);
    await res.body?.cancel();
  };
  return {
    call: (msg) =>
      new Promise((resolve, reject) => {
        pending.set(msg.id!, resolve);
        post(msg).catch(reject);
      }),
    notify: post,
    failed,
    close: () => ctrl.abort(),
  };
}

/** Minimal server-sent-events reader: yields `data` payloads of `message` events. */
async function* sseData(body: ReadableStream<Uint8Array>, onEvent?: (event: string, data: string) => void): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      onEvent?.(event, data.join('\n'));
      if (event === 'message') yield data.join('\n');
    }
  }
}
