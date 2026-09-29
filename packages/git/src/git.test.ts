import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCommand } from '@ao/core';
import { GitManager, destructiveReason } from './index.js';

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-'));
  const g = (...a: string[]) => runCommand('git', a, { cwd: dir });
  await g('init', '-q', '-b', 'main');
  await g('config', 'user.email', 't@example.com');
  await g('config', 'user.name', 'Test');
  await g('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'user.txt'), 'user\n');
  await g('add', '.');
  await g('commit', '-qm', 'init');
  return { dir, g, git: new GitManager(dir) };
}

describe('destructive operation guard (spec §42)', () => {
  it.each([
    [['push', '--force'], true],
    [['push', '-f', 'origin', 'main'], true],
    [['push', 'origin', '+main'], true],
    [['push', '--force-with-lease'], true],
    [['push', 'origin', '--delete', 'x'], true],
    [['reset', '--hard', 'HEAD~1'], true],
    [['clean', '-fd'], true],
    [['branch', '-D', 'x'], true],
    [['checkout', '--', '.'], true],
    [['restore', 'a.txt'], true],
    [['stash', 'drop'], true],
    [['commit', '--amend'], true],
    [['push', '--set-upstream', 'origin', 'refs/heads/a:refs/heads/a'], false],
    [['status'], false],
    [['switch', '-c', 'ao/x'], false],
    [['restore', '--staged', 'a.txt'], false],
  ])('%j destructive=%s', (args, bad) => expect(Boolean(destructiveReason(args as string[]))).toBe(bad));

  it('run() refuses destructive commands and never force-pushes', async () => {
    const { git } = await repo();
    await expect(git.run(['reset', '--hard'])).rejects.toMatchObject({ code: 'GIT_POLICY_VIOLATION' });
    await expect(git.run(['push', '--force'], { allowDestructive: true })).rejects.toMatchObject({ code: 'GIT_POLICY_VIOLATION' });
  });
});

