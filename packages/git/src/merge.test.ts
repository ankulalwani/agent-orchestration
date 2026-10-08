import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '@ao/core';
import { GitManager, pullRequestNumber, type HostingAccount } from './index.js';

let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-merge-'));
  await runCommand('git', ['init', '-q', '-b', 'main'], { cwd: dir });
});

/** A GitManager whose remote is `url` and whose host answers `METHOD path-ending` from `routes` (JSON, or [status, JSON]). */
async function manager(url: string, account: HostingAccount | null, routes: Record<string, unknown>) {
  await runCommand('git', ['remote', 'remove', 'origin'], { cwd: dir });
  await runCommand('git', ['remote', 'add', 'origin', url], { cwd: dir });
  const seen: Array<{ method: string; url: string; body: any }> = [];
  const fetchImpl = (async (input: string, init: { method?: string; body?: string }) => {
    const method = init.method ?? 'GET';
    seen.push({ method, url: input, body: init.body ? JSON.parse(init.body) : null });
    const key = Object.keys(routes).find((k) => k.startsWith(`${method} `) && input.endsWith(k.slice(method.length + 1)));
    const answer = key ? routes[key] : undefined;
    if (answer === undefined) return new Response('{"message":"Not Found"}', { status: 404 });
    const [status, body] = Array.isArray(answer) && typeof answer[0] === 'number' ? (answer as [number, unknown]) : [200, answer];
    return new Response(JSON.stringify(typeof body === 'function' ? body(seen.at(-1)!.body) : body), { status });
  }) as unknown as typeof fetch;
  return { git: new GitManager(dir, { hosting: async () => account, fetchImpl }), seen };
}

const gh: HostingAccount = { kind: 'github', apiBaseUrl: 'https://api.github.test/', token: 'ghp_x' };
const gl: HostingAccount = { kind: 'gitlab', apiBaseUrl: 'https://gitlab.test', token: 'glpat_x' };
const pull = (extra: object = {}) => ({ state: 'open', merged: false, draft: false, mergeable: true, mergeable_state: 'clean', base: { ref: 'main' }, head: { sha: 'abc' }, ...extra });

describe('pull request numbers', () => {
  it('come from GitHub and GitLab URLs', () => {
    expect(pullRequestNumber('https://github.com/acme/site/pull/43')).toBe(43);
    expect(pullRequestNumber('https://github.com/acme/site/pull/43/files')).toBe(43);
    expect(pullRequestNumber('https://gitlab.com/group/sub/site/-/merge_requests/7')).toBe(7);
    expect(pullRequestNumber('https://github.com/acme/site/issues/43')).toBeNull();
  });
});

