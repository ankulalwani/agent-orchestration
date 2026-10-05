import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '@ao/core';
import { GitManager, type HostingAccount } from './index.js';

let dir: string;
const SHA = 'a'.repeat(40);

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-ci-'));
  await runCommand('git', ['init', '-q', '-b', 'main'], { cwd: dir });
});

/** A GitManager whose remote is `url` and whose host answers from `routes` (path → JSON, text or status). */
async function manager(url: string, account: HostingAccount | null, routes: Record<string, unknown>) {
  await runCommand('git', ['remote', 'remove', 'origin'], { cwd: dir });
  await runCommand('git', ['remote', 'add', 'origin', url], { cwd: dir });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string, init: { headers: Record<string, string> }) => {
    seen.push({ url: input, headers: init.headers });
    const key = Object.keys(routes).find((k) => input.endsWith(k));
    const body = key ? routes[key] : undefined;
    if (body === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    if (typeof body === 'number') return new Response('{}', { status: body });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { git: new GitManager(dir, { hosting: async () => account, fetchImpl }), seen };
}

const gh: HostingAccount = { kind: 'github', apiBaseUrl: 'https://api.github.test/', token: 'ghp_x' };
const gl: HostingAccount = { kind: 'gitlab', apiBaseUrl: 'https://gitlab.test', token: 'glpat_x' };
const run = (id: number, name: string, status: string, conclusion: string | null, extra: object = {}) => ({ id, name, status, conclusion, html_url: `https://github.test/runs/${id}`, output: {}, ...extra });

describe('CI checks of a commit', () => {
  it('cannot be read without an account for the host', async () => {
    const { git, seen } = await manager('https://github.com/acme/site.git', null, {});
    expect(await git.ciStatus(SHA)).toBeNull();
    expect(seen).toEqual([]);
  });

  it('GitHub: check runs and commit statuses together decide the state', async () => {
    const routes = (runs: unknown[], statuses: unknown[] = []) => ({ [`/commits/${SHA}/check-runs?per_page=100`]: { check_runs: runs }, [`/commits/${SHA}/status`]: { statuses } });
    const state = async (runs: unknown[], statuses: unknown[] = []) => (await (await manager('git@github.com:acme/site.git', gh, routes(runs, statuses))).git.ciStatus(SHA))!.state;
    expect(await state([])).toBe('none');
    expect(await state([run(1, 'build', 'queued', null)])).toBe('pending');
    expect(await state([run(1, 'build', 'completed', 'success'), run(2, 'docs', 'completed', 'skipped'), run(3, 'audit', 'completed', 'neutral')])).toBe('success');
    expect(await state([run(1, 'build', 'completed', 'success')], [{ context: 'ci/legacy', state: 'pending' }])).toBe('pending');
    expect(await state([run(1, 'build', 'completed', 'success')], [{ context: 'ci/legacy', state: 'error', description: 'boom' }])).toBe('failure');
    for (const conclusion of ['failure', 'timed_out', 'cancelled', 'action_required']) expect(await state([run(1, 'build', 'completed', conclusion)])).toBe('failure');
    // One still running: not decided yet, even with a failure next to it.
    expect(await state([run(1, 'build', 'completed', 'failure'), run(2, 'e2e', 'in_progress', null)])).toBe('pending');

    const { git, seen } = await manager('https://github.com/acme/site.git', gh, routes([run(1, 'build', 'completed', 'success')]));
    await git.ciStatus(SHA);
    expect(seen[0]).toMatchObject({ url: `https://api.github.test/repos/acme/site/commits/${SHA}/check-runs?per_page=100`, headers: { authorization: 'Bearer ghp_x' } });
  });

  it('GitHub: a failed check carries the end of its Actions log, or its annotations', async () => {
    const { git } = await manager('https://github.com/acme/site.git', gh, {
      [`/commits/${SHA}/check-runs?per_page=100`]: {
        check_runs: [run(7, 'build', 'completed', 'failure', { app: { slug: 'github-actions' }, output: { title: 'Tests failed', summary: '1 failing' } }), run(8, 'sonar', 'completed', 'failure', { app: { slug: 'sonar' } }), run(9, 'lint', 'completed', 'success')],
      },
      [`/commits/${SHA}/status`]: { statuses: [] },
      '/actions/jobs/7/logs': `${'x'.repeat(9000)}\nError: expected 200, got 500`,
      '/check-runs/8/annotations?per_page=30': [{ path: 'src/a.ts', start_line: 12, annotation_level: 'failure', message: 'Unused variable' }],
    });
    const plain = (await git.ciStatus(SHA))!;
    expect(plain.checks.map((c) => c.log)).toEqual([null, null, null]);
    const withLogs = (await git.ciStatus(SHA, { logs: true }))!;
    const [build, sonar, lint] = withLogs.checks;
    expect(build).toMatchObject({ name: 'build', state: 'failure', summary: 'Tests failed: 1 failing', url: 'https://github.test/runs/7' });
    expect(build!.log!.endsWith('Error: expected 200, got 500')).toBe(true);
    expect(build!.log!.length).toBeLessThanOrEqual(6000);
    expect(sonar!.log).toBe('src/a.ts:12 failure: Unused variable');
    expect(lint!.log).toBeNull();
  });

  it('GitLab: commit statuses, with allowed failures and manual jobs left out', async () => {
    const st = (id: number, name: string, status: string, extra: object = {}) => ({ id, name, status, target_url: `https://gitlab.test/jobs/${id}`, ...extra });
    const of = async (statuses: unknown[], logs = false) => {
      const { git, seen } = await manager('https://gitlab.test/group/sub/site.git', gl, { [`/repository/commits/${SHA}/statuses?per_page=100`]: statuses, '/jobs/2/trace': 'rspec failed\n1 example, 1 failure' });
      return { status: (await git.ciStatus(SHA, { logs }))!, seen };
    };
    expect((await of([])).status.state).toBe('none');
    expect((await of([st(1, 'build', 'running')])).status.state).toBe('pending');
    expect((await of([st(1, 'build', 'success'), st(3, 'deploy', 'manual'), st(4, 'flaky', 'failed', { allow_failure: true })])).status.state).toBe('success');
    const failed = await of([st(1, 'build', 'success'), st(2, 'test', 'failed')], true);
    expect(failed.status.state).toBe('failure');
    expect(failed.status.checks[1]).toMatchObject({ name: 'test', state: 'failure', log: 'rspec failed\n1 example, 1 failure' });
    expect(failed.seen[0]).toMatchObject({ url: `https://gitlab.test/api/v4/projects/group%2Fsub%2Fsite/repository/commits/${SHA}/statuses?per_page=100`, headers: { 'private-token': 'glpat_x' } });
  });

  it('says so when the host refuses', async () => {
    const { git } = await manager('https://github.com/acme/site.git', gh, { [`/commits/${SHA}/check-runs?per_page=100`]: 403 });
    await expect(git.ciStatus(SHA)).rejects.toThrow(/GitHub did not return the checks of aaaaaaa \(HTTP 403\)/);
  });
});
