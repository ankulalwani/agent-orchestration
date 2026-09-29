import { randomBytes } from 'node:crypto';
import { createServices, loadServerConfig, type Actor, type Services } from '@ao/server';
import { MemoryQueue } from '@ao/queue';
import { Worker, WorkerPairing, mongoose } from '@ao/database';

export function testConfig(extra: Record<string, string> = {}) {
  return loadServerConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'x'.repeat(40),
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    MONGODB_URI: 'mongodb://unused',
    SWEEP_INTERVAL_MS: '600000',
    ...extra,
  });
}

export async function makeServices(extra: Record<string, string> = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const services = await createServices(testConfig(extra), {
    queue: new MemoryQueue(),
    mailer: { send: async (to, subject, text) => void sent.push({ to, subject, text }) },
    env: extra,
  });
  return { services, sent };
}

let counter = 0;
/** Registers a user (with their own org) and returns an OWNER actor. */
export async function makeOwner(s: Services, name = `u${++counter}`) {
  const r = await s.auth.register({ email: `${name}-${Date.now()}@example.com`, password: 'correct-horse-battery', name });
  const m = r.memberships[0]!;
  const actor: Actor = { userId: r.user.id, organizationId: m.organizationId, role: 'OWNER', correlationId: 'test' };
  return { actor, auth: r };
}

/** Pairs, approves and authenticates a worker with a project mapping and a mock agent inventory. */
export async function makeWorker(s: Services, owner: Actor, projectId: string, opts: { name?: string; agents?: unknown[]; providers?: unknown[]; tools?: string[] } = {}) {
  const start = await s.workers.startPairing({ name: opts.name ?? 'w', hostname: 'host', os: 'linux', arch: 'x64', version: '0.1.0' });
  await s.workers.approvePairing(owner, start.userCode);
  const poll = await s.workers.pollPairing(start.pairingId, start.pollSecret);
  if (poll.status !== 'APPROVED') throw new Error('pairing failed');
  const worker = await s.workers.authenticate(poll.credential);
  await s.workers.heartbeat(worker, {
    metrics: { cpuCount: 4, freeMemoryMb: 4000 },
    activeTasks: [],
    sentAt: new Date().toISOString(),
    inventory: {
      agents: (opts.agents ?? [{ id: 'mock', name: 'Mock', installed: true, authenticated: true, supportedProviders: ['mock'], capabilities: ['resume'] }]) as Record<string, unknown>[],
      providers: (opts.providers ?? [{ id: 'mock', kind: 'mock', name: 'Mock', healthy: true, models: [{ id: 'mock-1' }] }]) as Record<string, unknown>[],
      tools: opts.tools ?? ['node', 'git'],
      projects: [{ projectId, localPath: '/tmp/project' }],
    },
  });
  return { worker, credential: poll.credential };
}

export async function expireLease(taskId: string) {
  await mongoose.connection.db!.collection('tasks').updateOne({ _id: new mongoose.Types.ObjectId(taskId) }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
}

export { Worker, WorkerPairing };
