import { createHash } from 'node:crypto';
import { AppError, capabilityManifestSchema, evaluateCapabilityPolicy, resolvePolicy, type CapabilityManifest, type PolicyLayer } from '@ao/core';
import { Capability, CapabilityInstallation, Organization, Project, Setting, isDuplicateKeyError, oid } from '@ao/database';
import type { z } from 'zod';
import type { installCapabilityRequest } from '@ao/contracts';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';

type AnyDoc = Record<string, any>;
const toCapabilityDto = (c: AnyDoc) => ({
  id: String(c._id),
  capabilityId: c.capabilityId,
  organizationId: c.organizationId ? String(c.organizationId) : null,
  version: c.version,
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
  scope: i.scope,
  projectId: i.projectId ? String(i.projectId) : null,
  enabled: Boolean(i.enabled),
  status: i.status,
  approvalReasons: i.approvalReasons ?? [],
  config: i.config ?? {},
  createdAt: new Date(i.createdAt).toISOString(),
});

/**
 * Capability registry (spec §33). Each control-plane installation owns its registry; there is no
 * mandatory global marketplace. Organization capabilities are private to that organization and
 * never transmitted elsewhere (spec §40). Platform capabilities (organizationId = null) are managed
 * by platform admins of this installation.
 */
export class CapabilityService {
  async list(actor: Actor) {
    requirePermission(actor, 'capability.read');
    const caps = await Capability.find({ $or: [{ organizationId: oid(actor.organizationId) }, { organizationId: null }] }).sort({ capabilityId: 1, version: -1 }).lean();
    return caps.map(toCapabilityDto);
  }

  async register(actor: Actor, rawManifest: unknown, isPrivate = true, platform = false) {
    requirePermission(actor, 'capability.manage');
    if (platform && !actor.platformAdmin) throw new AppError('FORBIDDEN', 'Only platform administrators can publish platform capabilities');
    const manifest = capabilityManifestSchema.parse(rawManifest);
    // Trust can only be self-declared as LOCAL/UNVERIFIED/COMMUNITY; higher trust is granted by platform admins.
    if (['OFFICIAL', 'VERIFIED'].includes(manifest.trust) && !actor.platformAdmin) manifest.trust = 'LOCAL';
    // The checksum pins the exact code that was reviewed and approved; workers refuse anything else.
    if (manifest.plugin) manifest.plugin.sha256 = manifest.plugin.source ? createHash('sha256').update(manifest.plugin.source).digest('hex') : undefined;
    try {
      const c = await Capability.create({
        organizationId: platform ? null : oid(actor.organizationId),
        capabilityId: manifest.id,
        version: manifest.version,
        type: manifest.type,
        name: manifest.name,
        description: manifest.description,
        publisher: manifest.publisher,
        trust: manifest.trust,
        permissions: manifest.permissions,
        private: platform ? false : isPrivate,
        manifest,
        createdBy: oid(actor.userId),
      });
      await audit(actor, 'capability.register', { type: 'capability', id: `${manifest.id}@${manifest.version}` }, { type: manifest.type, permissions: manifest.permissions });
      return toCapabilityDto(c.toObject());
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', `${manifest.id}@${manifest.version} is already registered; bump the version to publish an update`);
      throw e;
    }
  }

  private async policyFor(actor: Actor, projectId?: string | null) {
    const [platform, org, project] = await Promise.all([
      Setting.findOne({ key: 'platform.policy' }).lean(),
      Organization.findById(oid(actor.organizationId), { policy: 1 }).lean(),
      projectId ? Project.findOne({ _id: oid(projectId), organizationId: oid(actor.organizationId) }, { policy: 1 }).lean() : null,
    ]);
    return resolvePolicy(platform?.value as PolicyLayer, org?.policy as PolicyLayer, project?.policy as PolicyLayer).capabilities;
  }

  /** Install at ORGANIZATION/PROJECT/TASK scope, applying trust & permission policy (spec §37–§39). */
  async install(actor: Actor, input: z.output<typeof installCapabilityRequest>) {
    requirePermission(actor, 'capability.install');
    if (input.scope === 'PROJECT' && !input.projectId) throw new AppError('VALIDATION_FAILED', 'projectId is required for PROJECT scope');
    const orgId = oid(actor.organizationId);
    const cap = await Capability.findOne({
      capabilityId: input.capabilityId,
      $or: [{ organizationId: orgId }, { organizationId: null }],
      ...(input.version ? { version: input.version } : {}),
    })
      .sort({ createdAt: -1 })
      .lean();
    if (!cap) throw new AppError('NOT_FOUND', 'Capability not found in this installation’s registry');
    const manifest = cap.manifest as CapabilityManifest;
    const decision = evaluateCapabilityPolicy(manifest, await this.policyFor(actor, input.projectId));
    if (decision.decision === 'block') throw new AppError('CAPABILITY_BLOCKED', 'Blocked by organization policy', { context: { reasons: decision.reasons } });
    // Admins installing explicitly count as the approval; others go to PENDING_APPROVAL.
    const autoApproved = decision.decision === 'allow' || actor.role === 'ADMIN' || actor.role === 'OWNER';
    const status = autoApproved ? 'ACTIVE' : 'PENDING_APPROVAL';
    const doc = await CapabilityInstallation.findOneAndUpdate(
      { organizationId: orgId, scope: input.scope, projectId: input.projectId ? oid(input.projectId) : null, capabilityId: cap.capabilityId },
      {
        $set: {
          version: cap.version,
          enabled: input.enabled,
          status,
          approvalReasons: decision.decision === 'require_approval' ? decision.reasons : [],
          approvedBy: autoApproved ? oid(actor.userId) : null,
          config: stripSecrets(manifest, input.config),
        },
      },
      { upsert: true, new: true },
    ).lean();
    await audit(actor, 'capability.install', { type: 'capability', id: `${cap.capabilityId}@${cap.version}` }, { scope: input.scope, projectId: input.projectId, status, reasons: decision.decision === 'require_approval' ? decision.reasons : [] });
    return toInstallationDto(doc!);
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

  async setEnabled(actor: Actor, installationId: string, enabled: boolean) {
    requirePermission(actor, 'capability.install');
    const d = await CapabilityInstallation.findOneAndUpdate({ _id: oid(installationId), organizationId: oid(actor.organizationId) }, { enabled }, { new: true }).lean();
    if (!d) throw new AppError('NOT_FOUND', 'Installation not found');
    await audit(actor, enabled ? 'capability.enable' : 'capability.disable', { type: 'capability', id: d.capabilityId });
    return toInstallationDto(d);
  }

  async uninstall(actor: Actor, installationId: string) {
    requirePermission(actor, 'capability.install');
    const d = await CapabilityInstallation.findOneAndDelete({ _id: oid(installationId), organizationId: oid(actor.organizationId) }).lean();
    if (!d) throw new AppError('NOT_FOUND', 'Installation not found');
    await audit(actor, 'capability.uninstall', { type: 'capability', id: d.capabilityId });
  }

  async installations(actor: Actor, projectId?: string) {
    requirePermission(actor, 'capability.read');
    const f: Record<string, unknown> = { organizationId: oid(actor.organizationId) };
    if (projectId) f.$or = [{ scope: 'ORGANIZATION' }, { scope: 'PROJECT', projectId: oid(projectId) }];
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
