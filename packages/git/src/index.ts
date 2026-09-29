import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError, formatCommand, runCommand, type GitPolicy, type RunResult } from '@ao/core';

/**
 * Git manager (spec §42). All commands are argv arrays (no shell). Destructive operations are
 * refused unless the caller passes an explicit approval, and even then force-push is never
 * performed automatically.
 */

const DESTRUCTIVE: Array<{ test: (a: string[]) => boolean; label: string }> = [
  { test: (a) => a[0] === 'push' && a.some((x) => x === '-f' || x.startsWith('--force') || x.startsWith('+') || /:\+/.test(x) || x === '--mirror' || x === '--delete' || x === '-d'), label: 'force/destructive push' },
  { test: (a) => a[0] === 'reset' && a.includes('--hard'), label: 'reset --hard' },
  { test: (a) => a[0] === 'clean', label: 'clean' },
  { test: (a) => a[0] === 'branch' && a.some((x) => ['-d', '-D', '--delete'].includes(x)), label: 'branch deletion' },
  { test: (a) => a[0] === 'checkout' && (a.includes('--') || a.includes('-f') || a.includes('--force') || a.includes('.')), label: 'checkout discarding changes' },
  { test: (a) => a[0] === 'restore' && !a.includes('--staged'), label: 'restore (discard changes)' },
  { test: (a) => a[0] === 'stash' && ['drop', 'clear'].includes(a[1] ?? ''), label: 'stash drop/clear' },
  { test: (a) => a[0] === 'rebase' || (a[0] === 'commit' && a.includes('--amend')), label: 'history rewrite' },
  { test: (a) => a[0] === 'switch' && (a.includes('--discard-changes') || a.includes('-f') || a.includes('--force')), label: 'switch discarding changes' },
];

export function destructiveReason(args: string[]): string | null {
  return DESTRUCTIVE.find((d) => d.test(args))?.label ?? null;
}

export interface FileChange {
  path: string;
  status: string; // porcelain XY, e.g. " M", "??", "A "
}

export interface Baseline {
  head: string | null;
  branch: string | null;
  /** Pre-existing uncommitted files → content hash at task start. */
  dirty: Record<string, string | null>;
}

export interface CommitResult {
  policy: GitPolicy;
  branch: string | null;
  baseBranch: string | null;
  commit: string | null;
  pushed: boolean;
  pullRequestUrl: string | null;
  filesChanged: FileChange[];
  diffStat: string;
  blocked: string[];
  warnings: string[];
}

/** Where a remote lives: host and repository path, from https, ssh or scp-style URLs. */
export function parseRemote(url: string): { host: string; path: string } | null {
  const trimmed = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp && !trimmed.includes('://')) return { host: scp[1]!.toLowerCase(), path: scp[2]! };
  try {
    const u = new URL(trimmed);
    if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return null;
    const p = u.pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
    return p ? { host: u.host.toLowerCase(), path: p } : null;
  } catch {
    return null;
  }
}

/** A Git hosting account the worker can open pull/merge requests with (GIT-004). */
export interface HostingAccount {
  kind: 'github' | 'gitlab';
  /** REST API base, e.g. https://api.github.com, https://github.example.com/api/v3, https://gitlab.com */
  apiBaseUrl: string;
  token: string;
}

/**
 * Git environment that authenticates HTTPS requests to `host` with a token (sent as a header; nothing
 * is written to the repository's configuration). Needs Git 2.31 or newer.
 */
