import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { connectDatabase } from './index.js';

/**
 * Test helper: in-memory MongoDB. Uses a locally installed mongod when available
 * (MONGOMS_SYSTEM_BINARY or a standard install path) so tests work offline.
 */
function findSystemMongod(): string | undefined {
  if (process.env.MONGOMS_SYSTEM_BINARY) return process.env.MONGOMS_SYSTEM_BINARY;
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const base = 'C:\\Program Files\\MongoDB\\Server';
    if (fs.existsSync(base)) {
      for (const v of fs.readdirSync(base).sort().reverse()) candidates.push(path.join(base, v, 'bin', 'mongod.exe'));
    }
  } else {
    candidates.push('/usr/bin/mongod', '/usr/local/bin/mongod', '/opt/homebrew/bin/mongod');
  }
  return candidates.find((c) => fs.existsSync(c));
}

let server: MongoMemoryServer | null = null;

export async function startTestDatabase(): Promise<string> {
  const systemBinary = findSystemMongod();
  // A small, non-preallocated journal: ~10 MB per test database instead of ~200 MB. Test files run in
  // parallel, each with its own mongod, and mongod refuses writes when its disk has < 500 MB free.
  const instance = { args: ['--wiredTigerEngineConfigString', 'log=(file_max=10MB,prealloc=false)'] };
  // Parallel test files each pick a free port; two can pick the same one, and mongod then exits with
  // code 48 (address in use). Retry with a new port.
  for (let attempt = 1; ; attempt++) {
    try {
      server = await MongoMemoryServer.create(systemBinary ? { binary: { systemBinary }, instance } : { instance });
      break;
    } catch (e) {
      if (attempt >= 3 || !/code "48"/.test(String(e))) throw e;
    }
  }
  const uri = server.getUri();
  await connectDatabase({ uri, dbName: `test_${process.pid}_${Date.now()}` });
  return uri;
}

/**
 * Chaos testing: stops the test mongod (keeping its data and port) to simulate a database outage.
 * The Mongoose connection stays open and reconnects by itself once `resumeTestDatabase` restarts it.
 */
export async function interruptTestDatabase() {
  if (!server?.instanceInfo) throw new Error('No test database running');
  const { port, dbPath } = server.instanceInfo;
  const opts = (server as unknown as { opts: { instance?: Record<string, unknown> } }).opts;
  opts.instance = { ...(opts.instance ?? {}), port, dbPath };
  await server.stop({ doCleanup: false });
}

export async function resumeTestDatabase() {
  if (!server) throw new Error('No test database');
  await server.start(true);
}

export async function stopTestDatabase() {
  await mongoose.disconnect();
  await server?.stop();
  server = null;
}

export async function clearDatabase() {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
