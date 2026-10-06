import { AppError, STOPPED_TASK_STATUSES } from '@ao/core';
import { Project, Task, UsageRecord, User, Worker, WorkerDailyStat, oid } from '@ao/database';
import type { AnalyticsCostDto, AnalyticsDto, AnalyticsFlowDto, AnalyticsReliabilityDto, AnalyticsWorkersDto } from '@ao/contracts';
import { requirePermission, type Actor } from './context.js';
import { budgetPeriod, type BudgetService } from './budget.service.js';

const DAY_MS = 86_400_000;
/** Completed tasks the time percentiles are computed from, most recent first. */
const MAX_TIME_SAMPLES = 50_000;

export interface AnalyticsQuery {
  days: number;
  projectId?: string;
}

/** Outcome figures of finished tasks, as accumulators of a `$group` stage. */
const FIGURES = {
  finished: { $sum: 1 },
  completed: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } },
  failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
  firstPass: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'COMPLETED'] }, { $eq: [{ $ifNull: ['$remediationCount', 0] }, 0] }] }, 1, 0] } },
  remediations: { $sum: { $ifNull: ['$remediationCount', 0] } },
  costUsd: { $sum: { $ifNull: ['$usage.costUsd', 0] } },
  activeMs: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, { $ifNull: ['$activeMs', 0] }, 0] } },
  leadMs: { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, { $subtract: ['$completedAt', '$createdAt'] }, 0] } },
};
type Sums = { finished: number; completed: number; failed: number; firstPass: number; remediations: number; costUsd: number; activeMs: number; leadMs: number };
type Group<K> = Sums & { _id: K };
const NO_SUMS: Sums = { finished: 0, completed: 0, failed: 0, firstPass: 0, remediations: 0, costUsd: 0, activeMs: 0, leadMs: 0 };

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
const shape = (g: Sums) => ({
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
/** A `$facet` branch: the figures per value of `by`, most finished tasks first. */
const figuresBy = (by: unknown, limit: number) => [{ $group: { _id: by, ...FIGURES } }, { $sort: { finished: -1 as const } }, { $limit: limit }];

/** Spend of usage records, as accumulators of a `$group` stage. Only an ended agent session is a session. */
const SPEND = {
  costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
  inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
  outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
  sessions: { $sum: { $cond: [{ $eq: ['$kind', 'execution'] }, 1, 0] } },
};
type Spend = { costUsd: number; inputTokens: number; outputTokens: number; sessions: number };
const NO_SPEND: Spend = { costUsd: 0, inputTokens: 0, outputTokens: 0, sessions: 0 };
const spend = (g: Spend): Spend => ({ costUsd: g.costUsd, inputTokens: g.inputTokens, outputTokens: g.outputTokens, sessions: g.sessions });
const spendBy = (by: unknown, limit: number) => [{ $group: { _id: by, ...SPEND } }, { $sort: { costUsd: -1 as const, sessions: -1 as const } }, { $limit: limit }];

const dayOf = { format: '%Y-%m-%d', timezone: 'UTC' };
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Average, median and 90th percentile (nearest rank) of durations; nulls when there are none. */
export function durationStats(values: number[]) {
  if (!values.length) return { avgMs: null, p50Ms: null, p90Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return { avgMs: sorted.reduce((a, v) => a + v, 0) / sorted.length, p50Ms: at(0.5), p90Ms: at(0.9) };
}

/**
 * Rows as a CSV file (RFC 4180), the columns in the order the rows name them. Text that a spreadsheet
 * would run as a formula gets a leading apostrophe.
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v == null) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/** One table (an array of rows) of an analytics view, as CSV. */
export function analyticsCsv(view: object, table: string | undefined) {
  const tables = Object.entries(view).filter(([, v]) => Array.isArray(v));
  const rows = tables.find(([k]) => k === table)?.[1] as Array<Record<string, unknown>> | undefined;
  if (!rows) throw new AppError('VALIDATION_FAILED', `table must be one of: ${tables.map(([k]) => k).join(', ')}`);
  return toCsv(rows);
}

/**
 * Analytics over finished tasks, agent sessions and workers. Everything is aggregated from the tasks and
 * usage records when asked; nothing is precomputed. Periods are whole UTC days, today included.
 */
export class AnalyticsService {
  constructor(private budgets: BudgetService) {}

  private period(actor: Actor, q: AnalyticsQuery, now: Date) {
    requirePermission(actor, 'task.read');
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (q.days - 1)));
    const scope = { organizationId: oid(actor.organizationId), ...(q.projectId ? { projectId: oid(q.projectId, 'Project') } : {}) };
    // Up to `now`: a caller that asks about a past moment gets nothing that happened after it.
    return { since, during: { $gte: since, $lte: now }, previousSince: new Date(since.getTime() - q.days * DAY_MS), scope, head: { since: since.toISOString(), days: q.days } };
  }

  /** Every day of the period, oldest first, with the day's row (or `empty`). */
  private days<T extends { _id: string }, R>(since: Date, days: number, rows: T[], pick: (row: T | undefined) => R) {
    const byDay = new Map(rows.map((r) => [r._id, r]));
    return Array.from({ length: days }, (_, i) => {
      const date = isoDay(new Date(since.getTime() + i * DAY_MS));
      return { date, ...pick(byDay.get(date)) };
    });
  }

  /**
   * Outcomes of the tasks that finished in the last `days` days: success and first-pass rates, cost and
   * time, in total, per day and by agent, model and project. A task counts for the agent and model it
   * finished on.
   */
  async overview(actor: Actor, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsDto> {
    const { since, during, previousSince, scope, head } = this.period(actor, q, now);
    const finished = { ...scope, status: { $in: ['COMPLETED', 'FAILED'] } };
    const [[facets], [previous], created, previousCreated] = await Promise.all([
      Task.aggregate<{
        totals: Group<null>[];
        daily: Array<{ _id: string; completed: number; failed: number; costUsd: number }>;
        byAgent: Group<string | null>[];
        byModel: Group<{ providerId: string | null; modelId: string | null }>[];
        byProject: Group<unknown>[];
      }>([
        { $match: { ...finished, completedAt: during } },
        {
          $facet: {
            totals: [{ $group: { _id: null, ...FIGURES } }],
            daily: [{ $group: { _id: { $dateToString: { ...dayOf, date: '$completedAt' } }, completed: FIGURES.completed, failed: FIGURES.failed, costUsd: FIGURES.costUsd } }],
            byAgent: figuresBy('$agentId', 20),
            byModel: figuresBy({ providerId: '$providerId', modelId: '$modelId' }, 30),
            byProject: figuresBy('$projectId', 50),
          },
        },
      ]),
      Task.aggregate<Group<null>>([{ $match: { ...finished, completedAt: { $gte: previousSince, $lt: since } } }, { $group: { _id: null, ...FIGURES } }]),
      Task.countDocuments({ ...scope, createdAt: during }),
      Task.countDocuments({ ...scope, createdAt: { $gte: previousSince, $lt: since } }),
    ]);
    const projectNames = await this.projectNames((facets?.byProject ?? []).map((p) => p._id));
    return {
      ...head,
      totals: { ...shape(facets?.totals[0] ?? NO_SUMS), created },
      previous: { ...shape(previous ?? NO_SUMS), created: previousCreated },
      daily: this.days(since, q.days, facets?.daily ?? [], (d) => ({ completed: d?.completed ?? 0, failed: d?.failed ?? 0, costUsd: d?.costUsd ?? 0 })),
      byAgent: (facets?.byAgent ?? []).map((g) => ({ agentId: g._id ?? 'none', ...shape(g) })),
      byModel: (facets?.byModel ?? []).map((g) => ({ providerId: g._id.providerId ?? 'none', modelId: g._id.modelId ?? 'none', ...shape(g) })),
      byProject: (facets?.byProject ?? []).map((g) => ({ projectId: String(g._id), name: projectNames.get(String(g._id)) ?? 'deleted project', ...shape(g) })),
    };
  }

  /** Spend by the day an agent session ended, where it went, and this month's budgets with a forecast. */
  async cost(actor: Actor, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsCostDto> {
    const { since, during, previousSince, scope, head } = this.period(actor, q, now);
    type G<K> = Spend & { _id: K };
    const [[facets], [previous], budget] = await Promise.all([
      UsageRecord.aggregate<{
        totals: G<null>[];
        daily: G<string>[];
        byProject: G<unknown>[];
        byModel: G<{ providerId: string | null; modelId: string | null }>[];
        byAgent: G<string | null>[];
        byKind: Array<G<string> & { count: number; durationMs: number }>;
        topTasks: G<unknown>[];
      }>([
        { $match: { ...scope, createdAt: during } },
        {
          $facet: {
            totals: [{ $group: { _id: null, ...SPEND } }],
            daily: [{ $group: { _id: { $dateToString: { ...dayOf, date: '$createdAt' } }, ...SPEND } }],
            byProject: spendBy('$projectId', 50),
            byModel: spendBy({ providerId: '$providerId', modelId: '$modelId' }, 30),
            byAgent: spendBy('$agentId', 20),
            byKind: [{ $group: { _id: '$kind', ...SPEND, count: { $sum: 1 }, durationMs: { $sum: { $ifNull: ['$durationMs', 0] } } } }, { $sort: { count: -1 } }],
            topTasks: [{ $match: { taskId: { $ne: null } } }, ...spendBy('$taskId', 10), { $match: { costUsd: { $gt: 0 } } }],
          },
        },
      ]),
      UsageRecord.aggregate<G<null>>([{ $match: { ...scope, createdAt: { $gte: previousSince, $lt: since } } }, { $group: { _id: null, ...SPEND } }]),
      this.budgets.status(actor, now),
    ]);
    const [projectNames, tasks] = await Promise.all([
      this.projectNames((facets?.byProject ?? []).map((p) => p._id)),
      Task.find({ _id: { $in: (facets?.topTasks ?? []).map((t) => t._id) }, organizationId: scope.organizationId }, { title: 1, projectId: 1, status: 1 }).lean(),
    ]);
    const taskOf = new Map(tasks.map((t) => [String(t._id), t]));

    // Month-end forecast: the month's spend so far, continued at the same rate (at least a day of it).
    const month = budgetPeriod(now);
    const elapsed = Math.max(DAY_MS, now.getTime() - month.start.getTime());
    const forecast = (spentUsd: number) => (spentUsd * (month.end.getTime() - month.start.getTime())) / elapsed;
    const budgetLine = (scopeName: 'organization' | 'project', projectId: string | null, name: string, l: { limitUsd: number | null; spentUsd: number; state: 'ok' | 'warning' | 'exceeded' }) => ({
      scope: scopeName,
      projectId,
      name,
      limitUsd: l.limitUsd,
      spentUsd: l.spentUsd,
      forecastUsd: forecast(l.spentUsd),
      state: l.state,
      forecastExceeds: l.limitUsd != null && forecast(l.spentUsd) > l.limitUsd,
    });
    return {
      ...head,
      totals: spend(facets?.totals[0] ?? NO_SPEND),
      previous: spend(previous ?? NO_SPEND),
      daily: this.days(since, q.days, facets?.daily ?? [], (d) => ({ costUsd: d?.costUsd ?? 0, inputTokens: d?.inputTokens ?? 0, outputTokens: d?.outputTokens ?? 0 })),
      byProject: (facets?.byProject ?? []).map((g) => ({ projectId: g._id ? String(g._id) : 'none', name: g._id ? (projectNames.get(String(g._id)) ?? 'deleted project') : 'no project', ...spend(g) })),
      byModel: (facets?.byModel ?? []).map((g) => ({ providerId: g._id.providerId ?? 'none', modelId: g._id.modelId ?? 'none', ...spend(g) })),
      byAgent: (facets?.byAgent ?? []).map((g) => ({ agentId: g._id ?? 'none', ...spend(g) })),
      byKind: (facets?.byKind ?? []).map((g) => ({ kind: g._id, count: g.count, costUsd: g.costUsd, inputTokens: g.inputTokens, outputTokens: g.outputTokens, durationMs: g.durationMs })),
      topTasks: (facets?.topTasks ?? []).flatMap((g) => {
        const t = taskOf.get(String(g._id));
        return t ? [{ taskId: String(t._id), title: t.title, projectId: String(t.projectId), status: t.status, costUsd: g.costUsd, inputTokens: g.inputTokens, outputTokens: g.outputTokens }] : [];
      }),
      budgets: [
        ...(q.projectId ? [] : [budgetLine('organization', null, 'Organization', budget.organization)]),
        ...budget.projects.filter((p) => (q.projectId ? p.projectId === q.projectId : p.limitUsd != null || p.spentUsd > 0)).map((p) => budgetLine('project', p.projectId, p.name, p)),
      ],
    };
  }

  /** What each worker did: finished tasks, agent time, cost, time online and how much of it was used. */
  async workers(actor: Actor, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsWorkersDto> {
    const { since, during, scope, head } = this.period(actor, q, now);
    const [workers, finished, stops, usage, online] = await Promise.all([
      Worker.find({ organizationId: scope.organizationId }, { name: 1, status: 1, os: 1, maxConcurrentTasks: 1 }).lean(),
      Task.aggregate<Group<unknown>>([{ $match: { ...scope, status: { $in: ['COMPLETED', 'FAILED'] }, completedAt: during, workerId: { $ne: null } } }, { $group: { _id: '$workerId', ...FIGURES } }]),
      Task.aggregate<{ _id: unknown; stops: number; workerLost: number }>([
        { $match: { ...scope, stoppedAt: during, workerId: { $ne: null } } },
        { $group: { _id: '$workerId', stops: { $sum: 1 }, workerLost: { $sum: { $cond: [{ $eq: ['$failureCategory', 'worker_lost'] }, 1, 0] } } } },
      ]),
      UsageRecord.aggregate<Spend & { _id: unknown; sessionMs: number }>([
        { $match: { ...scope, createdAt: during, workerId: { $ne: null } } },
        { $group: { _id: '$workerId', ...SPEND, sessionMs: { $sum: { $cond: [{ $eq: ['$kind', 'execution'] }, { $ifNull: ['$durationMs', 0] }, 0] } } } },
      ]),
      WorkerDailyStat.aggregate<{ _id: unknown; onlineMs: number }>([{ $match: { organizationId: scope.organizationId, date: { $gte: isoDay(since), $lte: isoDay(now) } } }, { $group: { _id: '$workerId', onlineMs: { $sum: '$onlineMs' } } }]),
    ]);
    const key = <T extends { _id: unknown }>(rows: T[]) => new Map(rows.map((r) => [String(r._id), r]));
    const [finishedOf, stopsOf, usageOf, onlineOf, workerOf] = [key(finished), key(stops), key(usage), key(online), key(workers)];
    const periodMs = now.getTime() - since.getTime();
    // Workers of the organization, and removed ones that still have work in the period.
    const ids = [...new Set([...workerOf.keys(), ...finishedOf.keys(), ...usageOf.keys(), ...stopsOf.keys()])];
    const rows = ids.map((id) => {
      const w = workerOf.get(id);
      const f = shape(finishedOf.get(id) ?? NO_SUMS);
      const u = usageOf.get(id);
      const onlineMs = onlineOf.get(id)?.onlineMs ?? null;
      return {
        workerId: id,
        name: w?.name ?? 'removed worker',
        status: w?.status ?? 'REMOVED',
        os: w?.os ?? '',
        finished: f.finished,
        completed: f.completed,
        failed: f.failed,
        successRate: f.successRate,
        firstPassRate: f.firstPassRate,
        avgActiveMs: f.avgActiveMs,
        costUsd: u?.costUsd ?? 0,
        sessions: u?.sessions ?? 0,
        sessionMs: u?.sessionMs ?? 0,
        onlineMs,
        onlineShare: onlineMs == null || periodMs <= 0 ? null : Math.min(1, onlineMs / periodMs),
        utilization: onlineMs ? Math.min(1, (u?.sessionMs ?? 0) / (onlineMs * Math.max(1, w?.maxConcurrentTasks ?? 1))) : null,
        stops: stopsOf.get(id)?.stops ?? 0,
        workerLost: stopsOf.get(id)?.workerLost ?? 0,
      };
    });
    return { ...head, workers: rows.sort((a, b) => b.finished - a.finished || b.sessionMs - a.sessionMs || a.name.localeCompare(b.name)) };
  }

  /** What went wrong: why tasks stopped, how often agents needed a recovery, and which checks fail. */
  async reliability(actor: Actor, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsReliabilityDto> {
    const { since, during, previousSince, scope, head } = this.period(actor, q, now);
    const counters = {
      finished: { $sum: 1 },
      limitHits: { $sum: { $ifNull: ['$limitHitCount', 0] } },
      fallbacks: { $sum: { $cond: [{ $gte: [{ $ifNull: ['$fallbackStep', -1] }, 0] }, 1, 0] } },
      contextResets: { $sum: { $ifNull: ['$contextResetCount', 0] } },
      restarts: { $sum: { $ifNull: ['$restartCount', 0] } },
      remediations: { $sum: { $ifNull: ['$remediationCount', 0] } },
    };
    type Counters = { finished: number; limitHits: number; fallbacks: number; contextResets: number; restarts: number; remediations: number };
    const stillStopped = { $sum: { $cond: [{ $in: ['$status', [...STOPPED_TASK_STATUSES]] }, 1, 0] } };
    const recovered = { $sum: { $cond: [{ $eq: ['$status', 'COMPLETED'] }, 1, 0] } };
    const [[finished], [stopped], previousStops, steps] = await Promise.all([
      Task.aggregate<{ totals: Array<Counters>; byAgent: Array<Counters & { _id: string | null }> }>([
        { $match: { ...scope, status: { $in: ['COMPLETED', 'FAILED'] }, completedAt: during } },
        { $facet: { totals: [{ $group: { _id: null, ...counters } }], byAgent: [{ $group: { _id: '$agentId', ...counters } }, { $sort: { finished: -1 } }, { $limit: 20 }] } },
      ]),
      Task.aggregate<{ byCategory: Array<{ _id: string | null; stops: number; stillStopped: number; recovered: number }>; daily: Array<{ _id: string; stops: number }> }>([
        { $match: { ...scope, stoppedAt: during } },
        {
          $facet: {
            byCategory: [{ $group: { _id: '$failureCategory', stops: { $sum: 1 }, stillStopped, recovered } }, { $sort: { stops: -1 } }],
            daily: [{ $group: { _id: { $dateToString: { ...dayOf, date: '$stoppedAt' } }, stops: { $sum: 1 } } }],
          },
        },
      ]),
      Task.countDocuments({ ...scope, stoppedAt: { $gte: previousSince, $lt: since } }),
      Task.aggregate<{ _id: { name: string; kind: string }; runs: number; failed: number; durationMs: number }>([
        { $match: { ...scope, $or: [{ completedAt: during }, { stoppedAt: during }] } },
        { $project: { verificationRuns: 1 } },
        { $unwind: '$verificationRuns' },
        { $unwind: '$verificationRuns.steps' },
        { $match: { 'verificationRuns.steps.status': { $ne: 'skipped' } } },
        {
          $group: {
            _id: { name: '$verificationRuns.steps.name', kind: '$verificationRuns.steps.kind' },
            runs: { $sum: 1 },
            failed: { $sum: { $cond: [{ $in: ['$verificationRuns.steps.status', ['failed', 'error']] }, 1, 0] } },
            durationMs: { $sum: { $ifNull: ['$verificationRuns.steps.durationMs', 0] } },
          },
        },
        { $sort: { failed: -1, runs: -1 } },
        { $limit: 50 },
      ]),
    ]);
    const pick = (c: Counters | undefined) => ({
      finished: c?.finished ?? 0,
      limitHits: c?.limitHits ?? 0,
      fallbacks: c?.fallbacks ?? 0,
      contextResets: c?.contextResets ?? 0,
      restarts: c?.restarts ?? 0,
      remediations: c?.remediations ?? 0,
    });
    const byCategory = (stopped?.byCategory ?? []).map((c) => ({ category: c._id ?? 'other', stops: c.stops, stillStopped: c.stillStopped, recovered: c.recovered }));
    const sum = (k: 'stops' | 'stillStopped' | 'recovered') => byCategory.reduce((a, c) => a + c[k], 0);
    return {
      ...head,
      totals: { ...pick(finished?.totals[0]), stops: sum('stops'), previousStops, stillStopped: sum('stillStopped'), recovered: sum('recovered') },
      daily: this.days(since, q.days, stopped?.daily ?? [], (d) => ({ stops: d?.stops ?? 0 })),
      byCategory,
      byAgent: (finished?.byAgent ?? []).map((g) => ({ agentId: g._id ?? 'none', ...pick(g) })),
      verificationSteps: steps.map((s) => ({ name: String(s._id.name ?? ''), kind: String(s._id.kind ?? ''), runs: s.runs, failed: s.failed, failureRate: ratio(s.failed, s.runs), avgDurationMs: ratio(s.durationMs, s.runs) })),
    };
  }

  /** How long completed tasks waited and took, and who and what the finished tasks came from. */
  async flow(actor: Actor, q: AnalyticsQuery, now = new Date()): Promise<AnalyticsFlowDto> {
    const { since, during, scope, head } = this.period(actor, q, now);
    const [[facets], samples] = await Promise.all([
      Task.aggregate<{ byCreator: Group<unknown>[]; bySource: Group<string>[]; byKind: Group<string>[]; byPriority: Group<string>[] }>([
        { $match: { ...scope, status: { $in: ['COMPLETED', 'FAILED'] }, completedAt: during } },
        {
          $facet: {
            byCreator: figuresBy('$createdBy', 50),
            bySource: figuresBy({ $ifNull: ['$source.kind', 'manual'] }, 20),
            byKind: figuresBy({ $ifNull: ['$kind', 'code'] }, 10),
            byPriority: figuresBy('$priority', 10),
          },
        },
      ]),
      Task.find({ ...scope, status: 'COMPLETED', completedAt: during }, { createdAt: 1, startedAt: 1, completedAt: 1, activeMs: 1 })
        .sort({ completedAt: -1 })
        .limit(MAX_TIME_SAMPLES + 1)
        .lean(),
    ]);
    const used = samples.slice(0, MAX_TIME_SAMPLES);
    const users = await User.find({ _id: { $in: (facets?.byCreator ?? []).map((c) => c._id) } }, { name: 1, email: 1 }).lean();
    const userName = new Map(users.map((u) => [String(u._id), u.name || u.email]));
    const positive = (values: Array<number | null>) => values.filter((v): v is number => v != null && v >= 0);
    return {
      ...head,
      samples: used.length,
      capped: samples.length > MAX_TIME_SAMPLES,
      times: {
        startWait: durationStats(positive(used.map((t) => (t.startedAt ? t.startedAt.getTime() - t.createdAt.getTime() : null)))),
        active: durationStats(positive(used.map((t) => t.activeMs ?? 0))),
        lead: durationStats(positive(used.map((t) => (t.completedAt ? t.completedAt.getTime() - t.createdAt.getTime() : null)))),
      },
      byCreator: (facets?.byCreator ?? []).map((g) => ({ userId: String(g._id), name: userName.get(String(g._id)) ?? 'removed user', ...shape(g) })),
      bySource: (facets?.bySource ?? []).map((g) => ({ source: g._id, ...shape(g) })),
      byKind: (facets?.byKind ?? []).map((g) => ({ kind: g._id, ...shape(g) })),
      byPriority: (facets?.byPriority ?? []).map((g) => ({ priority: g._id ?? 'NORMAL', ...shape(g) })),
    };
  }

  private async projectNames(ids: unknown[]) {
    const projects = await Project.find({ _id: { $in: ids.filter(Boolean) } }, { name: 1 }).lean();
    return new Map(projects.map((p) => [String(p._id), p.name]));
  }
}
