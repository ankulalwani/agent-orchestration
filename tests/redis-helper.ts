/**
 * Real Redis for tests: `AO_TEST_REDIS` or the portable build in `.tools/redis/`. Tests using it are
 * skipped when neither exists. No persistence; each server is private to the test file.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

function findRedis(): string | null {
  if (process.env.AO_TEST_REDIS) return process.env.AO_TEST_REDIS;
  const root = path.resolve('.tools/redis');
  if (!fs.existsSync(root)) return null;
  for (const d of fs.readdirSync(root)) {
    const exe = path.join(root, d, 'redis-server.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}
export const REDIS_BIN = findRedis();

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });

const reachable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

export interface TestRedis {
  url: string;
  port: number;
  /** Hard stop (simulates a crash). */
  kill(): Promise<void>;
  /** Start again on the same port (empty: no persistence). */
  restart(): Promise<void>;
}

export async function startRedis(): Promise<TestRedis> {
  if (!REDIS_BIN) throw new Error('No redis-server available');
  let port = await freePort();
  let proc: ChildProcess | null = null;
  /**
   * Start redis-server and make sure *this* process owns the port. Test files run in parallel and a
   * "free" port can be taken by another file's server in between; then this server exits (address in
   * use) while the port still answers — and the two files would silently share one Redis.
   */
  const up = async () => {
    const p = spawn(REDIS_BIN!, ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    proc = p;
    let exited = false;
    p.once('exit', () => (exited = true));
    for (let i = 0; i < 100 && !exited && !(await reachable(port)); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 200)); // a server that lost the bind race exits right away
    return !exited;
  };
  for (let attempt = 0; !(await up()); attempt++) {
    if (attempt >= 10) throw new Error('Could not start redis-server on a free port');
    port = await freePort();
  }
  const down = async () => {
    const p = proc;
    proc = null;
    if (!p) return;
    const exited = new Promise((r) => p.once('exit', r));
    p.kill('SIGKILL');
    await exited;
    for (let i = 0; i < 50 && (await reachable(port)); i++) await new Promise((r) => setTimeout(r, 100));
  };
  const restart = async () => {
    if (!(await up())) throw new Error(`Could not restart redis-server on port ${port} (taken by another process)`);
  };
  return { url: `redis://127.0.0.1:${port}`, port, kill: down, restart };
}