describe('whether a pull request can be merged', () => {
  it('cannot be read without an account for the host', async () => {
    const { git, seen } = await manager('https://github.com/acme/site.git', null, {});
    expect(await git.pullRequestState(5)).toBeNull();
    expect(seen).toEqual([]);
    expect(await git.mergePullRequest(5, { method: 'squash', sha: 'abc' })).toMatchObject({ merged: false, reason: expect.stringContaining('no Git hosting token') });
  });

  it('GitHub: open and clean is mergeable; the host’s reasons against it are passed on', async () => {
    const state = async (pr: object, reviews: unknown[] = []) => (await manager('https://github.com/acme/site.git', gh, { 'GET /repos/acme/site/pulls/5': pr, 'GET /repos/acme/site/pulls/5/reviews?per_page=100': reviews })).git.pullRequestState(5, { waitMs: 1 });
    expect(await state(pull())).toEqual({ number: 5, open: true, merged: false, draft: false, headSha: 'abc', blocked: null });
    // Checks that are not required and fail do not block (`unstable`); the task's own CI gate decides about them.
    expect((await state(pull({ mergeable_state: 'unstable' })))!.blocked).toBeNull();
    expect((await state(pull({ draft: true })))!.blocked).toBe('it is a draft');
    expect((await state(pull({ mergeable: false, mergeable_state: 'dirty' })))!.blocked).toBe('it conflicts with main');
    expect((await state(pull({ mergeable_state: 'blocked' })))!.blocked).toMatch(/^branch protection blocks it/);
    expect((await state(pull({ mergeable_state: 'behind' })))!.blocked).toBe('its branch must be up to date with main');
    expect((await state(pull({ mergeable: null, mergeable_state: 'unknown' })))!.blocked).toBe('GitHub has not decided yet whether it can be merged');
    expect(await state(pull({ state: 'closed', merged: true }))).toMatchObject({ open: false, merged: true });
    // The last review of each person counts; a dismissed request for changes no longer does.
    const review = (login: string, s: string) => ({ user: { login }, state: s });
    expect((await state(pull(), [review('maria', 'CHANGES_REQUESTED'), review('li', 'APPROVED')]))!.blocked).toBe('maria requested changes');
    expect((await state(pull(), [review('maria', 'CHANGES_REQUESTED'), review('maria', 'COMMENTED'), review('maria', 'APPROVED')]))!.blocked).toBeNull();
    expect((await state(pull(), [review('maria', 'CHANGES_REQUESTED'), review('maria', 'DISMISSED')]))!.blocked).toBeNull();
    await expect(state(undefined as never)).rejects.toThrow(/GitHub did not return pull request 5 \(HTTP 404\)/);
  });

  it('GitHub: merges at the verified commit, with another method when the repository does not allow the one asked for', async () => {
    const ok = await manager('https://github.com/acme/site.git', gh, { 'PUT /repos/acme/site/pulls/5/merge': { merged: true, sha: 'merged1' } });
    expect(await ok.git.mergePullRequest(5, { method: 'rebase', sha: 'abc' })).toEqual({ merged: true, method: 'rebase', commit: 'merged1', reason: null });
    expect(ok.seen).toEqual([{ method: 'PUT', url: 'https://api.github.test/repos/acme/site/pulls/5/merge', body: { merge_method: 'rebase', sha: 'abc' } }]);

    const picky = await manager('https://github.com/acme/site.git', gh, { 'PUT /repos/acme/site/pulls/5/merge': [200, (b: { merge_method: string }) => (b.merge_method === 'merge' ? { merged: true, sha: 'merged2' } : { message: 'Squash merges are not allowed on this repository.' })] });
    // A 200 without `merged` is not a merge.
    expect((await picky.git.mergePullRequest(5, { method: 'squash', sha: 'abc' })).merged).toBe(false);

    const refused = await manager('https://github.com/acme/site.git', gh, { 'PUT /repos/acme/site/pulls/5/merge': [409, { message: 'Head branch was modified. Review and try the merge again.' }] });
    expect(await refused.git.mergePullRequest(5, { method: 'squash', sha: 'old' })).toEqual({ merged: false, method: 'squash', commit: null, reason: 'Head branch was modified. Review and try the merge again. (HTTP 409)' });
    expect(refused.seen).toHaveLength(1); // only "method not allowed" is worth another method
  });

  it('GitLab: the detailed merge status says what stands in the way; squash is asked for, the rest is the project’s', async () => {
    const mr = (extra: object = {}) => ({ state: 'opened', draft: false, sha: 'abc', target_branch: 'main', merge_status: 'can_be_merged', detailed_merge_status: 'mergeable', has_conflicts: false, ...extra });
    const state = async (m: object) => (await manager('https://gitlab.com/group/site.git', gl, { 'GET /api/v4/projects/group%2Fsite/merge_requests/3': m })).git.pullRequestState(3, { waitMs: 1 });
    expect(await state(mr())).toEqual({ number: 3, open: true, merged: false, draft: false, headSha: 'abc', blocked: null });
    expect((await state(mr({ has_conflicts: true, detailed_merge_status: 'conflict' })))!.blocked).toBe('it conflicts with main');
    expect((await state(mr({ detailed_merge_status: 'not_approved' })))!.blocked).toBe('a required approval is missing');
    expect((await state(mr({ detailed_merge_status: 'discussions_not_resolved' })))!.blocked).toBe('there are unresolved discussions');
    expect((await state(mr({ detailed_merge_status: 'ci_must_pass' })))!.blocked).toBe('its pipeline must pass');
    expect((await state(mr({ detailed_merge_status: 'something_new' })))!.blocked).toBe('GitLab reports "something_new"');
    expect((await state(mr({ draft: true, detailed_merge_status: 'draft_status' })))!.blocked).toBe('it is a draft');
    expect((await state(mr({ detailed_merge_status: 'checking', merge_status: 'checking' })))!.blocked).toBe('GitLab has not decided yet whether it can be merged');
    expect(await state(mr({ state: 'merged' }))).toMatchObject({ open: false, merged: true });

    const ok = await manager('https://gitlab.com/group/site.git', gl, { 'PUT /api/v4/projects/group%2Fsite/merge_requests/3/merge': { state: 'merged', merge_commit_sha: 'm1' } });
    expect(await ok.git.mergePullRequest(3, { method: 'squash', sha: 'abc' })).toEqual({ merged: true, method: 'squash', commit: 'm1', reason: null });
    expect(ok.seen[0]!.body).toEqual({ squash: true, sha: 'abc' });
    const moved = await manager('https://gitlab.com/group/site.git', gl, { 'PUT /api/v4/projects/group%2Fsite/merge_requests/3/merge': [409, { message: 'SHA does not match HEAD of source branch' }] });
    expect((await moved.git.mergePullRequest(3, { method: 'merge', sha: 'old' })).reason).toBe('the branch changed after it was verified (HTTP 409)');
    expect(moved.seen[0]!.body).toEqual({ squash: false, sha: 'old' });
  });
});

