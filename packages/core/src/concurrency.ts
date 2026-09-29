import type { ExecutionPolicy } from './policy.js';
import type { ExecutionTarget } from './selection.js';

/** Concurrency limits (spec §19, §46). Counts are of tasks currently holding a lease. */
export interface ActiveCounts {
  project: number;
  worker: number;
  organization: number;
  agent: Record<string, number>;
  provider: Record<string, number>;
}

export type ConcurrencyVerdict = { ok: true } | { ok: false; limit: 'project' | 'worker' | 'organization' | 'agent' | 'provider'; detail: string };

export function checkConcurrency(counts: ActiveCounts, policy: ExecutionPolicy, target?: ExecutionTarget): ConcurrencyVerdict {
  const c = policy.concurrency;
  if (counts.project >= c.perProject) return { ok: false, limit: 'project', detail: `Project has ${counts.project}/${c.perProject} active tasks` };
  if (counts.worker >= c.perWorker) return { ok: false, limit: 'worker', detail: `Worker has ${counts.worker}/${c.perWorker} active tasks` };
  if (c.perOrganization > 0 && counts.organization >= c.perOrganization)
    return { ok: false, limit: 'organization', detail: `Organization has ${counts.organization}/${c.perOrganization} active tasks` };
  if (target) {
    const a = c.perAgent[target.agentId];
    if (a !== undefined && (counts.agent[target.agentId] ?? 0) >= a)
      return { ok: false, limit: 'agent', detail: `Agent ${target.agentId} at ${a} concurrent tasks` };
    const p = c.perProvider[target.providerId];
    if (p !== undefined && (counts.provider[target.providerId] ?? 0) >= p)
      return { ok: false, limit: 'provider', detail: `Provider ${target.providerId} at ${p} concurrent tasks` };
  }
  return { ok: true };
}
