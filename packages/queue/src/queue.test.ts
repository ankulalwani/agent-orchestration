import { describe, expect, it } from 'vitest';
import { MemoryQueue, agedBullPriority } from './index.js';

describe('MemoryQueue', () => {
  it('processes by priority and dedupes per task', async () => {
    const q = new MemoryQueue();
    const seen: string[] = [];
    await q.enqueue({ taskId: 'low', organizationId: 'o' }, { priority: 'LOW' });
    await q.enqueue({ taskId: 'crit', organizationId: 'o' }, { priority: 'CRITICAL' });
    await q.enqueue({ taskId: 'crit', organizationId: 'o' }, { priority: 'CRITICAL' });
    expect(await q.depth()).toBe(2);
    await new Promise<void>((resolve) => {
      q.process(async (j) => {
        seen.push(j.taskId);
        if (seen.length === 2) resolve();
      }, 1);
    });
    expect(seen).toEqual(['crit', 'low']);
  });

  it('ages waiting tasks so a long-waiting LOW task overtakes a fresh NORMAL one (spec §22)', async () => {
    const q = new MemoryQueue();
    const seen: string[] = [];
    await q.enqueue({ taskId: 'fresh-normal', organizationId: 'o' }, { priority: 'NORMAL' });
    await q.enqueue({ taskId: 'old-low', organizationId: 'o' }, { priority: 'LOW', queuedAt: Date.now() - 30 * 60_000 });
    await q.enqueue({ taskId: 'fresh-low', organizationId: 'o' }, { priority: 'LOW' });
    await new Promise<void>((resolve) => {
      q.process(async (j) => {
        seen.push(j.taskId);
        if (seen.length === 3) resolve();
      }, 1);
    });
    expect(seen).toEqual(['old-low', 'fresh-normal', 'fresh-low']);
  });

  it('maps effective priority to a BullMQ priority (lower number runs first)', () => {
    const now = Date.now();
    expect(agedBullPriority('CRITICAL', now, now)).toBeLessThan(agedBullPriority('HIGH', now, now));
    expect(agedBullPriority('LOW', now - 30 * 60_000, now)).toBeLessThan(agedBullPriority('NORMAL', now, now));
    expect(agedBullPriority('LOW', now, now)).toBeGreaterThanOrEqual(1);
  });

  it('honours delays', async () => {
    const q = new MemoryQueue();
    const t0 = Date.now();
    const done = new Promise<number>((r) => q.process(async () => r(Date.now() - t0)));
    await q.enqueue({ taskId: 'd', organizationId: 'o' }, { delayMs: 120 });
    expect(await done).toBeGreaterThanOrEqual(100);
    await q.close();
  });
});
