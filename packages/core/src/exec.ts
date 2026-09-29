import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { AppError } from './errors.js';
import { redactString } from './redact.js';

/**
 * Structured command execution (spec §58, §116). Commands are argv arrays executed with
 * `shell: false`; nothing is ever concatenated into a shell string.
 *
 * On Windows, `.cmd`/`.bat` shims (npm, pnpm, many CLIs) cannot be spawned without a shell. For those
 * we invoke `cmd.exe /d /s /c` with every argument validated against cmd metacharacters, so user input
 * can never introduce a second command.
 */

const CMD_META = /[&|<>^%!"\r\n]/;
const NUL = /\0/;

export interface SafeSpawnOptions extends Omit<SpawnOptions, 'shell'> {
  /** Resolve the executable to a Windows batch shim if needed (default true on win32). */
  resolveWindowsShim?: boolean;
}

export function validateArgs(command: string, args: readonly string[]): void {
  for (const a of [command, ...args]) {
    if (typeof a !== 'string') throw new AppError('UNSAFE_ARGUMENT', 'Command arguments must be strings');
    if (NUL.test(a)) throw new AppError('UNSAFE_ARGUMENT', 'Argument contains NUL byte');
  }
}

function isBatchShim(cmd: string) {
  return /\.(cmd|bat)$/i.test(cmd);
}

export function safeSpawn(command: string, args: readonly string[], opts: SafeSpawnOptions = {}): ChildProcess {
  validateArgs(command, args);
  const { resolveWindowsShim = process.platform === 'win32', ...spawnOpts } = opts;
  if (process.platform === 'win32' && resolveWindowsShim && isBatchShim(command)) {
    for (const a of args) {
      if (CMD_META.test(a)) {
        throw new AppError('UNSAFE_ARGUMENT', 'Argument contains characters unsafe for a Windows batch shim', {
          context: { argument: redactString(a).slice(0, 80) },
        });
      }
    }
    const quoted = [command, ...args].map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], {
      ...spawnOpts,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(command, args as string[], { ...spawnOpts, shell: false });
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run to completion, capturing (bounded) output. */
export function runCommand(
  command: string,
  args: readonly string[],
  opts: SafeSpawnOptions & { timeoutMs?: number; maxOutputBytes?: number; input?: string } = {},
): Promise<RunResult> {
  const { timeoutMs, maxOutputBytes = 4 * 1024 * 1024, input, ...spawnOpts } = opts;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = safeSpawn(command, args, { ...spawnOpts, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf: string, chunk: Buffer) => (buf.length >= maxOutputBytes ? buf : buf + chunk.toString('utf8'));
    child.stdout?.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr?.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

/** Terminate a process and its children. Windows needs taskkill /T for the tree. */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, signal); // process group, if detached
    } catch {
      child.kill(signal);
    }
  }
}

/** Safe, redacted, human-readable rendering of a command for logs. */
export function formatCommand(command: string, args: readonly string[]): string {
  return redactString([command, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));
}
