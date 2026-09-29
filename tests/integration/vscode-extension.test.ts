/**
 * VS Code extension (FUT-007): the extension's commands run against a real control plane with a
 * personal API token, through a scripted stand-in for VS Code's input boxes and pickers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { runCommand } from '@ao/core';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import type { Actor, Services } from '@ao/server';
import { buildApp } from '../../apps/api/src/app.js';
import { OrchestrationClient } from '../../apps/vscode/src/client.js';
import { chooseProject, createTask, reviewCurrentBranch, selectionPrompt, taskRows, type Context, type Ui } from '../../apps/vscode/src/commands.js';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
let app: FastifyInstance;
let base: string;
let owner: Actor;
let token: string;
let projects: string[];

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  app = await buildApp(s);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  owner = (await makeOwner(s, 'vscode')).actor;
  projects = [
    (await s.projects.create(owner, { name: 'web', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id,
    (await s.projects.create(owner, { name: 'api', description: '', defaultBranch: 'main', environments: [], knowledge: '' })).id,
  ];
  token = (await s.apiTokens.create(owner.userId, { name: 'VS Code', organizationId: owner.organizationId, role: 'DEVELOPER' })).token;
});
afterAll(async () => {
  await app.close();
  await stopTestDatabase();
});

/** A UI that answers from a script and records what it showed. */
function scriptedUi(answers: Array<string | undefined>) {
  const shown: string[] = [];
  const opened: string[] = [];
  const ui: Ui = {
    input: async (o) => {
      shown.push(`input: ${o.title}`);
      const a = answers.shift();
      if (a !== undefined && o.validate?.(a)) throw new Error(`invalid answer "${a}": ${o.validate(a)}`);
      return a;
    },
    pick: async (items, placeholder) => {
      shown.push(`pick: ${placeholder} [${items.map((i) => i.label).join(', ')}]`);
      const a = answers.shift();
      return items.find((i) => i.label === a)?.value;
    },
    info: async (m) => {
      shown.push(`info: ${m}`);
      return answers.shift();
    },
    error: (m) => void shown.push(`error: ${m}`),
    openExternal: (u) => void opened.push(u),
  };
  return { ui, shown, opened };
}
function memory() {
  const m = new Map<string, unknown>();
  return { get: <T,>(k: string) => m.get(k) as T | undefined, update: async (k: string, v: unknown) => void m.set(k, v) };
}

describe('VS Code extension commands', () => {
  it('create a task from a selection: project picked once, prompt includes the code, link opens in the browser', async () => {
    const mem = memory();
    const { ui, shown, opened } = scriptedUi(['api', 'Handle the empty cart', 'Fix empty cart crash', 'Open in browser']);
    const ctx: Context = { client: new OrchestrationClient(base, token), ui, memory: mem, webUrl: 'https://orchestration.test' };
    const task = await createTask(ctx, { text: 'const total = cart.items.reduce(sum);', file: 'src/cart.ts', startLine: 12, endLine: 12, languageId: 'typescript' });
    expect(task).toBeDefined();
    const stored = await s.tasks.get(owner, task!.id);
    expect(stored).toMatchObject({ title: 'Fix empty cart crash', projectId: projects[1] });
    expect(stored.originalPrompt).toBe(selectionPrompt('Handle the empty cart', { text: 'const total = cart.items.reduce(sum);', file: 'src/cart.ts', startLine: 12, endLine: 12, languageId: 'typescript' }));
    expect(stored.originalPrompt).toContain('`src/cart.ts` line 12');
    expect(shown[0]).toBe('pick: Project for tasks from this workspace [api, web]');
    expect(opened).toEqual([`https://orchestration.test/tasks/${task!.id}`]);

    // The project is remembered for this workspace.
    const second = scriptedUi(['Add a README', 'Add a README', undefined]);
    await createTask({ ...ctx, ui: second.ui });
    expect(second.shown.some((x) => x.startsWith('pick:'))).toBe(false);
    expect(await chooseProject({ ...ctx, ui: scriptedUi(['web']).ui }, true)).toBe(projects[0]);
  });

  it('review the current branch of a workspace repository', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-vscode-'));
    const g = (...a: string[]) => runCommand('git', a, { cwd: repo });
    await g('init', '-q', '-b', 'main');
    await g('config', 'user.email', 'v@example.com');
    await g('config', 'user.name', 'V');
    await g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    await g('add', '.');
    await g('commit', '-qm', 'init');
    await g('checkout', '-q', '-b', 'feature/login');
    const mem = memory();
    await mem.update('agentOrchestration.projectId', projects[0]);
    const { ui, shown } = scriptedUi(['main', undefined]);
    const task = await reviewCurrentBranch({ client: new OrchestrationClient(base, token), ui, memory: mem, webUrl: base }, repo);
    expect(shown[0]).toBe('input: Review feature/login against which branch?');
    expect(await s.tasks.get(owner, task!.id)).toMatchObject({ kind: 'review', title: 'Review feature/login', review: { base: 'main', head: 'feature/login' } });

    const notRepo = scriptedUi([]);
    expect(await reviewCurrentBranch({ client: new OrchestrationClient(base, token), ui: notRepo.ui, memory: mem, webUrl: base }, os.tmpdir())).toBeUndefined();
    expect(notRepo.shown).toEqual(['error: This workspace folder is not a Git repository.']);
  });

  it('task list rows, and a revoked token is reported', async () => {
    const client = new OrchestrationClient(base, token);
    const rows = taskRows(await client.tasks((await client.whoami()).organizationId));
    expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(['Fix empty cart crash', 'Review feature/login']));
    expect(rows.find((r) => r.label === 'Review feature/login')).toMatchObject({ description: 'queued · review', icon: 'clock' });
    await expect(new OrchestrationClient(base, 'aot_revoked').whoami()).rejects.toMatchObject({ status: 401 });
  });

  it('every command in the extension manifest is registered by the extension', () => {
    const manifest = JSON.parse(fs.readFileSync('apps/vscode/package.json', 'utf8'));
    const source = fs.readFileSync('apps/vscode/src/extension.ts', 'utf8');
    const registered = [...source.matchAll(/register\(\s*'([\w.]+)'/g)].map((m) => m[1]);
    expect(registered.sort()).toEqual(manifest.contributes.commands.map((c: { command: string }) => c.command).sort());
  });
});
