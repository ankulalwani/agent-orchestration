/**
 * Agent-neutral execution wrapper (spec §25). The same wrapper is given to every agent; adapters
 * decide only how to deliver it (argument, stdin, file).
 */

export interface Checkpoint {
  taskId: string;
  phase: string;
  completedSteps: string[];
  remainingSteps: string[];
  changedFiles: string[];
  testsRun: Array<{ name: string; passed: boolean; summary?: string }>;
  knownIssues: string[];
  nextAction: string;
  createdAt: string;
  sessionId?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
  reason?: 'periodic' | 'limit' | 'context' | 'crash' | 'fallback' | 'pause' | 'verification' | 'manual';
}

export interface ExecutionPromptInput {
  taskId: string;
  title: string;
  prompt: string; // normalizedPrompt ?? originalPrompt
  plan?: string | null;
  stateDir: string; // relative, normally ".agent-orchestration"
  checkpoint?: Checkpoint | null;
  verificationFailures?: string | null;
  remediationAttempt?: number;
  knowledge?: string[];
  skills?: Array<{ name: string; instructions: string }>;
  userInput?: string | null;
  /** Review tasks (FUT-003): the changes to review. The agent writes a review instead of changing code. */
  review?: { base: string; head: string; baseCommit: string; headCommit: string; stat: string; diff: string; truncated: boolean } | null;
  /** Plan tasks (FUT-001): break the goal into tasks instead of doing it. */
  planning?: { maxTasks: number } | null;
  /**
   * Projects with several repositories: all of them, with absolute paths. The working directory is the
   * primary one; the agent may read and change the others.
   */
  repositories?: Array<{ name: string; path: string; primary: boolean }> | null;
}

