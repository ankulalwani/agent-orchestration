import {
  LEASED_TASK_STATUSES,
  captureError,
  createLogger,
  dependencyReadiness,
  selectWorker,
  type TaskRequirements,
  type TaskStatus,
  type WorkerSnapshot,
} from '@ao/core';
import { Project, Task, Worker, oid } from '@ao/database';
import type { DispatchJob, DispatchQueue } from '@ao/queue';
import type { LiveHub } from './live.js';
import type { Metrics } from './metrics.js';
import type { TaskService } from './task.service.js';
import type { WorkerService } from './worker.service.js';
import { purgeExpiredData } from './retention.js';
import { saturatedTargets } from './concurrency-slots.js';
import { workerCheckouts } from './project.service.js';

const log = createLogger('scheduler');
const NO_WORKER_RETRY_MS = 30_000;

/**
 * Dispatch loop (spec §22, §47). For each ready QUEUED task, picks the best eligible *connected*
 * worker and pushes an offer. The worker then claims atomically; offers are hints, never locks.
 */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private sweeping = false;
  private lastPurge = 0;

  constructor(
    private queue: DispatchQueue,
    private live: LiveHub,
    private tasks: TaskService,
    private workers: WorkerService,
    private metrics: Metrics,
    private intervals: { sweepMs: number },
  ) {}

  start() {
    this.queue.process(async (job) => {
      await this.dispatch(job);
    }, 8);
    const t = setInterval(() => void this.sweep(), this.intervals.sweepMs);
    t.unref?.();
    this.timers.push(t);
    void this.sweep();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.workers.sweepOffline();
      await this.tasks.sweepExpiredLeases();
      await this.tasks.reconcile();
      await this.updateGauges();
      if (Date.now() - this.lastPurge > 3_600_000) {
        this.lastPurge = Date.now();
        await purgeExpiredData();
      }
    } catch (e) {
      log.error({ err: String(e) }, 'sweep failed');
      captureError(e, { tags: { component: 'scheduler.sweep' } });
    } finally {
      this.sweeping = false;
    }
  }

  private async updateGauges() {
    const [online, offline] = await Promise.all([Worker.countDocuments({ status: 'ONLINE' }), Worker.countDocuments({ status: 'OFFLINE' })]);
    this.metrics.workerOnline.set(online);
    this.metrics.workerOffline.set(offline);
    this.metrics.queueDepth.set(await this.queue.depth());
    const byStatus = await Task.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    for (const s of byStatus) this.metrics.tasksByStatus.set({ status: s._id }, s.n);
  }

  /** Returns the chosen worker id, or null. Exposed for tests. */
  async dispatch(job: DispatchJob): Promise<string | null> {
    const task = await Task.findById(oid(job.taskId)).lean();
    if (!task || task.status !== 'QUEUED') return null;

    if (task.dependencies?.length) {
      const deps = await Task.find({ _id: { $in: task.dependencies } }, { status: 1 }).lean();
      const r = dependencyReadiness(task.dependencies.map(String), new Map(deps.map((d) => [String(d._id), d.status as TaskStatus])));
      if (r.state !== 'ready') return null; // cascade re-enqueues on completion
    }

    const policy = await this.tasks.resolvedPolicy(task as never);
    const project = await Project.findById(task.projectId).lean();
    if (!project) return null;
    if ((project.activeTaskIds?.length ?? 0) >= policy.concurrency.perProject) {
      await Task.updateOne({ _id: task._id, status: 'QUEUED' }, { statusReason: 'Waiting for another task in this project to finish' });
      return null; // slot release re-enqueues
    }

    const workers = await Worker.find({ organizationId: task.organizationId, status: 'ONLINE', approved: true }).lean();
    const connected = workers.filter((w) => this.live.isWorkerConnected(String(w._id)));
    const active = await Task.aggregate<{ _id: unknown; n: number }>([
      { $match: { workerId: { $in: connected.map((w) => w._id) }, status: { $in: LEASED_TASK_STATUSES } } },
      { $group: { _id: '$workerId', n: { $sum: 1 } } },
    ]);
    const activeBy = new Map(active.map((a) => [String(a._id), a.n]));

    // A worker has the project only with a checkout of every repository (agents see them side by side).
    const checkoutsBy = new Map(
      connected.map((w) => {
        const c = workerCheckouts(project, String(w._id));
        return [String(w._id), c.complete ? c.primaryPath : null] as const;
      }),
    );
    const snapshots: WorkerSnapshot[] = connected.map((w) => ({
      id: String(w._id),
      online: true,
      approved: Boolean(w.approved),
      os: w.os as WorkerSnapshot['os'],
      labels: w.labels ?? [],
      cpuCount: (w.metrics as { cpuCount?: number } | null)?.cpuCount,
      freeMemoryMb: (w.metrics as { freeMemoryMb?: number } | null)?.freeMemoryMb,
      freeDiskMb: (w.metrics as { freeDiskMb?: number } | null)?.freeDiskMb ?? undefined,
      activeTaskCount: activeBy.get(String(w._id)) ?? 0,
      maxConcurrentTasks: w.maxConcurrentTasks ?? 1,
      projects: checkoutsBy.get(String(w._id)) ? { [String(project._id)]: checkoutsBy.get(String(w._id))! } : {},
      agents: (w.agents ?? []) as WorkerSnapshot['agents'],
      providers: ((w.providers ?? []) as Array<Record<string, any>>).map((p) => ({
        ...p,
        limitedUntil: p.limitedUntil ? new Date(p.limitedUntil).getTime() : null,
      })) as WorkerSnapshot['providers'],
      tools: w.tools ?? [],
    }));

    const req: TaskRequirements = { projectId: String(project._id), repositoryCount: Math.max(1, project.repositories?.length ?? 1), ...(task.requirements as object) };
    const { selected, evaluations } = selectWorker(snapshots, req, policy, await saturatedTargets(task.organizationId, policy));
    if (!selected) {
      const why = evaluations.length
        ? evaluations
            .map((e) => `${workers.find((w) => String(w._id) === e.workerId)?.name}: missing ${e.checks.filter((c) => !c.ok).map((c) => c.label).join(', ')}`)
            .join('; ')
        : 'No connected workers';
      await Task.updateOne({ _id: task._id, status: 'QUEUED' }, { statusReason: `Waiting for an eligible worker — ${why}`.slice(0, 1000) });
      await this.queue.enqueue(job, { priority: task.priority, queuedAt: task.queuedAt?.getTime(), delayMs: NO_WORKER_RETRY_MS });
      return null;
    }
    const offered = await Task.updateOne(
      { _id: task._id, status: 'QUEUED' },
      { offeredTo: oid(selected), offeredAt: new Date(), statusReason: 'Offered to worker' },
    );
    if (!offered.modifiedCount) return null;
    this.live.sendToWorker(selected, { type: 'task.offer', taskId: String(task._id) });
    await this.tasks.recordEvent(task as never, 'TaskOffered', { workerId: selected }, null);
    return selected;
  }
}
