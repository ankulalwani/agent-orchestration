import {
  AppError,
  SCOPE_RANK,
  parseRef,
  selectForTask,
  type CapabilityManifest,
  type CapabilityScope,
  EPHEMERAL_EVENT_TYPES,
  captureError,
  LEASED_TASK_STATUSES,
  STOPPED_TASK_STATUSES,
  TERMINAL_TASK_STATUSES,
  assertTransition,
  canTransition,
  createLogger,
  dependencyReadiness,
  inferFailureCategory,
  newCorrelationId,
  newId,
  redact,
  resolvePolicy,
  sortByEffectivePriority,
  sourcesFor,
  topoSort,
  validateNewDependencies,
  type PolicyLayer,
  type Priority,
  type TaskEventType,
  type TaskStatus,
} from '@ao/core';
import {
  CapabilityInstallation,
  Capability,
  Organization,
  Project,
  Secret,
  Setting,
  Task,
  TaskEvent,
  UsageRecord,
  Worker,
  isDuplicateKeyError,
  mongoose,
  oid,
} from '@ao/database';
import { createHash } from 'node:crypto';
import type { TaskActionRequest, TaskDto, TransitionRequest, WorkerEvent, createTaskRequest, taskListQuery } from '@ao/contracts';
import { planResult, transitionRequest } from '@ao/contracts';
import type { z } from 'zod';
import type { DispatchQueue } from '@ao/queue';
import { requirePermission, type Actor, type WorkerActor } from './context.js';
import { decodeCursor, encodeCursor, toTaskDto, toTaskEventDto } from './dto.js';
import type { FeatureFlags } from './feature-flags.js';
import type { SecretBox } from './crypto.js';
import { workerCheckouts } from './project.service.js';
import { audit } from './audit.js';
import { reconcileSlots, releaseSlots, reserveSlot, reserveTargetSlots } from './concurrency-slots.js';
import type { LiveHub } from './live.js';
import type { Metrics } from './metrics.js';
import type { NotificationService, NotificationType } from './notifications.js';
import type { BudgetBlock, BudgetService } from './budget.service.js';

const log = createLogger('tasks');
const MAX_APPLIED_IDS = 100;

type TaskLean = Record<string, any> & { _id: mongoose.Types.ObjectId };

export class TaskService {
  constructor(
    private live: LiveHub,
    private queue: DispatchQueue,
    private metrics: Metrics,
    private notifications: NotificationService,
    private features?: FeatureFlags,
    private box?: SecretBox,
    private budgets?: BudgetService,
  ) {}

  // ── Helpers ────────────────────────────────────────────────────────────────
  private async publish(task: TaskLean) {
    this.live.publishToOrg(String(task.organizationId), { type: 'task.updated', task: toTaskDto(task) });
  }

  async recordEvent(task: TaskLean, type: TaskEventType, payload: Record<string, unknown> = {}, workerId?: string | null) {
    const doc = await TaskEvent.create({
      organizationId: task.organizationId,
      taskId: task._id,
      workerId: workerId ? oid(workerId) : null,
      eventId: newId(),
      type,
      timestamp: new Date(),
      payload: redact(payload),
      correlationId: task.correlationId,
      ephemeral: EPHEMERAL_EVENT_TYPES.includes(type),
    });
    this.live.publishToOrg(String(task.organizationId), { type: 'task.event', event: toTaskEventDto(doc.toObject()) });
  }

  async policyLayersFor(task: TaskLean) {
    const [platform, org, project] = await Promise.all([
      Setting.findOne({ key: 'platform.policy' }).lean(),
      Organization.findById(task.organizationId, { policy: 1 }).lean(),
      Project.findById(task.projectId, { policy: 1 }).lean(),
    ]);
    return {
      platform: (platform?.value ?? {}) as PolicyLayer,
      organization: (org?.policy ?? {}) as PolicyLayer,
      project: (project?.policy ?? {}) as PolicyLayer,
      task: (task.policy ?? {}) as PolicyLayer,
    };
  }

  async resolvedPolicy(task: TaskLean) {
    const l = await this.policyLayersFor(task);
    return resolvePolicy(l.platform, l.organization, l.project, l.task);
  }

  /** Workers that run another attempt of the same task right now. */
  async workersWithSiblingAttempt(task: TaskLean): Promise<string[]> {
    if (!task.attempt?.groupId) return [];
    const siblings = await Task.find({ 'attempt.groupId': task.attempt.groupId, _id: { $ne: task._id }, status: { $in: LEASED_TASK_STATUSES }, workerId: { $ne: null } }, { workerId: 1 }).lean();
    return siblings.map((s) => String(s.workerId));
  }

  /** The spend limit that keeps this task from starting or continuing, if any. */
  async budgetBlock(task: TaskLean): Promise<BudgetBlock | null> {
    if (!this.budgets) return null;
    return this.budgets.check(task as never, await this.policyLayersFor(task));
  }

  /**
   * Stops a leased task that reached a spend limit: RECOVERY_REQUIRED, so that Retry continues from the
   * checkpoint once the limit is raised. The worker loses the task (its next request gets LEASE_LOST).
   */
  private async stopForBudget(task: TaskLean, block: BudgetBlock) {
    if (!canTransition(task.status, 'RECOVERY_REQUIRED')) return false;
    const workerId = task.workerId ? String(task.workerId) : null;
    let updated: TaskLean;
    try {
      updated = await this.applyServerTransition(task, 'RECOVERY_REQUIRED', block.message, { $set: { workerId: null, pendingInteraction: null, failureCategory: 'budget' } });
    } catch (e) {
      if (e instanceof AppError && e.code === 'CONFLICT') return false; // the task moved on; the next check catches it
      throw e;
    }
    await this.recordEvent(updated, 'BudgetExceeded', { scope: block.scope, unit: block.unit, limit: block.limit, spent: block.spent }, workerId);
    if (workerId) this.live.sendToWorker(workerId, { type: 'task.control', taskId: String(task._id), action: 'cancel' });
    return true;
  }

  private async enqueue(task: TaskLean, delayMs?: number) {
    try {
      await this.queue.enqueue(
        { taskId: String(task._id), organizationId: String(task.organizationId) },
        { priority: task.priority, queuedAt: task.queuedAt ? new Date(task.queuedAt).getTime() : undefined, delayMs },
      );
    } catch (e) {
      // Queue loss is tolerated: the sweeper re-enqueues QUEUED tasks from Mongo (decision D-003).
      log.warn({ err: String(e), taskId: String(task._id) }, 'enqueue failed; sweeper will retry');
    }
  }

  /** Dispatch the waiting tasks of these projects now (e.g. a worker just got a checkout of them). */
  async redispatchProjects(organizationId: string, projectIds: string[]) {
    const waiting = await Task.find({ organizationId: oid(organizationId), projectId: { $in: projectIds.map((p) => oid(p)) }, status: 'QUEUED', offeredTo: null }).lean();
    for (const t of waiting) await this.enqueue(t as TaskLean);
  }

  // ── User-facing operations ─────────────────────────────────────────────────
  /** Listeners for tasks reaching COMPLETED, FAILED or RECOVERY_REQUIRED (e.g. integration replies). Never block the transition. */
  private finishedListeners: Array<(task: ReturnType<typeof toTaskDto>) => Promise<void>> = [];
  onFinished(fn: (task: ReturnType<typeof toTaskDto>) => Promise<void>) {
    this.finishedListeners.push(fn);
  }

