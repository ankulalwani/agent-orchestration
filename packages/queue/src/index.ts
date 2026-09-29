import { effectivePriority, type Priority } from '@ao/core';

/**
 * Dispatch queue (spec §22, decision D-003). Jobs are *signals* ("try to dispatch task X"); MongoDB
 * holds task state and performs the atomic claim. Losing the queue loses no work: the scheduler's
 * periodic sweep re-enqueues every QUEUED task.
 */
export interface DispatchJob {
  taskId: string;
  organizationId: string;
}

export interface DispatchQueue {
  readonly driver: 'bullmq' | 'memory';
  /**
   * Idempotent per taskId while a job for it is pending. `queuedAt` (epoch ms, default now) drives
   * priority aging, so long-waiting tasks overtake newer higher-priority ones (spec §22).
   */
  enqueue(job: DispatchJob, opts?: EnqueueOptions): Promise<void>;
  process(handler: (job: DispatchJob) => Promise<void>, concurrency?: number): void;
  depth(): Promise<number>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export interface EnqueueOptions {
  priority?: Priority;
  queuedAt?: number;
  delayMs?: number;
}

export class MemoryQueue implements DispatchQueue {
  readonly driver = 'memory' as const;
  private pending = new Map<string, { job: DispatchJob; priority: Priority; queuedAt: number; readyAt: number; seq: number }>();
  private handler: ((job: DispatchJob) => Promise<void>) | null = null;
  private running = 0;
  private concurrency = 4;
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  async enqueue(job: DispatchJob, opts: EnqueueOptions = {}) {
    if (this.closed) return;
    const readyAt = Date.now() + (opts.delayMs ?? 0);
    const existing = this.pending.get(job.taskId);
    if (existing && existing.readyAt <= readyAt) return;
    this.pending.set(job.taskId, { job, priority: opts.priority ?? 'NORMAL', queuedAt: opts.queuedAt ?? Date.now(), readyAt, seq: this.seq++ });
    this.pump();
  }

  process(handler: (job: DispatchJob) => Promise<void>, concurrency = 4) {
    this.handler = handler;
    this.concurrency = concurrency;
    this.pump();
  }

  private pump() {
    if (!this.handler || this.closed) return;
    const now = Date.now();
    while (this.running < this.concurrency) {
      const next = [...this.pending.values()]
        .filter((p) => p.readyAt <= now)
        .sort((a, b) => effectivePriority(b.priority, b.queuedAt, now) - effectivePriority(a.priority, a.queuedAt, now) || a.seq - b.seq)[0];
      if (!next) break;
      this.pending.delete(next.job.taskId);
      this.running++;
      void this.handler(next.job)
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
    const soonest = Math.min(...[...this.pending.values()].map((p) => p.readyAt));
    if (Number.isFinite(soonest) && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.pump();
      }, Math.max(0, soonest - now));
      this.timer.unref?.();
    }
  }

  async depth() {
    return this.pending.size;
  }
  async healthy() {
    return !this.closed;
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
  }
}

/** BullMQ priority (1 = highest, max 2^21) from the effective priority, at 1/100 resolution. */
export function agedBullPriority(priority: Priority, queuedAt: number, now = Date.now()): number {
  const MAX = 2 ** 21;
  return Math.min(MAX, Math.max(1, MAX - Math.round(effectivePriority(priority, queuedAt, now) * 100)));
}

const REDIS_OP_TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms (Redis unavailable?)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function createBullQueue(redisUrl: string, name = 'ao-dispatch'): Promise<DispatchQueue> {
  const { Queue, Worker } = await import('bullmq');
  const { Redis } = await import('ioredis');
  // Producer side fails fast while Redis is down (BullMQ's advice for request paths): API requests
  // must not hang on the queue. MongoDB stays authoritative and the sweeper re-enqueues (D-003).
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, enableReadyCheck: true });
  connection.on('error', () => undefined); // reconnects by itself; health is reported by healthy()
  await withTimeout(new Promise<void>((resolve) => (connection.status === 'ready' ? resolve() : connection.once('ready', () => resolve()))), 10_000, 'Redis connection').catch(() => undefined);
  const queue = new Queue<DispatchJob>(name, {
    connection,
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  });
  queue.on('error', () => undefined);
  let worker: { close(): Promise<void> } | null = null;
  let workerConnection: InstanceType<typeof Redis> | null = null;
  return {
    driver: 'bullmq',
    async enqueue(job, opts = {}) {
      if (connection.status !== 'ready') throw new Error('Redis unavailable: dispatch job not queued');
      // jobId dedupes pending jobs for the same task (spec §105 idempotency).
      await withTimeout(
        queue.add('dispatch', job, {
          jobId: `dispatch-${job.taskId}-${opts.delayMs ? Math.floor((Date.now() + opts.delayMs) / 10_000) : 'now'}`,
          // BullMQ priorities are fixed once added, so aging is applied as of enqueue time. Jobs wait
          // briefly; a task that can't be dispatched is re-enqueued later with a fresh priority.
          priority: agedBullPriority(opts.priority ?? 'NORMAL', opts.queuedAt ?? Date.now()),
          delay: opts.delayMs,
        }),
        REDIS_OP_TIMEOUT_MS,
        'enqueue',
      );
    },
    process(handler, concurrency = 4) {
      // The consumer blocks on Redis and must retry forever (BullMQ requirement for workers).
      workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
      workerConnection.on('error', () => undefined);
      const w = new Worker<DispatchJob>(name, async (j) => handler(j.data), { connection: workerConnection, concurrency });
      w.on('error', () => undefined);
      worker = w;
    },
    async depth() {
      if (connection.status !== 'ready') return 0;
      const c = await withTimeout(queue.getJobCounts('waiting', 'delayed', 'prioritized'), REDIS_OP_TIMEOUT_MS, 'depth');
      return (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0);
    },
    async healthy() {
      if (connection.status !== 'ready') return false;
      try {
        return (await withTimeout(connection.ping(), 1000, 'ping')) === 'PONG';
      } catch {
        return false;
      }
    },
    /**
     * Bounded shutdown: the consumer is closed without waiting for in-flight dispatch jobs (they are
     * only signals; MongoDB holds the state and the sweeper re-dispatches), so a shutdown can't hang.
     */
    async close() {
      if (worker) await withTimeout((worker as { close(force?: boolean): Promise<void> }).close(true), 5000, 'worker close').catch(() => undefined);
      await withTimeout(queue.close(), 5000, 'queue close').catch(() => undefined);
      workerConnection?.disconnect();
      connection.disconnect();
    },
  };
}

export async function createDispatchQueue(redisUrl?: string | null): Promise<DispatchQueue> {
  return redisUrl ? createBullQueue(redisUrl) : new MemoryQueue();
}
