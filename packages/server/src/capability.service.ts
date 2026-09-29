import {
  addedPermissions,
  AppError,
  compareVersions,
  evaluateCapabilityPolicy,
  formatRef,
  isRef,
  latestSatisfying,
  PLATFORM_NAMESPACE,
  resolvePolicy,
  type CapabilityManifest,
  type PolicyLayer,
} from '@ao/core';
import { Capability, CapabilityInstallation, CapabilityPackage, Organization, Project, Publisher, Setting, Task, oid } from '@ao/database';
import type { z } from 'zod';
import type { installCapabilityRequest, registerCapabilityRequest } from '@ao/contracts';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';
import { RegistryService, refreshIndexable } from './registry.service.js';

type AnyDoc = Record<string, any>;
const toCapabilityDto = (c: AnyDoc) => ({
  id: String(c._id),
  capabilityId: c.capabilityId,
  organizationId: c.organizationId ? String(c.organizationId) : null,
  version: c.version,
  status: c.status ?? 'ACTIVE',
  type: c.type,
  name: c.name,
  description: c.description ?? '',
  publisher: c.publisher,
  trust: c.trust,
  permissions: c.permissions ?? [],
  private: Boolean(c.private),
  manifest: c.manifest,
  createdAt: new Date(c.createdAt).toISOString(),
});
const toInstallationDto = (i: AnyDoc) => ({
  id: String(i._id),
  capabilityId: i.capabilityId,
  version: i.version,
  versionRange: i.versionRange ?? i.version,
  scope: i.scope,
  projectId: i.projectId ? String(i.projectId) : null,
  userId: i.userId ? String(i.userId) : null,
  taskId: i.taskId ? String(i.taskId) : null,
  enabled: Boolean(i.enabled),
  status: i.status,
  approvalReasons: i.approvalReasons ?? [],
  config: i.config ?? {},
  createdAt: new Date(i.createdAt).toISOString(),
});

/**
 * Installing capabilities (spec §33–§39). Packages come from this installation's registry (see
 * RegistryService); organization and personal packages are never transmitted elsewhere (spec §40).
 * Installations exist at ORGANIZATION, USER (one person), PROJECT and TASK scope, pin an exact version
 * and digest, and keep a range for upgrades.
 */
export class CapabilityService {
  constructor(readonly registry = new RegistryService()) {}

  /** Versions of the packages this organization and person own, the platform's, and anything installed. */
  async list(actor: Actor) {
    requirePermission(actor, 'capability.read');
    const [owned, installed] = await Promise.all([
      CapabilityPackage.find(
        { $or: [{ ownerKind: 'organization', organizationId: oid(actor.organizationId) }, { ownerKind: 'user', userId: oid(actor.userId) }, { ownerKind: 'platform' }] },
        { ref: 1 },
      )
        .limit(2000)
        .lean(),
      CapabilityInstallation.distinct('capabilityId', { organizationId: oid(actor.organizationId) }),
    ]);
    const refs = [...new Set([...owned.map((p) => p.ref), ...(installed as string[])])];
    const caps = await Capability.find({ capabilityId: { $in: refs } }).sort({ capabilityId: 1, createdAt: -1 }).lean();
    return caps.map(toCapabilityDto);
  }

  /** Register a version (kept for existing clients; see RegistryService.register). */
  async register(actor: Actor, rawManifest: unknown, isPrivate = true, platform = false, extra: Partial<Pick<z.output<typeof registerCapabilityRequest>, 'owner' | 'visibility' | 'listing'>> = {}) {
    const r = await this.registry.register(actor, rawManifest, { platform, owner: extra.owner, visibility: extra.visibility ?? (isPrivate ? undefined : 'ORGANIZATION'), listing: extra.listing });
    const c = await Capability.findOne({ capabilityId: r.ref, version: r.version }).lean();
    return { ...toCapabilityDto(c!), findings: r.findings };
  }

