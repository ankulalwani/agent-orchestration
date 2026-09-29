import { LEASED_TASK_STATUSES, type ExecutionPolicy } from '@ao/core';
import { ConcurrencySlot, Task, isDuplicateKeyError, type mongoose } from '@ao/database';

type Id = mongoose.Types.ObjectId;
export type SlotScope = 'organization' | 'agent' | 'provider';

/**
 * Atomically reserves one slot of `limit` for a task (spec §19, §46). Idempotent: a task that
 * already holds the slot keeps it. The slot document is created first, then a single conditional
 * update adds the task only while it has room, so two claimants can never both take the last slot.
 */
export async function reserveSlot(organizationId: Id, scope: SlotScope, key: string, taskId: Id, limit: number): Promise<boolean> {
  try {
    await ConcurrencySlot.updateOne({ organizationId, scope, key }, { $setOnInsert: { taskIds: [] } }, { upsert: true });
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e; // a concurrent upsert created it
  }
  if (await ConcurrencySlot.exists({ organizationId, scope, key, taskIds: taskId })) return true;
  const r = await ConcurrencySlot.updateOne(
    { organizationId, scope, key, taskIds: { $ne: taskId }, $expr: { $lt: [{ $size: '$taskIds' }, limit] } },
    { $addToSet: { taskIds: taskId } },
  );
  return r.modifiedCount > 0;
}

/** Releases a task's slots: all of them, or those of one scope except `keep`. */
export async function releaseSlots(taskId: Id, only?: { scope: SlotScope; keep?: string | null }) {
  const filter: Record<string, unknown> = { taskIds: taskId };
  if (only) {
    filter.scope = only.scope;
    if (only.keep) filter.key = { $ne: only.keep };
  }
  const held = await ConcurrencySlot.find(filter, { scope: 1, key: 1 }).lean();
  if (held.length) await ConcurrencySlot.updateMany({ _id: { $in: held.map((h) => h._id) } }, { $pull: { taskIds: taskId } });
  return held.map((h) => ({ scope: h.scope as SlotScope, key: h.key }));
}

/**
 * Reserves the agent and provider slots a task needs for a target, when the policy limits them.
 * Returns the saturated limit if one is full. Slots for a previous target are not touched here;
 * the caller releases them once the new target is recorded.
 */
export async function reserveTargetSlots(
  task: { _id: Id; organizationId: Id },
  policy: ExecutionPolicy,
  target: { agentId?: string | null; providerId?: string | null },
): Promise<{ ok: true } | { ok: false; scope: 'agent' | 'provider'; key: string; limit: number }> {
  const c = policy.concurrency;
  const reserved: Array<{ scope: SlotScope; key: string }> = [];
  for (const [scope, key, limit] of [
    ['agent', target.agentId, target.agentId ? c.perAgent[target.agentId] : undefined],
    ['provider', target.providerId, target.providerId ? c.perProvider[target.providerId] : undefined],
  ] as const) {
    if (!key || limit === undefined) continue;
    const already = await ConcurrencySlot.exists({ organizationId: task.organizationId, scope, key, taskIds: task._id });
    if (already) continue;
    if (!(await reserveSlot(task.organizationId, scope, key, task._id, limit))) {
      // Undo what this call reserved so a partial reservation doesn't leak.
      for (const r of reserved) await ConcurrencySlot.updateOne({ organizationId: task.organizationId, scope: r.scope, key: r.key }, { $pull: { taskIds: task._id } });
      return { ok: false, scope, key, limit };
    }
    reserved.push({ scope, key });
  }
  return { ok: true };
}

/** Agents and providers whose limit is reached in an organization (used to steer dispatch). */
export async function saturatedTargets(organizationId: Id, policy: ExecutionPolicy) {
  const c = policy.concurrency;
  const agents = new Set<string>();
  const providers = new Set<string>();
  if (!Object.keys(c.perAgent).length && !Object.keys(c.perProvider).length) return { agents, providers };
  const slots = await ConcurrencySlot.find({ organizationId, scope: { $in: ['agent', 'provider'] } }, { scope: 1, key: 1, taskIds: 1 }).lean();
  for (const s of slots) {
    const limit = s.scope === 'agent' ? c.perAgent[s.key] : c.perProvider[s.key];
    if (limit !== undefined && s.taskIds.length >= limit) (s.scope === 'agent' ? agents : providers).add(s.key);
  }
  return { agents, providers };
}

/**
 * Self-healing (decision D-003): drops slot holders that no longer hold a lease (e.g. the API
 * stopped between a status change and the release). Slots can over-report after a crash, never under-report.
 */
export async function reconcileSlots() {
  const slots = await ConcurrencySlot.find({ 'taskIds.0': { $exists: true } }).lean();
  for (const s of slots) {
    const live = await Task.find({ _id: { $in: s.taskIds }, status: { $in: LEASED_TASK_STATUSES } }, { _id: 1 }).lean();
    const stale = s.taskIds.filter((id) => !live.some((l) => l._id.equals(id)));
    if (stale.length) await ConcurrencySlot.updateOne({ _id: s._id }, { $pull: { taskIds: { $in: stale } } });
  }
}
