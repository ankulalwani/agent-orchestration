import { randomBytes } from 'node:crypto';
import { AppError, TERMINAL_TASK_STATUSES, captureError, createLogger, nextCronRun, parseCron, type Role } from '@ao/core';
import { Membership, Project, Schedule, Task, isDuplicateKeyError, oid } from '@ao/database';
import { createTaskRequest, type ScheduleDto, type createScheduleRequest, type updateScheduleRequest } from '@ao/contracts';
import type { z } from 'zod';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';
import type { TaskService } from './task.service.js';

const log = createLogger('schedules');
const MAX_PER_ORGANIZATION = 200;
/** Minutes of an hour a schedule may name: every 5 minutes at most. */
const MAX_MINUTES = 12;

type ScheduleLean = Record<string, any> & { _id: any };

/**
 * Scheduled tasks: a task request that is created again on a cron expression (nightly dependency
 * updates, weekly reviews). Tasks are created on behalf of the member who made the schedule.
 * A run that was missed while the server was down runs once when it is back; earlier ones are not made up.
 */
export class ScheduleService {
  constructor(private tasks: TaskService) {}

  private dto(s: ScheduleLean): ScheduleDto {
    return {
      id: String(s._id),
      organizationId: String(s.organizationId),
      projectId: String(s.projectId),
      name: s.name,
      cron: s.cron,
      timeZone: s.timeZone ?? 'UTC',
      enabled: Boolean(s.enabled),
      overlap: s.overlap ?? 'skip',
      task: s.task,
      createdBy: String(s.createdBy),
      nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
      lastTaskId: s.lastTaskId ? String(s.lastTaskId) : null,
      lastResult: s.lastResult ?? null,
      runCount: s.runCount ?? 0,
      createdAt: new Date(s.createdAt).toISOString(),
    };
  }

  private validate(cron: string, timeZone: string, now: Date) {
    if (parseCron(cron).minutes.size > MAX_MINUTES) throw new AppError('VALIDATION_FAILED', 'A schedule can run every 5 minutes at most');
    return nextCronRun(cron, now, timeZone);
  }

  private async checkProject(actor: Actor, projectId: string) {
    const p = await Project.exists({ _id: oid(projectId, 'Project'), organizationId: oid(actor.organizationId), archived: { $ne: true } });
    if (!p) throw new AppError('NOT_FOUND', 'Project not found');
  }

  private async find(actor: Actor, id: string): Promise<ScheduleLean> {
    const s = (await Schedule.findOne({ _id: oid(id, 'Schedule'), organizationId: oid(actor.organizationId) }).lean()) as ScheduleLean | null;
    if (!s) throw new AppError('NOT_FOUND', 'Schedule not found');
    return s;
  }

  async list(actor: Actor) {
    requirePermission(actor, 'task.read');
    return ((await Schedule.find({ organizationId: oid(actor.organizationId) }).sort({ name: 1 }).lean()) as ScheduleLean[]).map((s) => this.dto(s));
  }

