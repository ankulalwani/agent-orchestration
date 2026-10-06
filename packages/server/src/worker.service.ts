import { AppError, LEASED_TASK_STATUSES, createLogger, newCorrelationId, newDeviceCode, newSecretToken, sha256, safeEqual } from '@ao/core';
import { Organization, Project, Task, Worker, WorkerDailyStat, WorkerPairing, isDuplicateKeyError, oid } from '@ao/database';
import type { HeartbeatPayload } from '@ao/contracts';
import type { z } from 'zod';
import type { pairingStartRequest, updateWorkerRequest } from '@ao/contracts';
import { requirePermission, type Actor, type WorkerActor } from './context.js';
import { toWorkerDto } from './dto.js';
import { audit } from './audit.js';
import type { LiveHub } from './live.js';
import type { NotificationService } from './notifications.js';
import type { ServerConfig } from './config.js';

const log = createLogger('workers');
const PAIRING_TTL_MS = 15 * 60_000;

export interface WorkerTiming {
  leaseMs: number;
  heartbeatMs: number;
  offlineThresholdMs: number;
}

export class WorkerService {
  constructor(
    private config: ServerConfig,
    private live: LiveHub,
    private notifications: NotificationService,
    private timing: WorkerTiming,
  ) {}

  /** Called with the projects in which a worker gained a checkout, so their waiting tasks are dispatched now. */
  private checkoutListeners: Array<(organizationId: string, projectIds: string[]) => void> = [];
  onCheckoutsAdded(fn: (organizationId: string, projectIds: string[]) => void) {
    this.checkoutListeners.push(fn);
  }