  async findByIdempotencyKey(organizationId: string, key: string) {
    return Task.exists({ organizationId: oid(organizationId), idempotencyKey: key });
  }

  /**
   * Checks that run before a task is created, whatever creates it (a person, a schedule, an integration,
   * a template, a plan). A guard refuses by throwing an AppError. The core registers none: this is for a
   * distribution's own rules (see docs/PUBLIC_PRIVATE_BOUNDARY.md).
   */
  private createGuards: Array<(organizationId: string) => Promise<void>> = [];
  addCreateGuard(guard: (organizationId: string) => Promise<void>) {
    this.createGuards.push(guard);
  }

  async create(actor: Actor, input: z.output<typeof createTaskRequest>, opts: { source?: Record<string, unknown>; parentTaskId?: string; attempt?: Record<string, unknown> } = {}): Promise<TaskDto> {
    requirePermission(actor, 'task.create');
    if (input.attempts?.length) return this.createAttempts(actor, input, opts);
    const orgId = oid(actor.organizationId);
    if (input.idempotencyKey) {
      const existing = await Task.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
      if (existing) return toTaskDto(existing);
    }
    for (const guard of this.createGuards) await guard(actor.organizationId);
    const project = await Project.findOne({ _id: oid(input.projectId, 'Project'), organizationId: orgId, archived: { $ne: true } }).lean();
    if (!project) throw new AppError('NOT_FOUND', 'Project not found');

    const depIds = [...new Set(input.dependencies)];
    const deps = depIds.length ? await Task.find({ _id: { $in: depIds.map((d) => oid(d, 'Dependency')) }, organizationId: orgId }, { _id: 1, status: 1, dependencies: 1 }).lean() : [];
    const newTaskId = new mongoose.Types.ObjectId();
    validateNewDependencies(
      { id: String(newTaskId), dependencies: depIds },
      deps.map((d) => ({ id: String(d._id), dependencies: (d.dependencies ?? []).map(String) })),
    );
    const readiness = dependencyReadiness(depIds, new Map(deps.map((d) => [String(d._id), d.status as TaskStatus])));
    if (input.policy) resolvePolicy(input.policy); // validate early
    if (input.kind === 'review' && !input.review) throw new AppError('VALIDATION_FAILED', 'A review task needs review.base and review.head');
    if (input.environment) {
      const env = (project.environments as Array<{ name: string; requiresApproval?: boolean }>).find((e) => e.name === input.environment);
      if (!env) throw new AppError('VALIDATION_FAILED', `Unknown environment "${input.environment}"`);
    }
    // A follow-up works on the branch of an earlier task of this project, and adds to its pull request.
    let continues: { taskId: mongoose.Types.ObjectId; branch: string; pullRequestUrl: string | null } | null = null;
    if (input.continuesTaskId) {
      if ((input.kind ?? 'code') !== 'code') throw new AppError('VALIDATION_FAILED', 'Only tasks that change code can follow up on another task');
      const earlier = await Task.findOne({ _id: oid(input.continuesTaskId, 'Task'), organizationId: orgId, projectId: project._id }, { gitResult: 1, kind: 1 }).lean();
      if (!earlier) throw new AppError('NOT_FOUND', 'The task to follow up on was not found in this project');
      const branch = (earlier.gitResult as { branch?: string | null; pullRequestUrl?: string | null } | null)?.branch;
      if (!branch) throw new AppError('VALIDATION_FAILED', 'The task to follow up on has no branch (it did not commit on a task branch)');
      continues = { taskId: earlier._id, branch, pullRequestUrl: (earlier.gitResult as { pullRequestUrl?: string | null }).pullRequestUrl ?? null };
    }

    let doc;
    try {
      doc = await Task.create({
        _id: newTaskId,
        organizationId: orgId,
        projectId: project._id,
        title: input.title,
        originalPrompt: input.prompt,
        knowledge: input.knowledge ?? '',
        source: opts.source ?? null,
        parentTaskId: opts.parentTaskId ? oid(opts.parentTaskId) : (continues?.taskId ?? null),
        continues,
        attempt: opts.attempt ?? null,
        kind: input.kind ?? 'code',
        review: input.kind === 'review' ? input.review : null,
        priority: input.priority,
        dependencies: depIds.map((d) => oid(d)),
        requirements: input.requirements,
        policy: {
          ...(input.policy ?? {}),
          ...(input.requirePlanApproval !== undefined ? { requireApprovalFor: { ...(input.policy?.requireApprovalFor ?? {}), plan: input.requirePlanApproval } } : {}),
          ...(input.environment === 'production' ? { requireApprovalFor: { ...(input.policy?.requireApprovalFor ?? {}), production: true } } : {}),
        },
        capabilityIds: input.capabilityIds,
        environment: input.environment ?? null,
        createdBy: oid(actor.userId),
        idempotencyKey: input.idempotencyKey,
        correlationId: newCorrelationId(),
        blockedReason: readiness.state === 'blocked' ? `Dependency ${readiness.reason}: ${readiness.offending.join(', ')}` : null,
      });
    } catch (e) {
      if (isDuplicateKeyError(e) && input.idempotencyKey) {
        const existing = await Task.findOne({ organizationId: orgId, idempotencyKey: input.idempotencyKey }).lean();
        if (existing) return toTaskDto(existing);
      }
      throw e;
    }
    const task = doc.toObject() as TaskLean;
    await this.recordEvent(task, 'TaskCreated', { title: task.title, priority: task.priority, dependencies: depIds, createdBy: actor.userId });
    await audit(actor, 'task.create', { type: 'task', id: String(task._id) }, { projectId: input.projectId, title: input.title });
    this.metrics.tasksCreated.inc();
    await this.publish(task);
    if (readiness.state === 'ready') await this.enqueue(task);
    return toTaskDto(task);
  }