  async create(actor: Actor, input: z.output<typeof createScheduleRequest>, now = new Date()) {
    requirePermission(actor, 'project.update');
    requirePermission(actor, 'task.create');
    await this.checkProject(actor, input.projectId);
    const next = this.validate(input.cron, input.timeZone, now);
    if ((await Schedule.countDocuments({ organizationId: oid(actor.organizationId) })) >= MAX_PER_ORGANIZATION) throw new AppError('VALIDATION_FAILED', `An organization can have ${MAX_PER_ORGANIZATION} schedules`);
    try {
      const doc = await Schedule.create({
        organizationId: oid(actor.organizationId),
        projectId: oid(input.projectId),
        name: input.name,
        cron: input.cron,
        timeZone: input.timeZone,
        enabled: input.enabled,
        overlap: input.overlap,
        task: input.task,
        createdBy: oid(actor.userId),
        nextRunAt: input.enabled ? next : null,
      });
      await audit(actor, 'schedule.create', { type: 'schedule', id: String(doc._id) }, { name: input.name, cron: input.cron, timeZone: input.timeZone, projectId: input.projectId });
      return this.dto(doc.toObject() as ScheduleLean);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A schedule with this name exists');
      throw e;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateScheduleRequest>, now = new Date()) {
    requirePermission(actor, 'project.update');
    const cur = await this.find(actor, id);
    if (input.projectId) await this.checkProject(actor, input.projectId);
    const cron = input.cron ?? cur.cron;
    const timeZone = input.timeZone ?? cur.timeZone ?? 'UTC';
    const enabled = input.enabled ?? Boolean(cur.enabled);
    const next = this.validate(cron, timeZone, now);
    const set: Record<string, unknown> = { nextRunAt: enabled ? next : null };
    for (const k of ['name', 'cron', 'timeZone', 'enabled', 'overlap', 'task'] as const) if (input[k] !== undefined) set[k] = input[k];
    if (input.projectId) set.projectId = oid(input.projectId);
    // Changing what runs makes the editor the member it runs as.
    if (input.task || input.projectId) {
      requirePermission(actor, 'task.create');
      set.createdBy = oid(actor.userId);
    }
    try {
      const doc = (await Schedule.findOneAndUpdate({ _id: cur._id }, { $set: set }, { new: true }).lean()) as ScheduleLean;
      await audit(actor, 'schedule.update', { type: 'schedule', id }, { fields: Object.keys(input) });
      return this.dto(doc);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A schedule with this name exists');
      throw e;
    }
  }

  async remove(actor: Actor, id: string) {
    requirePermission(actor, 'project.update');
    const cur = await this.find(actor, id);
    await Schedule.deleteOne({ _id: cur._id });
    await audit(actor, 'schedule.delete', { type: 'schedule', id }, { name: cur.name });
  }

  /** Creates the schedule's task now, as the caller; the schedule's next run does not move. */
  async runNow(actor: Actor, id: string, now = new Date()) {
    requirePermission(actor, 'task.create');
    const s = await this.find(actor, id);
    const task = await this.createTask(s, actor, now, `sched:${id}:now:${now.getTime()}`);
    await Schedule.updateOne({ _id: s._id }, { $set: { lastRunAt: now, lastTaskId: oid(task.id), lastResult: 'created' }, $inc: { runCount: 1 } });
    await audit(actor, 'schedule.run', { type: 'schedule', id }, { taskId: task.id });
    return task;
  }

  private createTask(s: ScheduleLean, actor: Actor, at: Date, idempotencyKey: string) {
    const date = at.toISOString().slice(0, 10);
    const fill = (text: string) => text.replaceAll('{date}', date);
    const input = createTaskRequest.parse({ ...s.task, title: fill(s.task.title).slice(0, 200), prompt: fill(s.task.prompt), projectId: String(s.projectId), dependencies: [], idempotencyKey });
    return this.tasks.create(actor, input, { source: { scheduleId: String(s._id), kind: 'schedule', name: s.name, url: null, ref: null } });
  }

  /**
   * Runs the schedules that are due. Each is claimed by moving `nextRunAt` forward atomically, so several
   * server instances create one task per run. Called by the scheduler's sweep.
   */
  async runDue(now = new Date()) {
    const due = (await Schedule.find({ enabled: true, nextRunAt: { $lte: now } }).limit(100).lean()) as ScheduleLean[];
    let created = 0;
    for (const s of due) {
      let next: Date | null;
      try {
        next = nextCronRun(s.cron, now, s.timeZone ?? 'UTC');
      } catch {
        next = null; // an expression that can no longer run: the schedule is switched off below
      }
      const claimed = await Schedule.updateOne({ _id: s._id, enabled: true, nextRunAt: s.nextRunAt }, { $set: { nextRunAt: next, lastRunAt: now, ...(next ? {} : { enabled: false }) } });
      if (!claimed.modifiedCount) continue; // another instance has this run
      const result = await this.fire(s).catch((e) => {
        if (!(e instanceof AppError)) captureError(e, { tags: { component: 'schedules' } });
        log.warn({ scheduleId: String(s._id), err: String(e) }, 'scheduled task was not created');
        return { result: `failed: ${(e as Error).message}`.slice(0, 500), taskId: null, disable: false };
      });
      await Schedule.updateOne(
        { _id: s._id },
        { $set: { lastResult: result.result, ...(result.taskId ? { lastTaskId: oid(result.taskId) } : {}), ...(result.disable ? { enabled: false, nextRunAt: null } : {}) }, ...(result.taskId ? { $inc: { runCount: 1 } } : {}) },
      );
      if (result.taskId) created++;
    }
    return created;
  }

  private async fire(s: ScheduleLean): Promise<{ result: string; taskId: string | null; disable: boolean }> {
    if (s.overlap !== 'allow' && s.lastTaskId) {
      // A task waiting for manual recovery does not hold later runs back.
      const previous = await Task.findById(s.lastTaskId, { status: 1 }).lean();
      if (previous && !TERMINAL_TASK_STATUSES.includes(previous.status) && previous.status !== 'RECOVERY_REQUIRED') return { result: 'skipped: the task of the previous run is not finished', taskId: null, disable: false };
    }
    const m = await Membership.findOne({ userId: s.createdBy, organizationId: s.organizationId, suspended: { $ne: true } }).lean();
    if (!m) return { result: 'failed: the member who made this schedule left the organization; save the schedule again to take it over', taskId: null, disable: true };
    const actor: Actor = { userId: String(s.createdBy), organizationId: String(s.organizationId), role: m.role as Role, correlationId: `sched_${randomBytes(6).toString('hex')}` };
    const slot = new Date(s.nextRunAt);
    const task = await this.createTask(s, actor, slot, `sched:${String(s._id)}:${slot.getTime()}`);
    return { result: 'created', taskId: task.id, disable: false };
  }
}
