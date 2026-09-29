import type { ExecutionPolicy, FallbackStep } from './policy.js';
import { candidateTargets, type ExecutionTarget, type TaskRequirements, type WorkerSnapshot } from './selection.js';

/**
 * Fallback engine (spec §9, §29). Decides what to do after a limit is detected.
 * It never switches to a target that fails compatibility checks (agent↔provider, required capabilities,
 * policy restrictions) and never fabricates reset times.
 */

export type FallbackDecision =
  | { action: 'SWITCH'; target: ExecutionTarget; stepIndex: number; reason: string }
  | { action: 'WAIT'; until: number | null; stepIndex: number; reason: string }
  | { action: 'ASK_USER'; stepIndex: number; reason: string }
  | { action: 'FAIL'; stepIndex: number; reason: string };

export interface FallbackInput {
  current: ExecutionTarget;
  /** Index of the chain step already in effect (-1 = still on primary). */
  stepIndex: number;
  /** Known reset time of the limit that was just hit, if the provider reported one. */
  retryAt: number | null;
  /** Time already spent waiting in the current WAIT step. */
  waitedMs: number;
  worker: Pick<WorkerSnapshot, 'agents' | 'providers'>;
  requirements: TaskRequirements;
  policy: ExecutionPolicy;
  /** Targets known to be limited right now (in addition to provider limitedUntil flags). */
  limitedTargets?: ExecutionTarget[];
  at?: number;
}

const sameTarget = (a: ExecutionTarget, b: ExecutionTarget) =>
  a.agentId === b.agentId && a.providerId === b.providerId && a.modelId === b.modelId;

function resolveStep(step: FallbackStep, input: FallbackInput): ExecutionTarget | null {
  const { current, worker, policy, requirements } = input;
  const limited = [current, ...(input.limitedTargets ?? [])];
  // Unpin agent/provider/model so the step can choose; the step's own fields become the new pins.
  const req: TaskRequirements = { ...requirements, agentId: undefined, providerId: undefined, modelId: undefined };
  switch (step.kind) {
    case 'FALLBACK_MODEL':
      req.agentId = step.agentId ?? current.agentId;
      req.providerId = step.providerId ?? current.providerId;
      req.modelId = step.modelId;
      break;
    case 'FALLBACK_PROVIDER':
      req.agentId = step.agentId ?? current.agentId;
      req.providerId = step.providerId;
      req.modelId = step.modelId;
      break;
    case 'FALLBACK_AGENT':
      req.agentId = step.agentId;
      req.providerId = step.providerId;
      req.modelId = step.modelId;
      break;
    default:
      return null;
  }
  const targets = candidateTargets(worker, req, policy, {
    at: input.at,
    exclude: (t) =>
      limited.some((l) => sameTarget(l, t)) ||
      // A provider-level limit also blocks the other models of that provider unless switching model is the point.
      (step.kind !== 'FALLBACK_MODEL' && t.providerId === current.providerId),
  });
  return targets[0] ?? null;
}

export function decideFallback(input: FallbackInput): FallbackDecision {
  const chain = input.policy.fallback.chain;
  const at = input.at ?? Date.now();
  for (let i = Math.max(input.stepIndex, 0); i < chain.length; i++) {
    const step = chain[i]!;
    switch (step.kind) {
      case 'WAIT': {
        // Wait budget only accrues in the step currently in effect; a newly entered WAIT starts at 0.
        const waited = i === input.stepIndex ? input.waitedMs : 0;
        if (step.maxWaitMs !== undefined && waited >= step.maxWaitMs) continue;
        const until = input.retryAt && input.retryAt > at ? input.retryAt : null;
        return {
          action: 'WAIT',
          until,
          stepIndex: i,
          reason: until ? `Waiting for provider reset at ${new Date(until).toISOString()}` : 'Waiting for provider limit (reset time unknown)',
        };
      }
      case 'ASK_USER':
        return { action: 'ASK_USER', stepIndex: i, reason: 'Fallback policy requires user decision' };
      case 'FAIL':
        return { action: 'FAIL', stepIndex: i, reason: 'Fallback policy ends in FAIL' };
      default: {
        if (i === input.stepIndex) continue; // already tried this step
        const target = resolveStep(step, input);
        if (target) {
          return { action: 'SWITCH', target, stepIndex: i, reason: `${step.kind} → ${target.agentId}/${target.providerId}/${target.modelId}` };
        }
        // Incompatible or unavailable: skip to the next step rather than blindly switching (spec §29).
      }
    }
  }
  return { action: 'WAIT', until: input.retryAt && input.retryAt > at ? input.retryAt : null, stepIndex: chain.length, reason: 'Fallback chain exhausted; waiting for primary' };
}