describe('bringing a branch up to date with its base', () => {
  it('merges the base, reports conflicts with the merge left in progress, and finds markers that were left in', async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-merge-remote-'));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-merge-work-'));
    const g = async (...a: string[]) => {
      const r = await runCommand('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', ...a], { cwd: work });
      if (r.exitCode !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    await runCommand('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    await g('init', '-q', '-b', 'main');
    await g('remote', 'add', 'origin', remote);
    const commit = async (file: string, text: string, message: string) => {
      fs.writeFileSync(path.join(work, file), text);
      await g('add', '.');
      await g('commit', '-qm', message);
    };
    await commit('a.txt', 'one\n', 'init');
    await g('push', '-q', 'origin', 'main');
    await g('checkout', '-q', '-b', 'feature');
    await commit('b.txt', 'feature\n', 'feature');
    await g('push', '-q', 'origin', 'feature');
    const git = new GitManager(work, { authorName: 'Agent', authorEmail: 'agent@example.com' });

    expect(await git.updateFromBase('main')).toEqual({ state: 'up_to_date', conflicts: [] });
    // main moves on without touching the feature's files: a merge commit, nothing to resolve.
    await g('checkout', '-q', 'main');
    await commit('c.txt', 'main\n', 'main moves');
    await g('push', '-q', 'origin', 'main');
    await g('checkout', '-q', 'feature');
    expect(await git.updateFromBase('main')).toEqual({ state: 'merged', conflicts: [] });
    expect(await g('log', '-1', '--format=%an|%s')).toBe('Agent|Merge main into feature');
    expect((await g('log', '-1', '--format=%P')).split(' ')).toHaveLength(2);
    expect(await git.updateFromBase('main')).toEqual({ state: 'up_to_date', conflicts: [] });

    // Both sides change the same line.
    await g('checkout', '-q', 'main');
    await commit('a.txt', 'one on main\n', 'main changes a');
    await g('push', '-q', 'origin', 'main');
    await g('checkout', '-q', 'feature');
    await commit('a.txt', 'one on the feature\n', 'feature changes a');
    expect(await git.updateFromBase('main')).toEqual({ state: 'conflicts', conflicts: ['a.txt'] });
    expect(await git.mergeInProgress()).toBe(true);
    expect(await git.withConflictMarkers(['a.txt', 'b.txt', 'gone.txt'])).toEqual(['a.txt']);
    // Asked again (the worker restarted): the same answer, and no second merge.
    expect(await git.updateFromBase('main')).toEqual({ state: 'conflicts', conflicts: ['a.txt'] });
    fs.writeFileSync(path.join(work, 'a.txt'), 'one on the feature and on main\n');
    expect(await git.withConflictMarkers(['a.txt'])).toEqual([]);
    // Committing the files concludes the merge.
    const base = await git.baseline();
    const head = await git.commit('Resolve', ['a.txt']);
    expect(await git.mergeInProgress()).toBe(false);
    expect((await g('log', '-1', '--format=%P', head!)).split(' ')).toHaveLength(2);
    expect(base.head).not.toBe(head);
    await expect(git.updateFromBase('main; rm -rf /')).rejects.toThrow(/Invalid branch name/);
    // Names from a pull request are never read as options.
    await expect(git.updateFromBase('--upload-pack')).rejects.toThrow(/Invalid branch name/);
    await expect(git.ensureBranchFromRef('-D', 'refs/heads/main')).rejects.toThrow(/Invalid branch name/);
    await expect(git.ensureBranchFromRef('ok', '--all')).rejects.toThrow(/Invalid ref/);
    await expect(git.push('feature', 'origin', { url: 'ext::sh -c id', branch: 'x' })).rejects.toThrow(/Invalid repository URL/);
    await expect(git.push('feature', 'origin', { url: 'https://example.com/a/b.git', branch: '--force' })).rejects.toThrow(/Invalid branch name/);
  });
});
