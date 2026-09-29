import { describe, expect, it } from 'vitest';
import { candidateTargets, selectWorker, type WorkerSnapshot } from './selection.js';
import { resolvePolicy } from './policy.js';
import { decideFallback } from './fallback.js';
import { checkConcurrency } from './concurrency.js';

const claude = { id: 'claude-code', installed: true, authenticated: true, supportedProviders: ['anthropic'], capabilities: ['resume', 'mcp'] };
const codex = { id: 'codex', installed: true, authenticated: true, supportedProviders: ['openai'], capabilities: ['mcp'] };
const gemini = { id: 'gemini', installed: true, authenticated: true, supportedProviders: ['google'], capabilities: [] };
const anthropic = { id: 'anthropic', kind: 'anthropic', healthy: true, models: [{ id: 'claude-opus' }, { id: 'claude-sonnet' }] };
const openai = { id: 'openai', kind: 'openai', healthy: true, models: [{ id: 'gpt-5' }] };
const google = { id: 'google', kind: 'google', healthy: true, models: [{ id: 'gemini-pro' }] };

function worker(id: string, over: Partial<WorkerSnapshot> = {}): WorkerSnapshot {
  return {
    id,
    online: true,
    approved: true,
    os: 'macos',
    labels: [],
    freeMemoryMb: 8000,
    activeTaskCount: 0,
    maxConcurrentTasks: 2,
    projects: { p1: '/src/p1' },
    agents: [claude],
    providers: [anthropic],
    tools: ['node', 'playwright'],
    ...over,
  };
}

describe('worker selection (spec §47 example)', () => {
  it('picks the worker that has the required MCP server', () => {
    const policy = resolvePolicy();
    const a = worker('A');
    const b = worker('B', { tools: ['node', 'playwright', 'mcp:shopify-mcp'] });
    const r = selectWorker([a, b], { projectId: 'p1', os: ['macos'], tools: ['node', 'playwright', 'mcp:shopify-mcp'], agentId: 'claude-code' }, policy);
    expect(r.selected).toBe('B');
    const evalA = r.evaluations.find((e) => e.workerId === 'A')!;
    expect(evalA.eligible).toBe(false);
    expect(evalA.checks.find((c) => c.label === 'mcp:shopify-mcp')?.ok).toBe(false);
  });

  it('excludes offline, unapproved, busy and projectless workers', () => {
    const policy = resolvePolicy();
    const r = selectWorker(
      [
        worker('off', { online: false }),
        worker('unapproved', { approved: false }),
        worker('busy', { activeTaskCount: 2 }),
        worker('noproj', { projects: {} }),
      ],
      { projectId: 'p1' },
      policy,
    );
    expect(r.selected).toBeNull();
  });

  it('skips workers whose only agents/providers are at their concurrency limit (spec §46)', () => {
    const policy = resolvePolicy();
    const saturated = { agents: new Set(['claude-code']), providers: new Set<string>() };
    const r = selectWorker([worker('claudeOnly'), worker('both', { agents: [claude, codex], providers: [anthropic, openai] })], { projectId: 'p1' }, policy, saturated);
    expect(r.selected).toBe('both');
    const blocked = r.evaluations.find((e) => e.workerId === 'claudeOnly')!;
    expect(blocked.checks.find((c) => c.label === 'Agent/provider below concurrency limit')?.ok).toBe(false);
    expect(selectWorker([worker('claudeOnly')], { projectId: 'p1' }, policy, { agents: new Set(), providers: new Set(['anthropic']) }).selected).toBeNull();
  });

  it('prefers idle workers', () => {
    const r = selectWorker([worker('busyish', { activeTaskCount: 1 }), worker('idle')], { projectId: 'p1' }, resolvePolicy());
    expect(r.selected).toBe('idle');
  });
});

describe('agent/model selection', () => {
  const w = worker('W', { agents: [claude, codex, gemini], providers: [anthropic, openai, google] });

  it('never pairs an agent with an unsupported provider', () => {
    const t = candidateTargets(w, { projectId: 'p1' }, resolvePolicy());
    for (const x of t) {
      if (x.agentId === 'claude-code') expect(x.providerId).toBe('anthropic');
      if (x.agentId === 'codex') expect(x.providerId).toBe('openai');
    }
    expect(t).toHaveLength(4);
  });

  it('honours preferences, blocks and required capabilities', () => {
    const policy = resolvePolicy({
      agents: { preferred: ['codex'], blocked: ['gemini'] },
      models: { preferred: [{ providerId: 'anthropic', modelId: 'claude-sonnet' }] },
    });
    const t = candidateTargets(w, { projectId: 'p1' }, policy);
    expect(t[0]).toEqual({ agentId: 'codex', providerId: 'openai', modelId: 'gpt-5' });
    expect(t.some((x) => x.agentId === 'gemini')).toBe(false);
    const withResume = candidateTargets(w, { projectId: 'p1', agentCapabilities: ['resume'] }, policy);
    expect(withResume.every((x) => x.agentId === 'claude-code')).toBe(true);
    expect(withResume[0]!.modelId).toBe('claude-sonnet');
  });

  it('skips limited providers', () => {
    const limited = { ...w, providers: [{ ...anthropic, limitedUntil: Date.now() + 60_000 }, openai, google] };
    const t = candidateTargets(limited, { projectId: 'p1' }, resolvePolicy());
    expect(t.some((x) => x.providerId === 'anthropic')).toBe(false);
  });
});

