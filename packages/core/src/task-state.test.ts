import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition, isTerminal, sourcesFor, TASK_STATUSES, TASK_TRANSITIONS } from './task-state.js';
import { AppError } from './errors.js';

describe('task state machine', () => {
  it('allows the happy path', () => {
    const path = ['QUEUED', 'CLAIMING', 'PREPARING', 'RUNNING', 'VERIFYING', 'COMPLETED'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('allows the recovery paths from the spec', () => {
    expect(canTransition('RUNNING', 'WAITING_FOR_LIMIT')).toBe(true);
    expect(canTransition('WAITING_FOR_LIMIT', 'RUNNING')).toBe(true);
    expect(canTransition('RUNNING', 'CRASHED')).toBe(true);
    expect(canTransition('CRASHED', 'RUNNING')).toBe(true);
    expect(canTransition('VERIFYING', 'RUNNING')).toBe(true); // remediation
  });

  it('rejects arbitrary transitions', () => {
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTransition('RUNNING', 'COMPLETED')).toBe(false); // must verify first
    expect(() => assertTransition('QUEUED', 'RUNNING', 't1')).toThrow(AppError);
    try {
      assertTransition('QUEUED', 'RUNNING');
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_TRANSITION');
    }
  });

  it('COMPLETED is final; FAILED/CANCELLED may only be retried', () => {
    expect(TASK_TRANSITIONS.COMPLETED).toEqual([]);
    expect(TASK_TRANSITIONS.FAILED).toEqual(['QUEUED']);
    expect(TASK_TRANSITIONS.CANCELLED).toEqual(['QUEUED']);
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('RUNNING')).toBe(false);
  });

  it('every transition target is a known status', () => {
    for (const s of TASK_STATUSES) for (const t of TASK_TRANSITIONS[s]) expect(TASK_STATUSES).toContain(t);
  });

  it('sourcesFor computes inverse edges', () => {
    expect(sourcesFor('CLAIMING')).toEqual(['QUEUED']);
    expect(sourcesFor('COMPLETED')).toEqual(['VERIFYING']);
  });
});