describe('GitManager', () => {
  it('commits only task changes and preserves pre-existing user work', async () => {
    const { dir, git, g } = await repo();
    fs.writeFileSync(path.join(dir, 'user.txt'), 'user edit in progress\n'); // user's uncommitted work
    fs.writeFileSync(path.join(dir, 'scratch.txt'), 'untracked user file\n');
    await git.excludeStateDir();
    const base = await git.baseline();
    expect(Object.keys(base.dirty).sort()).toEqual(['scratch.txt', 'user.txt']);
    await git.ensureBranch('ao/task-1');

    // Agent work:
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a changed\n');
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export {}\n');
    fs.mkdirSync(path.join(dir, '.agent-orchestration', 'progress'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.agent-orchestration', 'progress', 't.json'), '{}');

    const r = await git.applyPolicy({ policy: 'COMMIT', baseline: base, branch: 'ao/task-1', message: 'feat: task\n\nbody', prTitle: '', prBody: '' });
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(r.branch).toBe('ao/task-1');
    expect(r.filesChanged.map((f) => f.path).sort()).toEqual(['a.txt', 'new.ts']);
    const committed = (await g('show', '--name-only', '--format=', 'HEAD')).stdout.trim().split('\n').sort();
    expect(committed).toEqual(['a.txt', 'new.ts']);
    // User work untouched and still uncommitted.
    expect(fs.readFileSync(path.join(dir, 'user.txt'), 'utf8')).toBe('user edit in progress\n');
    expect(fs.existsSync(path.join(dir, 'scratch.txt'))).toBe(true);
    const status = await git.status();
    expect(status.map((s) => s.path).sort()).toEqual(['scratch.txt', 'user.txt']);
  });

  it('warns when the task touched a file that had user changes', async () => {
    const { dir, git } = await repo();
    fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip\n');
    const base = await git.baseline();
    fs.writeFileSync(path.join(dir, 'user.txt'), 'user wip + agent\n');
    const r = await git.taskChanges(base);
    expect(r.include).toEqual([]);
    expect(r.warnings[0]).toMatch(/left unstaged/);
  });

  it('policy NONE commits nothing; COMMIT_AND_PUSH without remote is reported, not fatal', async () => {
    const { dir, git, g } = await repo();
    const base = await git.baseline();
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    expect((await git.applyPolicy({ policy: 'NONE', baseline: base, branch: null, message: 'm', prTitle: '', prBody: '' })).commit).toBeNull();
    const r = await git.applyPolicy({ policy: 'COMMIT_AND_PUSH', baseline: base, branch: null, message: 'm', prTitle: '', prBody: '' });
    expect(r.commit).not.toBeNull();
    expect(r.pushed).toBe(false);
    expect(r.blocked[0]).toMatch(/origin/);
    expect((await g('log', '--oneline')).stdout.trim().split('\n')).toHaveLength(2);
  });

  it('pushes to a real (bare) remote', async () => {
    const { dir, git, g } = await repo();
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-remote-'));
    await runCommand('git', ['init', '-q', '--bare', remote]);
    await g('remote', 'add', 'origin', remote);
    const base = await git.baseline();
    await git.ensureBranch('ao/push-test');
    fs.writeFileSync(path.join(dir, 'p.txt'), 'p');
    const r = await git.applyPolicy({ policy: 'COMMIT_AND_PUSH', baseline: base, branch: 'ao/push-test', message: 'm', prTitle: '', prBody: '' });
    expect(r.pushed).toBe(true);
    const remoteHead = (await runCommand('git', ['rev-parse', 'refs/heads/ao/push-test'], { cwd: remote })).stdout.trim();
    expect(remoteHead).toBe(r.commit);
  });

  it('rejects unsafe branch names', async () => {
    const { git } = await repo();
    await expect(git.ensureBranch('../evil')).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
    await expect(git.ensureBranch('a;rm -rf')).rejects.toMatchObject({ code: 'UNSAFE_ARGUMENT' });
  });
});

describe('pull and merge requests through the REST API (GIT-004)', () => {
  it('parses https, ssh and scp-style remotes', async () => {
    const { parseRemote } = await import('./index.js');
    expect(parseRemote('https://github.com/acme/site.git')).toEqual({ host: 'github.com', path: 'acme/site' });
    expect(parseRemote('git@github.com:acme/site.git')).toEqual({ host: 'github.com', path: 'acme/site' });
    expect(parseRemote('ssh://git@gitlab.example.com:2222/group/sub/app.git')).toEqual({ host: 'gitlab.example.com:2222', path: 'group/sub/app' });
    expect(parseRemote('https://user:pw@gitlab.com/group/app')).toEqual({ host: 'gitlab.com', path: 'group/app' });
    expect(parseRemote('/local/path/repo.git')).toBeNull();
  });

  it('commit → push → pull request with the host token; GitLab merge requests; errors are reported, not thrown', async () => {
    const http = await import('node:http');
    const requests: Array<{ url: string; headers: Record<string, unknown>; body: any }> = [];
    let refuse = false;
    const api = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        requests.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) });
        if (refuse) return void res.writeHead(422, { 'content-type': 'application/json' }).end('{"message":"Validation Failed","errors":[{"message":"A pull request already exists"}]}');
        const gl = req.url!.includes('/merge_requests');
        res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(gl ? { web_url: 'https://gitlab.example.com/group/app/-/merge_requests/4' } : { html_url: 'https://github.com/acme/site/pull/9' }));
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
    try {
      for (const [remoteUrl, kind] of [['https://github.com/acme/site.git', 'github'], ['git@gitlab.example.com:group/app.git', 'gitlab']] as const) {
        const { dir } = await repo();
        const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-pr-remote-'));
        await runCommand('git', ['init', '-q', '--bare', bare]);
        // The remote looks like GitHub/GitLab; pushes go to the local bare repository.
        await runCommand('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir });
        await runCommand('git', ['config', `url.${bare.split(path.sep).join('/')}.insteadOf`, remoteUrl], { cwd: dir });
        const hosts: string[] = [];
        const g = new GitManager(dir, {
          hosting: async (host) => (hosts.push(host), { kind, apiBaseUrl: apiUrl, token: `${kind}-token` }),
        });
        const base = await g.baseline();
        await g.ensureBranch('ao/feature');
        fs.writeFileSync(path.join(dir, 'feature.txt'), 'x');
        const r = await g.applyPolicy({ policy: 'PULL_REQUEST', baseline: base, branch: 'ao/feature', message: 'Add feature', prTitle: 'Add feature\nwith newline', prBody: 'Report' });
        expect(r.blocked).toEqual([]);
        expect(r.pushed).toBe(true);
        expect((await runCommand('git', ['branch', '--list', 'ao/feature'], { cwd: bare })).stdout).toContain('ao/feature');
        const last = requests.at(-1)!;
        if (kind === 'github') {
          expect(hosts).toEqual(['github.com']);
          expect(r.pullRequestUrl).toBe('https://github.com/acme/site/pull/9');
          expect(last).toMatchObject({ url: '/repos/acme/site/pulls', headers: { authorization: 'Bearer github-token' }, body: { title: 'Add feature with newline', head: 'ao/feature', base: 'main', body: 'Report' } });
        } else {
          expect(hosts).toEqual(['gitlab.example.com']);
          expect(r.pullRequestUrl).toBe('https://gitlab.example.com/group/app/-/merge_requests/4');
          expect(last).toMatchObject({ url: '/api/v4/projects/group%2Fapp/merge_requests', headers: { 'private-token': 'gitlab-token' }, body: { source_branch: 'ao/feature', target_branch: 'main', description: 'Report' } });
        }
      }
      // A refusal is reported in the result; the commit and push still stand.
      refuse = true;
      const { dir } = await repo();
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-pr-remote-'));
      await runCommand('git', ['init', '-q', '--bare', bare]);
      await runCommand('git', ['remote', 'add', 'origin', 'https://github.com/acme/site.git'], { cwd: dir });
      await runCommand('git', ['config', `url.${bare.split(path.sep).join('/')}.insteadOf`, 'https://github.com/acme/site.git'], { cwd: dir });
      const g = new GitManager(dir, { hosting: async () => ({ kind: 'github', apiBaseUrl: apiUrl, token: 't' }) });
      const base = await g.baseline();
      await g.ensureBranch('ao/again');
      fs.writeFileSync(path.join(dir, 'again.txt'), 'x');
      const r = await g.applyPolicy({ policy: 'PULL_REQUEST', baseline: base, branch: 'ao/again', message: 'Again', prTitle: 'Again', prBody: '' });
      expect(r.pushed).toBe(true);
      expect(r.pullRequestUrl).toBeNull();
      expect(r.blocked[0]).toMatch(/GitHub refused the pull request \(HTTP 422: Validation Failed; A pull request already exists\)/);
    } finally {
      api.close();
    }
  });
});

describe('token credentials for pushes (GitHub App)', () => {
  it('passes the token as an HTTP header through the environment, never on the command line or in the repository', async () => {
    const { tokenAuthEnv } = await import('./index.js');
    const env = tokenAuthEnv('github.com', 'ghs_secret');
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_secret').toString('base64')}`,
    });
    // Git reads it as configuration for that host only.
    const r = await runCommand('git', ['config', '--get', 'http.https://github.com/.extraheader'], { env: { ...process.env, ...env } });
    expect(r.stdout.trim()).toBe(env.GIT_CONFIG_VALUE_0);
  });
});