describe('fallback engine (spec §29)', () => {
  const w = { agents: [claude, codex, gemini], providers: [anthropic, openai, google] };
  const policy = resolvePolicy({
    fallback: {
      chain: [
        { kind: 'FALLBACK_AGENT', agentId: 'codex' },
        { kind: 'FALLBACK_AGENT', agentId: 'gemini' },
        { kind: 'WAIT' },
      ],
    },
  });
  const current = { agentId: 'claude-code', providerId: 'anthropic', modelId: 'claude-opus' };

  it('switches to the first compatible fallback', () => {
    const d = decideFallback({ current, stepIndex: -1, retryAt: null, waitedMs: 0, worker: w, requirements: { projectId: 'p1' }, policy });
    expect(d).toMatchObject({ action: 'SWITCH', target: { agentId: 'codex', providerId: 'openai' }, stepIndex: 0 });
  });

  it('skips incompatible fallbacks instead of switching blindly', () => {
    // Task requires MCP: gemini lacks it, codex has it but is limited.
    const d = decideFallback({
      current,
      stepIndex: -1,
      retryAt: null,
      waitedMs: 0,
      worker: { ...w, providers: [anthropic, { ...openai, limited: true }, google] },
      requirements: { projectId: 'p1', agentCapabilities: ['mcp'] },
      policy,
    });
    expect(d.action).toBe('WAIT');
  });

  it('WAIT uses a known reset time and never fabricates one', () => {
    const waitOnly = resolvePolicy({ fallback: { chain: [{ kind: 'WAIT' }] } });
    const at = 1_000_000;
    const known = decideFallback({ current, stepIndex: -1, retryAt: at + 5000, waitedMs: 0, worker: w, requirements: { projectId: 'p1' }, policy: waitOnly, at });
    expect(known).toMatchObject({ action: 'WAIT', until: at + 5000 });
    const unknown = decideFallback({ current, stepIndex: -1, retryAt: null, waitedMs: 0, worker: w, requirements: { projectId: 'p1' }, policy: waitOnly, at });
    expect(unknown).toMatchObject({ action: 'WAIT', until: null });
  });

  it('moves past a WAIT whose budget is spent, to ASK_USER/FAIL', () => {
    const p = resolvePolicy({ fallback: { chain: [{ kind: 'WAIT', maxWaitMs: 1000 }, { kind: 'ASK_USER' }] } });
    const d = decideFallback({ current, stepIndex: 0, retryAt: null, waitedMs: 5000, worker: w, requirements: { projectId: 'p1' }, policy: p });
    expect(d.action).toBe('ASK_USER');
    const f = resolvePolicy({ fallback: { chain: [{ kind: 'FAIL' }] } });
    expect(decideFallback({ current, stepIndex: -1, retryAt: null, waitedMs: 0, worker: w, requirements: { projectId: 'p1' }, policy: f }).action).toBe('FAIL');
  });

  it('FALLBACK_MODEL stays on the same agent/provider', () => {
    const p = resolvePolicy({ fallback: { chain: [{ kind: 'FALLBACK_MODEL' }] } });
    const d = decideFallback({ current, stepIndex: -1, retryAt: null, waitedMs: 0, worker: w, requirements: { projectId: 'p1' }, policy: p });
    expect(d).toMatchObject({ action: 'SWITCH', target: { agentId: 'claude-code', providerId: 'anthropic', modelId: 'claude-sonnet' } });
  });
});

describe('policy resolution & concurrency', () => {
  it('layers override defaults; arrays replace', () => {
    const p = resolvePolicy({ concurrency: { perProject: 3 } }, { git: { policy: 'NONE' } }, { concurrency: { perAgent: { codex: 1 } } });
    expect(p.concurrency.perProject).toBe(3);
    expect(p.concurrency.perAgent).toEqual({ codex: 1 });
    expect(p.git.policy).toBe('NONE');
    expect(p.leaseMs).toBe(300_000);
    expect(p.heartbeatMs).toBe(15_000);
    expect(p.offlineThresholdMs).toBe(60_000);
    expect(p.maxRestarts).toBe(5);
    expect(p.maxRemediationAttempts).toBe(3);
  });

  it('rejects invalid layers', () => {
    expect(() => resolvePolicy({ leaseMs: -1 })).toThrow();
  });

  it('defaults to one active task per project', () => {
    const p = resolvePolicy();
    const counts = { project: 1, worker: 0, organization: 1, agent: {}, provider: {} };
    expect(checkConcurrency(counts, p)).toMatchObject({ ok: false, limit: 'project' });
    expect(checkConcurrency({ ...counts, project: 0 }, p)).toEqual({ ok: true });
    const withAgent = resolvePolicy({ concurrency: { perAgent: { codex: 1 } } });
    expect(
      checkConcurrency({ ...counts, project: 0, agent: { codex: 1 } }, withAgent, { agentId: 'codex', providerId: 'openai', modelId: 'm' }),
    ).toMatchObject({ ok: false, limit: 'agent' });
  });
});
