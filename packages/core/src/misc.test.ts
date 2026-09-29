import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backoffDelay, parseRetryAfter, retry } from './backoff.js';
import { effectivePriority, sortByEffectivePriority } from './priority.js';
import { resolveWithinRoot } from './path-guard.js';
import { runCommand, safeSpawn, formatCommand } from './exec.js';
import { buildExecutionPrompt } from './execution-prompt.js';
import { capabilityManifestSchema, evaluateCapabilityPolicy, resolveEffectiveCapabilities, compareVersions, parseRequirement } from './capabilities.js';
import { resolvePolicy } from './policy.js';
import { newDeviceCode } from './ids.js';

describe('backoff', () => {
  it('grows exponentially and respects the cap', () => {
    const d = (a: number) => backoffDelay(a, 1000, 30_000, () => 1);
    expect(d(0)).toBe(1000);
    expect(d(3)).toBe(8000);
    expect(d(10)).toBe(30_000);
    expect(backoffDelay(3, 1000, 30_000, () => 0)).toBe(4000);
  });

  it('parses Retry-After and never invents one', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'));
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('retry stops on non-retryable errors', async () => {
    let calls = 0;
    await expect(
      retry(async () => {
        calls++;
        throw new Error('fatal');
      }, { attempts: 5, baseMs: 1, maxMs: 1, isRetryable: () => false }),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
    let n = 0;
    await expect(retry(async () => (++n < 3 ? Promise.reject(new Error('x')) : 'ok'), { attempts: 5, baseMs: 1, maxMs: 2 })).resolves.toBe('ok');
  });
});

describe('priority aging', () => {
  it('prevents starvation', () => {
    const now = 100 * 60_000;
    expect(effectivePriority('LOW', now, now)).toBeLessThan(effectivePriority('NORMAL', now, now));
    expect(effectivePriority('LOW', now - 10 * 60_000, now)).toBeGreaterThan(effectivePriority('NORMAL', now, now));
    const sorted = sortByEffectivePriority(
      [
        { id: 'low-old', priority: 'LOW' as const, queuedAt: now - 60 * 60_000 },
        { id: 'normal-new', priority: 'NORMAL' as const, queuedAt: now },
        { id: 'crit', priority: 'CRITICAL' as const, queuedAt: now },
      ],
      now,
    );
    expect(sorted.map((t) => t.id)).toEqual(['crit', 'low-old', 'normal-new']);
  });
});

describe('path guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-root-'));
  fs.mkdirSync(path.join(root, 'src'));
  it('allows paths inside the project', () => {
    expect(resolveWithinRoot(root, 'src/index.ts')).toBe(path.join(root, 'src', 'index.ts'));
    expect(resolveWithinRoot(root, '.')).toBe(path.resolve(root));
  });
  it('rejects traversal and absolute escapes', () => {
    expect(() => resolveWithinRoot(root, '../etc/passwd')).toThrow(/outside/);
    expect(() => resolveWithinRoot(root, path.resolve(os.tmpdir()))).toThrow(/outside/);
    expect(() => resolveWithinRoot(root, 'src/../../x')).toThrow(/outside/);
  });
  it('rejects symlinks pointing outside', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-out-'));
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch {
      return; // symlink creation not permitted on this host
    }
    expect(() => resolveWithinRoot(root, 'escape')).toThrow(/outside/);
  });
});

