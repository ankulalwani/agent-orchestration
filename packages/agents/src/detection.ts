import fs from 'node:fs';
import path from 'node:path';
import { runCommand, type AgentState } from '@ao/core';

/** Find an executable on PATH (honours PATHEXT on Windows). */
export function which(name: string, envPath = process.env.PATH ?? ''): string | null {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of process.platform === 'win32' ? [...exts, ''] : ['']) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      const candidateUpper = path.join(dir, name + ext);
      for (const c of [candidate, candidateUpper]) {
        try {
          if (fs.statSync(c).isFile() && (process.platform === 'win32' ? ext !== '' : isExecutable(c))) return c;
        } catch {
          /* not here */
        }
      }
    }
  }
  return null;
}

function isExecutable(p: string) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run `<bin> --version` and extract the first semver-like token. */
export async function detectVersion(bin: string, args = ['--version']): Promise<string | null> {
  try {
    const r = await runCommand(bin, args, { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    const m = /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.]+)?)/.exec(`${r.stdout}\n${r.stderr}`);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Conservative text classifiers for agents without structured status output (spec §28).
 * Patterns are deliberately specific to avoid classifying ordinary program output (e.g. a test
 * named "rate limit") as a limit: callers apply them to agent error output and final messages only.
 */
const PATTERNS: Array<{ state: AgentState; re: RegExp }> = [
  { state: 'CONTEXT_EXHAUSTED', re: /(prompt is too long|context (length|window) (exceeded|limit)|maximum context length|exceeds? the (model'?s )?context|context_length_exceeded|token limit exceeded)/i },
  { state: 'RATE_LIMITED', re: /(rate[ _-]?limit(ed)?( exceeded| reached)?|usage limit (reached|exceeded)|quota (exceeded|exhausted)|too many requests|\b429\b|resource[_ ]exhausted|you'?ve (hit|reached) your (usage )?limit)/i },
  { state: 'CAPACITY_LIMITED', re: /(overloaded(_error)?|\b529\b|capacity (constraints|limit)|service unavailable|\b503\b)/i },
  { state: 'AUTH_REQUIRED', re: /(invalid (x-)?api[ _-]?key|authentication[_ ]error|unauthori[sz]ed|\b401\b|please run \/login|not logged in|login required|invalid_api_key|credentials? (not found|missing|expired))/i },
  { state: 'NETWORK_ERROR', re: /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network (error|is unreachable)|socket hang up|fetch failed)/i },
];

export function classifyText(text: string): AgentState | null {
  for (const p of PATTERNS) if (p.re.test(text)) return p.state;
  return null;
}

/**
 * Extract an explicit reset time from text. Returns null unless the text states one — never guesses (spec §28).
 * Supports "try again in 30 seconds/minutes", "retry after 120", "resets at 2026-01-01T10:00:00Z", and epoch seconds.
 */
export function extractRetryAt(text: string, now = Date.now()): number | null {
  const rel = /(?:try again|retry)(?: in| after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)?\b/i.exec(text);
  if (rel) {
    const n = Number(rel[1]);
    const unit = (rel[2] ?? 's').toLowerCase();
    const mult = unit.startsWith('ms') || unit.startsWith('milli') ? 1 : unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1000;
    return now + Math.round(n * mult);
  }
  const iso = /resets? (?:at|on)\s+(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (iso) {
    const t = Date.parse(iso[1]!);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/** Only pass a minimal, known-safe set of environment variables to agents (spec §114). */
const BASE_ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'USER', 'USERNAME', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'NVM_DIR', 'NVM_HOME', 'NVM_SYMLINK',
  'VOLTA_HOME', 'PNPM_HOME', 'COREPACK_HOME', 'JAVA_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME', 'PYENV_ROOT', 'VIRTUAL_ENV',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
];

export function baseEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV_ALLOWLIST) if (source[k] !== undefined) env[k] = source[k]!;
  env.CI = '1';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

/** A path is safe to pass as a Windows batch-shim argument (no cmd metacharacters). */
export function assertSafePathArg(p: string) {
  if (/[&|<>^%!"\r\n]/.test(p)) throw new Error(`Path contains characters that cannot be passed safely to the agent CLI: ${p}`);
}
