import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Invocation } from './types.js';

/**
 * OS-level sandbox for agent processes (SEC-014). The agent keeps read access to the machine (it needs
 * compilers, package managers and the project's dependencies) but can write only to the project,
 * temporary folders and its own state folders, and cannot read credential folders such as ~/.ssh or
 * the worker's own data (which holds its credentials when no OS keyring is available).
 *
 * - Linux: bubblewrap (`bwrap`), user namespaces. `network: false` also removes network access.
 * - macOS: `sandbox-exec` with a generated Seatbelt profile.
 * - Windows: no built-in equivalent that works without administrator rights; reported as unavailable.
 */
export interface SandboxSpec {
  projectDir: string;
  /** Extra writable paths (existing paths only are used). */
  writable: string[];
  /** Paths the agent must not read (existing paths only are used). */
  hidden: string[];
  network: boolean;
}

export type SandboxBackendName = 'bubblewrap' | 'sandbox-exec';
export interface SandboxAvailability {
  backend: SandboxBackendName | null;
  executable: string | null;
  reason: string | null;
}

/** State folders agents write to (relative to the home folder). */
const AGENT_STATE: Record<string, string[]> = {
  'claude-code': ['.claude', '.claude.json', '.claude.json.backup', '.config/claude'],
  codex: ['.codex'],
  'gemini-cli': ['.gemini'],
  opencode: ['.config/opencode', '.local/share/opencode', '.local/state/opencode', '.cache/opencode'],
  aider: ['.aider', '.aider.chat.history.md', '.aider.input.history'],
};
const COMMON_STATE = ['.cache', '.npm', '.local/share/pnpm', '.bun', '.cargo/registry', 'go/pkg/mod'];
/** Never readable by agents. Cloud credential files stay readable: Bedrock/Vertex agents may use profiles. */
export const DEFAULT_HIDDEN = ['.ssh', '.gnupg', '.netrc', '.git-credentials', '.docker', '.kube', '.azure', '.password-store'];

function findOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Which sandbox this machine offers. `AO_SANDBOX_BACKEND` and `AO_SANDBOX_EXECUTABLE` override detection
 * (non-standard installs, and tests).
 */
export function detectSandbox(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SandboxAvailability {
  const forced = env.AO_SANDBOX_BACKEND as SandboxBackendName | undefined;
  if (forced === 'bubblewrap' || forced === 'sandbox-exec') {
    const exe = env.AO_SANDBOX_EXECUTABLE ?? (forced === 'bubblewrap' ? findOnPath('bwrap', env) : '/usr/bin/sandbox-exec');
    return exe ? { backend: forced, executable: exe, reason: null } : { backend: null, executable: null, reason: `${forced} was requested but not found` };
  }
  if (platform === 'linux') {
    const exe = findOnPath('bwrap', env);
    return exe ? { backend: 'bubblewrap', executable: exe, reason: null } : { backend: null, executable: null, reason: 'bubblewrap (bwrap) is not installed. Install the "bubblewrap" package.' };
  }
  if (platform === 'darwin') {
    return fs.existsSync('/usr/bin/sandbox-exec') ? { backend: 'sandbox-exec', executable: '/usr/bin/sandbox-exec', reason: null } : { backend: null, executable: null, reason: '/usr/bin/sandbox-exec is missing' };
  }
  return { backend: null, executable: null, reason: `No OS sandbox is available for agents on ${platform}` };
}

/** Writable and hidden paths for one agent, from the home folder and the spec. Only existing paths. */
export function sandboxPaths(agentId: string, spec: SandboxSpec, home = os.homedir(), tmp = os.tmpdir()) {
  const inHome = (rel: string) => path.join(home, rel);
  const existing = (list: string[]) => [...new Set(list.map((p) => path.resolve(p)))].filter((p) => fs.existsSync(p));
  return {
    writable: existing([spec.projectDir, tmp, ...(AGENT_STATE[agentId] ?? []).map(inHome), ...COMMON_STATE.map(inHome), ...spec.writable]),
    hidden: existing([...DEFAULT_HIDDEN.map(inHome), ...spec.hidden]),
  };
}

/** Wraps an agent invocation so it runs inside the sandbox. */
export function wrapInvocation(inv: Invocation, availability: SandboxAvailability, agentId: string, spec: SandboxSpec, home = os.homedir(), tmp = os.tmpdir()): Invocation {
  if (!availability.backend || !availability.executable) throw new Error(availability.reason ?? 'No sandbox available');
  const { writable, hidden } = sandboxPaths(agentId, spec, home, tmp);
  if (availability.backend === 'bubblewrap') {
    const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--unshare-uts', ...(spec.network ? [] : ['--unshare-net']), '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
    for (const w of writable) args.push('--bind', w, w);
    for (const h of hidden) args.push(...(fs.statSync(h).isDirectory() ? ['--tmpfs', h] : ['--ro-bind', '/dev/null', h]));
    args.push('--chdir', spec.projectDir, '--', inv.command, ...inv.args);
    return { ...inv, command: availability.executable, args };
  }
  return { ...inv, command: availability.executable, args: ['-p', seatbeltProfile(writable, hidden, spec.network), inv.command, ...inv.args] };
}

/** macOS Seatbelt profile: allow by default, then deny writes outside `writable`, reads of `hidden`, and optionally the network. */
export function seatbeltProfile(writable: string[], hidden: string[], network: boolean): string {
  const q = (p: string) => JSON.stringify(p); // Seatbelt strings use the same escaping as JSON
  // /tmp and /var are symlinks into /private on macOS; allow both spellings.
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const paths = (list: string[]) => [...new Set(list.flatMap((p) => [p, real(p)]))];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${paths(writable).map((p) => `(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/tty") (regex #"^/dev/fd/") (subpath "/private/var/folders"))`,
    ...(hidden.length ? [`(deny file-read* ${paths(hidden).map((p) => `(subpath ${q(p)})`).join(' ')})`] : []),
    ...(network ? [] : ['(deny network*)', '(allow network* (local unix-socket))']),
  ].join('\n');
}
