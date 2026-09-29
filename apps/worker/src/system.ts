import fs from 'node:fs';
import os from 'node:os';
import { runCommand } from '@ao/core';
import { which } from '@ao/agents';

/** System metrics for heartbeats and the local dashboard (spec §12). */
let lastCpu = os.cpus().map((c) => c.times);
export function systemMetrics(dataDir: string) {
  const cpus = os.cpus();
  let busy = 0;
  let total = 0;
  cpus.forEach((c, i) => {
    const prev = lastCpu[i] ?? c.times;
    const d = (k: keyof typeof c.times) => c.times[k] - prev[k];
    const t = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    busy += t - d('idle');
    total += t;
  });
  lastCpu = cpus.map((c) => c.times);
  let freeDiskMb: number | null = null;
  let totalDiskMb: number | null = null;
  try {
    const s = fs.statfsSync(dataDir);
    freeDiskMb = Math.round((s.bavail * s.bsize) / 1024 / 1024);
    totalDiskMb = Math.round((s.blocks * s.bsize) / 1024 / 1024);
  } catch {
    /* statfs unsupported */
  }
  return {
    cpuCount: cpus.length,
    cpuLoadPercent: total > 0 ? Math.round((busy / total) * 100) : null,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    freeDiskMb,
    totalDiskMb,
    uptimeSec: Math.round(os.uptime()),
  };
}

export function platformOs(): 'windows' | 'macos' | 'linux' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
}

/** Tool detection → capability tags used by worker selection (spec §47), e.g. "node", "docker". */
const TOOLS: Array<{ tag: string; bin: string; args?: string[] }> = [
  { tag: 'node', bin: 'node' },
  { tag: 'npm', bin: 'npm' },
  { tag: 'pnpm', bin: 'pnpm' },
  { tag: 'yarn', bin: 'yarn' },
  { tag: 'bun', bin: 'bun' },
  { tag: 'git', bin: 'git' },
  { tag: 'gh', bin: 'gh' },
  { tag: 'docker', bin: 'docker' },
  { tag: 'python', bin: process.platform === 'win32' ? 'python' : 'python3' },
  { tag: 'php', bin: 'php' },
  { tag: 'composer', bin: 'composer' },
  { tag: 'java', bin: 'java' },
  { tag: 'go', bin: 'go' },
  { tag: 'cargo', bin: 'cargo' },
];

export async function detectTools(): Promise<{ tags: string[]; details: Array<{ tag: string; path: string | null; version: string | null }> }> {
  const details = await Promise.all(
    TOOLS.map(async (t) => {
      const p = which(t.bin);
      let version: string | null = null;
      if (p) {
        try {
          const r = await runCommand(p, t.args ?? ['--version'], { timeoutMs: 10_000, maxOutputBytes: 8192 });
          version = /(\d+\.\d+(\.\d+)?)/.exec(r.stdout + r.stderr)?.[1] ?? null;
        } catch {
          /* ignore */
        }
      }
      return { tag: t.tag, path: p, version };
    }),
  );
  const tags = details.filter((d) => d.path).map((d) => d.tag);
  return { tags, details };
}
