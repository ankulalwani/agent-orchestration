import { AppError } from './errors.js';

export const TASK_STATUSES = [
  'QUEUED',
  'CLAIMING',
  'PREPARING',
  'RUNNING',
  'PAUSED',
  'WAITING_FOR_LIMIT',
  'WAITING_FOR_INPUT',
  'WAITING_FOR_APPROVAL',
  'RECOVERY_REQUIRED',
  'CRASHED',
  'VERIFYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Statuses in which a worker holds (or is acquiring) a lease on the task. */
export const LEASED_TASK_STATUSES: readonly TaskStatus[] = [
  'CLAIMING',
  'PREPARING',
  'RUNNING',
  'PAUSED',
  'WAITING_FOR_LIMIT',
  'WAITING_FOR_INPUT',
  'WAITING_FOR_APPROVAL',
  'VERIFYING',
  'CRASHED',
];

/**
 * Authoritative transition table (spec §21). Any transition not listed is rejected.
 * PAUSED and WAITING_FOR_APPROVAL extend the spec minimum to support §83 (pause) and §37/§78 (approvals).
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  QUEUED: ['CLAIMING', 'CANCELLED', 'FAILED'],
  CLAIMING: ['PREPARING', 'QUEUED', 'CANCELLED'],
  PREPARING: ['RUNNING', 'WAITING_FOR_APPROVAL', 'CRASHED', 'FAILED', 'QUEUED', 'CANCELLED', 'RECOVERY_REQUIRED'],
  RUNNING: [
    'VERIFYING',
    'PAUSED',
    'WAITING_FOR_LIMIT',
    'WAITING_FOR_INPUT',
    'WAITING_FOR_APPROVAL',
    'CRASHED',
    'RECOVERY_REQUIRED',
    'FAILED',
    'CANCELLED',
    'QUEUED', // worker lost → requeue for another worker
  ],
  PAUSED: ['RUNNING', 'CANCELLED', 'QUEUED'],
  WAITING_FOR_LIMIT: ['RUNNING', 'QUEUED', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_INPUT: ['RUNNING', 'CANCELLED', 'QUEUED', 'RECOVERY_REQUIRED'],
  WAITING_FOR_APPROVAL: ['PREPARING', 'RUNNING', 'VERIFYING', 'CANCELLED', 'FAILED'],
  CRASHED: ['RUNNING', 'QUEUED', 'RECOVERY_REQUIRED', 'FAILED', 'CANCELLED'],
  RECOVERY_REQUIRED: ['QUEUED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'RUNNING', 'FAILED', 'RECOVERY_REQUIRED', 'WAITING_FOR_APPROVAL', 'CANCELLED', 'QUEUED'],
  COMPLETED: [],
  FAILED: ['QUEUED'], // explicit user retry only
  CANCELLED: ['QUEUED'], // explicit user retry only
};

export const isTerminal = (s: TaskStatus) => TERMINAL_TASK_STATUSES.includes(s);

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** Throws INVALID_TRANSITION if not allowed; returns the target on success. */
export function assertTransition(from: TaskStatus, to: TaskStatus, taskId?: string): TaskStatus {
  if (!canTransition(from, to)) {
    throw new AppError('INVALID_TRANSITION', `Task cannot move from ${from} to ${to}`, {
      context: { from, to, taskId },
    });
  }
  return to;
}

/** Statuses from which `to` is reachable in one step — used to build atomic Mongo preconditions. */
export function sourcesFor(to: TaskStatus): TaskStatus[] {
  return TASK_STATUSES.filter((s) => TASK_TRANSITIONS[s].includes(to));
}

/** Statuses whose elapsed time counts toward hang/execution timeouts (spec §31: limit waits excluded). */
export const TIMED_STATUSES: readonly TaskStatus[] = ['PREPARING', 'RUNNING', 'VERIFYING'];
