/** Task priorities with aging to prevent starvation (spec §22). */
export const PRIORITIES = ['CRITICAL', 'HIGH', 'NORMAL', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

const BASE: Record<Priority, number> = { CRITICAL: 1000, HIGH: 100, NORMAL: 10, LOW: 1 };

/**
 * Effective score = base + age bonus. With the default aging rate a LOW task waiting ~9 minutes
 * overtakes a fresh NORMAL task, and after ~1.5 h overtakes a fresh HIGH one. CRITICAL is never
 * overtaken by aging within a working day.
 */
export function effectivePriority(priority: Priority, queuedAt: number, now = Date.now(), agingPerMinute = 1): number {
  const ageMinutes = Math.max(0, (now - queuedAt) / 60_000);
  return BASE[priority] + ageMinutes * agingPerMinute;
}

export function sortByEffectivePriority<T extends { priority: Priority; queuedAt: number }>(tasks: T[], now = Date.now()): T[] {
  return [...tasks].sort(
    (a, b) => effectivePriority(b.priority, b.queuedAt, now) - effectivePriority(a.priority, a.queuedAt, now) || a.queuedAt - b.queuedAt,
  );
}

/** BullMQ priority: 1 = highest. */
export const bullPriority = (p: Priority) => ({ CRITICAL: 1, HIGH: 2, NORMAL: 3, LOW: 4 })[p];
