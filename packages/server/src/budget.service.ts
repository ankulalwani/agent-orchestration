import { resolvePolicy, type PolicyLayer } from '@ao/core';
import { BudgetAlert, Organization, Project, Setting, UsageRecord, isDuplicateKeyError, mongoose, oid } from '@ao/database';
import type { BudgetStatusDto } from '@ao/contracts';
import { requirePermission, type Actor } from './context.js';
import type { NotificationService } from './notifications.js';

export interface BudgetLayers {
  platform: PolicyLayer;
  organization: PolicyLayer;
  project: PolicyLayer;
  task: PolicyLayer;
}

/** Why a task may not start or continue. */
export interface BudgetBlock {
  scope: 'task' | 'project' | 'organization';
  unit: 'usd' | 'tokens';
  limit: number;
  spent: number;
  message: string;
}

type BudgetTask = { _id: mongoose.Types.ObjectId; organizationId: mongoose.Types.ObjectId; projectId: mongoose.Types.ObjectId; usage?: { costUsd?: number; inputTokens?: number; outputTokens?: number } | null };

/** The calendar month (UTC) that monthly limits cover. */
export function budgetPeriod(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const lower = (a: number | null, b: number | null) => (a == null ? b : b == null ? a : Math.min(a, b));
const RAISE = 'Raise the limit in the execution policy, then retry the task.';

/**
 * Spend budgets: limits from the execution policy against the spend that agents and providers report.
 * Spend is known when an agent session ends, so a single session can overshoot a limit; the task is
 * stopped before its next session.
 */
export class BudgetService {
  constructor(private notifications: NotificationService) {}

  /**
   * The limits in effect. The organization limit comes from the platform and organization layers, the
   * project limit from those and the project layer, so a narrower layer cannot raise a wider budget.
   * A task's own layer can only lower the task limits.
   */
  limits(layers: BudgetLayers) {
    const org = resolvePolicy(layers.platform, layers.organization).budget;
    const project = resolvePolicy(layers.platform, layers.organization, layers.project).budget;
    const task = resolvePolicy(layers.platform, layers.organization, layers.project, layers.task).budget;
    return {
      organizationMonthlyUsd: org.organizationMonthlyUsd,
      projectMonthlyUsd: project.projectMonthlyUsd,
      taskUsd: lower(project.taskUsd, task.taskUsd),
      taskTokens: lower(project.taskTokens, task.taskTokens),
      warnAt: org.warnAt,
    };
  }

  private async monthSpend(organizationId: mongoose.Types.ObjectId, projectId: mongoose.Types.ObjectId | null, now: Date) {
    const [r] = await UsageRecord.aggregate<{ usd: number }>([
      { $match: { organizationId, ...(projectId ? { projectId } : {}), createdAt: { $gte: budgetPeriod(now).start } } },
      { $group: { _id: null, usd: { $sum: { $ifNull: ['$costUsd', 0] } } } },
    ]);
    return r?.usd ?? 0;
  }

  /** The limit that keeps this task from starting or continuing, if any. */
  async check(task: BudgetTask, layers: BudgetLayers, now = new Date()): Promise<BudgetBlock | null> {
    const l = this.limits(layers);
    const cost = task.usage?.costUsd ?? 0;
    const tokens = (task.usage?.inputTokens ?? 0) + (task.usage?.outputTokens ?? 0);
    if (l.taskUsd != null && cost >= l.taskUsd) {
      return { scope: 'task', unit: 'usd', limit: l.taskUsd, spent: cost, message: `Task budget reached: spent ${usd(cost)} of ${usd(l.taskUsd)}. ${RAISE}` };
    }
    if (l.taskTokens != null && tokens >= l.taskTokens) {
      return { scope: 'task', unit: 'tokens', limit: l.taskTokens, spent: tokens, message: `Task budget reached: used ${tokens} of ${l.taskTokens} tokens. ${RAISE}` };
    }
    if (l.projectMonthlyUsd != null) {
      const spent = await this.monthSpend(task.organizationId, task.projectId, now);
      if (spent >= l.projectMonthlyUsd) {
        return { scope: 'project', unit: 'usd', limit: l.projectMonthlyUsd, spent, message: `Project budget for this month reached: spent ${usd(spent)} of ${usd(l.projectMonthlyUsd)}. ${RAISE}` };
      }
    }
    if (l.organizationMonthlyUsd != null) {
      const spent = await this.monthSpend(task.organizationId, null, now);
      if (spent >= l.organizationMonthlyUsd) {
        return { scope: 'organization', unit: 'usd', limit: l.organizationMonthlyUsd, spent, message: `Organization budget for this month reached: spent ${usd(spent)} of ${usd(l.organizationMonthlyUsd)}. ${RAISE}` };
      }
    }
    return null;
  }

  /**
   * After new spend: tell owners and administrators when a monthly limit passes its warning share or
   * is reached. Each notice goes out once per limit and month.
   */
  async notifyThresholds(task: BudgetTask, layers: BudgetLayers, now = new Date()) {
    const l = this.limits(layers);
    const period = budgetPeriod(now);
    const scopes = [
      { scope: 'organization' as const, scopeId: '', limit: l.organizationMonthlyUsd, projectId: null },
      { scope: 'project' as const, scopeId: String(task.projectId), limit: l.projectMonthlyUsd, projectId: task.projectId },
    ];
    for (const s of scopes) {
      if (s.limit == null) continue;
      const spent = await this.monthSpend(task.organizationId, s.projectId, now);
      const level = spent >= s.limit ? 'exceeded' : spent >= s.limit * l.warnAt ? 'warning' : null;
      if (!level) continue;
      try {
        await BudgetAlert.create({ organizationId: task.organizationId, scope: s.scope, scopeId: s.scopeId, period: period.key, level });
      } catch (e) {
        if (isDuplicateKeyError(e)) continue; // already sent this month
        throw e;
      }
      const name = s.projectId ? `Project "${(await Project.findById(s.projectId, { name: 1 }).lean())?.name ?? s.scopeId}"` : 'The organization';
      await this.notifications.notify({
        organizationId: String(task.organizationId),
        type: level === 'exceeded' ? 'budget.exceeded' : 'budget.warning',
        title: level === 'exceeded' ? `Budget reached: ${usd(spent)} of ${usd(s.limit)} this month` : `Budget warning: ${usd(spent)} of ${usd(s.limit)} this month`,
        body:
          level === 'exceeded'
            ? `${name} reached its budget for ${period.key}. Running tasks stop before their next agent session and queued tasks wait until the limit is raised or the month ends.`
            : `${name} has used ${Math.round((spent / s.limit) * 100)}% of its budget for ${period.key}.`,
        roles: ['OWNER', 'ADMIN'],
        email: level === 'exceeded',
      });
    }
  }

  /** This month's spend against the limits, for the dashboard. */
  async status(actor: Actor, now = new Date()): Promise<BudgetStatusDto> {
    requirePermission(actor, 'task.read');
    const orgId = oid(actor.organizationId);
    const period = budgetPeriod(now);
    const [platform, org, projects, spend] = await Promise.all([
      Setting.findOne({ key: 'platform.policy' }).lean(),
      Organization.findById(orgId, { policy: 1 }).lean(),
      Project.find({ organizationId: orgId, archived: { $ne: true } }, { name: 1, policy: 1 }).sort({ name: 1 }).lean(),
      UsageRecord.aggregate<{ _id: mongoose.Types.ObjectId | null; usd: number; inputTokens: number; outputTokens: number }>([
        { $match: { organizationId: orgId, createdAt: { $gte: period.start } } },
        { $group: { _id: '$projectId', usd: { $sum: { $ifNull: ['$costUsd', 0] } }, inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } }, outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } } } },
      ]),
    ]);
    const base = { platform: (platform?.value ?? {}) as PolicyLayer, organization: (org?.policy ?? {}) as PolicyLayer, project: {} as PolicyLayer, task: {} as PolicyLayer };
    const orgLimits = this.limits(base);
    const line = (limitUsd: number | null, s: { usd: number; inputTokens: number; outputTokens: number }) => ({
      limitUsd,
      spentUsd: s.usd,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      state: limitUsd == null ? ('ok' as const) : s.usd >= limitUsd ? ('exceeded' as const) : s.usd >= limitUsd * orgLimits.warnAt ? ('warning' as const) : ('ok' as const),
    });
    const total = spend.reduce((a, s) => ({ usd: a.usd + s.usd, inputTokens: a.inputTokens + s.inputTokens, outputTokens: a.outputTokens + s.outputTokens }), { usd: 0, inputTokens: 0, outputTokens: 0 });
    const byProject = new Map(spend.map((s) => [String(s._id), s]));
    return {
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      warnAt: orgLimits.warnAt,
      organization: line(orgLimits.organizationMonthlyUsd, total),
      projects: projects.map((p) => ({
        projectId: String(p._id),
        name: p.name,
        ...line(this.limits({ ...base, project: (p.policy ?? {}) as PolicyLayer }).projectMonthlyUsd, byProject.get(String(p._id)) ?? { usd: 0, inputTokens: 0, outputTokens: 0 }),
      })),
      task: { limitUsd: orgLimits.taskUsd, limitTokens: orgLimits.taskTokens },
    };
  }
}
