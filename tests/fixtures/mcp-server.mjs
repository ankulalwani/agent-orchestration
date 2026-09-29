// A real MCP server (official SDK) for health-check tests.
//   node mcp-server.mjs stdio | http <port> | sse <port> | crash | silent
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const [mode, portArg] = process.argv.slice(2);

function makeServer() {
  const server = new McpServer({ name: 'test-mcp', version: '1.2.3' });
  server.registerTool('ping', { description: 'Replies pong' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  server.registerTool('time', { description: 'Current time' }, async () => ({ content: [{ type: 'text', text: new Date().toISOString() }] }));
  return server;
}

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b ? JSON.parse(b) : undefined));
  });

if (mode === 'stdio') {
  await makeServer().connect(new StdioServerTransport());
} else if (mode === 'crash') {
  process.stderr.write('fatal: missing configuration GITHUB_TOKEN\n');
  process.exit(1);
} else if (mode === 'silent') {
  // Starts, reads stdin, never answers (a hung server).
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
} else if (mode === 'http') {
  const sessions = new Map();
  http
    .createServer(async (req, res) => {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      const sid = req.headers['mcp-session-id'];
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, transport) });
        await makeServer().connect(transport);
      }
      await transport.handleRequest(req, res, body);
    })
    .listen(Number(portArg), '127.0.0.1', () => process.stdout.write('ready\n'));
} else if (mode === 'sse') {
  const transports = new Map();
  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/sse') {
        const t = new SSEServerTransport('/messages', res);
        transports.set(t.sessionId, t);
        await makeServer().connect(t);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const t = transports.get(url.searchParams.get('sessionId'));
        if (!t) return res.writeHead(404).end();
        return t.handlePostMessage(req, res, await readBody(req));
      }
      res.writeHead(404).end();
    })
    .listen(Number(portArg), '127.0.0.1', () => process.stdout.write('ready\n'));
}
