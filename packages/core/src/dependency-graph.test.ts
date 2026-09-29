import { describe, expect, it } from 'vitest';
import { dependencyReadiness, findCycle, topoSort, validateNewDependencies } from './dependency-graph.js';

describe('dependency graph', () => {
  const chain = [
    { id: 'A', dependencies: [] },
    { id: 'B', dependencies: ['A'] },
    { id: 'C', dependencies: ['B'] },
    { id: 'D', dependencies: [] },
    { id: 'E', dependencies: ['C', 'D'] },
  ];

  it('has no cycle in the spec example', () => {
    expect(findCycle(chain)).toBeNull();
    const order = topoSort(chain);
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B'));
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('E'));
    expect(order.indexOf('D')).toBeLessThan(order.indexOf('E'));
  });

  it('detects cycles', () => {
    const cyc = findCycle([
      { id: 'A', dependencies: ['C'] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['B'] },
    ]);
    expect(cyc).not.toBeNull();
    expect(cyc![0]).toBe(cyc![cyc!.length - 1]);
    expect(() => topoSort([{ id: 'A', dependencies: ['A'] }])).toThrow();
  });

  it('validates new tasks: missing, self and cyclic deps', () => {
    expect(() => validateNewDependencies({ id: 'X', dependencies: ['nope'] }, chain)).toThrow(/do not exist/);
    expect(() => validateNewDependencies({ id: 'X', dependencies: ['X'] }, [...chain, { id: 'X', dependencies: [] }])).toThrow(/itself/);
    // Re-pointing A to depend on E creates A→E→C→B→A
    expect(() => validateNewDependencies({ id: 'A', dependencies: ['E'] }, chain)).toThrow(/cycle/i);
    expect(() => validateNewDependencies({ id: 'F', dependencies: ['E'] }, chain)).not.toThrow();
  });

  it('computes readiness', () => {
    const m = new Map([
      ['A', 'COMPLETED' as const],
      ['B', 'RUNNING' as const],
      ['C', 'FAILED' as const],
      ['D', 'CANCELLED' as const],
    ]);
    expect(dependencyReadiness(['A'], m)).toEqual({ state: 'ready' });
    expect(dependencyReadiness([], m)).toEqual({ state: 'ready' });
    expect(dependencyReadiness(['A', 'B'], m)).toEqual({ state: 'waiting', pending: ['B'] });
    expect(dependencyReadiness(['A', 'C'], m)).toMatchObject({ state: 'blocked', reason: 'failed' });
    expect(dependencyReadiness(['D'], m)).toMatchObject({ state: 'blocked', reason: 'cancelled' });
    expect(dependencyReadiness(['Z'], m)).toMatchObject({ state: 'blocked', reason: 'missing' });
  });

  it('handles large graphs without recursion limits', () => {
    const nodes = Array.from({ length: 20_000 }, (_, i) => ({ id: `n${i}`, dependencies: i ? [`n${i - 1}`] : [] }));
    expect(findCycle(nodes)).toBeNull();
  });
});
