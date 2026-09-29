import fs from 'node:fs';
import path from 'node:path';
import type { Checkpoint } from '@ao/core';

/**
 * Checkpoints and task state in `<project>/.agent-orchestrator/` (spec §26). The agent maintains
 * progress/<taskId>.json (instructed by the execution wrapper); the worker turns it into immutable
 * checkpoint files and sends each checkpoint to the control plane.
 */
export const STATE_DIR = '.agent-orchestrator';
export const STATE_SUBDIRS = ['task-state', 'checkpoints', 'progress', 'logs', 'plans', 'verification', 'metadata', 'prompts'];

export function ensureStateDir(projectRoot: string) {
  const root = path.join(projectRoot, STATE_DIR);
  for (const d of STATE_SUBDIRS) fs.mkdirSync(path.join(root, d), { recursive: true });
  const readme = path.join(root, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, 'Orchestrator task state. Excluded from Git via .git/info/exclude. Do not store secrets here.\n');
  return root;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).slice(0, 500) : []);

/** Read the agent-maintained progress file; tolerate missing/malformed content. */
export function readProgress(stateRoot: string, taskId: string): Partial<Checkpoint> | null {
  const f = path.join(stateRoot, 'progress', `${taskId}.json`);
  try {
    const p = JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
    return {
      phase: typeof p.phase === 'string' ? p.phase : undefined,
      completedSteps: arr(p.completedSteps),
      remainingSteps: arr(p.remainingSteps),
      changedFiles: arr(p.changedFiles),
      knownIssues: arr(p.knownIssues),
      nextAction: typeof p.nextAction === 'string' ? p.nextAction : '',
      testsRun: Array.isArray(p.testsRun)
        ? (p.testsRun as unknown[]).slice(0, 200).map((t) =>
            typeof t === 'object' && t ? { name: String((t as any).name ?? 'test'), passed: Boolean((t as any).passed), summary: (t as any).summary ? String((t as any).summary) : undefined } : { name: String(t), passed: false },
          )
        : [],
    };
  } catch {
    return null;
  }
}

export function readAgentReport(stateRoot: string, taskId: string): string | null {
  try {
    return fs.readFileSync(path.join(stateRoot, 'progress', `${taskId}.report.md`), 'utf8').slice(0, 50_000);
  } catch {
    return null;
  }
}

export function buildCheckpoint(stateRoot: string, taskId: string, base: Partial<Checkpoint> | null, extra: Partial<Checkpoint>): Checkpoint {
  const progress = readProgress(stateRoot, taskId) ?? {};
  const cp: Checkpoint = {
    taskId,
    phase: progress.phase ?? base?.phase ?? 'execute',
    completedSteps: progress.completedSteps ?? base?.completedSteps ?? [],
    remainingSteps: progress.remainingSteps ?? base?.remainingSteps ?? [],
    changedFiles: progress.changedFiles ?? base?.changedFiles ?? [],
    testsRun: progress.testsRun ?? base?.testsRun ?? [],
    knownIssues: progress.knownIssues ?? base?.knownIssues ?? [],
    nextAction: progress.nextAction || base?.nextAction || '',
    createdAt: new Date().toISOString(),
    ...extra,
  };
  const file = path.join(stateRoot, 'checkpoints', `${taskId}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(cp, null, 2));
  return cp;
}

export interface LocalTaskState {
  taskId: string;
  baseline: unknown;
  /** Baselines of the project's other repositories, by repository name. */
  repoBaselines?: Record<string, unknown>;
  branch: string | null;
  recoveryEvents: string[];
  consecutiveFailures: Array<string>;
  updatedAt: string;
}

export function saveTaskState(stateRoot: string, s: LocalTaskState) {
  const f = path.join(stateRoot, 'task-state', `${s.taskId}.json`);
  fs.writeFileSync(f + '.tmp', JSON.stringify({ ...s, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(f + '.tmp', f);
}

export function loadTaskState(stateRoot: string, taskId: string): LocalTaskState | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateRoot, 'task-state', `${taskId}.json`), 'utf8'));
  } catch {
    return null;
  }
}
