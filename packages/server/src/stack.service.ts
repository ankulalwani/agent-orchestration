import { AppError } from '@ao/core';
import { CapabilityPackage, CapabilityStack, Publisher, isDuplicateKeyError, oid } from '@ao/database';
import type { InstallStackResponse, StackDto, createStackRequest, installStackRequest, updateStackRequest } from '@ao/contracts';
import type { z } from 'zod';
import { requirePermission, type Actor, type PlatformActor } from './context.js';
import { audit } from './audit.js';
import type { CapabilityService } from './capability.service.js';
import { toPackageDto, type RegistryService, type Viewer } from './registry.service.js';

type AnyDoc = Record<string, any>;
type StackInput = z.output<typeof createStackRequest>;
type PlatformAdmin = PlatformActor & { platformAdmin?: boolean };

/**
 * Stacks: packages that belong together (a framework's skills and MCP servers), installed in one step.
 * The platform's stacks are offered to everyone and may only hold public packages; an organization's
 * own stacks may hold anything the organization can see. Installing a stack installs each package the
 * usual way, so trust, permission and approval rules apply to every one of them.
 */
export class StackService {
  constructor(
    private registry: RegistryService,
    private capabilities: CapabilityService,
  ) {}

  private async dto(s: AnyDoc, viewer: Viewer): Promise<StackDto> {
    const refs: string[] = (s.items ?? []).map((i: AnyDoc) => i.ref);
    const packages = await CapabilityPackage.find({ $and: [{ ref: { $in: refs } }, this.registry.visibilityFilter(viewer, true)] }).lean();
    const verified = new Set((await Publisher.find({ namespace: { $in: packages.map((p) => p.namespace) }, verified: true }, { namespace: 1 }).lean()).map((p) => p.namespace));
    const byRef = new Map(packages.map((p) => [p.ref, p]));
    // What most of the stack's packages are about, most common first.
    const top = (field: 'categories' | 'technologies') => {
      const n = new Map<string, number>();
      for (const p of packages) for (const v of (p[field] ?? []) as string[]) n.set(v, (n.get(v) ?? 0) + 1);
      return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 6).map(([v]) => v);
    };
    return {
      id: String(s._id),
      slug: s.slug,
      name: s.name,
      description: s.description ?? '',
      readme: s.readme ?? null,
      ownerKind: s.organizationId ? 'organization' : 'platform',
      items: (s.items ?? []).map((i: AnyDoc) => {
        const p = byRef.get(i.ref);
        return { ref: i.ref, versionRange: i.versionRange ?? null, note: i.note ?? '', package: p ? toPackageDto(p, verified.has(p.namespace)) : null };
      }),
      categories: top('categories'),
      technologies: top('technologies'),
      installs: s.installs ?? 0,
      createdAt: new Date(s.createdAt).toISOString(),
    };
  }

  /** Every item must be a package the stack's audience can see: the public for a platform stack. */
  private async checkItems(items: StackInput['items'], viewer: Viewer) {
    const refs = items.map((i) => i.ref);
    if (new Set(refs).size !== refs.length) throw new AppError('VALIDATION_FAILED', 'A package can be in a stack once');
    const found = new Set((await CapabilityPackage.find({ $and: [{ ref: { $in: refs } }, viewer ? this.registry.visibilityFilter(viewer, true) : { visibility: 'PUBLIC' }] }, { ref: 1 }).lean()).map((p) => p.ref));
    const missing = refs.filter((r) => !found.has(r));
    if (missing.length) throw new AppError('VALIDATION_FAILED', `${viewer ? 'Not found in the registry' : 'Not a public package'}: ${missing.join(', ')}`, { context: { missing } });
  }

  /** The viewer's organization's stack with this slug, else the platform's. The public sees the platform's only. */
  private async find(viewer: Viewer, slug: string): Promise<AnyDoc> {
    const own = viewer ? await CapabilityStack.findOne({ organizationId: oid(viewer.organizationId), slug }).lean() : null;
    const s = own ?? (await CapabilityStack.findOne({ organizationId: null, slug }).lean());
    if (!s) throw new AppError('NOT_FOUND', 'Stack not found');
    return s;
  }

  /** The platform's stacks, and for a member also their organization's (first). */
  async list(viewer: Viewer) {
    const stacks = await CapabilityStack.find({ organizationId: viewer ? { $in: [null, oid(viewer.organizationId)] } : null }).sort({ installs: -1, name: 1 }).limit(200).lean();
    const ordered = [...stacks.filter((s) => s.organizationId), ...stacks.filter((s) => !s.organizationId)];
    return Promise.all(ordered.map((s) => this.dto(s, viewer)));
  }

  async get(viewer: Viewer, slug: string) {
    return this.dto(await this.find(viewer, slug), viewer);
  }

  private async save(organizationId: string | null, createdBy: string, input: StackInput) {
    try {
      const doc = await CapabilityStack.create({ slug: input.slug, organizationId: organizationId ? oid(organizationId) : null, name: input.name, description: input.description, readme: input.readme ?? null, items: input.items, createdBy: oid(createdBy) });
      return doc.toObject() as AnyDoc;
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A stack with this address exists');
      throw e;
    }
  }

  /** An organization's own stack (administrators). */
  async create(actor: Actor, input: StackInput) {
    requirePermission(actor, 'capability.manage');
    await this.checkItems(input.items, actor);
    const s = await this.save(actor.organizationId, actor.userId, input);
    await audit(actor, 'stack.create', { type: 'stack', id: input.slug }, { items: input.items.length });
    return this.dto(s, actor);
  }

  async update(actor: Actor, slug: string, input: z.output<typeof updateStackRequest>) {
    requirePermission(actor, 'capability.manage');
    const cur = await CapabilityStack.findOne({ organizationId: oid(actor.organizationId), slug }).lean();
    if (!cur) throw new AppError('NOT_FOUND', 'Stack not found');
    if (input.items) await this.checkItems(input.items, actor);
    const s = await CapabilityStack.findOneAndUpdate({ _id: cur._id }, { $set: input }, { new: true }).lean();
    await audit(actor, 'stack.update', { type: 'stack', id: slug }, { fields: Object.keys(input) });
    return this.dto(s!, actor);
  }

  async remove(actor: Actor, slug: string) {
    requirePermission(actor, 'capability.manage');
    const r = await CapabilityStack.deleteOne({ organizationId: oid(actor.organizationId), slug });
    if (!r.deletedCount) throw new AppError('NOT_FOUND', 'Stack not found');
    await audit(actor, 'stack.delete', { type: 'stack', id: slug });
  }

  // ── The platform's stacks (platform administrators) ─────────────────────────
  private requireAdmin(actor: PlatformAdmin) {
    if (!actor.platformAdmin) throw new AppError('FORBIDDEN', 'Only server administrators manage the platform’s stacks');
  }

  async createPlatform(actor: PlatformAdmin, input: StackInput) {
    this.requireAdmin(actor);
    await this.checkItems(input.items, null);
    const s = await this.save(null, actor.userId, input);
    await audit(actor, 'stack.create', { type: 'stack', id: input.slug }, { platform: true, items: input.items.length });
    return this.dto(s, null);
  }

  async updatePlatform(actor: PlatformAdmin, slug: string, input: z.output<typeof updateStackRequest>) {
    this.requireAdmin(actor);
    if (input.items) await this.checkItems(input.items, null);
    const s = await CapabilityStack.findOneAndUpdate({ organizationId: null, slug }, { $set: input }, { new: true }).lean();
    if (!s) throw new AppError('NOT_FOUND', 'Stack not found');
    await audit(actor, 'stack.update', { type: 'stack', id: slug }, { platform: true, fields: Object.keys(input) });
    return this.dto(s, null);
  }

  async removePlatform(actor: PlatformAdmin, slug: string) {
    this.requireAdmin(actor);
    const r = await CapabilityStack.deleteOne({ organizationId: null, slug });
    if (!r.deletedCount) throw new AppError('NOT_FOUND', 'Stack not found');
    await audit(actor, 'stack.delete', { type: 'stack', id: slug }, { platform: true });
  }

  /**
   * Installs every package of a stack at one scope. Each goes through the usual installation, so one
   * that policy blocks, or that needs approval, says so without stopping the others.
   */
  async install(actor: Actor, slug: string, input: z.output<typeof installStackRequest>): Promise<InstallStackResponse> {
    requirePermission(actor, input.scope === 'USER' ? 'capability.personal' : 'capability.install');
    if (input.scope === 'PROJECT' && !input.projectId) throw new AppError('VALIDATION_FAILED', 'projectId is required for PROJECT scope');
    const s = await this.find(actor, slug);
    const results: InstallStackResponse['results'] = [];
    for (const item of (s.items ?? []) as Array<{ ref: string; versionRange?: string }>) {
      try {
        const i = await this.capabilities.install(actor, { capabilityId: item.ref, versionRange: item.versionRange, scope: input.scope, projectId: input.projectId, enabled: true, config: {} });
        results.push({ ref: item.ref, status: i.status === 'ACTIVE' ? 'installed' : 'pending_approval', version: i.version, reason: i.status === 'ACTIVE' ? null : i.approvalReasons.join('; ') || 'Needs an administrator’s approval' });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        const reasons = (e.context as { reasons?: string[] }).reasons;
        results.push({ ref: item.ref, status: 'failed', version: null, reason: reasons?.length ? `${e.userMessage}: ${reasons.join('; ')}` : e.userMessage });
      }
    }
    if (results.some((r) => r.status !== 'failed')) await CapabilityStack.updateOne({ _id: s._id }, { $inc: { installs: 1 } });
    await audit(actor, 'stack.install', { type: 'stack', id: slug }, { scope: input.scope, projectId: input.projectId, installed: results.filter((r) => r.status === 'installed').length, failed: results.filter((r) => r.status === 'failed').length });
    return { results };
  }
}
