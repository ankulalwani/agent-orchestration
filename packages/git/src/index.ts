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

/** One CI check of a commit. `log`: the end of a failed check's log, or its annotations, when asked for. */
export interface CiCheck {
  name: string;
  state: 'pending' | 'success' | 'failure' | 'skipped';
  url: string | null;
  summary: string | null;
  log: string | null;
}
/** `none`: the host reports no checks for the commit (yet). */
export interface CiStatus {
  state: 'none' | 'pending' | 'success' | 'failure';
  checks: CiCheck[];
}
/** A pull/merge request as its host sees it. `blocked`: why the host would not merge it now (null: nothing known against it). */
export interface PullRequestState {
  number: number;
  open: boolean;
  merged: boolean;
  draft: boolean;
  headSha: string | null;
  blocked: string | null;
}
export type MergeMethod = 'merge' | 'squash' | 'rebase';
/** `merged: false`: the host refused, with its reason. */
export interface MergeResult {
  merged: boolean;
  method: MergeMethod;
  commit: string | null;
  reason: string | null;
}
/** The number of a pull request (GitHub) or merge request (GitLab) from its URL. */
export function pullRequestNumber(url: string): number | null {
  const m = /\/(?:pull|merge_requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  return m ? Number(m[1]) : null;
}
/** Characters kept from the end of a failed check's log. */
const CI_LOG_TAIL = 6000;

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

/** A branch or ref name that is safe as a Git argument: no option look-alikes, no ranges, no refspec characters. */
const safeRef = (name: string) => /^[A-Za-z0-9._/-]{1,200}$/.test(name) && !name.includes('..') && !name.startsWith('-');

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
  async ensureBranch(name: string, o: { /** A branch that exists on origin (a follow-up): get it, and what was pushed to it since. */ fromRemote?: boolean } = {}) {
    if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.includes('..')) throw new AppError('UNSAFE_ARGUMENT', 'Invalid branch name');
    const has = async () => (await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true })).exitCode === 0;
    const tracking = `refs/remotes/origin/${name}`;
    let fetched = false;
    if (o.fromRemote) {
      const url = (await this.run(['remote', 'get-url', 'origin'], { allowFail: true })).stdout.trim();
      const host = url ? parseRemote(url)?.host : null;
      const env = host && this.opts.pushAuth ? ((await this.opts.pushAuth(host).catch(() => null)) ?? undefined) : undefined;
      // Best effort: without a remote, or without access, the local branch (or a new one) is used.
      fetched = Boolean(url) && (await this.run(['fetch', '--quiet', 'origin', `refs/heads/${name}:${tracking}`], { allowFail: true, timeoutMs: 300_000, env })).exitCode === 0;
      if (fetched && !(await has())) await this.run(['branch', '--quiet', name, tracking], { allowFail: true });
    }
    const current = await this.currentBranch();
    if (current !== name) await this.run((await has()) ? ['switch', name] : ['switch', '-c', name]);
    // Commits others pushed to the branch, when they follow ours (never a merge commit, never a reset).
    if (fetched) await this.run(['merge', '--ff-only', '--quiet', tracking], { allowFail: true });
  }

  /** Git environment with the credentials for a remote URL's host, when the worker has some of its own for it. */
  private async authEnv(url: string): Promise<Record<string, string> | undefined> {
    const host = url ? parseRemote(url)?.host : null;
    return host && this.opts.pushAuth ? ((await this.opts.pushAuth(host).catch(() => null)) ?? undefined) : undefined;
  }

  private async originUrl() {
    return (await this.run(['remote', 'get-url', 'origin'], { allowFail: true })).stdout.trim();
  }

  /**
   * Create (or switch to) a local branch for a ref that origin publishes without a branch of ours, e.g.
   * `pull/12/head` for a pull request from a fork. An existing branch only moves forward.
   */
  async ensureBranchFromRef(name: string, ref: string) {
    // Both names can come from a pull request, which anyone may open.
    if (!safeRef(name)) throw new AppError('UNSAFE_ARGUMENT', 'Invalid branch name');
    if (!safeRef(ref)) throw new AppError('UNSAFE_ARGUMENT', 'Invalid ref');
    const url = await this.originUrl();
    await this.run(['fetch', '--quiet', 'origin', ref], { timeoutMs: 300_000, env: await this.authEnv(url) });
    const fetched = (await this.run(['rev-parse', 'FETCH_HEAD^{commit}'])).stdout.trim();
    const has = (await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true })).exitCode === 0;
    if (!has) await this.run(['branch', '--quiet', name, fetched]);
    if ((await this.currentBranch()) !== name) await this.run(['switch', name]);
    if (has) await this.run(['merge', '--ff-only', '--quiet', fetched], { allowFail: true });
  }

  /** Files with unresolved conflicts of a merge that is in progress. */
  async conflicts(): Promise<string[]> {
    return (await this.run(['diff', '--name-only', '--diff-filter=U', '-z'], { allowFail: true })).stdout.split('\0').filter(Boolean);
  }

  async mergeInProgress() {
    return (await this.run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { allowFail: true })).exitCode === 0;
  }

  /**
   * Brings the current branch up to date with origin's `base` by merging it (never a rebase: the branch's
   * history is other people's). `conflicts`: the merge is left in progress with conflict markers in the
   * listed files; committing all of them concludes it.
   */
  async updateFromBase(base: string): Promise<{ state: 'up_to_date' | 'merged' | 'conflicts'; conflicts: string[] }> {
    if (!safeRef(base)) throw new AppError('UNSAFE_ARGUMENT', 'Invalid branch name');
    if (await this.mergeInProgress()) return { state: 'conflicts', conflicts: await this.conflicts() };
    const tracking = `refs/remotes/origin/${base}`;
    await this.run(['fetch', '--quiet', 'origin', `refs/heads/${base}:${tracking}`], { timeoutMs: 300_000, env: await this.authEnv(await this.originUrl()) });
    if ((await this.run(['merge-base', '--is-ancestor', tracking, 'HEAD'], { allowFail: true })).exitCode === 0) return { state: 'up_to_date', conflicts: [] };
    const ident = [...(this.opts.authorName ? ['-c', `user.name=${this.opts.authorName}`] : []), ...(this.opts.authorEmail ? ['-c', `user.email=${this.opts.authorEmail}`] : [])];
    const r = await this.run([...ident, 'merge', '--no-edit', '--no-ff', '-m', `Merge ${base} into ${(await this.currentBranch()) ?? 'the branch'}`, tracking], { allowFail: true, timeoutMs: 300_000 });
    if (r.exitCode === 0) return { state: 'merged', conflicts: [] };
    const conflicts = await this.conflicts();
    // Not a conflict (e.g. local changes in the way): nothing was merged, and the caller is told why.
    if (!conflicts.length) throw new AppError('INTERNAL', `git merge failed: ${(r.stderr.trim() || r.stdout.trim()).slice(0, 500)}`);
    return { state: 'conflicts', conflicts };
  }

  /** Those of `files` that still contain conflict markers. */
  async withConflictMarkers(files: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const f of files) {
      const text = await fs.readFile(path.resolve(this.cwd, f), 'utf8').catch(() => '');
      if (/^<{7} /m.test(text) && /^>{7} /m.test(text)) out.push(f);
    }
    return out;
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

  async push(branch: string, remote = 'origin', to?: { /** Another repository (a fork), by URL. */ url: string; branch: string }) {
    if (to) {
      if (!safeRef(to.branch)) throw new AppError('UNSAFE_ARGUMENT', 'Invalid branch name');
      if (!parseRemote(to.url)) throw new AppError('UNSAFE_ARGUMENT', 'Invalid repository URL');
      await this.run(['push', to.url, `refs/heads/${branch}:refs/heads/${to.branch}`], { timeoutMs: 300_000, env: await this.authEnv(to.url) });
      return;
    }
    const url = (await this.run(['remote', 'get-url', remote], { allowFail: true })).stdout.trim();
    await this.run(['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 300_000, env: await this.authEnv(url) });
  }

  private async hostingFor() {
    const remoteUrl = (await this.run(['config', '--get', 'remote.origin.url'], { allowFail: true })).stdout.trim();
    const remote = remoteUrl ? parseRemote(remoteUrl) : null;
    const account = remote && this.opts.hosting ? await this.opts.hosting(remote.host) : null;
    return remote && account ? { remote, account } : null;
  }

  /**
   * A pull/merge request of origin's repository, as its host sees it. Null when the worker has no account
   * for the host. GitHub computes mergeability in the background: it is asked again a few times.
   */
  async pullRequestState(number: number, o: { waitMs?: number } = {}): Promise<PullRequestState | null> {
    const h = await this.hostingFor();
    if (!h) return null;
    const f = this.opts.fetchImpl ?? fetch;
    const api = h.account.apiBaseUrl.replace(/\/+$/, '');
    const github = h.account.kind === 'github';
    const headers: Record<string, string> = github ? { authorization: `Bearer ${h.account.token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-orchestration' } : { 'private-token': h.account.token };
    const get = async (url: string) => {
      const res = await f(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new AppError('UPSTREAM_ERROR', `${github ? 'GitHub' : 'GitLab'} did not return ${github ? 'pull' : 'merge'} request ${number} (HTTP ${res.status})`);
      return (await res.json()) as Record<string, any>;
    };
    const wait = o.waitMs ?? 3000;
    if (github) {
      const repo = `${api}/repos/${h.remote.path}`;
      let pr = await get(`${repo}/pulls/${number}`);
      for (let i = 0; i < 5 && pr.state === 'open' && !pr.merged && pr.mergeable === null; i++) {
        await new Promise((r) => setTimeout(r, wait));
        pr = await get(`${repo}/pulls/${number}`);
      }
      let blocked: string | null = null;
      if (pr.draft) blocked = 'it is a draft';
      else if (pr.mergeable === false || pr.mergeable_state === 'dirty') blocked = `it conflicts with ${pr.base?.ref ?? 'the base branch'}`;
      else if (pr.mergeable_state === 'blocked') blocked = 'branch protection blocks it (a required review or check is missing)';
      else if (pr.mergeable_state === 'behind') blocked = `its branch must be up to date with ${pr.base?.ref ?? 'the base branch'}`;
      else if (pr.mergeable === null) blocked = 'GitHub has not decided yet whether it can be merged';
      if (!blocked && pr.state === 'open') {
        // Someone asked for changes and has not looked again: not ours to overrule, whatever the branch rules say.
        const reviews = (await get(`${repo}/pulls/${number}/reviews?per_page=100`).catch(() => [])) as unknown as Array<Record<string, any>>;
        const latest = new Map<string, string>();
        for (const r of Array.isArray(reviews) ? reviews : []) if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(String(r.user?.login), r.state);
        const asking = [...latest].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([u]) => u);
        if (asking.length) blocked = `${asking.join(', ')} requested changes`;
      }
      return { number, open: pr.state === 'open', merged: Boolean(pr.merged), draft: Boolean(pr.draft), headSha: pr.head?.sha ?? null, blocked };
    }
    const project = `${api}/api/v4/projects/${encodeURIComponent(h.remote.path)}`;
    let mr = await get(`${project}/merge_requests/${number}`);
    const checking = (m: Record<string, any>) => ['checking', 'unchecked', 'preparing'].includes(m.detailed_merge_status ?? m.merge_status);
    for (let i = 0; i < 5 && mr.state === 'opened' && checking(mr); i++) {
      await new Promise((r) => setTimeout(r, wait));
      mr = await get(`${project}/merge_requests/${number}`);
    }
    const detail = String(mr.detailed_merge_status ?? '');
    const reasons: Record<string, string> = {
      conflict: `it conflicts with ${mr.target_branch ?? 'the target branch'}`,
      need_rebase: `its branch must be rebased on ${mr.target_branch ?? 'the target branch'}`,
      not_approved: 'a required approval is missing',
      discussions_not_resolved: 'there are unresolved discussions',
      ci_must_pass: 'its pipeline must pass',
      ci_still_running: 'its pipeline is still running',
      draft_status: 'it is a draft',
      requested_changes: 'a reviewer requested changes',
      blocked_status: 'it is blocked by another merge request',
      external_status_checks: 'an external status check must pass',
      not_open: 'it is not open',
    };
    let blocked: string | null = null;
    if (mr.draft || mr.work_in_progress) blocked = 'it is a draft';
    else if (mr.has_conflicts || mr.merge_status === 'cannot_be_merged') blocked = reasons.conflict!;
    else if (detail && detail !== 'mergeable' && !checking(mr)) blocked = reasons[detail] ?? `GitLab reports "${detail}"`;
    else if (checking(mr)) blocked = 'GitLab has not decided yet whether it can be merged';
    return { number, open: mr.state === 'opened', merged: mr.state === 'merged', draft: Boolean(mr.draft || mr.work_in_progress), headSha: mr.sha ?? null, blocked };
  }

  /**
   * Merges a pull/merge request through the host, only at `sha` (the head that was verified). A method
   * the repository does not allow is replaced by one it allows. A refusal is a result, not an error.
   */
  async mergePullRequest(number: number, o: { method: MergeMethod; sha: string | null }): Promise<MergeResult> {
    const h = await this.hostingFor();
    if (!h) return { merged: false, method: o.method, commit: null, reason: 'this worker has no Git hosting token for the repository’s host' };
    const f = this.opts.fetchImpl ?? fetch;
    const api = h.account.apiBaseUrl.replace(/\/+$/, '');
    if (h.account.kind === 'github') {
      const headers = { authorization: `Bearer ${h.account.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'agent-orchestration' };
      let reason: string | null = null;
      for (const method of [o.method, ...(['squash', 'merge', 'rebase'] as const).filter((m) => m !== o.method)]) {
        const res = await f(`${api}/repos/${h.remote.path}/pulls/${number}/merge`, { method: 'PUT', headers, body: JSON.stringify({ merge_method: method, ...(o.sha ? { sha: o.sha } : {}) }), signal: AbortSignal.timeout(60_000) });
        const data = (await res.json().catch(() => ({}))) as { merged?: boolean; sha?: string; message?: string };
        if (res.ok && data.merged) return { merged: true, method, commit: data.sha ?? null, reason: null };
        reason = `${data.message ?? 'GitHub refused the merge'} (HTTP ${res.status})`;
        // Only "this repository does not allow that method" is worth another method.
        if (!(res.status === 405 && /not allowed|not enabled/i.test(data.message ?? ''))) break;
      }
      return { merged: false, method: o.method, commit: null, reason };
    }
    const res = await f(`${api}/api/v4/projects/${encodeURIComponent(h.remote.path)}/merge_requests/${number}/merge`, {
      method: 'PUT',
      headers: { 'private-token': h.account.token, 'content-type': 'application/json' },
      // How a merge request is merged (merge commit, fast-forward) is the project's setting; squashing is ours to ask for.
      body: JSON.stringify({ squash: o.method === 'squash', ...(o.sha ? { sha: o.sha } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json().catch(() => ({}))) as { state?: string; merge_commit_sha?: string; squash_commit_sha?: string; sha?: string; message?: string | object };
    if (res.ok && data.state === 'merged') return { merged: true, method: o.method, commit: data.merge_commit_sha ?? data.squash_commit_sha ?? data.sha ?? null, reason: null };
    const message = typeof data.message === 'string' ? data.message : data.message ? JSON.stringify(data.message) : 'GitLab refused the merge';
    return { merged: false, method: o.method, commit: null, reason: `${res.status === 409 ? 'the branch changed after it was verified' : message} (HTTP ${res.status})` };
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

  /**
   * The CI checks of a commit on the remote's host: GitHub check runs and commit statuses, or GitLab
   * pipeline jobs and statuses. Null when the worker has no account for the host (nothing can be read).
   * With `logs`, a failed check also carries the end of its log (GitHub Actions, GitLab CI) or its
   * annotations, for the agent to act on.
   */
  async ciStatus(sha: string, o: { logs?: boolean } = {}): Promise<CiStatus | null> {
    const remoteUrl = (await this.run(['config', '--get', 'remote.origin.url'], { allowFail: true })).stdout.trim();
    const remote = remoteUrl ? parseRemote(remoteUrl) : null;
    const account = remote && this.opts.hosting ? await this.opts.hosting(remote.host) : null;
    if (!remote || !account) return null;
    const f = this.opts.fetchImpl ?? fetch;
    const api = account.apiBaseUrl.replace(/\/+$/, '');
    const github = account.kind === 'github';
    const headers: Record<string, string> = github ? { authorization: `Bearer ${account.token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-orchestration' } : { 'private-token': account.token };
    const get = async (url: string) => {
      const res = await f(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new AppError('UPSTREAM_ERROR', `${github ? 'GitHub' : 'GitLab'} did not return the checks of ${sha.slice(0, 7)} (HTTP ${res.status})`);
      return res;
    };
    const tail = async (url: string) => {
      try {
        const res = await f(url, { headers, signal: AbortSignal.timeout(30_000) });
        return res.ok ? (await res.text()).slice(-CI_LOG_TAIL).trim() || null : null;
      } catch {
        return null; // the log is a help, not a requirement
      }
    };
    const checks: CiCheck[] = [];
    if (github) {
      const repo = `${api}/repos/${remote.path}`;
      const runs = ((await (await get(`${repo}/commits/${sha}/check-runs?per_page=100`)).json()) as { check_runs?: Array<Record<string, any>> }).check_runs ?? [];
      for (const r of runs) {
        const state: CiCheck['state'] = r.status !== 'completed' ? 'pending' : ['success', 'neutral'].includes(r.conclusion) ? 'success' : r.conclusion === 'skipped' ? 'skipped' : 'failure';
        const check: CiCheck = { name: String(r.name), state, url: r.html_url ?? null, summary: [r.output?.title, r.output?.summary].filter(Boolean).join(': ').slice(0, 2000) || null, log: null };
        if (state === 'failure' && o.logs) {
          check.log = r.app?.slug === 'github-actions' ? await tail(`${repo}/actions/jobs/${r.id}/logs`) : null;
          if (!check.log) {
            const annotations = await f(`${repo}/check-runs/${r.id}/annotations?per_page=30`, { headers, signal: AbortSignal.timeout(30_000) })
              .then((res) => (res.ok ? (res.json() as Promise<Array<Record<string, any>>>) : []))
              .catch(() => []);
            check.log = annotations.map((a) => `${a.path}:${a.start_line} ${a.annotation_level}: ${a.message}`).join('\n').slice(0, CI_LOG_TAIL) || null;
          }
        }
        checks.push(check);
      }
      const statuses = ((await (await get(`${repo}/commits/${sha}/status`)).json()) as { statuses?: Array<Record<string, any>> }).statuses ?? [];
      for (const st of statuses) checks.push({ name: String(st.context), state: st.state === 'success' ? 'success' : st.state === 'pending' ? 'pending' : 'failure', url: st.target_url ?? null, summary: st.description ?? null, log: null });
    } else {
      const project = `${api}/api/v4/projects/${encodeURIComponent(remote.path)}`;
      const statuses = (await (await get(`${project}/repository/commits/${sha}/statuses?per_page=100`)).json()) as Array<Record<string, any>>;
      for (const st of statuses) {
        const failed = ['failed', 'canceled'].includes(st.status);
        const state: CiCheck['state'] = st.status === 'success' ? 'success' : ['skipped', 'manual'].includes(st.status) || (failed && st.allow_failure) ? 'skipped' : failed ? 'failure' : 'pending';
        checks.push({ name: String(st.name), state, url: st.target_url ?? null, summary: st.description ?? null, log: state === 'failure' && o.logs ? await tail(`${project}/jobs/${st.id}/trace`) : null });
      }
    }
    const state = !checks.length ? 'none' : checks.some((c) => c.state === 'pending') ? 'pending' : checks.some((c) => c.state === 'failure') ? 'failure' : 'success';
    return { state, checks };
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
  async applyPolicy(input: { policy: GitPolicy; baseline: Baseline; branch: string | null; message: string; prTitle: string; prBody: string; requirePushApproval?: boolean; pushApproved?: boolean; /** The pull request an earlier commit of this task opened: later commits join it. */ existingPullRequestUrl?: string | null; /** Commits made outside this call (a merge of the base branch) are pushed even without new changes. */ pushHead?: boolean; /** Push to a fork's branch instead of origin. */ pushTo?: { url: string; branch: string } | null; /** The branch a new pull request targets (default: the branch the task started from). */ prBase?: string | null }): Promise<CommitResult> {
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
    if (input.policy === 'NONE' || (!include.length && !input.pushHead)) return result;
    result.commit = include.length ? await this.commit(input.message, include.map((f) => f.path)) : await this.head();
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
      await this.push(result.branch, 'origin', input.pushTo ?? undefined);
      result.pushed = true;
    } catch (e) {
      result.blocked.push(`Push failed: ${(e as Error).message}`);
      return result;
    }
    if (input.policy === 'PULL_REQUEST' && input.existingPullRequestUrl) result.pullRequestUrl = input.existingPullRequestUrl;
    else if (input.policy === 'PULL_REQUEST') {
      try {
        result.pullRequestUrl = await this.createPullRequest(input.prTitle, input.prBody, input.prBase ?? input.baseline.branch, result.branch);
      } catch (e) {
        result.blocked.push(`Pull request not created: ${(e as Error).message}. Add a GitHub/GitLab token for this host in the worker (Git hosting), or install and sign in to the GitHub CLI (gh).`);
      }
    }
    return result;
  }
}
