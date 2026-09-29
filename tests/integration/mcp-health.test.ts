/** MCP server health checks (CAP-011) against real MCP servers built with the official SDK. */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { checkMcpServer } from '../../apps/worker/src/mcp-health.js';
import { McpMonitor } from '../../apps/worker/src/mcp-monitor.js';

const SERVER = path.resolve('tests/fixtures/mcp-server.mjs');
const children: ChildProcess[] = [];
afterAll(() => children.forEach((c) => c.kill()));

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function httpServer(mode: 'http' | 'sse') {
  const port = await freePort();
  const c = spawn(process.execPath, [SERVER, mode, String(port)], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(c);
  await new Promise<void>((resolve) => c.stdout!.once('data', () => resolve()));
  return port;
}

const expectHealthy = (h: Awaited<ReturnType<typeof checkMcpServer>>) =>
  expect(h).toMatchObject({ ok: true, serverName: 'test-mcp', serverVersion: '1.2.3', toolCount: 2, protocolVersion: expect.any(String) });

describe('MCP health checks against real servers', () => {
  it('stdio: full handshake and tool listing', async () => {
    expectHealthy(await checkMcpServer({ id: 's', transport: 'stdio', command: [process.execPath, SERVER, 'stdio'], cwd: process.cwd() }));
  });

  it('Streamable HTTP (with a session id)', async () => {
    const port = await httpServer('http');
    expectHealthy(await checkMcpServer({ id: 'h', transport: 'http', url: `http://127.0.0.1:${port}/mcp` }));
  });

  it('legacy HTTP+SSE', async () => {
    const port = await httpServer('sse');
    expectHealthy(await checkMcpServer({ id: 'e', transport: 'sse', url: `http://127.0.0.1:${port}/sse` }));
  });

  it('a server that crashes on start reports its error, quickly', async () => {
    const t0 = Date.now();
    const h = await checkMcpServer({ id: 'c', transport: 'stdio', command: [process.execPath, SERVER, 'crash'], cwd: process.cwd() });
    expect(h.ok).toBe(false);
    expect(h.error).toMatch(/exited \(1\).*missing configuration GITHUB_TOKEN/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('a server that never answers times out', async () => {
    const h = await checkMcpServer({ id: 'x', transport: 'stdio', command: [process.execPath, SERVER, 'silent'], cwd: process.cwd() }, 1500);
    expect(h).toMatchObject({ ok: false, error: expect.stringMatching(/no complete handshake within 1500 ms/) });
  });

  it('the worker advertises only healthy servers and re-announces when health changes', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ao-mcp-mon-')), 'mcp-servers.json');
    let changes = 0;
    const mon = new McpMonitor(file, () => changes++);
    mon.save([
      { id: 'good', name: 'Good', transport: 'stdio', command: [process.execPath, SERVER, 'stdio'] },
      { id: 'broken', name: 'Broken', transport: 'stdio', command: [process.execPath, SERVER, 'crash'] },
    ]);
    await mon.checkAll();
    expect(mon.healthyTags()).toEqual(['mcp:good']);
    expect(mon.healthOf('broken')).toMatchObject({ ok: false, error: expect.stringMatching(/GITHUB_TOKEN/) });
    expect(changes).toBe(2); // unknown → healthy, unknown → unhealthy
    // The broken server gets fixed.
    mon.save([
      { id: 'good', name: 'Good', transport: 'stdio', command: [process.execPath, SERVER, 'stdio'] },
      { id: 'broken', name: 'Broken', transport: 'stdio', command: [process.execPath, SERVER, 'stdio'] },
    ]);
    await mon.checkOne('broken');
    expect(mon.healthyTags().sort()).toEqual(['mcp:broken', 'mcp:good']);
    expect(changes).toBe(3);
    // Removing a server forgets it.
    mon.save([{ id: 'good', name: 'Good', transport: 'stdio', command: [process.execPath, SERVER, 'stdio'] }]);
    expect(mon.healthOf('broken')).toBeNull();
  });

  it('missing command, unreachable URL and non-MCP endpoints are unhealthy, never thrown', async () => {
    expect((await checkMcpServer({ id: 'm', transport: 'stdio', command: ['definitely-not-a-command-ao'] })).ok).toBe(false);
    expect((await checkMcpServer({ id: 'u', transport: 'http', url: `http://127.0.0.1:${await freePort()}/mcp` }, 3000)).ok).toBe(false);
    const port = await httpServer('sse'); // an SSE server spoken to as Streamable HTTP
    expect((await checkMcpServer({ id: 'w', transport: 'http', url: `http://127.0.0.1:${port}/sse` }, 3000)).ok).toBe(false);
  });
});
