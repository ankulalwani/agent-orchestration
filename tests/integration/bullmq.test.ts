/** BullMQ dispatch driver (TASK-003) against a real Redis server. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBullQueue, type DispatchQueue } from '@ao/queue';
import { REDIS_BIN, startRedis, type TestRedis } from '../redis-helper.js';

let redis: TestRedis;
let n = 0;
const queues: DispatchQueue[] = [];
async function queue() {
  const q = await createBullQueue(redis.url, `test-${Date.now()}-${++n}`);
  queues.push(q);
  return q;
}
const job = (taskId: string) => ({ taskId, organizationId: 'o' });

describe.runIf(REDIS_BIN)('BullMQ dispatch queue (real Redis)', () => {
  beforeAll(async () => {
    redis = await startRedis();
  });
  afterAll(async () => {
    for (const q of queues) await q.close().catch(() => undefined);
    await redis.kill();
  });

  it('delivers jobs, reports depth and health', async () => {
    const q = await queue();
    expect(q.driver).toBe('bullmq');
    expect(await q.healthy()).toBe(true);
    await q.enqueue(job('a'));
    expect(await q.depth()).toBe(1);
    const got = await new Promise<string>((resolve) => q.process(async (j) => resolve(j.taskId), 1));
    expect(got).toBe('a');
  });

  it('dedupes a task while its job is pending', async () => {
    const q = await queue();
    await q.enqueue(job('same'));
    await q.enqueue(job('same'));
    expect(await q.depth()).toBe(1);
  });

  it('orders by aged effective priority: a long-waiting LOW task overtakes a fresh NORMAL one', async () => {
    const q = await queue();
    const now = Date.now();
    await q.enqueue(job('fresh-normal'), { priority: 'NORMAL', queuedAt: now });
    await q.enqueue(job('old-low'), { priority: 'LOW', queuedAt: now - 30 * 60_000 });
    await q.enqueue(job('critical'), { priority: 'CRITICAL', queuedAt: now });
    await q.enqueue(job('fresh-low'), { priority: 'LOW', queuedAt: now });
    const seen: string[] = [];
    await new Promise<void>((resolve) =>
      q.process(async (j) => {
        seen.push(j.taskId);
        if (seen.length === 4) resolve();
      }, 1),
    );
    expect(seen).toEqual(['critical', 'old-low', 'fresh-normal', 'fresh-low']);
  });

  it('honours delays', async () => {
    const q = await queue();
    const t0 = Date.now();
    await q.enqueue(job('later'), { delayMs: 700 });
    const at = await new Promise<number>((resolve) => q.process(async () => resolve(Date.now()), 1));
    expect(at - t0).toBeGreaterThanOrEqual(600);
  });

  it('reports unhealthy while Redis is down and recovers when it is back', async () => {
    const q = await queue();
    await redis.kill();
    expect(await q.healthy()).toBe(false);
    await expect(q.enqueue(job('during-outage'))).rejects.toThrow(); // callers log and rely on the sweeper (D-003)
    await redis.restart();
    for (let i = 0; i < 50 && !(await q.healthy()); i++) await new Promise((r) => setTimeout(r, 200));
    expect(await q.healthy()).toBe(true);
    // Right after a reconnect a command can still fail once; callers tolerate that (the sweeper
    // re-enqueues, D-003). What must hold is that enqueueing works again within seconds.
    for (let i = 0; ; i++) {
      try {
        await q.enqueue(job('after'));
        break;
      } catch (e) {
        if (i >= 80) throw e; // up to ~20 s: reconnecting is slower when the whole suite runs in parallel
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    expect(await new Promise<string>((resolve) => q.process(async (j) => resolve(j.taskId), 1))).toBe('after');
  }, 60_000);

  it('recovers when Redis dies while the queue is still starting up (BullMQ keeps that failure otherwise)', async () => {
    // Found as a rare failure of the test above under load: the queue object stayed broken although the
    // connection was ready again. Commands in flight at varying offsets around the crash provoke it.
    for (let round = 0; round < 6; round++) {
      const q = await queue();
      const inflight = [0, 1, 2].map((i) => q.enqueue(job(`in-flight-${i}`)).catch(() => undefined));
      if (round % 3) await new Promise((r) => setTimeout(r, round));
      await redis.kill();
      await Promise.all(inflight);
      await q.enqueue(job('during-outage')).catch(() => undefined);
      await redis.restart();
      for (let i = 0; i < 50 && !(await q.healthy()); i++) await new Promise((r) => setTimeout(r, 200));
      expect(await q.healthy(), `round ${round}`).toBe(true);
      // One call may still fail right after the reconnect; a healthy queue must take the job within seconds.
      let queued = false;
      for (let i = 0; i < 12 && !queued; i++) {
        queued = await q.enqueue(job('after')).then(() => true, () => false);
        if (!queued) await new Promise((r) => setTimeout(r, 250));
      }
      expect(queued, `round ${round}`).toBe(true);
      expect(await q.depth()).toBe(1);
    }
  }, 120_000);
});
