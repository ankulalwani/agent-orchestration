import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, runCommand } from '@ao/core';
import type { DiscoveredRepositoryReport } from '@ao/contracts';

const log = createLogger('discovery');

/**
 * Folders never scanned: operating system, program, package-manager and build folders, which hold no
 * user repositories (or only copies of other repositories) and would make a scan slow.
 */
const SKIP_NAMES = new Set(
  [
    'node_modules', 'bower_components', '.pnpm-store', '.npm', '.yarn', '.cache', '.gradle', '.m2', '.nuget', '.cargo', '.rustup', '.pub-cache',
    '.venv', 'venv', '__pycache__', 'site-packages', '.tox', '.mypy_cache', '.pytest_cache', '.next', '.nuxt', '.turbo', '.parcel-cache',
    'dist', 'build', 'target', 'out', 'vendor', 'Pods', 'DerivedData', '.vscode', '.vscode-server', '.vscode-test', '.cursor', '.idea',
    '.agent-orchestrator', '.Trash', '.Trashes', '$Recycle.Bin', 'System Volume Information', 'Recovery', 'PerfLogs', 'Config.Msi',
    'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'AppData', 'MSOCache', 'Intel', 'AMD', 'NVIDIA',
  ].map((n) => n.toLowerCase()),
);
/** Top-level folders of Unix-like systems that hold no user repositories. */
const SKIP_UNIX_ROOTS = ['/proc', '/sys', '/dev', '/run', '/boot', '/snap', '/usr', '/lib', '/lib32', '/lib64', '/libx32', '/bin', '/sbin', '/etc', '/var/lib', '/var/cache', '/var/log', '/tmp', '/lost+found', '/nix', '/System', '/Library', '/private', '/Applications', '/Volumes', '/cores', '/Network'];

export interface ScanOptions {
  roots: string[];
  exclude?: string[];
  maxDepth?: number;
  /** Stop after visiting this many folders (a safety net on huge disks). */
  maxDirectories?: number;
  signal?: AbortSignal;
}

export interface ScanResult {
  scannedAt: string;
  roots: string[];
  durationMs: number;
  directories: number;
  truncated: boolean;
  repos: DiscoveredRepositoryReport[];
}

/** Every fixed (local, non-removable) drive; on macOS and Linux the file system root. */
export async function defaultRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/'];
  const r = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $_.DeviceID }'], { timeoutMs: 20_000 }).catch(() => null);
  const drives = (r?.exitCode === 0 ? r.stdout : '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Z]:$/i.test(s));
  if (drives.length) return drives.map((d) => `${d.toUpperCase()}\\`);
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((l) => `${l}:\\`).filter((d) => fs.existsSync(d));
}

/** Finds Git repositories below the roots. A repository's own folders are not searched further. */
export async function scanForRepositories(opts: ScanOptions): Promise<ScanResult> {
  const t0 = Date.now();
  const maxDepth = opts.maxDepth ?? 8;
  const maxDirectories = opts.maxDirectories ?? 2_000_000;
  const excludeNames = new Set((opts.exclude ?? []).filter((e) => !path.isAbsolute(e)).map((e) => e.toLowerCase()));
  const excludePaths = [
    ...(opts.exclude ?? []).filter((e) => path.isAbsolute(e)),
    ...(process.platform === 'win32' ? [] : SKIP_UNIX_ROOTS),
    ...(process.platform === 'darwin' ? [path.join(os.homedir(), 'Library')] : []),
  ].map(norm);
  const found: string[] = [];
  let directories = 0;
  let truncated = false;
  const queue: Array<{ dir: string; depth: number }> = opts.roots.map((r) => ({ dir: path.resolve(r), depth: 0 }));

  const visit = async ({ dir, depth }: { dir: string; depth: number }) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // no permission, vanished, not a folder
    }
    if (entries.some((e) => e.name === '.git' && (e.isDirectory() || e.isFile()))) {
      found.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      // Links and junctions are skipped: they lead to folders scanned elsewhere, or into loops.
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const lower = e.name.toLowerCase();
      if (SKIP_NAMES.has(lower) || excludeNames.has(lower)) continue;
      const child = path.join(dir, e.name);
      if (excludePaths.some((x) => norm(child) === x)) continue;
      queue.push({ dir: child, depth: depth + 1 });
    }
  };

  // Breadth-first with a few folders read at once.
  while (queue.length && !opts.signal?.aborted) {
    if (directories >= maxDirectories) {
      truncated = true;
      break;
    }
    const batch = queue.splice(0, 32);
    directories += batch.length;
    await Promise.all(batch.map(visit));
  }

  const repos: DiscoveredRepositoryReport[] = [];
  for (let i = 0; i < found.length && !opts.signal?.aborted; i += 4) {
    repos.push(...(await Promise.all(found.slice(i, i + 4).map(describeRepository))).filter((r): r is DiscoveredRepositoryReport => r !== null));
  }
  const result = { scannedAt: new Date().toISOString(), roots: opts.roots, durationMs: Date.now() - t0, directories, truncated: truncated || Boolean(opts.signal?.aborted), repos };
  log.info({ roots: opts.roots, repositories: repos.length, directories, durationMs: result.durationMs, truncated: result.truncated }, 'repository scan finished');
  return result;
}

/** Remotes, root commit and branch of a repository; null when Git can't read it. */
export async function describeRepository(dir: string): Promise<DiscoveredRepositoryReport | null> {
  const git = (...args: string[]) => runCommand('git', ['-C', dir, ...args], { timeoutMs: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).catch(() => null);
  const inside = await git('rev-parse', '--is-inside-work-tree');
  if (inside?.exitCode !== 0 || inside.stdout.trim() !== 'true') return null;
  const [remotes, roots, branch] = await Promise.all([git('config', '--get-regexp', '^remote\\..*\\.url$'), git('rev-list', '--max-parents=0', 'HEAD'), git('symbolic-ref', '--quiet', '--short', 'HEAD')]);
  const remoteList = (remotes?.exitCode === 0 ? remotes.stdout : '')
    .split(/\r?\n/)
    .map((l) => /^remote\.(.+)\.url\s+(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ name: m[1]!, url: m[2]!.trim() }))
    .slice(0, 20);
  // A history can have several root commits (merged unrelated histories): the smallest is stable.
  const rootCommit = (roots?.exitCode === 0 ? roots.stdout : '').split(/\s+/).filter((c) => /^[0-9a-f]{40,64}$/.test(c)).sort()[0] ?? null;
  return { localPath: dir, name: path.basename(dir) || dir, remotes: remoteList, rootCommit, branch: branch?.exitCode === 0 ? branch.stdout.trim().slice(0, 250) || null : null };
}

function norm(p: string) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), 'Projects');
