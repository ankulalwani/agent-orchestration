import { AppError, maskSecret } from '@ao/core';
import { AuditLog, Notification, Project, PushToken, ProviderConfig, Secret, Task, UsageRecord, Worker, isDuplicateKeyError, oid } from '@ao/database';
import type { AnalyticsDto, OverviewDto } from '@ao/contracts';
import { requirePermission, type Actor } from './context.js';
import { decodeCursor, encodeCursor, toNotificationDto, toTaskDto } from './dto.js';
import { audit } from './audit.js';
import type { SecretBox } from './crypto.js';

/** Read models for dashboards, audit, notifications, usage; plus org provider configs and secrets. */
export class QueryService {
  constructor(private box: SecretBox) {}

  async overview(actor: Actor): Promise<OverviewDto> {
    requirePermission(actor, 'task.read');
    const orgId = oid(actor.organizationId);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const counts = await Task.aggregate<{ _id: string; n: number }>([{ $match: { organizationId: orgId } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const by = (ss: string[]) => counts.filter((c) => ss.includes(c._id)).reduce((a, c) => a + c.n, 0);
    const [completedToday, verificationFailures, workers, attention] = await Promise.all([
      Task.countDocuments({ organizationId: orgId, status: 'COMPLETED', completedAt: { $gte: startOfDay } }),
      Task.countDocuments({ organizationId: orgId, verificationStatus: 'FAILED', status: { $nin: ['COMPLETED', 'CANCELLED'] } }),
      Worker.find({ organizationId: orgId }, { status: 1, providers: 1 }).lean(),
      Task.find({
        organizationId: orgId,
        $or: [
          { status: { $in: ['WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'RECOVERY_REQUIRED', 'FAILED', 'WAITING_FOR_LIMIT'] } },
          // Plans waiting for someone to create their tasks (FUT-001), for 30 days.
          { kind: 'plan', status: 'COMPLETED', planApplied: null, completedAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } },
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean(),
    ]);
    const providerHealth = new Map<string, { healthy: number; unhealthy: number; limited: number }>();
    for (const w of workers) {
      for (const p of (w.providers ?? []) as Array<Record<string, any>>) {
        const h = providerHealth.get(p.id) ?? { healthy: 0, unhealthy: 0, limited: 0 };
        if (p.limited || (p.limitedUntil && new Date(p.limitedUntil).getTime() > Date.now())) h.limited++;
        else if (p.healthy) h.healthy++;
        else h.unhealthy++;
        providerHealth.set(p.id, h);
      }
    }
    return {
      activeTasks: by(['CLAIMING', 'PREPARING', 'RUNNING', 'VERIFYING']),
      waitingTasks: by(['QUEUED', 'PAUSED', 'WAITING_FOR_LIMIT', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL']),
      completedToday,
      failedTasks: by(['FAILED']),
      recoveryRequired: by(['RECOVERY_REQUIRED', 'CRASHED']),
      verificationFailures,
      workersOnline: workers.filter((w) => w.status === 'ONLINE').length,
      workersOffline: workers.filter((w) => w.status === 'OFFLINE').length,
      pendingApprovals: by(['WAITING_FOR_APPROVAL']) + workers.filter((w) => w.status === 'PENDING_APPROVAL').length,
      providerHealth: [...providerHealth].map(([providerId, h]) => ({ providerId, ...h })),
      needsAttention: attention.map((t) => {
        const d = toTaskDto(t);
        const planReady = d.kind === 'plan' && d.status === 'COMPLETED';
        return { taskId: d.id, title: d.title, status: d.status, reason: planReady ? `Plan ready: review it and create its ${d.completionReport?.plan?.tasks.length ?? ''} tasks`.replace('  ', ' ') : d.statusReason };
      }),
    };
  }

  async audit(actor: Actor, q: { cursor?: string; limit: number; action?: string }) {
    requirePermission(actor, 'audit.read');
    const f: Record<string, unknown> = { organizationId: oid(actor.organizationId) };
    if (q.action) f.action = q.action;
    const cur = decodeCursor(q.cursor);
    if (cur) f.$or = [{ createdAt: { $lt: cur.t } }, { createdAt: cur.t, _id: { $lt: oid(cur.id) } }];
    const docs = await AuditLog.find(f).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).lean();
    const items = docs.slice(0, q.limit);
    return {
      items: items.map((a) => ({
        id: String(a._id),
        organizationId: a.organizationId ? String(a.organizationId) : null,
        actorType: a.actorType,
        actorId: a.actorId ?? null,
        action: a.action,
        targetType: a.targetType ?? null,
        targetId: a.targetId ?? null,
        metadata: a.metadata ?? {},
        ip: a.ip ?? null,
        createdAt: a.createdAt.toISOString(),
      })),
      nextCursor: docs.length > q.limit ? encodeCursor(items[items.length - 1]!) : null,
    };
  }

  async notifications(actor: Actor, q: { cursor?: string; limit: number; unreadOnly?: boolean }) {
    const f: Record<string, unknown> = { organizationId: oid(actor.organizationId), userId: oid(actor.userId) };
    if (q.unreadOnly) f.readAt = null;
    const cur = decodeCursor(q.cursor);
    if (cur) f.$or = [{ createdAt: { $lt: cur.t } }, { createdAt: cur.t, _id: { $lt: oid(cur.id) } }];
    const docs = await Notification.find(f).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).lean();
    const items = docs.slice(0, q.limit);
    const unread = await Notification.countDocuments({ organizationId: oid(actor.organizationId), userId: oid(actor.userId), readAt: null });
    return { items: items.map(toNotificationDto), nextCursor: docs.length > q.limit ? encodeCursor(items[items.length - 1]!) : null, unread };
  }

  async markNotificationsRead(actor: Actor, ids: string[] | 'all') {
    const f: Record<string, unknown> = { organizationId: oid(actor.organizationId), userId: oid(actor.userId), readAt: null };
    if (ids !== 'all') f._id = { $in: ids.map((i) => oid(i)) };
    await Notification.updateMany(f, { readAt: new Date() });
  }

  async registerPushToken(userId: string, token: string, platform?: string) {
    await PushToken.updateOne({ token }, { userId: oid(userId), token, platform }, { upsert: true });
  }

  async usage(actor: Actor, days = 30) {
    requirePermission(actor, 'task.read');
    const since = new Date(Date.now() - days * 86_400_000);
    return UsageRecord.aggregate([
      { $match: { organizationId: oid(actor.organizationId), createdAt: { $gte: since } } },
      {
        $group: {
          _id: { providerId: '$providerId', modelId: '$modelId', agentId: '$agentId', kind: '$kind' },
          count: { $sum: 1 },
          durationMs: { $sum: '$durationMs' },
          inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
          costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
        },
      },
      { $sort: { count: -1 } },
    ]);
  }

  /**
   * Outcomes of the tasks that finished in the last `days` days: success and first-pass rates, cost and
   * time, in total, per day and by agent, model and project. A task counts for the agent and model it
   * finished on.
   */
  async analytics(actor: Actor, q: { days: number; projectId?: string }, now = new Date()): Promise<AnalyticsDto> {
    requirePermission(actor, 'task.read');
    const orgId = oid(actor.organizationId);
    // Whole UTC days, today included.
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (q.days - 1)));
    const scope = { organizationId: orgId, ...(q.projectId ? { projectId: oid(q.projectId, 'Project') } : {}) };
    const figures = {
      finished: { $sum: 1 },
      completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
      failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
      firstPass: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'COMPLETED'] }, { $eq: [{ $ifNull: ['$remediationCount', 0] }, 0] }] }, 1, 0] } },
      remediations: { $sum: { $ifNull: ['$remediationCount', 0] } },
      costUsd: { $sum: { $ifNull: ['$usage.costUsd', 0] } },
      activeMs: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, { $ifNull: ['$activeMs', 0] }, 0] } },
      leadMs: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, { $subtract: ['$completedAt', '$createdAt'] }, 0] } },
    };
    type Group<K> = { _id: K; finished: number; completed: number; failed: number; firstPass: number; remediations: number; costUsd: number; activeMs: number; leadMs: number };
    const [facets] = await Task.aggregate<{
      totals: Group<null>[];
      daily: Array<{ _id: string; completed: number; failed: number; costUsd: number }>;
      byAgent: Group<string | null>[];
      byModel: Group<{ providerId: string | null; modelId: string | null }>[];
      byProject: Group<unknown>[];
    }>([
      { $match: { ...scope, status: { $in: ['COMPLETED', 'FAILED'] }, completedAt: { $gte: since } } },
      {
        $facet: {
          totals: [{ $group: { _id: null, ...figures } }],
          daily: [{ $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'UTC' } }, completed: figures.completed, failed: figures.failed, costUsd: figures.costUsd } }],
          byAgent: [{ $group: { _id: '$agentId', ...figures } }, { $sort: { finished: -1 } }, { $limit: 20 }],
          byModel: [{ $group: { _id: { providerId: '$providerId', modelId: '$modelId' }, ...figures } }, { $sort: { finished: -1 } }, { $limit: 30 }],
          byProject: [{ $group: { _id: '$projectId', ...figures } }, { $sort: { finished: -1 } }, { $limit: 50 }],
        },
      },
    ]);
    const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
    const shape = (g: Omit<Group<unknown>, '_id'>) => ({
      finished: g.finished,
      completed: g.completed,
      failed: g.failed,
      successRate: ratio(g.completed, g.finished),
      firstPassRate: ratio(g.firstPass, g.completed),
      avgRemediations: g.finished ? g.remediations / g.finished : 0,
      costUsd: g.costUsd,
      costPerCompletedUsd: ratio(g.costUsd, g.completed),
      avgActiveMs: ratio(g.activeMs, g.completed),
      avgLeadMs: ratio(g.leadMs, g.completed),
    });
    const empty = { finished: 0, completed: 0, failed: 0, firstPass: 0, remediations: 0, costUsd: 0, activeMs: 0, leadMs: 0 };
    const byDay = new Map((facets?.daily ?? []).map((d) => [d._id, d]));
    const projectNames = new Map((await Project.find({ _id: { $in: (facets?.byProject ?? []).map((p) => p._id) } }, { name: 1 }).lean()).map((p) => [String(p._id), p.name]));
    return {
      since: since.toISOString(),
      days: q.days,
      totals: { ...shape(facets?.totals[0] ?? empty), created: await Task.countDocuments({ ...scope, createdAt: { $gte: since } }) },
      daily: Array.from({ length: q.days }, (_, i) => {
        const date = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
        const d = byDay.get(date);
        return { date, completed: d?.completed ?? 0, failed: d?.failed ?? 0, costUsd: d?.costUsd ?? 0 };
      }),
      byAgent: (facets?.byAgent ?? []).map((g) => ({ agentId: g._id ?? 'none', ...shape(g) })),
      byModel: (facets?.byModel ?? []).map((g) => ({ providerId: g._id.providerId ?? 'none', modelId: g._id.modelId ?? 'none', ...shape(g) })),
      byProject: (facets?.byProject ?? []).map((g) => ({ projectId: String(g._id), name: projectNames.get(String(g._id)) ?? 'deleted project', ...shape(g) })),
    };
  }

  // ── Organization provider configuration (models & policy; credentials stay on workers) ──
  async listProviders(actor: Actor) {
    requirePermission(actor, 'provider.read');
    const ps = await ProviderConfig.find({ organizationId: oid(actor.organizationId) }).lean();
    return ps.map((p) => ({ id: String(p._id), organizationId: String(p.organizationId), providerId: p.providerId, kind: p.kind, name: p.name, baseUrl: p.baseUrl ?? null, enabled: p.enabled, models: p.models ?? [], createdAt: p.createdAt.toISOString() }));
  }

  async upsertProvider(actor: Actor, input: { providerId: string; kind: string; name: string; baseUrl?: string | null; enabled?: boolean; models?: unknown[] }) {
    requirePermission(actor, 'provider.manage');
    await ProviderConfig.updateOne(
      { organizationId: oid(actor.organizationId), providerId: input.providerId },
      { $set: { kind: input.kind, name: input.name, baseUrl: input.baseUrl ?? null, enabled: input.enabled ?? true, models: input.models ?? [] } },
      { upsert: true },
    );
    await audit(actor, 'provider.upsert', { type: 'provider', id: input.providerId }, { kind: input.kind, baseUrl: input.baseUrl });
    return this.listProviders(actor);
  }

  async deleteProvider(actor: Actor, providerId: string) {
    requirePermission(actor, 'provider.manage');
    await ProviderConfig.deleteOne({ organizationId: oid(actor.organizationId), providerId });
    await audit(actor, 'provider.delete', { type: 'provider', id: providerId });
  }

  // ── Control-plane secrets (encrypted at rest, only masked values leave the server) ──
  async listSecrets(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    const s = await Secret.find({ organizationId: oid(actor.organizationId) }).lean();
    return s.map((x) => ({ name: x.name, masked: x.masked, updatedAt: x.updatedAt.toISOString() }));
  }

  async putSecret(actor: Actor, name: string, value: string) {
    requirePermission(actor, 'settings.manage');
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw new AppError('VALIDATION_FAILED', 'Secret names must be UPPER_SNAKE_CASE');
    try {
      await Secret.updateOne(
        { organizationId: oid(actor.organizationId), name },
        { $set: { valueEnc: this.box.encrypt(value), masked: maskSecret(value), createdBy: oid(actor.userId) } },
        { upsert: true },
      );
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
    }
    await audit(actor, 'secret.put', { type: 'secret', id: name });
    return { name, masked: maskSecret(value) };
  }

  async deleteSecret(actor: Actor, name: string) {
    requirePermission(actor, 'settings.manage');
    await Secret.deleteOne({ organizationId: oid(actor.organizationId), name });
    await audit(actor, 'secret.delete', { type: 'secret', id: name });
  }
}