  // ── Device-code pairing (spec §13) ─────────────────────────────────────────
  async startPairing(input: z.output<typeof pairingStartRequest>) {
    const pollSecret = newSecretToken(32);
    for (let i = 0; i < 5; i++) {
      const userCode = newDeviceCode();
      try {
        const p = await WorkerPairing.create({ ...input, userCode, pollSecretHash: sha256(pollSecret), expiresAt: new Date(Date.now() + PAIRING_TTL_MS) });
        return {
          pairingId: String(p._id),
          userCode,
          pollSecret,
          verificationUrl: `${this.config.WEB_URL}/pair?code=${encodeURIComponent(userCode)}`,
          expiresAt: p.expiresAt.toISOString(),
          intervalSec: 3,
        };
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
    }
    throw new AppError('INTERNAL', 'Could not allocate a pairing code');
  }

  /** Looks up a pending pairing so the user can confirm what they are approving. */
  async describePairing(userCode: string) {
    const p = await WorkerPairing.findOne({ userCode: userCode.toUpperCase(), status: 'PENDING', expiresAt: { $gt: new Date() } }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'Pairing code not found or expired');
    return { name: p.name, hostname: p.hostname, os: p.os, arch: p.arch, version: p.version, expiresAt: p.expiresAt.toISOString() };
  }

  async approvePairing(actor: Actor, userCode: string, name?: string) {
    requirePermission(actor, 'task.create'); // developers may pair their own machines
    const org = await Organization.findById(oid(actor.organizationId)).lean();
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    const needsAdmin = org.settings?.requireWorkerApproval === true;
    const pairing = await WorkerPairing.findOne({ userCode: userCode.toUpperCase(), status: 'PENDING', expiresAt: { $gt: new Date() } });
    if (!pairing) throw new AppError('NOT_FOUND', 'Pairing code not found or expired');
    const worker = await Worker.create({
      organizationId: org._id,
      name: name || pairing.name || pairing.hostname || 'worker',
      hostname: pairing.hostname ?? '',
      os: pairing.os,
      arch: pairing.arch ?? '',
      version: pairing.version ?? '',
      approved: !needsAdmin,
      status: needsAdmin ? 'PENDING_APPROVAL' : 'OFFLINE',
      pairedBy: oid(actor.userId),
      approvedBy: needsAdmin ? null : oid(actor.userId),
    });
    const updated = await WorkerPairing.updateOne(
      { _id: pairing._id, status: 'PENDING' },
      { status: 'APPROVED', organizationId: org._id, workerId: worker._id, approvedBy: oid(actor.userId) },
    );
    if (!updated.modifiedCount) {
      await Worker.deleteOne({ _id: worker._id });
      throw new AppError('CONFLICT', 'Pairing was already completed');
    }
    await audit(actor, 'worker.pair', { type: 'worker', id: String(worker._id) }, { hostname: pairing.hostname, needsAdmin });
    if (needsAdmin) {
      await this.notifications.notify({
        organizationId: actor.organizationId,
        type: 'worker.pending_approval',
        title: `Worker "${worker.name}" awaits approval`,
        workerId: String(worker._id),
        roles: ['OWNER', 'ADMIN'],
      });
    }
    return toWorkerDto(worker.toObject());
  }

  async denyPairing(actor: Actor, userCode: string) {
    requirePermission(actor, 'task.create');
    await WorkerPairing.updateOne({ userCode: userCode.toUpperCase(), status: 'PENDING' }, { status: 'DENIED' });
    await audit(actor, 'worker.pair_denied', null, { userCode });
  }

  /** Worker polls; on approval the credential is minted exactly once and only its hash is stored. */
  async pollPairing(pairingId: string, pollSecret: string) {
    const p = await WorkerPairing.findById(oid(pairingId, 'Pairing'));
    if (!p || !safeEqual(p.pollSecretHash, sha256(pollSecret))) throw new AppError('NOT_FOUND', 'Pairing not found');
    if (p.status === 'DENIED') return { status: 'DENIED' as const };
    if (p.status === 'CONSUMED') return { status: 'EXPIRED' as const };
    if (p.status === 'PENDING') return p.expiresAt.getTime() < Date.now() ? { status: 'EXPIRED' as const } : { status: 'PENDING' as const };
    const consumed = await WorkerPairing.updateOne({ _id: p._id, status: 'APPROVED' }, { status: 'CONSUMED' });
    if (!consumed.modifiedCount) return { status: 'EXPIRED' as const };
    const credential = `aow_${newSecretToken(32)}`;
    await Worker.updateOne({ _id: p.workerId }, { credentialHash: sha256(credential) });
    await audit({ system: true, organizationId: String(p.organizationId) }, 'worker.credential_issued', { type: 'worker', id: String(p.workerId) });
    return { status: 'APPROVED' as const, workerId: String(p.workerId), organizationId: String(p.organizationId), credential };
  }

  async authenticate(credential: string): Promise<WorkerActor> {
    if (!credential.startsWith('aow_')) throw new AppError('UNAUTHENTICATED', 'Invalid worker credential');
    const w = await Worker.findOne({ credentialHash: sha256(credential) }).lean();
    if (!w) throw new AppError('UNAUTHENTICATED', 'Invalid worker credential');
    if (w.status === 'DISABLED') throw new AppError('FORBIDDEN', 'This worker has been disabled');
    return { workerId: String(w._id), organizationId: String(w.organizationId), correlationId: newCorrelationId() };
  }

  // ── Management ─────────────────────────────────────────────────────────────
  private async activeTaskIds(workerIds: string[]) {
    const tasks = await Task.find({ workerId: { $in: workerIds.map((w) => oid(w)) }, status: { $in: LEASED_TASK_STATUSES } }, { _id: 1, workerId: 1 }).lean();
    const map = new Map<string, string[]>();
    for (const t of tasks) map.set(String(t.workerId), [...(map.get(String(t.workerId)) ?? []), String(t._id)]);
    return map;
  }

  async list(actor: Actor) {
    requirePermission(actor, 'worker.read');
    const ws = await Worker.find({ organizationId: oid(actor.organizationId) }).sort({ name: 1 }).lean();
    const active = await this.activeTaskIds(ws.map((w) => String(w._id)));
    return ws.map((w) => toWorkerDto(w, active.get(String(w._id)) ?? []));
  }

  async get(actor: Actor, id: string) {
    requirePermission(actor, 'worker.read');
    const w = await Worker.findOne({ _id: oid(id, 'Worker'), organizationId: oid(actor.organizationId) }).lean();
    if (!w) throw new AppError('NOT_FOUND', 'Worker not found');
    const active = await this.activeTaskIds([id]);
    return toWorkerDto(w, active.get(id) ?? []);
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateWorkerRequest>) {
    requirePermission(actor, 'worker.manage');
    const w = await Worker.findOneAndUpdate({ _id: oid(id, 'Worker'), organizationId: oid(actor.organizationId) }, { $set: input }, { new: true }).lean();
    if (!w) throw new AppError('NOT_FOUND', 'Worker not found');
    await audit(actor, 'worker.update', { type: 'worker', id }, input);
    const dto = toWorkerDto(w);
    this.live.publishToOrg(actor.organizationId, { type: 'worker.updated', worker: dto });
    return dto;
  }

  async approve(actor: Actor, id: string) {
    requirePermission(actor, 'worker.approve');
    const w = await Worker.findOneAndUpdate(
      { _id: oid(id, 'Worker'), organizationId: oid(actor.organizationId) },
      { approved: true, approvedBy: oid(actor.userId), status: 'OFFLINE' },
      { new: true },
    ).lean();
    if (!w) throw new AppError('NOT_FOUND', 'Worker not found');
    await audit(actor, 'worker.approve', { type: 'worker', id });
    return toWorkerDto(w);
  }

  /** Revokes the credential. Leased tasks are recovered by the lease sweeper. */
  async revoke(actor: Actor, id: string) {
    requirePermission(actor, 'worker.manage');
    const r = await Worker.updateOne(
      { _id: oid(id, 'Worker'), organizationId: oid(actor.organizationId) },
      { status: 'DISABLED', $unset: { credentialHash: 1 } },
    );
    if (!r.matchedCount) throw new AppError('NOT_FOUND', 'Worker not found');
    this.live.sendToWorker(id, { type: 'error', code: 'REVOKED', message: 'Worker credential revoked' });
    await audit(actor, 'worker.revoke', { type: 'worker', id });
  }

  // ── Heartbeat (spec §14, §23) ──────────────────────────────────────────────
  async heartbeat(worker: WorkerActor, payload: HeartbeatPayload, now = new Date()) {
    const w = await Worker.findById(oid(worker.workerId)).lean();
    if (!w) throw new AppError('UNAUTHENTICATED', 'Unknown worker');
    const set: Record<string, unknown> = {
      lastHeartbeatAt: now,
      metrics: payload.metrics,
      latencyMs: Math.max(0, now.getTime() - new Date(payload.sentAt).getTime()),
    };
    if (w.approved && w.status !== 'DISABLED') set.status = 'ONLINE';
    if (payload.inventory) {
      set.agents = payload.inventory.agents;
      set.providers = payload.inventory.providers;
      set.tools = payload.inventory.tools;
      await this.syncProjectPaths(worker, payload.inventory.projects);
    }
    await Worker.updateOne({ _id: w._id }, { $set: set });
    // Online time for analytics: the time since the last heartbeat, when the worker was online then. A
    // longer gap than the offline threshold is not counted (it was offline for part of it).
    if (w.status === 'ONLINE' && set.status === 'ONLINE' && w.lastHeartbeatAt) {
      const gap = now.getTime() - w.lastHeartbeatAt.getTime();
      if (gap > 0 && gap <= this.timing.offlineThresholdMs) {
        await WorkerDailyStat.updateOne({ workerId: w._id, date: now.toISOString().slice(0, 10) }, { $inc: { onlineMs: gap }, $setOnInsert: { organizationId: w.organizationId } }, { upsert: true }).catch((e) => {
          if (!isDuplicateKeyError(e)) throw e; // two heartbeats creating the day's row at once: one interval is lost
        });
      }
    }

    // Renew leases only for tasks this worker still owns.
    const reported = payload.activeTasks.map((t) => t.taskId).filter((id) => /^[a-f0-9]{24}$/i.test(id));
    const leaseUntil = new Date(now.getTime() + this.timing.leaseMs);
    if (reported.length) {
      await Task.updateMany(
        { _id: { $in: reported.map((r) => oid(r)) }, workerId: w._id, status: { $in: LEASED_TASK_STATUSES } },
        { leaseExpiresAt: leaseUntil },
      );
    }
    const owned = await Task.find({ _id: { $in: reported.map((r) => oid(r)) }, workerId: w._id, status: { $in: LEASED_TASK_STATUSES } }, { _id: 1 }).lean();
    const ownedSet = new Set(owned.map((o) => String(o._id)));
    const revokedTaskIds = reported.filter((r) => !ownedSet.has(r));

    if (w.status !== 'ONLINE' && set.status === 'ONLINE') {
      log.info({ workerId: worker.workerId }, 'worker online');
      const dto = toWorkerDto({ ...w, ...set }, [...ownedSet]);
      this.live.publishToOrg(worker.organizationId, { type: 'worker.updated', worker: dto });
    }
    return { serverTime: now.toISOString(), leasesRenewedUntil: reported.length ? leaseUntil.toISOString() : null, revokedTaskIds };
  }

  /** The worker is authoritative for which local paths map to which projects (spec §115). */
  private async syncProjectPaths(worker: WorkerActor, projects: Array<{ projectId: string; repositoryId?: string; localPath: string }>) {
    const wid = oid(worker.workerId);
    const valid = projects.filter((p) => /^[a-f0-9]{24}$/i.test(p.projectId) && (!p.repositoryId || /^[a-f0-9]{24}$/i.test(p.repositoryId)));
    const had = new Set(
      (await Project.find({ organizationId: oid(worker.organizationId), 'workerPaths.workerId': wid }, { workerPaths: 1 }).lean()).flatMap((p) =>
        p.workerPaths.filter((w) => String(w.workerId) === worker.workerId).map((w) => `${p._id}:${w.repositoryId}`),
      ),
    );
    await Project.updateMany({ organizationId: oid(worker.organizationId), 'workerPaths.workerId': wid }, { $pull: { workerPaths: { workerId: wid } } });
    // A repository is found by its id in whichever project holds it now (it may have been moved since the
    // worker saved the mapping); without an id (older workers) a path is its project's primary repository.
    const docs = await Project.find(
      { organizationId: oid(worker.organizationId), $or: [{ _id: { $in: valid.map((p) => oid(p.projectId)) } }, { 'repositories._id': { $in: valid.flatMap((p) => (p.repositoryId ? [oid(p.repositoryId)] : [])) } }] },
      { repositories: 1 },
    ).lean();
    const pathsBy = new Map<string, Array<{ workerId: typeof wid; repositoryId: ReturnType<typeof oid>; localPath: string }>>();
    for (const p of valid) {
      const project = p.repositoryId ? docs.find((x) => x.repositories?.some((r) => String(r._id) === p.repositoryId)) : docs.find((x) => String(x._id) === p.projectId);
      const repo = project?.repositories?.find((r) => (p.repositoryId ? String(r._id) === p.repositoryId : r.primary));
      if (!project || !repo) continue;
      const list = pathsBy.get(String(project._id)) ?? [];
      if (list.some((x) => String(x.repositoryId) === String(repo._id))) continue; // one path per repository
      list.push({ workerId: wid, repositoryId: repo._id, localPath: p.localPath });
      pathsBy.set(String(project._id), list);
    }
    for (const [projectId, list] of pathsBy) await Project.updateOne({ _id: oid(projectId) }, { $push: { workerPaths: { $each: list } } });
    const gained = [...pathsBy].filter(([projectId, list]) => list.some((w) => !had.has(`${projectId}:${w.repositoryId}`))).map(([projectId]) => projectId);
    if (gained.length) for (const fn of this.checkoutListeners) fn(worker.organizationId, gained);
  }

  /** Mark workers offline after missed heartbeats (spec §23). */
  async sweepOffline(now = Date.now()) {
    const cutoff = new Date(now - this.timing.offlineThresholdMs);
    const stale = await Worker.find({ status: 'ONLINE', lastHeartbeatAt: { $lt: cutoff } }).lean();
    for (const w of stale) {
      const r = await Worker.updateOne({ _id: w._id, status: 'ONLINE', lastHeartbeatAt: { $lt: cutoff } }, { status: 'OFFLINE' });
      if (!r.modifiedCount) continue;
      log.warn({ workerId: String(w._id) }, 'worker offline (missed heartbeats)');
      this.live.publishToOrg(String(w.organizationId), { type: 'worker.updated', worker: toWorkerDto({ ...w, status: 'OFFLINE' }) });
      await this.notifications.notify({
        organizationId: String(w.organizationId),
        type: 'worker.offline',
        title: `Worker "${w.name}" went offline`,
        body: `No heartbeat since ${w.lastHeartbeatAt?.toISOString()}`,
        workerId: String(w._id),
        roles: ['OWNER', 'ADMIN', 'MANAGER'],
      });
    }
    return stale.length;
  }
}
