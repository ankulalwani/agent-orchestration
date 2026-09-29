import type { ExecutionPolicy } from './policy.js';

/**
 * Worker, agent and model selection (spec §47–§49).
 * Pure functions: inputs are snapshots of worker/agent/provider state; outputs include
 * human-readable reasons so the UI can explain every decision.
 */

export type OS = 'windows' | 'macos' | 'linux';

export interface AgentInventory {
  id: string; // adapter id, e.g. "claude-code"
  installed: boolean;
  version?: string;
  authenticated?: boolean;
  /** Provider ids this agent can drive (e.g. claude-code → anthropic, bedrock). */
  supportedProviders: string[];
  /** Capability flags from the adapter, e.g. resume, mcp, skills, nonInteractive. */
  capabilities: string[];
}

export interface ModelInventory {
  id: string;
  contextWindow?: number;
  costTier?: 'low' | 'medium' | 'high';
  speedTier?: 'fast' | 'medium' | 'slow';
  qualityTier?: 'high' | 'medium' | 'low';
}

export interface ProviderInventory {
  id: string; // provider instance id, e.g. "anthropic"
  kind: string; // provider type
  healthy: boolean;
  /** When set and in the future, the provider is limited until this time. */
  limitedUntil?: number | null;
  /** Limited with unknown reset. */
  limited?: boolean;
  models: ModelInventory[];
  /** Position in the worker's add-on list (earlier = tried first). */
  order?: number;
}

export interface WorkerSnapshot {
  id: string;
  online: boolean;
  approved: boolean;
  os: OS;
  labels: string[];
  cpuCount?: number;
  freeMemoryMb?: number;
  freeDiskMb?: number;
  activeTaskCount: number;
  maxConcurrentTasks: number;
  /** projectId → local path of its primary repository. Only projects with every repository checked out. */
  projects: Record<string, string>;
  agents: AgentInventory[];
  providers: ProviderInventory[];
  /** Detected tools and installed capabilities: "node", "playwright", "mcp:shopify-mcp", … */
  tools: string[];
}

export interface TaskRequirements {
  projectId: string;
  /**
   * Number of repositories in the project. With more than one, the worker needs a checkout of each and
   * an agent that can work in several directories (capability `additionalDirectories`).
   */
  repositoryCount?: number;
  os?: OS[];
  labels?: string[];
  tools?: string[];
  agentCapabilities?: string[];
  minFreeMemoryMb?: number;
  minFreeDiskMb?: number;
  minContextWindow?: number;
  /** Explicit pins from the user. */
  workerId?: string;
  agentId?: string;
  providerId?: string;
  modelId?: string;
}

export interface Check {
  label: string;
  ok: boolean;
}

export interface WorkerEvaluation {
  workerId: string;
  eligible: boolean;
  checks: Check[];
  score: number;
}

export interface ExecutionTarget {
  agentId: string;
  providerId: string;
  modelId: string;
}

const now = () => Date.now();

/**
 * A harness's own login and model choice (its subscription or its own configuration): provider
 * `native:<agentId>`, model `default`. Needs no configuration and is preferred by default; its limits
 * are tracked separately from every other provider.
 */
export const NATIVE_PROVIDER_KIND = 'native';
export const nativeProviderId = (agentId: string) => `native:${agentId}`;
export const isNativeProvider = (providerId: string) => providerId.startsWith('native:');

/**
 * Add-on providers the worker's model gateway can reach (OpenAI-compatible APIs). A harness with the
 * `gateway` capability can use any of them, whatever API it speaks itself.
 */
export const GATEWAY_PROVIDER_KINDS = ['openai', 'openrouter', 'google', 'ollama', 'openai-compatible', 'anthropic', 'deepseek', 'groq', 'nvidia-nim', 'lmstudio'];