export function buildExecutionPrompt(i: ExecutionPromptInput): string {
  const progressFile = `${i.stateDir}/progress/${i.taskId}.json`;
  const reportFile = `${i.stateDir}/progress/${i.taskId}.report.md`;
  const parts: string[] = [];

  parts.push(`# Task: ${i.title}\n\n${i.prompt.trim()}`);

  const multiRepo = (i.repositories?.length ?? 0) > 1;
  if (multiRepo) {
    parts.push(
      [
        '## Repositories',
        'This project consists of several Git repositories. Change whichever of them the task needs; the orchestration platform commits each one separately.',
        ...i.repositories!.map((r) => `- ${r.name}: \`${r.path}\`${r.primary ? ' (primary; your working directory)' : ''}`),
      ].join('\n'),
    );
  }

  if (i.plan) parts.push(`## Approved plan\n\n${i.plan.trim()}`);

  if (i.checkpoint) {
    const c = i.checkpoint;
    parts.push(
      [
        '## Resume from checkpoint',
        'This task was already partly executed. Do NOT start over. Continue from the last incomplete step.',
        `- Phase: ${c.phase}`,
        `- Completed steps:\n${bullet(c.completedSteps)}`,
        `- Remaining steps:\n${bullet(c.remainingSteps)}`,
        `- Files changed so far:\n${bullet(c.changedFiles)}`,
        `- Known issues:\n${bullet(c.knownIssues)}`,
        `- Next action: ${c.nextAction || '(not recorded — inspect the repository and progress file)'}`,
      ].join('\n'),
    );
  }

  if (i.verificationFailures) {
    parts.push(
      `## Verification failed (remediation attempt ${i.remediationAttempt ?? 1})\n\nFix the following failures without reverting unrelated working code, then re-run the checks:\n\n${i.verificationFailures.trim()}`,
    );
  }

  if (i.userInput) parts.push(`## Response from user\n\n${i.userInput.trim()}`);

  if (i.knowledge?.length) parts.push(`## Knowledge\n\nBackground from your organization, the project and the task author. Follow it unless the task says otherwise.\n\n${i.knowledge.join('\n\n')}`);
  for (const s of i.skills ?? []) parts.push(`## Skill: ${s.name}\n\n${s.instructions.trim()}`);

  if (i.planning) {
    const planFile = `${i.stateDir}/progress/${i.taskId}.plan.json`;
    parts.push(
      [
        '## Planning rules',
        'You are the project manager for this goal. Do not implement it: break it into tasks that coding agents will carry out one by one, each in a fresh session that knows only its own task and the project.',
        '1. Study the repository first (structure, conventions, tests) so the tasks fit the existing code.',
        '2. Do NOT modify, create or delete any file in the working directory. The plan fails if anything changes.',
        `3. Make at most ${i.planning.maxTasks} tasks. Each task must be completable and verifiable on its own (tests, type checks or a clear manual check), and small enough for one session.`,
        '4. Each prompt must be self-contained: what to change, where, the acceptance criteria and how to verify it. Do not refer to "the plan" or to other tasks by number.',
        '5. Use dependsOn only where a task truly needs another one finished first; independent tasks can run in parallel.',
        `6. Write the plan as JSON to \`${planFile}\`: {"summary": "…", "tasks": [{"key": "add-api", "title": "…", "prompt": "…", "dependsOn": [], "priority": "NORMAL"}]}. Keys are lowercase words joined by dashes; priority is LOW, NORMAL, HIGH or CRITICAL.`,
        '7. Put open questions and risks in the summary.',
      ].join('\n'),
    );
    return parts.join('\n\n');
  }

  if (i.review) {
    const r = i.review;
    const reviewFile = `${i.stateDir}/progress/${i.taskId}.review.json`;
    parts.push(
      [
        `## Changes to review: ${r.head} (${r.headCommit.slice(0, 12)}) against ${r.base} (${r.baseCommit.slice(0, 12)})`,
        'The working directory is a checkout of the reviewed commit. Read the surrounding code wherever the diff alone is not enough.',
        '```',
        r.stat.trim(),
        '```',
        '```diff',
        r.diff.trim(),
        '```',
        ...(r.truncated ? ['The diff was cut short. Run `git diff ' + r.baseCommit.slice(0, 12) + '...' + r.headCommit.slice(0, 12) + '` for the rest.'] : []),
      ].join('\n'),
    );
    parts.push(
      [
        '## Review rules',
        '1. Do NOT modify, create or delete any file in the working directory, and do not commit. The review fails if anything changes.',
        '2. Look for bugs, security problems, missing tests, broken edge cases, performance problems and deviations from the project\'s conventions. Run the tests if that helps.',
        '3. Be specific: point to the file and line, explain the problem and suggest the fix. Do not comment on things that are fine.',
        `4. Write the review as JSON to \`${reviewFile}\`: {"summary": "…", "verdict": "approve" | "comment" | "request_changes", "comments": [{"path": "src/a.ts", "line": 12, "severity": "blocker" | "major" | "minor" | "nit", "body": "…"}]}. \`line\` is the line number in the new version of the file.`,
        '5. Use "request_changes" only for blockers or major problems; "approve" when nothing important remains.',
        '6. Never print or copy secrets into the review.',
      ].join('\n'),
    );
    return parts.join('\n\n');
  }

  parts.push(
    [
      '## Operating rules',
      '1. Inspect the repository and understand the existing architecture before changing anything.',
      '2. Do not rewrite working code unnecessarily; reuse existing components and conventions.',
      '3. Break the work into concrete steps and implement every requested requirement.',
      `4. Keep progress in \`${progressFile}\` as JSON with keys: phase, completedSteps, remainingSteps, changedFiles, testsRun, knownIssues, nextAction. Update it after every step, and immediately if you expect to run out of context.`,
      '5. Write or update tests for the change. Run the tests, type checking, linting and build that the project provides.',
      '6. Where the change affects a UI or API, perform the applicable browser/API/smoke verification.',
      '7. Fix failures you find. Never claim completion without having run verification.',
      '8. Never run destructive Git commands (force push, reset --hard, clean, branch deletion). Do not commit; the orchestration platform handles Git.',
      '9. Never print, log or commit secrets.',
      `10. Stay inside the project ${multiRepo ? 'repositories listed above' : 'directory'}. The directory \`${i.stateDir}/\` is for orchestration state — do not delete it.`,
      `11. Finish by writing a completion report to \`${reportFile}\` with sections: Summary, Requirements (each marked done/not done), Implementation, Files changed, Tests executed, Verification, Known limitations, Remaining work, Warnings.`,
      '12. If anything remains incomplete, say so explicitly in the report and in the progress file.',
    ].join('\n'),
  );

  return parts.join('\n\n');
}

const bullet = (xs: string[]) => (xs.length ? xs.map((x) => `  - ${x}`).join('\n') : '  - (none)');