  /**
   * A reference, or a bare name tried as the organization's package, then the platform's, then the
   * person's own. Only packages the actor may see resolve.
   */
  async resolvePackage(actor: Actor, capabilityId: string): Promise<AnyDoc> {
    const viewer = { userId: actor.userId, organizationId: actor.organizationId };
    if (isRef(capabilityId)) {
      const p = await this.registry.findVisible(viewer, capabilityId);
      if (p) return p;
    } else {
      const [org, user] = await Promise.all([
        Publisher.findOne({ kind: 'organization', organizationId: oid(actor.organizationId) }, { namespace: 1 }).lean(),
        Publisher.findOne({ kind: 'user', userId: oid(actor.userId) }, { namespace: 1 }).lean(),
      ]);
      for (const ns of [org?.namespace, PLATFORM_NAMESPACE, user?.namespace]) {
        if (!ns) continue;
        const p = await this.registry.findVisible(viewer, formatRef(ns, capabilityId));
        if (p) return p;
      }
    }
    throw new AppError('NOT_FOUND', 'Capability not found in this installation’s registry');
  }

  private async policyFor(actor: Actor, projectId?: string | null) {
    const [platform, org, project] = await Promise.all([
      Setting.findOne({ key: 'platform.policy' }).lean(),
      Organization.findById(oid(actor.organizationId), { policy: 1 }).lean(),
      projectId ? Project.findOne({ _id: oid(projectId), organizationId: oid(actor.organizationId) }, { policy: 1 }).lean() : null,
    ]);
    return resolvePolicy(platform?.value as PolicyLayer, org?.policy as PolicyLayer, project?.policy as PolicyLayer).capabilities;
  }

  /** Install at ORGANIZATION/USER/PROJECT/TASK scope, applying trust & permission policy (spec §37–§39). */
  async install(actor: Actor, input: z.output<typeof installCapabilityRequest>) {
    requirePermission(actor, input.scope === 'USER' ? 'capability.personal' : 'capability.install');
    if (input.scope === 'PROJECT' && !input.projectId) throw new AppError('VALIDATION_FAILED', 'projectId is required for PROJECT scope');
    if (input.scope === 'TASK' && !input.taskId) throw new AppError('VALIDATION_FAILED', 'taskId is required for TASK scope');
    const orgId = oid(actor.organizationId);
    let projectId = input.scope === 'PROJECT' ? input.projectId! : null;
    if (input.scope === 'TASK') {
      const task = await Task.findOne({ _id: oid(input.taskId!, 'Task'), organizationId: orgId }, { projectId: 1 }).lean();
      if (!task) throw new AppError('NOT_FOUND', 'Task not found');
      projectId = String(task.projectId);
    }
    const pkg = await this.resolvePackage(actor, input.capabilityId);
    // A personal package is only for its owner: it cannot reach other people's tasks.
    if (pkg.ownerKind === 'user' && pkg.visibility === 'PRIVATE' && !['USER', 'TASK'].includes(input.scope)) {
      throw new AppError('VALIDATION_FAILED', 'This is a personal package. Install it for yourself, or publish it to share it.');
    }
    const cap = await this.pickVersion(pkg.ref, input.version, input.versionRange);
    const manifest = cap.manifest as CapabilityManifest;
    const decision = evaluateCapabilityPolicy(manifest, await this.policyFor(actor, projectId));
    if (decision.decision === 'block') throw new AppError('CAPABILITY_BLOCKED', 'Blocked by organization policy', { context: { reasons: decision.reasons } });
    // Admins installing explicitly count as the approval; others go to PENDING_APPROVAL.
    const autoApproved = decision.decision === 'allow' || actor.role === 'ADMIN' || actor.role === 'OWNER';
    const status = autoApproved ? 'ACTIVE' : 'PENDING_APPROVAL';
    const key = {
      organizationId: orgId,
      scope: input.scope,
      projectId: input.scope === 'PROJECT' ? oid(projectId!) : null,
      userId: input.scope === 'USER' ? oid(actor.userId) : null,
      taskId: input.scope === 'TASK' ? oid(input.taskId!) : null,
      capabilityId: pkg.ref,
    };
    const existed = await CapabilityInstallation.exists(key);
    const doc = await CapabilityInstallation.findOneAndUpdate(
      key,
      {
        $set: {
          version: cap.version,
          versionRange: input.versionRange ?? (input.version && /-/.test(input.version) ? input.version : `^${cap.version}`),
          digest: cap.digest ?? null,
          enabled: input.enabled,
          status,
          approvalReasons: decision.decision === 'require_approval' ? decision.reasons : [],
          approvedBy: autoApproved ? oid(actor.userId) : null,
          config: stripSecrets(manifest, input.config),
        },
        $setOnInsert: { installedBy: oid(actor.userId) },
      },
      { upsert: true, new: true },
    ).lean();
    if (!existed) {
      await CapabilityPackage.updateOne({ ref: pkg.ref }, { $inc: { installs: 1 } });
      await refreshIndexable({ ref: pkg.ref });
    }
    await audit(actor, 'capability.install', { type: 'capability', id: `${pkg.ref}@${cap.version}` }, { scope: input.scope, projectId, taskId: input.taskId, status, reasons: decision.decision === 'require_approval' ? decision.reasons : [] });
    return toInstallationDto(doc!);
  }