/** How an agent reaches a provider: directly (it supports it), through the model gateway, or not at all. */
export function providerRoute(agent: Pick<AgentInventory, 'id' | 'supportedProviders' | 'capabilities'>, provider: Pick<ProviderInventory, 'id' | 'kind'>): 'direct' | 'gateway' | null {
  if (provider.kind === NATIVE_PROVIDER_KIND) return provider.id === nativeProviderId(agent.id) ? 'direct' : null;
  if (agent.supportedProviders.includes(provider.kind) || agent.supportedProviders.includes(provider.id)) return 'direct';
  if (agent.capabilities.includes('gateway') && GATEWAY_PROVIDER_KINDS.includes(provider.kind)) return 'gateway';
  return null;
}

export function isProviderAvailable(p: ProviderInventory, at = now()): boolean {
  if (!p.healthy) return false;
  if (p.limitedUntil && p.limitedUntil > at) return false;
  if (p.limited && !p.limitedUntil) return false;
  return true;
}

function agentAllowed(agentId: string, policy: ExecutionPolicy): boolean {
  if (policy.agents.blocked.includes(agentId)) return false;
  if (policy.agents.allowed && !policy.agents.allowed.includes(agentId)) return false;
  return true;
}

function providerAllowed(providerId: string, policy: ExecutionPolicy): boolean {
  if (policy.models.blockedProviders.includes(providerId)) return false;
  if (policy.models.allowedProviders && !policy.models.allowedProviders.includes(providerId)) return false;
  return true;
}

const COST_RANK = { low: 0, medium: 1, high: 2 } as const;

function modelAllowed(m: ModelInventory, req: TaskRequirements, policy: ExecutionPolicy): boolean {
  if (req.minContextWindow && m.contextWindow && m.contextWindow < req.minContextWindow) return false;
  if (policy.models.maxCostTier && m.costTier && COST_RANK[m.costTier] > COST_RANK[policy.models.maxCostTier]) return false;
  return true;
}

/**
 * All (agent, provider, model) combinations on a worker that are compatible with the task and policy,
 * ordered by policy preference. Excludes `exclude` targets (e.g. ones that just hit a limit).
 */
export function candidateTargets(
  worker: Pick<WorkerSnapshot, 'agents' | 'providers'>,
  req: TaskRequirements,
  policy: ExecutionPolicy,
  opts: { exclude?: (t: ExecutionTarget) => boolean; at?: number; requireAvailable?: boolean } = {},
): ExecutionTarget[] {
  const out: Array<ExecutionTarget & { rank: number }> = [];
  const requireAvailable = opts.requireAvailable ?? true;
  for (const agent of worker.agents) {
    if (!agent.installed || agent.authenticated === false) continue;
    if (!agentAllowed(agent.id, policy)) continue;
    if (req.agentId && agent.id !== req.agentId) continue;
    if (req.agentCapabilities?.some((c) => !agent.capabilities.includes(c))) continue;
    if ((req.repositoryCount ?? 1) > 1 && !agent.capabilities.includes('additionalDirectories')) continue;
    for (const provider of worker.providers) {
      if (!providerRoute(agent, provider)) continue;
      if (!providerAllowed(provider.id, policy)) continue;
      if (req.providerId && provider.id !== req.providerId) continue;
      if (requireAvailable && !isProviderAvailable(provider, opts.at)) continue;
      for (const model of provider.models) {
        if (req.modelId && model.id !== req.modelId) continue;
        if (!modelAllowed(model, req, policy)) continue;
        const t = { agentId: agent.id, providerId: provider.id, modelId: model.id };
        if (opts.exclude?.(t)) continue;
        out.push({ ...t, rank: rankTarget(t, model, policy, provider) });
      }
    }
  }
  out.sort((a, b) => a.rank - b.rank || a.agentId.localeCompare(b.agentId) || a.modelId.localeCompare(b.modelId));
  return out.map(({ rank: _r, ...t }) => t);
}

