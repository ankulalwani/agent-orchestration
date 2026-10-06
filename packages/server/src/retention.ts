import { TERMINAL_TASK_STATUSES, createLogger } from '@ao/core';
import { AuditLog, Organization, Task, TaskEvent, WorkerDailyStat } from '@ao/database';

const log = createLogger('retention');

/**
 * Data retention (spec §126). Per organization:
 *  - agent output (ephemeral events) older than `retentionDays.agentOutput`;
 *  - other task events older than `retentionDays.events`;
 *  - audit entries older than `retentionDays.audit` (minimum 30).
 * Events of tasks that are not in a terminal state are never deleted ("do not delete active task data").
 * Audit entries are immutable to users; only this system job removes expired ones, via the driver.
 */
export async function purgeExpiredData(now = new Date()) {
  const result = { outputEvents: 0, events: 0, audit: 0 };
  const orgs = await Organization.find({}, { settings: 1 }).lean();
  for (const org of orgs) {
    const days = org.settings?.retentionDays ?? { events: 180, agentOutput: 30, audit: 730 };
    const before = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const activeTaskIds = (await Task.find({ organizationId: org._id, status: { $nin: TERMINAL_TASK_STATUSES } }, { _id: 1 }).lean()).map((t) => t._id);
    const notActive = { taskId: { $nin: activeTaskIds } };
    const out = await TaskEvent.deleteMany({ organizationId: org._id, ephemeral: true, timestamp: { $lt: before(days.agentOutput ?? 30) }, ...notActive });
    const ev = await TaskEvent.deleteMany({ organizationId: org._id, ephemeral: { $ne: true }, timestamp: { $lt: before(days.events ?? 180) }, ...notActive });
    const auditDays = Math.max(30, days.audit ?? 730);
    const au = await AuditLog.collection.deleteMany({ organizationId: org._id, createdAt: { $lt: before(auditDays) } });
    result.outputEvents += out.deletedCount;
    result.events += ev.deletedCount;
    result.audit += au.deletedCount;
  }
  // Worker online time is only read for periods of up to a year.
  await WorkerDailyStat.deleteMany({ date: { $lt: new Date(now.getTime() - 400 * 86_400_000).toISOString().slice(0, 10) } });
  if (result.outputEvents + result.events + result.audit) log.info(result, 'retention purge');
  return result;
}