  /** The requested version, or the latest non-yanked one in the range. */
  private async pickVersion(ref: string, version?: string, range?: string) {
    if (version) {
      const v = await Capability.findOne({ capabilityId: ref, version }).lean();
      if (!v) throw new AppError('NOT_FOUND', `${ref}@${version} does not exist`);
      if (v.status === 'YANKED') throw new AppError('VALIDATION_FAILED', `${ref}@${version} was withdrawn by its publisher`);
      return v;
    }
    const versions = await Capability.find({ capabilityId: ref, status: { $ne: 'YANKED' } }, { version: 1 }).lean();
    // Without a range, a package that only has pre-releases still installs its newest one.
    const best = latestSatisfying(versions.map((v) => v.version), range ?? '*') ?? (range ? null : (versions.map((v) => v.version).sort(compareVersions).at(-1) ?? null));
    if (!best) throw new AppError('NOT_FOUND', `No installable version of ${ref}${range ? ` matches ${range}` : ''}`);
    return (await Capability.findOne({ capabilityId: ref, version: best }).lean())!;
  }

  /**
   * Move an installation to the latest version in its range. New permissions need an administrator's
   * approval again, like a first install.
   */
  async upgrade(actor: Actor, installationId: string) {
    const i = await this.ownInstallation(actor, installationId);
    const current = await Capability.findOne({ capabilityId: i.capabilityId, version: i.version }).lean();
    const next = await this.pickVersion(i.capabilityId, undefined, i.versionRange ?? '*').catch(() => null);
    if (!next || next.version === i.version) return toInstallationDto(i);
    const added = current ? addedPermissions(current.manifest as CapabilityManifest, next.manifest as CapabilityManifest) : [];
    const decision = evaluateCapabilityPolicy(next.manifest as CapabilityManifest, await this.policyFor(actor, i.projectId ? String(i.projectId) : null));
    if (decision.decision === 'block') throw new AppError('CAPABILITY_BLOCKED', 'Blocked by organization policy', { context: { reasons: decision.reasons } });
    const admin = actor.role === 'ADMIN' || actor.role === 'OWNER';
    const needsApproval = !admin && (added.length > 0 || decision.decision === 'require_approval');
    const reasons = [...(added.length ? [`Adds permissions: ${added.join(', ')}`] : []), ...(decision.decision === 'require_approval' ? decision.reasons : [])];
    const d = await CapabilityInstallation.findOneAndUpdate(
      { _id: i._id },
      { $set: { version: next.version, digest: next.digest ?? null, status: needsApproval ? 'PENDING_APPROVAL' : i.status, approvalReasons: needsApproval ? reasons : [], ...(needsApproval ? { approvedBy: null } : {}) } },
      { new: true },
    ).lean();
    await audit(actor, 'capability.upgrade', { type: 'capability', id: `${i.capabilityId}@${next.version}` }, { from: i.version, addedPermissions: added });
    return toInstallationDto(d!);
  }