function rankTarget(t: ExecutionTarget, m: ModelInventory, policy: ExecutionPolicy, provider: ProviderInventory): number {
  let rank = 0;
  const modelIdx = policy.models.preferred.findIndex((p) => p.providerId === t.providerId && p.modelId === t.modelId);
  // Explicit preferences first; then the harness's own login; then add-on providers in the worker's order.
  rank += modelIdx >= 0 ? modelIdx : isNativeProvider(t.providerId) ? 500 : 1000 + (provider.order ?? 0);
  const agentIdx = policy.agents.preferred.indexOf(t.agentId);
  rank += (agentIdx >= 0 ? agentIdx : 100) * 10_000;
  // Tie-breaker by optimisation goal.
  const tier =
    policy.models.optimizeFor === 'cost'
      ? { low: 0, medium: 1, high: 2 }[m.costTier ?? 'medium']
      : policy.models.optimizeFor === 'speed'
        ? { fast: 0, medium: 1, slow: 2 }[m.speedTier ?? 'medium']
        : { high: 0, medium: 1, low: 2 }[m.qualityTier ?? 'medium'];
  return rank + tier / 10;
}

/** Agents and providers at their organization-wide concurrency limit (spec §46). */
export interface SaturatedTargets {
  agents: ReadonlySet<string>;
  providers: ReadonlySet<string>;
}

export function evaluateWorker(worker: WorkerSnapshot, req: TaskRequirements, policy: ExecutionPolicy, saturated?: SaturatedTargets): WorkerEvaluation {
  const checks: Check[] = [];
  const add = (label: string, ok: boolean) => checks.push({ label, ok });

  add('Online', worker.online);
  add('Approved', worker.approved);
  if (req.workerId) add(`Pinned worker ${req.workerId}`, worker.id === req.workerId);
  add((req.repositoryCount ?? 1) > 1 ? `Has checkouts of all ${req.repositoryCount} repositories` : 'Has project checkout', Boolean(worker.projects[req.projectId]));
  if (req.os?.length) add(`OS ${req.os.join('/')}`, req.os.includes(worker.os));
  for (const l of req.labels ?? []) add(`Label ${l}`, worker.labels.includes(l));
  for (const t of req.tools ?? []) add(t, worker.tools.includes(t));
  if (req.minFreeMemoryMb) add(`≥${req.minFreeMemoryMb} MB RAM free`, (worker.freeMemoryMb ?? 0) >= req.minFreeMemoryMb);
  if (req.minFreeDiskMb) add(`≥${req.minFreeDiskMb} MB disk free`, (worker.freeDiskMb ?? 0) >= req.minFreeDiskMb);
  const cap = Math.min(worker.maxConcurrentTasks, policy.concurrency.perWorker);
  add(`Capacity (${worker.activeTaskCount}/${cap})`, worker.activeTaskCount < cap);
  const targets = candidateTargets(worker, req, policy);
  add('Compatible agent + provider + model', targets.length > 0);
  if (targets.length && saturated && (saturated.agents.size || saturated.providers.size)) {
    const free = targets.filter((t) => !saturated.agents.has(t.agentId) && !saturated.providers.has(t.providerId));
    add('Agent/provider below concurrency limit', free.length > 0);
  }

  const eligible = checks.every((c) => c.ok);
  // Higher is better: prefer idle workers, then more free memory.
  const score = eligible ? (cap - worker.activeTaskCount) * 1000 + Math.min(worker.freeMemoryMb ?? 0, 999) / 1000 : -1;
  return { workerId: worker.id, eligible, checks, score };
}

export function selectWorker(workers: WorkerSnapshot[], req: TaskRequirements, policy: ExecutionPolicy, saturated?: SaturatedTargets) {
  const evaluations = workers.map((w) => evaluateWorker(w, req, policy, saturated));
  const best = evaluations.filter((e) => e.eligible).sort((a, b) => b.score - a.score || a.workerId.localeCompare(b.workerId))[0];
  return { selected: best?.workerId ?? null, evaluations };
}
