import fs from 'node:fs';
import os from 'node:os';
import { runCommand } from '@ao/core';
import { which } from '@ao/agents';
import type { WorkerRuntime } from './runtime.js';
import { systemMetrics } from './system.js';
import { API_PREFIX } from '@ao/contracts';

export interface Check {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  fix?: string;
}

/** Worker diagnostics (spec §68). Every failing check carries an actionable fix. */
export async function runDiagnostics(rt: WorkerRuntime): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const cfg = rt.config.get();

  add({ id: 'os', label: 'Operating system', status: 'info', detail: `${os.type()} ${os.release()} (${process.arch})` });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add({ id: 'node', label: 'Node.js', status: nodeMajor >= 20 ? 'ok' : 'fail', detail: process.versions.node, fix: nodeMajor >= 20 ? undefined : 'Install Node.js 20 or newer' });

  const git = which('git');
  add({ id: 'git', label: 'Git', status: git ? 'ok' : 'fail', detail: git ?? 'not found', fix: git ? undefined : 'Install Git and ensure it is on PATH' });
  const docker = which('docker');
  add({ id: 'docker', label: 'Docker', status: docker ? 'ok' : 'info', detail: docker ?? 'not installed (optional)' });

  for (const a of await rt.agentInventory()) {
    add({
      id: `agent:${a.id}`,
      label: `Agent: ${a.name}`,
      status: a.installed ? (a.enabled ? 'ok' : 'info') : 'info',
      detail: a.installed ? `${a.version ?? 'unknown version'} at ${a.path}${a.enabled ? '' : ' (disabled)'}${a.notes.length ? ` — ${a.notes.join('; ')}` : ''}` : 'not installed',
    });
  }
  const anyAgent = (await rt.agentInventory()).some((a) => a.installed && a.enabled && a.id !== 'mock');
  if (!anyAgent) add({ id: 'agents', label: 'Coding agents', status: 'warn', detail: 'No enabled coding agent is installed', fix: 'Install at least one agent (e.g. Claude Code, Codex, Gemini CLI, Cursor Agent or Copilot CLI)' });

  const providers = rt.providers.inventory();
  if (!providers.length) add({ id: 'providers', label: 'AI providers', status: 'warn', detail: 'No providers configured', fix: 'Add a provider in the local UI (AI Providers) or via the CLI' });
  for (const p of providers) {
    add({ id: `provider:${p.id}`, label: `Provider: ${p.name}`, status: p.limited ? 'warn' : p.healthy ? 'ok' : 'fail', detail: p.limited ? `limited${p.limitedUntil ? ` until ${p.limitedUntil}` : ' (reset time unknown)'}` : p.error ?? `${p.models.length} models`, fix: p.healthy ? undefined : 'Check the credential and base URL for this provider' });
  }

  add({
    id: 'credentials',
    label: 'Credential storage',
    status: rt.credentials.backend === 'os-keyring' ? 'ok' : 'warn',
    detail:
      rt.credentials.backend === 'os-keyring'
        ? 'OS credential store'
        : process.env.AO_CREDENTIAL_BACKEND === 'file'
          ? 'Encrypted file (forced by AO_CREDENTIAL_BACKEND=file)'
          : 'Encrypted file (OS credential store unavailable)',
    fix: rt.credentials.backend === 'os-keyring' ? undefined : 'On Linux install and unlock a Secret Service provider (e.g. gnome-keyring) for OS-level protection',
  });

  const base = rt.controlPlaneUrl();
  if (!base) add({ id: 'control-plane', label: 'Control plane', status: 'warn', detail: 'Not connected', fix: 'Open the local UI and enter your control plane URL to pair this worker' });
  else {
    try {
      const t0 = Date.now();
      const r = await fetch(base.replace(/\/+$/, '') + API_PREFIX + '/server-info', { signal: AbortSignal.timeout(10_000) });
      add({ id: 'control-plane', label: 'Control plane reachable', status: r.ok ? 'ok' : 'fail', detail: `${base} → HTTP ${r.status} in ${Date.now() - t0} ms`, fix: r.ok ? undefined : 'Check the URL and that the server is running' });
    } catch (e) {
      add({ id: 'control-plane', label: 'Control plane reachable', status: 'fail', detail: `${base}: ${(e as Error).message}`, fix: 'Check network connectivity, proxy settings and the server URL' });
    }
    add({ id: 'connection', label: 'Worker connection', status: rt.client?.state === 'connected' ? 'ok' : rt.client?.state === 'unauthorized' ? 'fail' : 'warn', detail: rt.client?.state ?? 'not started', fix: rt.client?.state === 'unauthorized' ? 'The worker credential was revoked or is invalid: disconnect and pair again' : undefined });
  }

  for (const p of cfg.projects) {
    const ok = fs.existsSync(p.localPath);
    let isRepo = false;
    if (ok) isRepo = (await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: p.localPath, timeoutMs: 10_000 }).catch(() => ({ exitCode: 1 }))).exitCode === 0;
    add({ id: `project:${p.projectId}`, label: `Project path ${p.name ?? p.projectId}`, status: ok ? (isRepo ? 'ok' : 'warn') : 'fail', detail: `${p.localPath}${ok ? (isRepo ? '' : ' (not a Git repository: Git policies will be skipped)') : ' does not exist'}`, fix: ok ? undefined : 'Fix the path mapping in the local UI' });
  }

  const m = systemMetrics(rt.dataDir);
  add({ id: 'disk', label: 'Free disk', status: m.freeDiskMb === null ? 'info' : m.freeDiskMb < 2048 ? 'warn' : 'ok', detail: m.freeDiskMb === null ? 'unknown' : `${m.freeDiskMb} MB`, fix: m.freeDiskMb !== null && m.freeDiskMb < 2048 ? 'Free up disk space; builds and tests may fail' : undefined });
  add({ id: 'memory', label: 'Free memory', status: m.freeMemoryMb < 1024 ? 'warn' : 'ok', detail: `${m.freeMemoryMb} / ${m.totalMemoryMb} MB` });
  add({ id: 'buffer', label: 'Unsent events', status: rt.buffer.size > 1000 ? 'warn' : 'ok', detail: String(rt.buffer.size) });
  add({ id: 'local-ui', label: 'Local UI binding', status: ['127.0.0.1', 'localhost', '::1'].includes(cfg.localHost) ? 'ok' : 'warn', detail: `${cfg.localHost}:${cfg.localPort}`, fix: ['127.0.0.1', 'localhost', '::1'].includes(cfg.localHost) ? undefined : 'The local UI is exposed beyond this machine; bind it to 127.0.0.1 unless you have a reverse proxy with authentication' });
  return checks;
}