  async approve(actor: Actor, installationId: string) {
    requirePermission(actor, 'capability.manage');
    const d = await CapabilityInstallation.findOneAndUpdate(
      { _id: oid(installationId), organizationId: oid(actor.organizationId), status: 'PENDING_APPROVAL' },
      { status: 'ACTIVE', approvedBy: oid(actor.userId) },
      { new: true },
    ).lean();
    if (!d) throw new AppError('NOT_FOUND', 'Pending installation not found');
    await audit(actor, 'capability.approve', { type: 'capability', id: d.capabilityId });
    return toInstallationDto(d);
  }

  /** An installation the actor may change: their own USER ones, or any other with capability.install. */
  private async ownInstallation(actor: Actor, installationId: string): Promise<AnyDoc> {
    const i = await CapabilityInstallation.findOne({ _id: oid(installationId), organizationId: oid(actor.organizationId) }).lean();
    if (!i) throw new AppError('NOT_FOUND', 'Installation not found');
    if (i.scope === 'USER') {
      if (String(i.userId) !== actor.userId) throw new AppError('NOT_FOUND', 'Installation not found');
      requirePermission(actor, 'capability.personal');
    } else requirePermission(actor, 'capability.install');
    return i;
  }

  async setEnabled(actor: Actor, installationId: string, enabled: boolean) {
    const i = await this.ownInstallation(actor, installationId);
    const d = await CapabilityInstallation.findOneAndUpdate({ _id: i._id }, { enabled }, { new: true }).lean();
    await audit(actor, enabled ? 'capability.enable' : 'capability.disable', { type: 'capability', id: i.capabilityId });
    return toInstallationDto(d!);
  }

  async uninstall(actor: Actor, installationId: string) {
    const i = await this.ownInstallation(actor, installationId);
    await CapabilityInstallation.deleteOne({ _id: i._id });
    await CapabilityPackage.updateOne({ ref: i.capabilityId, installs: { $gt: 0 } }, { $inc: { installs: -1 } });
    await refreshIndexable({ ref: i.capabilityId });
    await audit(actor, 'capability.uninstall', { type: 'capability', id: i.capabilityId });
  }

  /** Installations the actor can see: everything in the organization except other people's USER ones. */
  async installations(actor: Actor, projectId?: string) {
    requirePermission(actor, 'capability.read');
    const mine = { scope: 'USER', userId: oid(actor.userId) };
    const f: Record<string, unknown> = { organizationId: oid(actor.organizationId) };
    if (projectId) f.$or = [{ scope: 'ORGANIZATION' }, mine, { scope: 'PROJECT', projectId: oid(projectId) }];
    else f.$or = [{ scope: { $ne: 'USER' } }, mine];
    return (await CapabilityInstallation.find(f).sort({ capabilityId: 1 }).lean()).map(toInstallationDto);
  }
}

/** Secret configuration values must be stored as secret references, never inline. */
function stripSecrets(manifest: CapabilityManifest, config: Record<string, unknown>) {
  const secretKeys = new Set(manifest.configuration.filter((c) => c.secret).map((c) => c.key));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    if (secretKeys.has(k)) {
      if (typeof v !== 'string' || !v.startsWith('secret:')) throw new AppError('VALIDATION_FAILED', `"${k}" is secret: pass a reference like "secret:NAME"`);
    }
    out[k] = v;
  }
  return out;
}