  /**
   * A task that several agents try (`attempts`): one task per attempt, pinned to its agent (and model),
   * in one group. The first attempt to pass verification wins and the others are cancelled
   * (`settleAttempts`). Attempts work in the project's checkout, so each needs a worker of its own;
   * with fewer workers, or a project limit of one task at a time, they run one after another.
   */
  private async createAttempts(actor: Actor, input: z.output<typeof createTaskRequest>, opts: { source?: Record<string, unknown>; parentTaskId?: string }) {
    const attempts = input.attempts!;
    if ((input.kind ?? 'code') !== 'code') throw new AppError('VALIDATION_FAILED', 'Only tasks that change code can be tried by several agents');
    const key = (a: (typeof attempts)[number]) => `${a.agentId}|${a.providerId ?? ''}|${a.modelId ?? ''}`;
    if (new Set(attempts.map(key)).size !== attempts.length) throw new AppError('VALIDATION_FAILED', 'Each attempt needs a different agent or model');
    if (attempts.some((a) => Boolean(a.providerId) !== Boolean(a.modelId))) throw new AppError('VALIDATION_FAILED', 'Give an attempt both a provider and a model, or neither');
    // Derived from the idempotency key when there is one, so a repeated request finds the same group.
    const groupId = input.idempotencyKey ? new mongoose.Types.ObjectId(createHash('sha256').update(`${actor.organizationId}:${input.idempotencyKey}`).digest('hex').slice(0, 24)) : new mongoose.Types.ObjectId();
    const created: TaskDto[] = [];
    for (const [index, a] of attempts.entries()) {
      const policy = {
        ...(input.policy ?? {}),
        agents: { ...(input.policy?.agents ?? {}), allowed: [a.agentId], preferred: [a.agentId] },
        ...(a.providerId && a.modelId ? { models: { ...(input.policy?.models ?? {}), preferred: [{ providerId: a.providerId, modelId: a.modelId }] } } : {}),
      };
      created.push(
        await this.create(
          actor,
          { ...input, attempts: undefined, policy, idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:a${index}`.slice(-100) : undefined },
          { ...opts, attempt: { groupId, index, of: attempts.length, agentId: a.agentId, providerId: a.providerId ?? null, modelId: a.modelId ?? null, winnerTaskId: null } },
        ),
      );
    }
    await audit(actor, 'task.attempts_created', { type: 'task', id: created[0]!.id }, { attempts: attempts.map((a) => a.agentId), taskIds: created.map((t) => t.id) });
    return created[0]!;
  }

  /**
   * An attempt passed verification: it wins, and the attempts still under way are cancelled. When two
   * pass at the same moment, both stay completed and the first to get here is the winner.
   */
  private async settleAttempts(task: TaskLean) {
    const groupId = task.attempt?.groupId;
    if (!groupId) return;
    await Task.updateMany({ 'attempt.groupId': groupId, 'attempt.winnerTaskId': null }, { $set: { 'attempt.winnerTaskId': task._id } });
    const others = (await Task.find({ 'attempt.groupId': groupId, _id: { $ne: task._id }, status: { $nin: [...TERMINAL_TASK_STATUSES] } }).lean()) as TaskLean[];
    for (const other of others) {
      const workerId = other.workerId ? String(other.workerId) : null;
      try {
        const cancelled = await this.applyServerTransition(other, 'CANCELLED', `Another attempt passed verification first (${task.agentId ?? task.attempt.agentId})`);
        await this.recordEvent(cancelled, 'TaskCancelled', { reason: 'attempt_lost', winnerTaskId: String(task._id) });
        if (workerId) this.live.sendToWorker(workerId, { type: 'task.control', taskId: String(other._id), action: 'cancel' });
      } catch (e) {
        // It finished or moved on in the meantime; nothing to cancel.
        if (!(e instanceof AppError)) throw e;
      }
    }
  }

  async list(actor: Actor, q: z.output<typeof taskListQuery>) {
    requirePermission(actor, 'task.read');
    const filter: Record<string, unknown> = { organizationId: oid(actor.organizationId) };
    if (q.attemptGroupId && /^[a-f0-9]{24}$/i.test(q.attemptGroupId)) filter['attempt.groupId'] = oid(q.attemptGroupId);
    if (q.projectId) filter.projectId = oid(q.projectId, 'Project');
    if (q.workerId) filter.workerId = oid(q.workerId, 'Worker');
    if (q.status?.length) filter.status = { $in: q.status };
    if (q.q) filter.$text = { $search: q.q };
    const cur = decodeCursor(q.cursor);
    if (cur) filter.$or = [{ createdAt: { $lt: cur.t } }, { createdAt: cur.t, _id: { $lt: oid(cur.id) } }];
    const docs = await Task.find(filter).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).lean();
    const items = docs.slice(0, q.limit);
    return { items: items.map(toTaskDto), nextCursor: docs.length > q.limit ? encodeCursor(items[items.length - 1]!) : null };
  }

  async getLean(organizationId: string, id: string): Promise<TaskLean> {
    const t = await Task.findOne({ _id: oid(id, 'Task'), organizationId: oid(organizationId) }).lean();
    if (!t) throw new AppError('NOT_FOUND', 'Task not found');
    return t as TaskLean;
  }

  /**
   * Creates the tasks a completed plan proposes (FUT-001), in dependency order, with dependencies
   * between them. Idempotent: applying twice (or concurrently) returns the same tasks.
   */
  async applyPlan(actor: Actor, id: string) {
    requirePermission(actor, 'task.create');
    const t = await this.getLean(actor.organizationId, id);
    if (t.kind !== 'plan' || t.status !== 'COMPLETED') throw new AppError('VALIDATION_FAILED', 'Only a completed plan task can be applied');
    const parsed = planResult.safeParse(t.completionReport?.plan);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'This task has no valid plan');
    const plan = parsed.data;
    const byKey = new Map(plan.tasks.map((x) => [x.key, x]));
    const created = new Map<string, string>();
    for (const key of topoSort(plan.tasks.map((x) => ({ id: x.key, dependencies: x.dependsOn })))) {
      const item = byKey.get(key)!;
      const task = await this.create(
        actor,
        {
          projectId: String(t.projectId),
          title: item.title,
          prompt: item.prompt,
          priority: item.priority,
          dependencies: item.dependsOn.map((d) => created.get(d)!),
          requirements: {},
          capabilityIds: [],
          knowledge: `This task is part of the plan "${t.title}":\n${plan.summary}`.slice(0, 50_000),
          idempotencyKey: `plan:${id}:${key}`,
        },
        { parentTaskId: id },
      );
      created.set(key, task.id);
    }
    const taskIds = plan.tasks.map((x) => created.get(x.key)!);
    const r = await Task.updateOne({ _id: t._id, planApplied: null }, { $set: { planApplied: { at: new Date(), by: oid(actor.userId), taskIds } } });
    if (r.modifiedCount) await audit(actor, 'task.plan_applied', { type: 'task', id }, { tasks: taskIds.length });
    return { taskIds };
  }

  async get(actor: Actor, id: string) {
    requirePermission(actor, 'task.read');
    return toTaskDto(await this.getLean(actor.organizationId, id));
  }

  /** Timeline, oldest first, paginated by an `after` cursor so large histories are never loaded at once (spec §109). */
  async events(actor: Actor, id: string, opts: { after?: string; limit: number; includeOutput?: boolean }) {
    requirePermission(actor, 'task.read');
    const task = await this.getLean(actor.organizationId, id);
    const filter: Record<string, unknown> = { taskId: task._id, organizationId: task.organizationId };
    if (!opts.includeOutput) filter.ephemeral = { $ne: true };
    if (opts.after && /^[a-f0-9]{24}$/i.test(opts.after)) filter._id = { $gt: oid(opts.after) };
    const docs = await TaskEvent.find(filter).sort({ _id: 1 }).limit(opts.limit + 1).lean();
    const items = docs.slice(0, opts.limit);
    return { items: items.map(toTaskEventDto), nextCursor: docs.length > opts.limit ? String(items[items.length - 1]!._id) : null };
  }

  /** Pause/resume/cancel/retry/restart/input/approve/deny (spec §83, §84). */
  async action(actor: Actor, id: string, req: TaskActionRequest) {
    requirePermission(actor, req.action === 'approve' || req.action === 'deny' ? 'task.approve' : 'task.control');
    const task = await this.getLean(actor.organizationId, id);
    const status = task.status as TaskStatus;
    const workerId = task.workerId ? String(task.workerId) : null;
    await audit(actor, `task.${req.action}`, { type: 'task', id }, { reason: req.reason, from: status });

    switch (req.action) {
      case 'cancel': {
        assertTransition(status, 'CANCELLED', id);
        const updated = await this.applyServerTransition(task, 'CANCELLED', req.reason ?? 'Cancelled by user');
        if (workerId) this.live.sendToWorker(workerId, { type: 'task.control', taskId: id, action: 'cancel' });
        await this.recordEvent(task, 'TaskCancelled', { by: actor.userId, reason: req.reason });
        return toTaskDto(updated);
      }
      case 'retry':
      case 'restart': {
        if (['FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(status)) {
          const updated = await this.applyServerTransition(task, 'QUEUED', req.action === 'retry' ? 'Retried by user' : 'Restarted by user', {
            $inc: { retryCount: 1 },
            $set: {
              blockedReason: null,
              fallbackStep: -1,
              pendingInteraction: null,
              // restart = start fresh; retry = continue from the last checkpoint.
              ...(req.action === 'restart' ? { lastCheckpoint: null, sessionId: null } : {}),
            },
          });
          await this.recordEvent(task, 'TaskRetried', { by: actor.userId, mode: req.action });
          await this.enqueue(updated);
          return toTaskDto(updated);
        }
        if (req.action === 'restart' && workerId && LEASED_TASK_STATUSES.includes(status)) {
          this.requireConnected(workerId);
          this.live.sendToWorker(workerId, { type: 'task.control', taskId: id, action: 'restart' });
          return toTaskDto(task);
        }
        throw new AppError('INVALID_TRANSITION', `Cannot ${req.action} a task that is ${status}`);
      }
      case 'pause':
      case 'resume':
      case 'input':
      case 'approve':
      case 'deny': {
        const allowed: Record<string, TaskStatus[]> = {
          pause: ['RUNNING', 'WAITING_FOR_LIMIT'],
          resume: ['PAUSED', 'WAITING_FOR_LIMIT'],
          input: ['WAITING_FOR_INPUT'],
          approve: ['WAITING_FOR_APPROVAL'],
          deny: ['WAITING_FOR_APPROVAL'],
        };
        if (!allowed[req.action]!.includes(status)) throw new AppError('INVALID_TRANSITION', `Cannot ${req.action} a task that is ${status}`);
        if (req.action === 'input' && !req.input) throw new AppError('VALIDATION_FAILED', 'Input text is required');
        if (!workerId) throw new AppError('CONFLICT', 'Task is not assigned to a worker');
        this.requireConnected(workerId);
        this.live.sendToWorker(workerId, { type: 'task.control', taskId: id, action: req.action, input: req.input });
        if (req.action === 'input') await this.recordEvent(task, 'AgentInputProvided', { by: actor.userId, input: req.input });
        if (req.action === 'approve') await this.recordEvent(task, 'ApprovalGranted', { by: actor.userId });
        if (req.action === 'deny') await this.recordEvent(task, 'ApprovalDenied', { by: actor.userId, reason: req.reason });
        return toTaskDto(task);
      }
    }
  }

  private requireConnected(workerId: string) {
    if (!this.live.isWorkerConnected(workerId)) {
      throw new AppError('CONFLICT', 'The worker running this task is not connected. Try again when it reconnects, or cancel and retry.', { retryable: true });
    }
  }

  /** Server-initiated transition (user actions, sweeper). Atomic on the current status. */
  private async applyServerTransition(task: TaskLean, to: TaskStatus, reason: string, extra: { $set?: Record<string, unknown>; $inc?: Record<string, number> } = {}) {
    assertTransition(task.status, to, String(task._id));
    const releasing = !LEASED_TASK_STATUSES.includes(to);
    const set: Record<string, unknown> = { status: to, statusReason: reason, ...(extra.$set ?? {}) };
    if (releasing) Object.assign(set, { leaseExpiresAt: null, waitingUntil: null, offeredTo: null });
    if (to === 'QUEUED') Object.assign(set, { workerId: null, queuedAt: new Date() });
    if (TERMINAL_TASK_STATUSES.includes(to)) set.completedAt = new Date();
    if (STOPPED_TASK_STATUSES.includes(to)) Object.assign(set, { failureCategory: set.failureCategory ?? inferFailureCategory(task.verificationStatus), stoppedAt: new Date() });
    const updated = await Task.findOneAndUpdate({ _id: task._id, status: task.status }, { $set: set, ...(extra.$inc ? { $inc: extra.$inc } : {}) }, { new: true }).lean();
    if (!updated) throw new AppError('CONFLICT', 'Task changed concurrently; reload and try again', { retryable: true });
    if (releasing) await this.releaseTaskSlots(updated as TaskLean);
    await this.afterStatusChange(task.status, updated as TaskLean);
    return updated as TaskLean;
  }

  // ── Worker-facing operations ───────────────────────────────────────────────
  async offersFor(worker: WorkerActor) {
    // Highest effective priority first, so a worker short on capacity claims the most urgent offer (spec §22).
    const tasks = await Task.find({ offeredTo: oid(worker.workerId), status: 'QUEUED' }, { _id: 1, priority: 1, queuedAt: 1 }).limit(50).lean();
    return sortByEffectivePriority(tasks.map((t) => ({ id: String(t._id), priority: t.priority as Priority, queuedAt: t.queuedAt?.getTime() ?? 0 })))
      .slice(0, 20)
      .map((t) => t.id);
  }

  /**
   * Atomic claim (spec §23). Preconditions: task QUEUED in the worker's org, dependencies complete,
   * worker has the project, project slot available. Only one worker can win.
   */
  async claim(worker: WorkerActor, taskId: string) {
    const w = await Worker.findOne({ _id: oid(worker.workerId), organizationId: oid(worker.organizationId) }).lean();
    if (!w || !w.approved || w.status === 'DISABLED') throw new AppError('FORBIDDEN', 'Worker is not approved');
    const task = (await Task.findOne({ _id: oid(taskId, 'Task'), organizationId: w.organizationId }).lean()) as TaskLean | null;
    if (!task) throw new AppError('NOT_FOUND', 'Task not found');
    if (task.status !== 'QUEUED') return { claimed: false, reason: `Task is ${task.status}` };

    if (task.dependencies?.length) {
      const deps = await Task.find({ _id: { $in: task.dependencies } }, { status: 1 }).lean();
      const r = dependencyReadiness(task.dependencies.map(String), new Map(deps.map((d) => [String(d._id), d.status as TaskStatus])));
      if (r.state !== 'ready') return { claimed: false, reason: r.state === 'waiting' ? 'Dependencies not complete' : `Dependency ${r.reason}` };
    }
    const project = await Project.findById(task.projectId).lean();
    const checkouts = project ? workerCheckouts(project, worker.workerId) : null;
    if (!project || !checkouts?.complete) return { claimed: false, reason: checkouts?.repositories.length ? 'Not every repository of the project is checked out on this worker' : 'Project is not configured on this worker' };

    const layers = await this.policyLayersFor(task);
    const policy = resolvePolicy(layers.platform, layers.organization, layers.project, layers.task);

    const overBudget = await this.budgets?.check(task as never, layers);
    if (overBudget) {
      await Task.updateOne({ _id: task._id, status: 'QUEUED' }, { statusReason: overBudget.message });
      return { claimed: false, reason: overBudget.message };
    }
    // Attempts of one task share the project's checkout on a worker, so a worker runs one at a time.
    if ((await this.workersWithSiblingAttempt(task)).includes(worker.workerId)) return { claimed: false, reason: 'Another attempt of this task runs on this worker' };

    // Atomic organization slot, then atomic project slot.
    if (policy.concurrency.perOrganization > 0 && !(await reserveSlot(task.organizationId, 'organization', '', task._id, policy.concurrency.perOrganization))) {
      return { claimed: false, reason: 'Organization concurrency limit reached' };
    }
    const slot = await Project.updateOne(
      { _id: project._id, $expr: { $lt: [{ $size: { $ifNull: ['$activeTaskIds', []] } }, policy.concurrency.perProject] }, activeTaskIds: { $ne: task._id } },
      { $addToSet: { activeTaskIds: task._id } },
    );
    if (!slot.modifiedCount) {
      await releaseSlots(task._id);
      return { claimed: false, reason: 'Project concurrency limit reached' };
    }

    const leaseExpiresAt = new Date(Date.now() + policy.leaseMs);
    const claimed = (await Task.findOneAndUpdate(
      { _id: task._id, status: 'QUEUED' },
      { $set: { status: 'CLAIMING', statusReason: null, workerId: w._id, leaseExpiresAt, offeredTo: null, blockedReason: null } },
      { new: true },
    ).lean()) as TaskLean | null;
    if (!claimed) {
      await Project.updateOne({ _id: project._id }, { $pull: { activeTaskIds: task._id } });
      await releaseSlots(task._id);
      return { claimed: false, reason: 'Task was claimed by another worker' };
    }
    await this.recordEvent(claimed, 'TaskClaimed', { workerId: worker.workerId, workerName: w.name }, worker.workerId);
    await this.publish(claimed);

    const capabilities = await this.deliverableCapabilities(claimed, worker);
    const knowledge = await knowledgeFor(claimed, project);
    return {
      claimed: true,
      task: toTaskDto(claimed),
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      policyLayers: layers,
      localPath: checkouts.primaryPath!,
      repositories: checkouts.repositories,
      capabilities,
      knowledge,
      features: this.features?.forOrganization(String(claimed.organizationId)) ?? {},
      environment: await this.environmentFor(claimed, project, worker),
    };
  }

  /** For a restarted worker: the claim payload of a task it still owns, so it can continue from checkpoint. */
  async ownedTaskInfo(worker: WorkerActor, taskId: string) {
    const task = (await Task.findOne({ _id: oid(taskId, 'Task'), organizationId: oid(worker.organizationId) }).lean()) as TaskLean | null;
    if (!task) throw new AppError('NOT_FOUND', 'Task not found');
    if (String(task.workerId) !== worker.workerId || !LEASED_TASK_STATUSES.includes(task.status)) return { claimed: false, reason: `Task is ${task.status} and not owned by this worker` };
    const project = await Project.findById(task.projectId).lean();
    const checkouts = project ? workerCheckouts(project, worker.workerId) : null;
    if (!project || !checkouts?.complete) return { claimed: false, reason: checkouts?.repositories.length ? 'Not every repository of the project is checked out on this worker' : 'Project is not configured on this worker' };
    return {
      claimed: true,
      task: toTaskDto(task),
      leaseExpiresAt: task.leaseExpiresAt?.toISOString(),
      policyLayers: await this.policyLayersFor(task),
      localPath: checkouts.primaryPath!,
      repositories: checkouts.repositories,
      capabilities: await this.deliverableCapabilities(task, worker),
      knowledge: await knowledgeFor(task, project),
      features: this.features?.forOrganization(String(task.organizationId)) ?? {},
      environment: await this.environmentFor(task, project, worker),
    };
  }

  /**
   * The task's environment profile (spec §78) for the worker: variables, and the values of the secrets it
   * references, which become environment variables of the agent and verification steps. Each delivery is
   * audited by secret name. A referenced secret that does not exist is reported, never silently empty.
   */
  private async environmentFor(task: TaskLean, project: { environments?: unknown }, worker: WorkerActor) {
    if (!task.environment) return null;
    const profile = ((project.environments ?? []) as Array<{ name: string; variables?: Record<string, string>; secretRefs?: string[]; requiresApproval?: boolean }>).find((e) => e.name === task.environment);
    if (!profile) return null;
    const names = profile.secretRefs ?? [];
    const secrets: Record<string, string> = {};
    const missing: string[] = [];
    if (names.length && this.box) {
      const found = await Secret.find({ organizationId: task.organizationId, name: { $in: names } }).select('+valueEnc').lean();
      for (const n of names) {
        const s = found.find((x) => x.name === n);
        if (s) secrets[n] = this.box.decrypt(s.valueEnc);
        else missing.push(n);
      }
      await audit(worker, 'secret.deliver', { type: 'task', id: String(task._id) }, { environment: profile.name, secrets: Object.keys(secrets) });
    }
    return { name: profile.name, variables: profile.variables ?? {}, secrets, missingSecrets: missing, requiresApproval: Boolean(profile.requiresApproval) };
  }

  /**
   * Capabilities as sent to the worker. Plugins that declare `secrets.read` get their secret
   * configuration references (`secret:NAME`) resolved, only while plugin execution is enabled for the
   * organization; each delivery is audited. Everything else keeps references, never values.
   */
  private async deliverableCapabilities(task: TaskLean, worker: WorkerActor) {
    const caps = await this.effectiveCapabilities(task);
    if (!this.box || !this.features?.enabled('plugins.execution', String(task.organizationId))) return caps;
    for (const c of caps) {
      const m = c.manifest as { id: string; type: string; permissions?: string[] };
      if (m.type !== 'plugin' || !m.permissions?.includes('secrets.read')) continue;
      const config = { ...((c.config as Record<string, unknown>) ?? {}) };
      const refs = Object.entries(config).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].startsWith('secret:'));
      if (!refs.length) continue;
      const secrets = await Secret.find({ organizationId: task.organizationId, name: { $in: refs.map(([, v]) => v.slice(7)) } }).select('+valueEnc').lean();
      for (const [key, ref] of refs) {
        const s = secrets.find((x) => x.name === ref.slice(7));
        config[key] = s ? this.box.decrypt(s.valueEnc) : null;
      }
      c.config = config;
      await audit(worker, 'secret.deliver', { type: 'task', id: String(task._id) }, { plugin: m.id, secrets: refs.map(([, v]) => v.slice(7)) });
    }
    return caps;
  }

  /**
   * Effective capabilities for a task: org + the task creator's own + project + task scopes, active
   * installations only (spec §34), the more specific scope winning. Yanked versions are left out. When
   * there are more skills than fit an agent's prompt, the ones relevant to the task are chosen; skills
   * installed for the task or named in `capabilityIds` always go.
   */
  async effectiveCapabilities(task: TaskLean) {
    const installs = await CapabilityInstallation.find({
      organizationId: task.organizationId,
      status: 'ACTIVE',
      // Disabled ones too: a disabled installation at a narrower scope switches the capability off.
      $or: [{ scope: 'ORGANIZATION' }, { scope: 'USER', userId: task.createdBy }, { scope: 'PROJECT', projectId: task.projectId }, { scope: 'TASK', taskId: task._id }],
    }).lean();
    const caps = installs.length
      ? await Capability.find({ $or: installs.map((i) => ({ capabilityId: i.capabilityId, version: i.version })), status: { $ne: 'YANKED' } }).lean()
      : [];
    const byRef = new Map<string, { manifest: CapabilityManifest; scope: string; config: unknown; pinned: boolean; enabled: boolean }>();
    const requested = new Set<string>(task.capabilityIds ?? []);
    for (const i of installs.sort((a, b) => (SCOPE_RANK[a.scope as CapabilityScope] ?? 0) - (SCOPE_RANK[b.scope as CapabilityScope] ?? 0))) {
      const cap = caps.find((c) => c.capabilityId === i.capabilityId && c.version === i.version);
      if (!cap) continue;
      const manifest = cap.manifest as CapabilityManifest;
      const pinned = i.scope === 'TASK' || requested.has(i.capabilityId) || requested.has(manifest.id);
      byRef.set(i.capabilityId, { manifest, scope: i.scope, config: i.config, pinned, enabled: i.enabled !== false });
    }
    // Two packages from different publishers may share a name; agents and workers key MCP servers and
    // plugins by manifest id, so the later ones get "<namespace>.<name>".
    const seen = new Set<string>();
    const items = [...byRef.entries()].filter(([, c]) => c.enabled).map(([ref, c]) => {
      if (!seen.has(c.manifest.id)) {
        seen.add(c.manifest.id);
        return c;
      }
      const { namespace } = parseRef(ref);
      return { ...c, manifest: { ...c.manifest, id: `${namespace}.${c.manifest.id}`.slice(0, 64) } };
    });
    const stack = (await Project.findById(task.projectId, { 'readiness.stack': 1 }).lean())?.readiness?.stack ?? null;
    const { selected } = selectForTask(items, {
      text: `${task.title ?? ''}\n${task.normalizedPrompt ?? task.originalPrompt ?? ''}\n${task.knowledge ?? ''}`,
      dependencies: stack?.dependencies,
      files: stack?.files,
    });
    return selected.map(({ manifest, scope, config }) => ({ manifest, scope, config }));
  }

  /**
   * Worker-driven transition. Enforces: lease ownership, explicit state machine, idempotency via
   * transitionId, and the verification gate for COMPLETED (spec §21, §43, §105).
   */
  async transition(worker: WorkerActor, taskId: string, raw: TransitionRequest) {
    const req = transitionRequest.parse(raw);
    const id = oid(taskId, 'Task');
    const current = (await Task.findOne({ _id: id, organizationId: oid(worker.organizationId) }).select('+appliedTransitionIds').lean()) as TaskLean | null;
    if (!current) throw new AppError('NOT_FOUND', 'Task not found');
    if ((current.appliedTransitionIds ?? []).includes(req.transitionId)) return toTaskDto(current); // idempotent replay
    if (String(current.workerId) !== worker.workerId) {
      throw new AppError('LEASE_LOST', 'This worker no longer owns the task', { context: { taskId, status: current.status } });
    }
    const p = req.patch;
    const same = current.status === req.to;
    if (!same) assertTransition(current.status, req.to, taskId);
    if (req.to === 'COMPLETED') {
      const vs = p.verificationStatus ?? current.verificationStatus;
      if (!['PASSED', 'SKIPPED'].includes(vs)) {
        throw new AppError('VALIDATION_FAILED', 'A task can only complete after verification passed (or was explicitly skipped by policy)');
      }
      if (!p.completionReport && !current.completionReport) throw new AppError('VALIDATION_FAILED', 'A completion report is required');
    }

    // Spend limits: no new agent session (first run, remediation, resume) once a limit is reached.
    if (!same && req.to === 'RUNNING') {
      const overBudget = await this.budgetBlock(current);
      if (overBudget && (await this.stopForBudget(current, overBudget))) throw new AppError('LEASE_LOST', overBudget.message, { context: { taskId, status: 'RECOVERY_REQUIRED' } });
    }

    const policy = await this.resolvedPolicy(current);
    const releasing = !LEASED_TASK_STATUSES.includes(req.to);
    const set: Record<string, unknown> = { status: req.to };
    if (req.reason !== undefined) set.statusReason = req.reason;
    for (const k of ['agentId', 'providerId', 'modelId', 'sessionId', 'lastCheckpoint', 'verificationStatus', 'gitStatus', 'gitResult', 'completionReport', 'generatedPlan', 'fallbackStep'] as const) {
      if (p[k] !== undefined) set[k] = p[k];
    }
    if (p.pendingInteraction !== undefined) set.pendingInteraction = p.pendingInteraction ? { ...p.pendingInteraction, requestedAt: new Date().toISOString() } : null;
    else if (!['WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL'].includes(req.to)) set.pendingInteraction = null;
    if (p.waitingUntil !== undefined) set.waitingUntil = p.waitingUntil ? new Date(p.waitingUntil) : null;
    else if (req.to !== 'WAITING_FOR_LIMIT') set.waitingUntil = null;
    if (p.progress) for (const [k, v] of Object.entries(p.progress)) set[`progress.${k}`] = v;
    if (req.to === 'RUNNING' && !current.startedAt) set.startedAt = new Date();
    if (TERMINAL_TASK_STATUSES.includes(req.to)) set.completedAt = new Date();
    if (!same && STOPPED_TASK_STATUSES.includes(req.to)) {
      Object.assign(set, { failureCategory: p.failureCategory ?? inferFailureCategory(p.verificationStatus ?? current.verificationStatus), stoppedAt: new Date() });
    }
    if (releasing) Object.assign(set, { leaseExpiresAt: null });
    else set.leaseExpiresAt = new Date(Date.now() + policy.leaseMs);
    if (req.to === 'QUEUED') Object.assign(set, { workerId: null, queuedAt: new Date() });

    const inc: Record<string, number> = {};
    if (p.incRestart) inc.restartCount = 1;
    if (p.incLimitHit) inc.limitHitCount = 1;
    if (p.incContextReset) inc.contextResetCount = 1;
    if (p.incRemediation) inc.remediationCount = 1;
    if (p.activeMsDelta) inc.activeMs = p.activeMsDelta;

    const update: Record<string, unknown> = {
      $set: set,
      $push: { appliedTransitionIds: { $each: [req.transitionId], $slice: -MAX_APPLIED_IDS }, ...(p.verificationRun ? { verificationRuns: p.verificationRun } : {}) },
    };
    if (Object.keys(inc).length) update.$inc = inc;

    // Per-agent / per-provider concurrency (spec §46): a leased task switching to a target takes its slots first.
    const targetChanged = !releasing && ((p.agentId !== undefined && p.agentId !== current.agentId) || (p.providerId !== undefined && p.providerId !== current.providerId));
    if (targetChanged) {
      const r = await reserveTargetSlots({ _id: current._id, organizationId: current.organizationId }, policy, { agentId: p.agentId ?? current.agentId, providerId: p.providerId ?? current.providerId });
      if (!r.ok) {
        throw new AppError('CONCURRENCY_LIMIT', `${r.scope === 'agent' ? 'Agent' : 'Provider'} ${r.key} is at its concurrency limit (${r.limit})`, {
          context: { scope: r.scope, key: r.key, limit: r.limit },
        });
      }
    }

    const filter: Record<string, unknown> = {
      _id: id,
      workerId: oid(worker.workerId),
      status: same ? current.status : { $in: sourcesFor(req.to) },
      appliedTransitionIds: { $ne: req.transitionId },
    };
    const updated = (await Task.findOneAndUpdate(filter, update, { new: true }).lean()) as TaskLean | null;
    if (targetChanged && updated) {
      await releaseSlots(updated._id, { scope: 'agent', keep: updated.agentId });
      await releaseSlots(updated._id, { scope: 'provider', keep: updated.providerId });
    }
    if (!updated) {
      const now = (await Task.findById(id).select('+appliedTransitionIds').lean()) as TaskLean | null;
      if (now && (now.appliedTransitionIds ?? []).includes(req.transitionId)) return toTaskDto(now);
      if (now && String(now.workerId) !== worker.workerId) throw new AppError('LEASE_LOST', 'This worker no longer owns the task');
      throw new AppError('CONFLICT', 'Task changed concurrently', { retryable: true, context: { status: now?.status } });
    }
    if (releasing) await this.releaseTaskSlots(updated);
    if (!same) await this.afterStatusChange(current.status, updated, worker.workerId);
    else await this.publish(updated);
    return toTaskDto(updated);
  }

  /** Ingest a batch of buffered worker events; duplicates (same eventId) are ignored (spec §107). */
  async ingestEvents(worker: WorkerActor, events: WorkerEvent[]) {
    const taskIds = [...new Set(events.map((e) => e.taskId).filter((t) => /^[a-f0-9]{24}$/i.test(t)))];
    const tasks = await Task.find({ _id: { $in: taskIds.map((t) => oid(t)) }, organizationId: oid(worker.organizationId) }, { _id: 1, organizationId: 1, projectId: 1, correlationId: 1 }).lean();
    const known = new Map(tasks.map((t) => [String(t._id), t]));
    const docs = events
      .filter((e) => known.has(e.taskId) && e.workerId === worker.workerId)
      .map((e) => ({
        organizationId: oid(worker.organizationId),
        taskId: oid(e.taskId),
        workerId: oid(worker.workerId),
        eventId: e.eventId,
        type: e.type,
        timestamp: new Date(e.timestamp),
        sequence: e.sequence,
        payload: redact(e.payload),
        correlationId: e.correlationId ?? known.get(e.taskId)!.correlationId,
        ephemeral: EPHEMERAL_EVENT_TYPES.includes(e.type),
      }));
    let inserted: Array<Record<string, any>> = [];
    let duplicates = events.length - docs.length;
    if (docs.length) {
      try {
        inserted = (await TaskEvent.insertMany(docs, { ordered: false })).map((d) => d.toObject());
      } catch (e: any) {
        // Unordered insert: duplicates fail individually, the rest succeed.
        const ok: Array<Record<string, any>> = (e?.insertedDocs ?? []).map((d: any) => (d.toObject ? d.toObject() : d));
        const dupCount = (e?.writeErrors ?? []).filter((w: any) => (w.code ?? w.err?.code) === 11000).length;
        if (dupCount + ok.length < docs.length) throw e;
        inserted = ok;
        duplicates += dupCount;
      }
    }
    for (const d of inserted) this.live.publishToOrg(worker.organizationId, { type: 'task.event', event: toTaskEventDto(d) });
    await this.recordUsage(worker, inserted, new Map(tasks.map((t) => [String(t._id), t.projectId])));
    const highestSequence = Math.max(0, ...events.map((e) => e.sequence));
    await Worker.updateOne({ _id: oid(worker.workerId), lastSequence: { $lt: highestSequence } }, { lastSequence: highestSequence });
    return { accepted: inserted.length, duplicates, highestSequence };
  }

  /** Usage tracking from events that carry usage (spec §50). Idempotent on eventId. */
  private async recordUsage(worker: WorkerActor, events: Array<Record<string, any>>, projectOf: Map<string, unknown>) {
    const usage = events.filter((e) => ['AgentExited', 'ProviderLimitDetected', 'FallbackStarted'].includes(e.type));
    const spent = new Set<string>();
    for (const e of usage) {
      const p = e.payload ?? {};
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
      try {
        await UsageRecord.create({
          organizationId: oid(worker.organizationId),
          projectId: projectOf.get(String(e.taskId)) ?? null,
          taskId: e.taskId,
          workerId: oid(worker.workerId),
          agentId: p.agentId,
          providerId: p.providerId,
          modelId: p.modelId,
          kind: e.type === 'AgentExited' ? 'execution' : e.type === 'FallbackStarted' ? 'fallback' : 'limit',
          durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
          inputTokens: typeof p.inputTokens === 'number' ? p.inputTokens : null,
          outputTokens: typeof p.outputTokens === 'number' ? p.outputTokens : null,
          costUsd: typeof p.costUsd === 'number' ? p.costUsd : null,
          eventId: e.eventId,
        });
        // Only after the record was created (unique on eventId), so a replayed event is not counted twice.
        if (num(p.costUsd) || num(p.inputTokens) || num(p.outputTokens)) {
          await Task.updateOne({ _id: e.taskId }, { $inc: { 'usage.costUsd': num(p.costUsd), 'usage.inputTokens': num(p.inputTokens), 'usage.outputTokens': num(p.outputTokens) } });
          spent.add(String(e.taskId));
        }
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
      if (e.type === 'ProviderLimitDetected') this.metrics.providerLimitCount.inc({ provider: String(p.providerId ?? 'unknown') });
      if (e.type === 'FallbackStarted') this.metrics.fallbackCount.inc({ from_provider: String(p.fromProviderId ?? ''), to_provider: String(p.providerId ?? '') });
      if (e.type === 'AgentExited') this.metrics.agentSessions.inc({ agent: String(p.agentId ?? 'unknown') });
    }
    for (const taskId of spent) await this.enforceBudget(taskId).catch((e) => captureError(e, { tags: { component: 'tasks.budget' } }));
  }

  /**
   * After new spend on a task: budget notices, and a stop when a limit is reached. A task that is being
   * verified keeps going (verification costs nothing and may complete it); it is stopped if it asks for
   * another agent session.
   */
  private async enforceBudget(taskId: string) {
    if (!this.budgets) return;
    const task = (await Task.findById(taskId).lean()) as TaskLean | null;
    if (!task) return;
    const layers = await this.policyLayersFor(task);
    await this.budgets.notifyThresholds(task as never, layers);
    if (!LEASED_TASK_STATUSES.includes(task.status) || task.status === 'VERIFYING') return;
    const block = await this.budgets.check(task as never, layers);
    if (block) await this.stopForBudget(task, block);
  }

  private async releaseTaskSlots(task: TaskLean) {
    await Project.updateOne({ _id: task.projectId }, { $pull: { activeTaskIds: task._id } });
    const freed = await releaseSlots(task._id);
    // A freed slot may unblock other queued tasks: this project's, or the organization's when an
    // organization/agent/provider slot was freed. Enqueued in effective-priority order (spec §22).
    const scope = freed.length ? { organizationId: task.organizationId } : { projectId: task.projectId };
    const waiting = await Task.find({ ...scope, status: 'QUEUED', blockedReason: null, _id: { $ne: task._id } }, { _id: 1, organizationId: 1, priority: 1, queuedAt: 1 })
      .sort({ queuedAt: 1 })
      .limit(50)
      .lean();
    const next = sortByEffectivePriority(waiting.map((w) => ({ task: w as TaskLean, priority: w.priority as Priority, queuedAt: w.queuedAt?.getTime() ?? 0 }))).slice(0, 10);
    for (const n of next) await this.enqueue(n.task);
  }

  /** Side effects of a status change: events, metrics, notifications, dependency cascade. */
  private async afterStatusChange(from: TaskStatus, task: TaskLean, workerId?: string) {
    const to = task.status as TaskStatus;
    await this.recordEvent(task, 'TaskStatusChanged', { from, to, reason: task.statusReason }, workerId ?? null);
    if (['COMPLETED', 'FAILED', 'RECOVERY_REQUIRED'].includes(to)) {
      const dto = toTaskDto(task);
      for (const l of this.finishedListeners) void l(dto).catch((e) => captureError(e, { tags: { component: 'task.finished-listener' } }));
    }
    await this.publish(task);
    const notify = (type: NotificationType, title: string, body?: string) =>
      this.notifications.notify({
        organizationId: String(task.organizationId),
        type,
        title,
        body: body ?? task.statusReason ?? '',
        taskId: String(task._id),
        userIds: [String(task.createdBy)],
      });
    switch (to) {
      case 'COMPLETED':
        this.metrics.tasksCompleted.inc();
        this.metrics.taskExecutionSeconds.observe((task.activeMs ?? 0) / 1000);
        await this.recordEvent(task, 'TaskCompleted', {});
        await notify('task.completed', `Task completed: ${task.title}`);
        await this.settleAttempts(task);
        await this.cascadeDependents(task);
        break;
      case 'FAILED':
        this.metrics.tasksFailed.inc();
        await this.recordEvent(task, 'TaskFailed', { reason: task.statusReason });
        await notify('task.failed', `Task failed: ${task.title}`);
        await this.cascadeDependents(task);
        break;
      case 'CANCELLED':
        await this.cascadeDependents(task);
        break;
      case 'WAITING_FOR_LIMIT':
        this.metrics.tasksWaitingForLimit.inc({ provider: String(task.providerId ?? 'unknown') });
        await notify('task.provider_limit', `Provider limit reached: ${task.title}`);
        break;
      case 'WAITING_FOR_INPUT':
        await notify('task.input_required', `Agent needs input: ${task.title}`, task.pendingInteraction?.question);
        break;
      case 'WAITING_FOR_APPROVAL':
        await notify('task.approval_required', `Approval required: ${task.title}`, task.pendingInteraction?.question);
        break;
      case 'RECOVERY_REQUIRED':
        await this.recordEvent(task, 'RecoveryRequired', { reason: task.statusReason });
        await notify('task.recovery_required', `Recovery required: ${task.title}`);
        break;
      case 'QUEUED':
        await this.enqueue(task);
        break;
    }
    if (from === 'VERIFYING' && to === 'RUNNING') this.metrics.verificationFailures.inc();
  }

  /** Dependency cascade (spec §24): unblock on completion, mark blocked on failure/cancel. */
  private async cascadeDependents(task: TaskLean) {
    const dependents = await Task.find({ dependencies: task._id, status: 'QUEUED' }, { _id: 1, organizationId: 1, priority: 1, queuedAt: 1, dependencies: 1 }).lean();
    for (const d of dependents) {
      const deps = await Task.find({ _id: { $in: d.dependencies } }, { status: 1 }).lean();
      const r = dependencyReadiness(d.dependencies.map(String), new Map(deps.map((x) => [String(x._id), x.status as TaskStatus])));
      await Task.updateOne({ _id: d._id }, { blockedReason: r.state === 'blocked' ? `Dependency ${r.reason}: ${r.offending.join(', ')}` : null });
      if (r.state === 'ready') await this.enqueue(d as TaskLean);
    }
  }

  // ── Lease sweeper (spec §23) ───────────────────────────────────────────────
  async sweepExpiredLeases(now = new Date()) {
    const expired = (await Task.find({ status: { $in: LEASED_TASK_STATUSES }, leaseExpiresAt: { $lt: now } }).limit(200).lean()) as TaskLean[];
    let recovered = 0;
    for (const t of expired) {
      const policy = await this.resolvedPolicy(t);
      const exhausted = (t.restartCount ?? 0) + 1 > policy.maxRestarts;
      const to: TaskStatus = policy.onWorkerLost === 'RECOVERY_REQUIRED' || exhausted ? 'RECOVERY_REQUIRED' : 'QUEUED';
      const reason =
        to === 'QUEUED'
          ? 'Worker stopped renewing its lease; task requeued from last checkpoint'
          : exhausted
            ? `Worker lost and restart limit (${policy.maxRestarts}) reached`
            : 'Worker lost; policy requires manual recovery';
      const set: Record<string, unknown> = { status: to, statusReason: reason, leaseExpiresAt: null, offeredTo: null, pendingInteraction: null };
      if (to === 'QUEUED') Object.assign(set, { workerId: null, queuedAt: new Date() });
      else Object.assign(set, { failureCategory: 'worker_lost', stoppedAt: now });
      // Precondition on the expired lease: a concurrent heartbeat renewal wins (no double execution).
      const updated = (await Task.findOneAndUpdate(
        { _id: t._id, status: t.status, leaseExpiresAt: { $lt: now } },
        { $set: set, $inc: { restartCount: 1 } },
        { new: true },
      ).lean()) as TaskLean | null;
      if (!updated) continue;
      recovered++;
      this.metrics.leaseExpirations.inc();
      await this.recordEvent(updated, 'LeaseExpired', { previousWorkerId: String(t.workerId), previousStatus: t.status, action: to });
      if (t.workerId) this.live.sendToWorker(String(t.workerId), { type: 'task.control', taskId: String(t._id), action: 'cancel' });
      await this.releaseTaskSlots(updated);
      await this.afterStatusChange(t.status, updated);
    }
    return recovered;
  }

  /** Self-healing: rebuild project slots from task truth, re-enqueue stale QUEUED tasks (heals queue loss). */
  async reconcile(now = new Date()) {
    const projects = await Project.find({ 'activeTaskIds.0': { $exists: true } }, { _id: 1, activeTaskIds: 1 }).lean();
    for (const p of projects) {
      const live = await Task.find({ _id: { $in: p.activeTaskIds }, status: { $in: LEASED_TASK_STATUSES } }, { _id: 1 }).lean();
      if (live.length !== p.activeTaskIds.length) await Project.updateOne({ _id: p._id }, { activeTaskIds: live.map((l) => l._id) });
    }
    await reconcileSlots();
    const staleOffer = new Date(now.getTime() - 30_000);
    const queued = await Task.find(
      { status: 'QUEUED', blockedReason: null, $or: [{ offeredAt: null }, { offeredAt: { $lt: staleOffer } }] },
      { _id: 1, organizationId: 1, priority: 1, queuedAt: 1 },
    )
      .sort({ queuedAt: 1 })
      .limit(500)
      .lean();
    const ordered = sortByEffectivePriority(queued.map((q) => ({ task: q as TaskLean, priority: q.priority as Priority, queuedAt: q.queuedAt?.getTime() ?? 0 })), now.getTime());
    for (const q of ordered) await this.enqueue(q.task);
    return queued.length;
  }
}

/**
 * Knowledge for the agent (spec §77): organization, then project, then task, each under its own
 * heading. Sent as a list of sections so workers of any version can place them in the prompt.
 */
async function knowledgeFor(task: TaskLean, project: { knowledge?: string | null }): Promise<string[]> {
  const org = await Organization.findById(task.organizationId, { knowledge: 1 }).lean();
  return (
    [
      ['Organization', org?.knowledge],
      ['Project', project.knowledge],
      ['This task', task.knowledge],
    ] as const
  )
    .filter(([, k]) => Boolean(k?.trim()))
    .map(([label, k]) => `### ${label}\n\n${k!.trim()}`);
}
