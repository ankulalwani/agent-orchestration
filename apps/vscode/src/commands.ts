import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OrchestratorClient, TaskSummary } from './client.js';

/**
 * The extension's behaviour, independent of the VS Code API so it can be tested against a real
 * server: `extension.ts` supplies a `Ui` backed by VS Code's input boxes, quick picks and messages.
 */
export interface Ui {
  input(opts: { title: string; prompt?: string; value?: string; password?: boolean; validate?: (v: string) => string | null }): Promise<string | undefined>;
  pick<T>(items: Array<{ label: string; description?: string; value: T }>, placeholder: string): Promise<T | undefined>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string): void;
  openExternal(url: string): void;
}
/** Per-workspace memory (VS Code workspaceState). */
export interface Memory {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}
export interface Context {
  client: OrchestratorClient;
  ui: Ui;
  memory: Memory;
  webUrl: string;
}

export interface Selection {
  text: string;
  /** Path relative to the workspace folder, for the agent. */
  file: string;
  startLine: number;
  endLine: number;
  languageId: string;
}

const PROJECT_KEY = 'agentOrchestrator.projectId';
export const taskUrl = (webUrl: string, id: string) => `${webUrl.replace(/\/+$/, '')}/tasks/${id}`;

/** The project tasks from this workspace go to: remembered, or picked once. */
export async function chooseProject(ctx: Context, force = false): Promise<string | undefined> {
  const remembered = ctx.memory.get<string>(PROJECT_KEY);
  const who = await ctx.client.whoami();
  const projects = await ctx.client.projects(who.organizationId);
  if (!force && remembered && projects.some((p) => p.id === remembered)) return remembered;
  if (!projects.length) {
    ctx.ui.error(`No projects in ${who.organizationName} yet. Create one in the dashboard first.`);
    return undefined;
  }
  const id = projects.length === 1 && !force ? projects[0]!.id : await ctx.ui.pick(projects.map((p) => ({ label: p.name, value: p.id })), 'Project for tasks from this workspace');
  if (id) await ctx.memory.update(PROJECT_KEY, id);
  return id;
}

/** The prompt for a task about a selection: the request, then the code it is about. */
export function selectionPrompt(request: string, sel: Selection): string {
  const lines = sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}–${sel.endLine}`;
  return `${request.trim()}\n\nThis is about \`${sel.file}\` ${lines}:\n\n\`\`\`${sel.languageId}\n${sel.text}\n\`\`\``;
}

async function created(ctx: Context, task: TaskSummary, what: string) {
  const choice = await ctx.ui.info(`${what}: ${task.title}`, 'Open in browser');
  if (choice === 'Open in browser') ctx.ui.openExternal(taskUrl(ctx.webUrl, task.id));
  return task;
}

export async function createTask(ctx: Context, selection?: Selection): Promise<TaskSummary | undefined> {
  const projectId = await chooseProject(ctx);
  if (!projectId) return undefined;
  const request = await ctx.ui.input({ title: selection ? 'What should the agent do with the selected code?' : 'What should the agent do?', validate: (v) => (v.trim() ? null : 'Describe the task') });
  if (!request) return undefined;
  const title = await ctx.ui.input({ title: 'Task title', value: request.trim().split('\n')[0]!.slice(0, 120), validate: (v) => (v.trim() ? null : 'A title is required') });
  if (!title) return undefined;
  const who = await ctx.client.whoami();
  const task = await ctx.client.createTask(who.organizationId, {
    projectId,
    title: title.trim(),
    prompt: selection ? selectionPrompt(request, selection) : request.trim(),
    idempotencyKey: randomUUID(),
  });
  return created(ctx, task, 'Task created');
}

const run = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await run('git', args, { cwd, windowsHide: true })).stdout.trim();
}

/** Review task for the workspace's current branch against a base branch (default: the remote's default, else main). */
export async function reviewCurrentBranch(ctx: Context, repoDir: string): Promise<TaskSummary | undefined> {
  let head: string;
  try {
    head = await git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  } catch {
    ctx.ui.error('This workspace folder is not a Git repository.');
    return undefined;
  }
  if (head === 'HEAD') {
    ctx.ui.error('Check out a branch to review (the workspace is on a detached commit).');
    return undefined;
  }
  const defaultBase = await git(repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    .then((r) => r.replace(/^origin\//, ''))
    .catch(() => 'main');
  const base = await ctx.ui.input({ title: `Review ${head} against which branch?`, value: defaultBase, validate: (v) => (!v.trim() ? 'A base branch is required' : v.trim() === head ? 'Choose a different branch than the one under review' : null) });
  if (!base) return undefined;
  const projectId = await chooseProject(ctx);
  if (!projectId) return undefined;
  const who = await ctx.client.whoami();
  const task = await ctx.client.createTask(who.organizationId, {
    projectId,
    kind: 'review',
    review: { base: base.trim(), head },
    title: `Review ${head}`,
    prompt: `Review the changes on ${head} against ${base.trim()} in ${path.basename(repoDir)}.`,
    idempotencyKey: randomUUID(),
  });
  return created(ctx, task, 'Review requested');
}

/** Tree view rows for recent tasks. */
export function taskRows(tasks: TaskSummary[]) {
  const icon: Record<string, string> = {
    COMPLETED: 'pass',
    FAILED: 'error',
    CANCELLED: 'circle-slash',
    RECOVERY_REQUIRED: 'warning',
    WAITING_FOR_INPUT: 'question',
    WAITING_FOR_APPROVAL: 'question',
    WAITING_FOR_LIMIT: 'watch',
    RUNNING: 'sync~spin',
    VERIFYING: 'beaker',
    QUEUED: 'clock',
    PAUSED: 'debug-pause',
  };
  return tasks.map((t) => ({
    id: t.id,
    label: t.title,
    description: `${t.status.toLowerCase().replace(/_/g, ' ')}${t.kind && t.kind !== 'code' ? ` · ${t.kind}` : ''}`,
    tooltip: [t.statusReason, t.completionReport?.summary].filter(Boolean).join('\n\n') || t.title,
    icon: icon[t.status] ?? 'circle-outline',
    attention: ['RECOVERY_REQUIRED', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'FAILED'].includes(t.status),
  }));
}
