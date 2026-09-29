import { AppError } from './errors.js';
import type { TaskStatus } from './task-state.js';

/** Spec §24: dependency graph validation and readiness. */

export interface DepNode {
  id: string;
  dependencies: string[];
}

/** Returns one cycle (as a list of ids, first === last) or null. Iterative DFS, safe for large graphs. */
export function findCycle(nodes: DepNode[]): string[] | null {
  const deps = new Map(nodes.map((n) => [n.id, n.dependencies]));
  const color = new Map<string, 0 | 1 | 2>(); // 0 white, 1 grey, 2 black
  const parent = new Map<string, string>();

  for (const start of deps.keys()) {
    if (color.get(start)) continue;
    const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
    color.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const children = deps.get(frame.id) ?? [];
      if (frame.i < children.length) {
        const child = children[frame.i++]!;
        if (!deps.has(child)) continue; // external/missing handled elsewhere
        const c = color.get(child) ?? 0;
        if (c === 0) {
          color.set(child, 1);
          parent.set(child, frame.id);
          stack.push({ id: child, i: 0 });
        } else if (c === 1) {
          const cycle = [child];
          let cur = frame.id;
          while (cur !== child) {
            cycle.push(cur);
            cur = parent.get(cur)!;
          }
          cycle.push(child);
          return cycle.reverse();
        }
      } else {
        color.set(frame.id, 2);
        stack.pop();
      }
    }
  }
  return null;
}

/**
 * Validate adding `newNode` to an existing graph. `existing` must contain every node reachable
 * from newNode's dependencies (callers load the transitive closure).
 */
export function validateNewDependencies(newNode: DepNode, existing: DepNode[]): void {
  const ids = new Set(existing.map((n) => n.id));
  const missing = newNode.dependencies.filter((d) => !ids.has(d));
  if (missing.length) {
    throw new AppError('DEPENDENCY_MISSING', 'Task depends on tasks that do not exist', { context: { missing } });
  }
  if (newNode.dependencies.includes(newNode.id)) {
    throw new AppError('DEPENDENCY_CYCLE', 'Task cannot depend on itself', { context: { cycle: [newNode.id] } });
  }
  const cycle = findCycle([...existing.filter((n) => n.id !== newNode.id), newNode]);
  if (cycle) throw new AppError('DEPENDENCY_CYCLE', 'Dependency cycle detected', { context: { cycle } });
}

export type DependencyReadiness =
  | { state: 'ready' }
  | { state: 'waiting'; pending: string[] }
  | { state: 'blocked'; reason: 'failed' | 'cancelled' | 'missing'; offending: string[] };

/** Given the statuses of a task's direct dependencies, decide whether it can start. */
export function dependencyReadiness(
  dependencies: string[],
  statusById: ReadonlyMap<string, TaskStatus>,
): DependencyReadiness {
  const missing = dependencies.filter((d) => !statusById.has(d));
  if (missing.length) return { state: 'blocked', reason: 'missing', offending: missing };
  const failed = dependencies.filter((d) => statusById.get(d) === 'FAILED');
  if (failed.length) return { state: 'blocked', reason: 'failed', offending: failed };
  const cancelled = dependencies.filter((d) => statusById.get(d) === 'CANCELLED');
  if (cancelled.length) return { state: 'blocked', reason: 'cancelled', offending: cancelled };
  const pending = dependencies.filter((d) => statusById.get(d) !== 'COMPLETED');
  return pending.length ? { state: 'waiting', pending } : { state: 'ready' };
}

/** Topological order (Kahn). Throws on cycle. */
export function topoSort(nodes: DepNode[]): string[] {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, indeg.get(n.id) ?? 0);
    for (const d of n.dependencies) {
      out.set(d, [...(out.get(d) ?? []), n.id]);
      indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
      if (!indeg.has(d)) indeg.set(d, 0);
    }
  }
  const queue = [...indeg].filter(([, v]) => v === 0).map(([k]) => k);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const v = indeg.get(next)! - 1;
      indeg.set(next, v);
      if (v === 0) queue.push(next);
    }
  }
  if (order.length !== indeg.size) throw new AppError('DEPENDENCY_CYCLE', 'Dependency cycle detected');
  return order;
}