describe('safe exec', () => {
  it('passes metacharacters literally with no shell', async () => {
    const r = await runCommand(process.execPath, ['-e', 'console.log(process.argv[1])', '; echo pwned && whoami']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('; echo pwned && whoami');
  });
  it('rejects NUL bytes', () => {
    expect(() => safeSpawn('node', ['a\0b'])).toThrow(/NUL/);
  });
  it.runIf(process.platform === 'win32')('rejects cmd metacharacters for batch shims', () => {
    expect(() => safeSpawn('npm.cmd', ['run', 'x & calc'])).toThrow(/unsafe/i);
  });
  it('enforces timeouts', async () => {
    const r = await runCommand(process.execPath, ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });
  it('redacts command lines for logs', () => {
    expect(formatCommand('git', ['push', 'https://u:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x'])).not.toContain('ghp_');
  });
});

describe('execution prompt', () => {
  it('is agent-neutral and includes checkpoint + rules', () => {
    const p = buildExecutionPrompt({
      taskId: 't1',
      title: 'Add Razorpay',
      prompt: 'Add Razorpay support',
      stateDir: '.agent-orchestrator',
      checkpoint: {
        taskId: 't1',
        phase: 'implement',
        completedSteps: ['added client'],
        remainingSteps: ['tests'],
        changedFiles: ['src/pay.ts'],
        testsRun: [],
        knownIssues: [],
        nextAction: 'write tests',
        createdAt: new Date().toISOString(),
      },
    });
    expect(p).toContain('Do NOT start over');
    expect(p).toContain('write tests');
    expect(p).toContain('.agent-orchestrator/progress/t1.json');
    expect(p).toMatch(/Never claim completion without/);
    expect(p.toLowerCase()).not.toContain('claude');
  });
  it('puts knowledge sections after the task, under one heading', () => {
    const p = buildExecutionPrompt({ taskId: 't1', title: 'T', prompt: 'Do it', stateDir: '.ao', knowledge: ['### Organization\n\nOrg rules', '### This task\n\nTicket 42'] });
    expect(p).toMatch(/# Task: T[\s\S]*## Knowledge[\s\S]*### Organization\n\nOrg rules\n\n### This task\n\nTicket 42[\s\S]*## Operating rules/);
    expect(buildExecutionPrompt({ taskId: 't1', title: 'T', prompt: 'Do it', stateDir: '.ao', knowledge: [] })).not.toContain('## Knowledge');
  });
});

describe('capabilities', () => {
  const skill = capabilityManifestSchema.parse({
    id: 'shopify-development',
    name: 'Shopify Development',
    version: '1.2.0',
    type: 'skill',
    compatibleAgents: ['claude-code', 'codex'],
    requires: ['node'],
    permissions: ['filesystem.project.read', 'filesystem.project.write', 'network.outbound'],
    skill: { instructions: 'Use Shopify CLI' },
  });

  it('validates manifests and type-specific blocks', () => {
    expect(skill.trust).toBe('LOCAL');
    expect(() => capabilityManifestSchema.parse({ id: 'x1', name: 'x', version: '1.0.0', type: 'mcp' })).toThrow(/mcp/);
    expect(() => capabilityManifestSchema.parse({ id: 'Bad Id', name: 'x', version: '1', type: 'skill' })).toThrow();
  });

  it('resolves scopes with overrides', () => {
    const base = { manifest: skill, enabled: true };
    const eff = resolveEffectiveCapabilities([
      { ...base, scope: 'ORGANIZATION' },
      { ...base, scope: 'PROJECT', enabled: false },
      { manifest: { ...skill, id: 'other' }, scope: 'PLATFORM', enabled: true },
    ]);
    expect(eff.map((c) => c.manifest.id)).toEqual(['other']);
  });

  it('applies permission and trust policy', () => {
    const p = resolvePolicy().capabilities;
    expect(evaluateCapabilityPolicy({ ...skill, permissions: ['filesystem.project.read'] }, { ...p, installPolicy: 'AUTO' })).toEqual({ decision: 'allow' });
    expect(evaluateCapabilityPolicy({ ...skill, permissions: ['shell'] }, { ...p, installPolicy: 'AUTO' }).decision).toBe('require_approval');
    expect(evaluateCapabilityPolicy({ ...skill, permissions: ['shell'] }, { ...p, blockedPermissions: ['shell'] }).decision).toBe('block');
    expect(evaluateCapabilityPolicy({ ...skill, trust: 'UNVERIFIED' }, { ...p, installPolicy: 'RESTRICTED' }).decision).toBe('block');
    expect(evaluateCapabilityPolicy({ ...skill, type: 'plugin' }, { ...p, installPolicy: 'AUTO' }).decision).toBe('require_approval');
  });

  it('parses requirements and compares versions', () => {
    expect(parseRequirement('node>=18')).toEqual({ tool: 'node', op: '>=', version: '18' });
    expect(parseRequirement('git')).toEqual({ tool: 'git', op: undefined, version: undefined });
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });
});

describe('ids', () => {
  it('device codes look like ABCD-1234', () => {
    expect(newDeviceCode()).toMatch(/^[A-Z]{4}-\d{4}$/);
  });
});