export function tokenAuthEnv(host: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

export class GitManager {
  readonly log: Array<{ command: string; exitCode: number | null; durationMs: number }> = [];

  constructor(
    private cwd: string,
    private opts: {
      authorName?: string;
      authorEmail?: string;
      timeoutMs?: number;
      /** Account for the remote's host, to create pull/merge requests through the REST API. */
      hosting?: (host: string) => Promise<HostingAccount | null>;
      /**
       * Credentials for pushing to the remote's host (e.g. a GitHub App token from the control plane),
       * as environment for Git. Without them, the user's own Git credentials are used.
       */
      pushAuth?: (host: string) => Promise<Record<string, string> | null>;
      fetchImpl?: typeof fetch;
    } = {},
  ) {}

  async run(args: string[], o: { allowDestructive?: boolean; allowFail?: boolean; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
    const reason = destructiveReason(args);
    if (reason && !o.allowDestructive) {
      throw new AppError('GIT_POLICY_VIOLATION', `Refusing destructive Git operation: ${reason}`, { context: { command: formatCommand('git', args) } });
    }
    if (args[0] === 'push' && args.some((x) => x === '-f' || x.startsWith('--force'))) {
      throw new AppError('GIT_POLICY_VIOLATION', 'Force push is never performed automatically');
    }
    const r = await runCommand('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args], {
      cwd: this.cwd,
      timeoutMs: o.timeoutMs ?? this.opts.timeoutMs ?? 120_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: process.env.GIT_ASKPASS ?? '', ...(o.env ?? {}) },
    });
    this.log.push({ command: formatCommand('git', args), exitCode: r.exitCode, durationMs: r.durationMs });
    if (r.exitCode !== 0 && !o.allowFail) {
      throw new AppError('INTERNAL', `git ${args[0]} failed: ${r.stderr.trim().slice(0, 500)}`, { context: { command: formatCommand('git', args) } });
    }
    return r;
  }

  async isRepo() {
    const r = await this.run(['rev-parse', '--is-inside-work-tree'], { allowFail: true });
    return r.exitCode === 0 && r.stdout.trim() === 'true';
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFail: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  async head(): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  async status(): Promise<FileChange[]> {
    const r = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const parts = r.stdout.split('\0').filter(Boolean);
    const out: FileChange[] = [];
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i]!;
      const status = entry.slice(0, 2);
      out.push({ path: entry.slice(3), status });
      if (status[0] === 'R' || status[0] === 'C') i++; // skip rename source
    }
    return out;
  }

  async branches(): Promise<string[]> {
    const r = await this.run(['branch', '--format=%(refname:short)']);
    return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  async diff(paths: string[] = [], opts: { staged?: boolean; stat?: boolean } = {}): Promise<string> {
    const args = ['diff', ...(opts.staged ? ['--cached'] : []), ...(opts.stat ? ['--stat'] : []), '--', ...paths];
    return (await this.run(args)).stdout;
  }

  // ── Reviews (FUT-003): a detached worktree at the reviewed commit, never the user's checkout ──
  /**
   * Commit for a ref. `fetch` (e.g. `pull/12/head`) is fetched from origin first and its FETCH_HEAD
   * used; otherwise origin's copy of the branch is preferred when there is a remote.
   */
  async resolveCommit(ref: string, fetch?: string | null): Promise<string> {
    if (fetch) {
      await this.run(['fetch', '--quiet', 'origin', fetch]);
      return (await this.run(['rev-parse', 'FETCH_HEAD^{commit}'])).stdout.trim();
    }
    const hasOrigin = (await this.run(['remote'], { allowFail: true })).stdout.split(/\r?\n/).includes('origin');
    if (hasOrigin) {
      await this.run(['fetch', '--quiet', 'origin', ref], { allowFail: true });
      const remote = await this.run(['rev-parse', '--verify', '--quiet', `origin/${ref}^{commit}`], { allowFail: true });
      if (remote.exitCode === 0) return remote.stdout.trim();
    }
    const local = await this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
    if (local.exitCode !== 0) throw new AppError('VALIDATION_FAILED', `Git ref "${ref}" was not found`);
    return local.stdout.trim();
  }

  async addWorktree(dir: string, commit: string) {
    await this.run(['worktree', 'add', '--detach', dir, commit]);
  }

  /** Removes a worktree this manager created (its folder only; branches and commits are untouched). */
  async removeWorktree(dir: string) {
    await this.run(['worktree', 'remove', '--force', dir], { allowFail: true });
    await this.run(['worktree', 'prune'], { allowFail: true });
  }

  /** Changes on `head` since it diverged from `base` (three-dot), limited to `maxBytes`. */
  async diffRange(base: string, head: string, maxBytes = 200_000): Promise<{ diff: string; stat: string; truncated: boolean }> {
    const diff = (await this.run(['diff', '--no-color', '--no-ext-diff', `${base}...${head}`], { timeoutMs: 60_000 })).stdout;
    const stat = (await this.run(['diff', '--stat', `${base}...${head}`])).stdout;
    return { diff: diff.length > maxBytes ? diff.slice(0, maxBytes) : diff, stat, truncated: diff.length > maxBytes };
  }

  private async hashFile(p: string): Promise<string | null> {
    const r = await this.run(['hash-object', '--', p], { allowFail: true });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  /** Keep the orchestration state dir out of Git without touching the project's .gitignore. */
  async excludeStateDir(dir = '.agent-orchestration/') {
    const gitDir = (await this.run(['rev-parse', '--git-dir'])).stdout.trim();
    const file = path.resolve(this.cwd, gitDir, 'info', 'exclude');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const current = await fs.readFile(file, 'utf8').catch(() => '');
    if (!current.split(/\r?\n/).includes(dir)) await fs.appendFile(file, `${current.endsWith('\n') || !current ? '' : '\n'}${dir}\n`);
  }

  /** Snapshot before the agent runs so user work is never swept into a task commit. */
  async baseline(): Promise<Baseline> {
    const dirty: Record<string, string | null> = {};
    for (const f of await this.status()) dirty[f.path] = f.status.includes('D') ? null : await this.hashFile(f.path);
    return { head: await this.head(), branch: await this.currentBranch(), dirty };
  }

  /** Create (or switch to) the task branch. `switch -c` carries uncommitted changes; nothing is discarded. */
  async ensureBranch(name: string) {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes('..')) throw new AppError('UNSAFE_ARGUMENT', 'Invalid branch name');
    const current = await this.currentBranch();
    if (current === name) return;
    const exists = (await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true })).exitCode === 0;
    await this.run(exists ? ['switch', name] : ['switch', '-c', name]);
  }

  /** Files changed by the task: current changes minus untouched pre-existing user changes. */
  async taskChanges(base: Baseline): Promise<{ include: FileChange[]; skipped: FileChange[]; warnings: string[] }> {
    const include: FileChange[] = [];
    const skipped: FileChange[] = [];
    const warnings: string[] = [];
    for (const f of await this.status()) {
      if (f.path.startsWith('.agent-orchestration/')) continue;
      if (f.path in base.dirty) {
        const now = f.status.includes('D') ? null : await this.hashFile(f.path);
        if (now !== base.dirty[f.path]) warnings.push(`${f.path} had uncommitted changes before the task and was modified by the task; left unstaged for review`);
        skipped.push(f);
        continue;
      }
      include.push(f);
    }
    return { include, skipped, warnings };
  }

  async commit(message: string, files: string[]): Promise<string | null> {
    if (!files.length) return null;
    for (let i = 0; i < files.length; i += 100) await this.run(['add', '-A', '--', ...files.slice(i, i + 100)]);
    const ident = [
      ...(this.opts.authorName ? ['-c', `user.name=${this.opts.authorName}`] : []),
      ...(this.opts.authorEmail ? ['-c', `user.email=${this.opts.authorEmail}`] : []),
    ];
    const msgFile = path.join(this.cwd, '.agent-orchestration', 'metadata', `commit-msg-${Date.now()}.txt`);
    await fs.mkdir(path.dirname(msgFile), { recursive: true });
    await fs.writeFile(msgFile, message, 'utf8');
    try {
      // Project commit hooks run normally; they are never skipped.
      await this.run([...ident, 'commit', '--quiet', '-F', msgFile]);
    } finally {
      await fs.rm(msgFile, { force: true });
    }
    return this.head();
  }

  async push(branch: string, remote = 'origin') {
    const url = (await this.run(['remote', 'get-url', remote], { allowFail: true })).stdout.trim();
    const host = url ? parseRemote(url)?.host : null;
    const env = host && this.opts.pushAuth ? await this.opts.pushAuth(host).catch(() => null) : null;
    await this.run(['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 300_000, env: env ?? undefined });
  }

  /**
   * Opens a pull request (GitHub) or merge request (GitLab) for `head` into `base`: through the REST API
   * when the worker has a token for the remote's host, else through the GitHub CLI (gh).
   */
  async createPullRequest(title: string, body: string, base: string | null, head?: string | null): Promise<string | null> {
    const remoteUrl = (await this.run(['config', '--get', 'remote.origin.url'], { allowFail: true })).stdout.trim();
    const remote = remoteUrl ? parseRemote(remoteUrl) : null;
    const account = remote && this.opts.hosting ? await this.opts.hosting(remote.host) : null;
    if (remote && account && head) return this.createPullRequestViaApi(account, remote.path, title, body, base ?? 'main', head);
    return this.createPullRequestWithGh(title, body, base);
  }

  private async createPullRequestViaApi(a: HostingAccount, repoPath: string, title: string, body: string, base: string, head: string): Promise<string> {
    const f = this.opts.fetchImpl ?? fetch;
    const api = a.apiBaseUrl.replace(/\/+$/, '');
    const cleanTitle = title.replace(/[\r\n]+/g, ' ').slice(0, 250);
    const res =
      a.kind === 'github'
        ? await f(`${api}/repos/${repoPath}/pulls`, {
            method: 'POST',
            headers: { authorization: `Bearer ${a.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'agent-orchestration' },
            body: JSON.stringify({ title: cleanTitle, body, head, base }),
            signal: AbortSignal.timeout(30_000),
          })
        : await f(`${api}/api/v4/projects/${encodeURIComponent(repoPath)}/merge_requests`, {
            method: 'POST',
            headers: { 'private-token': a.token, 'content-type': 'application/json' },
            body: JSON.stringify({ title: cleanTitle, description: body, source_branch: head, target_branch: base }),
            signal: AbortSignal.timeout(30_000),
          });
    const data = (await res.json().catch(() => ({}))) as { html_url?: string; web_url?: string; message?: string | string[]; errors?: Array<{ message?: string }> };
    if (!res.ok) {
      const msg = [data.message, ...(data.errors ?? []).map((e) => e.message)].flat().filter(Boolean).join('; ');
      throw new AppError('INTERNAL', `${a.kind === 'github' ? 'GitHub' : 'GitLab'} refused the ${a.kind === 'github' ? 'pull' : 'merge'} request (HTTP ${res.status}${msg ? `: ${msg}` : ''})`);
    }
    return data.html_url ?? data.web_url ?? '';
  }

  /** PR creation through the GitHub CLI integration, when installed and authenticated. */
  private async createPullRequestWithGh(title: string, body: string, base: string | null): Promise<string | null> {
    const bodyFile = path.join(this.cwd, '.agent-orchestration', 'metadata', `pr-body-${Date.now()}.md`);
    await fs.mkdir(path.dirname(bodyFile), { recursive: true });
    await fs.writeFile(bodyFile, body, 'utf8');
    try {
      const r = await runCommand('gh', ['pr', 'create', '--title', title.replace(/[\r\n"]/g, ' '), '--body-file', bodyFile, ...(base ? ['--base', base] : [])], { cwd: this.cwd, timeoutMs: 120_000 });
      if (r.exitCode !== 0) throw new AppError('INTERNAL', `gh pr create failed: ${r.stderr.trim().slice(0, 300)}`);
      return /https?:\/\/\S+/.exec(r.stdout)?.[0] ?? null;
    } finally {
      await fs.rm(bodyFile, { force: true });
    }
  }

  /**
   * Apply the task's Git policy (spec §42). Never discards anything; returns blocked reasons instead
   * of failing the task when an optional step (push/PR) cannot be done.
   */
  async applyPolicy(input: { policy: GitPolicy; baseline: Baseline; branch: string | null; message: string; prTitle: string; prBody: string; requirePushApproval?: boolean; pushApproved?: boolean }): Promise<CommitResult> {
    const { include, warnings } = await this.taskChanges(input.baseline);
    const result: CommitResult = {
      policy: input.policy,
      branch: await this.currentBranch(),
      baseBranch: input.baseline.branch,
      commit: null,
      pushed: false,
      pullRequestUrl: null,
      filesChanged: include,
      diffStat: include.length ? (await this.run(['diff', '--stat', 'HEAD', '--', ...include.filter((f) => f.status !== '??').map((f) => f.path)], { allowFail: true })).stdout.trim() : '',
      blocked: [],
      warnings,
    };
    if (input.policy === 'NONE' || !include.length) return result;
    result.commit = await this.commit(input.message, include.map((f) => f.path));
    if (input.policy === 'COMMIT') return result;
    if (input.requirePushApproval && !input.pushApproved) {
      result.blocked.push('Push requires approval by policy');
      return result;
    }
    if (!result.branch) {
      result.blocked.push('Detached HEAD: cannot push');
      return result;
    }
    const remotes = (await this.run(['remote'])).stdout.split('\n').filter(Boolean);
    if (!remotes.includes('origin')) {
      result.blocked.push('No "origin" remote configured');
      return result;
    }
    try {
      await this.push(result.branch);
      result.pushed = true;
    } catch (e) {
      result.blocked.push(`Push failed: ${(e as Error).message}`);
      return result;
    }
    if (input.policy === 'PULL_REQUEST') {
      try {
        result.pullRequestUrl = await this.createPullRequest(input.prTitle, input.prBody, input.baseline.branch, result.branch);
      } catch (e) {
        result.blocked.push(`Pull request not created: ${(e as Error).message}. Add a GitHub/GitLab token for this host in the worker (Git hosting), or install and sign in to the GitHub CLI (gh).`);
      }
    }
    return result;
  }
}
