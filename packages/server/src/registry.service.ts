import { createHash } from 'node:crypto';
import {
  AppError,
  CATEGORIES,
  CLASSIFIER_VERSION,
  classificationFields,
  extractSignals,
  getCategory,
  getTechnology,
  rankSuggestions,
  suggestionScore,
  SUGGESTION_THRESHOLD,
  RELATED_THRESHOLD,
  signalsOfPackage,
  TECHNOLOGIES,
  type Signals,
  type SuggestCandidate,
  capabilityManifestSchema,
  compareVersions,
  formatRef,
  fromMcpRegistry,
  isIndexable,
  mcpRegistryNextCursor,
  PLATFORM_NAMESPACE,
  reviewManifest,
  slugifyNamespace,
  TRUST_RANK,
  type CapabilityManifest,
  type ReviewFinding,
} from '@ao/core';
import { Capability, CapabilityInstallation, CapabilityPackage, Organization, Project, Publisher, Task, User, isDuplicateKeyError, oid } from '@ao/database';
import type { z } from 'zod';
import type { catalogQuery, packageListingInput, suggestRequest } from '@ao/contracts';
import { requirePermission, type Actor, type PlatformActor } from './context.js';
import { requirePlatformAdmin } from './admin.service.js';
import { audit } from './audit.js';
import type { ServerConfig } from './config.js';
import { EmbeddingService, cosine, type EmbeddingsConfig } from './embeddings.js';

type AnyDoc = Record<string, any>;
type Listing = z.output<typeof packageListingInput>;
type CatalogQuery = z.output<typeof catalogQuery>;
type SuggestInput = z.output<typeof suggestRequest>;
/** Who is looking: null = the public (marketplace pages, search engines). */
export type Viewer = Pick<Actor, 'userId' | 'organizationId'> | null;

/** SHA-256 of a manifest as stored; installations pin it. */
export const manifestDigest = (m: unknown) => createHash('sha256').update(JSON.stringify(m)).digest('hex');

/** Same rule as isIndexable() in @ao/core, as an update-pipeline expression, so the flag can be stored and indexed. */
const INDEXABLE_EXPR = {
  $or: [
    { $eq: ['$curated', true] },
    { $gte: [{ $ifNull: ['$installs', 0] }, 5] },
    { $gte: [{ $strLenCP: { $ifNull: ['$readme', ''] } }, 300] },
    { $and: [{ $eq: ['$source', 'native'] }, { $gte: [{ $strLenCP: { $ifNull: ['$description', ''] } }, 60] }] },
  ],
};

/** Recompute the stored `indexable` flag after a change to curation, installs, description or readme. */
export async function refreshIndexable(filter: Record<string, unknown>) {
  await CapabilityPackage.updateMany(filter, [{ $set: { indexable: INDEXABLE_EXPR } }]);
}

export function toPackageDto(p: AnyDoc, verified: boolean, withReview = false) {
  return {
    id: String(p._id),
    ref: p.ref,
    namespace: p.namespace,
    name: p.name,
    type: p.type,
    displayName: p.displayName,
    description: p.description ?? '',
    readme: p.readme ?? null,
    categories: p.categories ?? [],
    technologies: p.technologies ?? [],
    tags: p.tags ?? [],
    homepage: p.homepage ?? null,
    repository: p.repository ?? null,
    publisherName: p.publisherName || p.namespace,
    publisherVerified: verified,
    ownerKind: p.ownerKind,
    visibility: p.visibility,
    source: p.source,
    latestVersion: p.latestVersion,
    trust: p.trust,
    permissions: p.permissions ?? [],
    compatibleAgents: p.compatibleAgents ?? [],
    curated: Boolean(p.curated),
    curatedRank: p.curatedRank ?? null,
    installs: p.installs ?? 0,
    deprecated: p.deprecated ?? null,
    indexable: isIndexable({ curated: Boolean(p.curated), installs: p.installs, description: p.description ?? '', readme: p.readme, source: p.source }),
    ...(withReview ? { review: { status: p.review?.status ?? 'NONE', listed: p.review?.listed ?? true, notes: p.review?.notes ?? '', findings: p.review?.findings ?? [] } } : {}),
    lastPublishedAt: new Date(p.lastPublishedAt ?? p.createdAt).toISOString(),
    createdAt: new Date(p.createdAt).toISOString(),
  };
}

/**
 * Capability registry and marketplace. Packages ("@namespace/name") belong to the platform, an
 * organization, a person, or an upstream registry they were mirrored from. Owners use their packages
 * right away; other organizations see them only after a platform administrator approved a publish
 * request. Curated packages come first in every listing.
 */
export class RegistryService {
  private embeddings: EmbeddingService;

  constructor(
    private config: Pick<ServerConfig, 'REGISTRY_SEARCH'> & EmbeddingsConfig = { REGISTRY_SEARCH: 'text' },
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.embeddings = new EmbeddingService(config, fetchImpl);
  }

  // ── Publishers ──────────────────────────────────────────────────────────────

  private async uniqueNamespace(base: string): Promise<string> {
    let ns = slugifyNamespace(base);
    for (let n = 2; ns === PLATFORM_NAMESPACE || (await Publisher.exists({ namespace: ns })); n++) ns = `${slugifyNamespace(base).slice(0, 35)}-${n}`;
    return ns;
  }

  private async createPublisher(doc: Record<string, unknown>, base: string, retry: () => Promise<AnyDoc>): Promise<AnyDoc> {
    try {
      return (await Publisher.create({ ...doc, namespace: await this.uniqueNamespace(base) })).toObject();
    } catch (e) {
      if (isDuplicateKeyError(e)) return retry(); // a concurrent request created it
      throw e;
    }
  }

  async organizationPublisher(organizationId: string): Promise<AnyDoc> {
    const found = await Publisher.findOne({ kind: 'organization', organizationId: oid(organizationId) }).lean();
    if (found) return found;
    const org = await Organization.findById(oid(organizationId)).lean();
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    return this.createPublisher({ kind: 'organization', organizationId: org._id, displayName: org.name }, org.slug ?? org.name, () => this.organizationPublisher(organizationId));
  }

  async userPublisher(userId: string): Promise<AnyDoc> {
    const found = await Publisher.findOne({ kind: 'user', userId: oid(userId) }).lean();
    if (found) return found;
    const user = await User.findById(oid(userId)).lean();
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    return this.createPublisher({ kind: 'user', userId: user._id, displayName: user.name }, user.email.split('@')[0] ?? user.name, () => this.userPublisher(userId));
  }

  private async platformPublisher(): Promise<AnyDoc> {
    const found = await Publisher.findOne({ namespace: PLATFORM_NAMESPACE }).lean();
    if (found) return found;
    try {
      return (await Publisher.create({ namespace: PLATFORM_NAMESPACE, kind: 'platform', displayName: 'Platform', verified: true })).toObject();
    } catch (e) {
      if (isDuplicateKeyError(e)) return (await Publisher.findOne({ namespace: PLATFORM_NAMESPACE }).lean())!;
      throw e;
    }
  }

  private async verifiedNamespaces(namespaces: string[]) {
    const pubs = await Publisher.find({ namespace: { $in: [...new Set(namespaces)] }, verified: true }, { namespace: 1 }).lean();
    return new Set(pubs.map((p) => p.namespace));
  }

  // ── Visibility ──────────────────────────────────────────────────────────────

  /** Packages a viewer may see and install. `direct` also admits UNLISTED ones (lookup by reference). */
  visibilityFilter(viewer: Viewer, direct = false): Record<string, unknown> {
    const open = { visibility: { $in: direct ? ['PUBLIC', 'UNLISTED'] : ['PUBLIC'] } };
    if (!viewer) return open;
    return {
      $or: [
        open,
        { ownerKind: 'organization', organizationId: oid(viewer.organizationId) },
        { ownerKind: 'user', userId: oid(viewer.userId) },
        { ownerKind: 'platform' },
      ],
    };
  }

  canManage(actor: Actor, p: AnyDoc): boolean {
    if (actor.platformAdmin) return true;
    if (p.ownerKind === 'user') return String(p.userId) === actor.userId;
    if (p.ownerKind === 'organization') return String(p.organizationId) === actor.organizationId && ['OWNER', 'ADMIN'].includes(actor.role);
    return false;
  }

  async findVisible(viewer: Viewer, ref: string): Promise<AnyDoc | null> {
    return CapabilityPackage.findOne({ ref, ...this.visibilityFilter(viewer, true) }).lean();
  }

  // ── Registering versions ────────────────────────────────────────────────────

  /**
   * Adds a version. The package is created on first use and belongs to the organization, the person
   * or (for platform administrators) the platform. Versions are immutable.
   */
  async register(
    actor: Actor,
    rawManifest: unknown,
    opts: { owner?: 'organization' | 'user'; platform?: boolean; visibility?: 'PRIVATE' | 'ORGANIZATION'; listing?: Listing } = {},
  ) {
    const owner = opts.platform ? 'platform' : (opts.owner ?? 'organization');
    if (owner === 'platform' && !actor.platformAdmin) throw new AppError('FORBIDDEN', 'Only platform administrators can publish platform capabilities');
    requirePermission(actor, owner === 'user' ? 'capability.personal' : 'capability.manage');
    const manifest = capabilityManifestSchema.parse(rawManifest);
    // Trust can only be self-declared as LOCAL/UNVERIFIED/COMMUNITY; higher trust is granted by platform admins.
    if (['OFFICIAL', 'VERIFIED'].includes(manifest.trust) && !actor.platformAdmin) manifest.trust = 'LOCAL';
    // The checksum pins the exact code that was reviewed and approved; workers refuse anything else.
    if (manifest.plugin) manifest.plugin.sha256 = manifest.plugin.source ? createHash('sha256').update(manifest.plugin.source).digest('hex') : undefined;

    const publisher = owner === 'platform' ? await this.platformPublisher() : owner === 'user' ? await this.userPublisher(actor.userId) : await this.organizationPublisher(actor.organizationId);
    const ref = formatRef(publisher.namespace, manifest.id);
    const existing = await CapabilityPackage.findOne({ ref }).lean();
    if (existing) {
      const sameOwner = existing.ownerKind === owner && (owner === 'platform' || (owner === 'user' ? String(existing.userId) === actor.userId : String(existing.organizationId) === actor.organizationId));
      if (!sameOwner) throw new AppError('CONFLICT', `${ref} belongs to someone else`);
      if (existing.type !== manifest.type) throw new AppError('CONFLICT', `${ref} is a ${existing.type}; a new version cannot change its type`);
    }
    const previous = existing ? await Capability.findOne({ capabilityId: ref, version: existing.latestVersion }).lean() : null;
    const findings = reviewManifest(manifest, previous?.manifest as CapabilityManifest | undefined);
    // Anything other organizations can already install must stay safe: no blocked findings in new versions.
    const shared = existing && ['PUBLIC', 'UNLISTED'].includes(existing.visibility) && owner !== 'platform';
    const blocking = findings.filter((f) => f.level === 'block');
    if (shared && blocking.length) {
      throw new AppError('VALIDATION_FAILED', `${ref} is published; this version cannot be accepted: ${blocking.map((f) => f.message).join(' ')}`, { context: { findings } });
    }
    // A published package keeps the trust its review granted.
    if (shared && TRUST_RANK[existing.trust]! > TRUST_RANK[manifest.trust]!) manifest.trust = existing.trust as CapabilityManifest['trust'];

    const visibility = owner === 'platform' ? 'PUBLIC' : owner === 'user' ? 'PRIVATE' : 'ORGANIZATION';
    const now = new Date();
    const pkg = await CapabilityPackage.findOneAndUpdate(
      { ref },
      {
        $setOnInsert: {
          ref,
          namespace: publisher.namespace,
          name: manifest.id,
          type: manifest.type,
          ownerKind: owner,
          organizationId: owner === 'organization' ? oid(actor.organizationId) : null,
          userId: owner === 'user' ? oid(actor.userId) : null,
          visibility: owner === 'organization' ? (opts.visibility ?? visibility) : visibility,
          source: 'native',
          createdBy: oid(actor.userId),
          latestVersion: manifest.version,
          trust: manifest.trust,
          displayName: manifest.name,
          ...(owner === 'platform' ? { review: { status: 'APPROVED', listed: true, findings: [] } } : {}),
        },
      },
      { upsert: true, new: true },
    ).lean();
    try {
      await Capability.create({
        organizationId: owner === 'organization' ? oid(actor.organizationId) : null,
        packageId: pkg!._id,
        namespace: publisher.namespace,
        capabilityId: ref,
        version: manifest.version,
        type: manifest.type,
        name: manifest.name,
        description: manifest.description,
        publisher: manifest.publisher,
        trust: manifest.trust,
        permissions: manifest.permissions,
        private: visibility !== 'PUBLIC',
        status: 'ACTIVE',
        digest: manifestDigest(manifest),
        findings,
        manifest,
        createdBy: oid(actor.userId),
      });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', `${ref}@${manifest.version} is already registered; bump the version to publish an update`);
      throw e;
    }
    const isLatest = !existing || compareVersions(manifest.version, existing.latestVersion) >= 0;
    await CapabilityPackage.updateOne(
      { _id: pkg!._id },
      {
        $set: {
          ...(isLatest
            ? {
                latestVersion: manifest.version,
                trust: manifest.trust,
                permissions: manifest.permissions,
                compatibleAgents: manifest.compatibleAgents,
                displayName: manifest.name,
                description: manifest.description,
                homepage: manifest.homepage ?? null,
                publisherName: publisher.displayName || publisher.namespace,
                lastPublishedAt: now,
                deprecated: null,
              }
            : {}),
          ...listingSet(opts.listing),
        },
      },
    );
    await refreshIndexable({ _id: pkg!._id });
    await this.classifyPackage(pkg!._id);
    await audit(actor, 'capability.register', { type: 'capability', id: `${ref}@${manifest.version}` }, { type: manifest.type, permissions: manifest.permissions, findings: findings.map((f) => f.code) });
    return { ref, version: manifest.version, findings };
  }

  async updateListing(actor: Actor, ref: string, listing: Listing) {
    const p = await this.managed(actor, ref);
    await CapabilityPackage.updateOne({ _id: p._id }, { $set: listingSet(listing) });
    await refreshIndexable({ _id: p._id });
    await this.classifyPackage(p._id);
    return this.get(actor, p.namespace, p.name);
  }

  private async managed(actor: Actor, ref: string): Promise<AnyDoc> {
    const p = await CapabilityPackage.findOne({ ref }).lean();
    if (!p || !this.canManage(actor, p)) throw new AppError('NOT_FOUND', 'Package not found');
    return p;
  }

  // ── Publishing and review ───────────────────────────────────────────────────

  /** Ask for a package to be shown to everyone (listed) or installable by reference (unlisted). */
  async requestPublish(actor: Actor, ref: string, listed: boolean) {
    const p = await this.managed(actor, ref);
    if (p.source !== 'native') throw new AppError('VALIDATION_FAILED', 'Mirrored packages are published by their upstream registry');
    const latest = await Capability.findOne({ capabilityId: ref, version: p.latestVersion }).lean();
    const findings: ReviewFinding[] = reviewManifest(latest!.manifest as CapabilityManifest);
    const blocking = findings.filter((f) => f.level === 'block');
    if (blocking.length) throw new AppError('VALIDATION_FAILED', `Fix these before publishing: ${blocking.map((f) => f.message).join(' ')}`, { context: { findings } });
    const now = new Date();
    const autoApprove = p.ownerKind === 'platform';
    await CapabilityPackage.updateOne(
      { _id: p._id },
      {
        $set: {
          'review.status': autoApprove ? 'APPROVED' : 'PENDING',
          'review.listed': listed,
          'review.requestedAt': now,
          'review.requestedBy': oid(actor.userId),
          'review.findings': findings,
          'review.notes': '',
          ...(autoApprove ? { visibility: listed ? 'PUBLIC' : 'UNLISTED' } : {}),
        },
      },
    );
    await audit(actor, 'capability.publish_request', { type: 'capability', id: ref }, { listed, findings: findings.map((f) => f.code) });
    return this.get(actor, p.namespace, p.name, true);
  }

  /** Stop sharing: back to the owner (or organization) only. Existing installations elsewhere keep working. */
  async unpublish(actor: Actor, ref: string) {
    const p = await this.managed(actor, ref);
    await CapabilityPackage.updateOne({ _id: p._id }, { $set: { visibility: p.ownerKind === 'user' ? 'PRIVATE' : 'ORGANIZATION', 'review.status': 'NONE', curated: false } });
    await refreshIndexable({ _id: p._id });
    await audit(actor, 'capability.unpublish', { type: 'capability', id: ref });
  }

  async reviewQueue(platformAdmin: boolean | undefined) {
    requirePlatformAdmin(platformAdmin);
    const items = await CapabilityPackage.find({ 'review.status': 'PENDING' }).sort({ 'review.requestedAt': 1 }).limit(200).lean();
    const verified = await this.verifiedNamespaces(items.map((i) => i.namespace));
    return items.map((p) => toPackageDto(p, verified.has(p.namespace), true));
  }

  async review(actor: PlatformActor & { platformAdmin?: boolean }, ref: string, input: { decision: 'approve' | 'reject'; notes: string; trust?: 'OFFICIAL' | 'VERIFIED' | 'COMMUNITY' }) {
    requirePlatformAdmin(actor.platformAdmin);
    const p = await CapabilityPackage.findOne({ ref, 'review.status': 'PENDING' }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'No pending review for this package');
    const set: Record<string, unknown> = { 'review.status': input.decision === 'approve' ? 'APPROVED' : 'REJECTED', 'review.notes': input.notes, 'review.reviewedAt': new Date(), 'review.reviewedBy': oid(actor.userId) };
    if (input.decision === 'approve') {
      const trust = input.trust ?? (TRUST_RANK[p.trust]! > TRUST_RANK.COMMUNITY! ? p.trust : 'COMMUNITY');
      set.visibility = p.review?.listed === false ? 'UNLISTED' : 'PUBLIC';
      set.trust = trust;
      await Capability.updateMany({ capabilityId: ref }, { $set: { trust, 'manifest.trust': trust, private: false } });
    }
    await CapabilityPackage.updateOne({ _id: p._id }, { $set: set });
    await audit(actor, `capability.review_${input.decision}`, { type: 'capability', id: ref }, { notes: input.notes });
    return this.get(null, p.namespace, p.name).catch(() => null);
  }

  async curate(actor: PlatformActor & { platformAdmin?: boolean }, ref: string, curated: boolean, rank?: number | null) {
    requirePlatformAdmin(actor.platformAdmin);
    const p = await CapabilityPackage.findOne({ ref }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'Package not found');
    if (curated && p.visibility !== 'PUBLIC') throw new AppError('VALIDATION_FAILED', 'Only public packages can be curated');
    // Unranked curated packages sort after ranked ones.
    await CapabilityPackage.updateOne({ _id: p._id }, { $set: { curated, curatedRank: curated ? (rank ?? 100_000) : null } });
    await refreshIndexable({ _id: p._id });
    await audit(actor, curated ? 'capability.curate' : 'capability.uncurate', { type: 'capability', id: ref }, { rank });
    return this.get(null, p.namespace, p.name);
  }

  /** Deprecate or yank a version. Yanked versions cannot be installed and are not delivered to agents. */
  async setVersionStatus(actor: Actor, ref: string, version: string, status: 'ACTIVE' | 'DEPRECATED' | 'YANKED', message?: string) {
    const p = await this.managed(actor, ref);
    const v = await Capability.findOneAndUpdate({ capabilityId: ref, version }, { $set: { status } }, { new: true }).lean();
    if (!v) throw new AppError('NOT_FOUND', 'Version not found');
    const active = (await Capability.find({ capabilityId: ref, status: { $ne: 'YANKED' } }, { version: 1, status: 1, manifest: 1 }).lean()).sort((a, b) => compareVersions(b.version, a.version));
    const latest = active[0];
    await CapabilityPackage.updateOne(
      { _id: p._id },
      {
        $set: {
          ...(latest ? { latestVersion: latest.version, permissions: (latest.manifest as CapabilityManifest).permissions } : {}),
          deprecated: latest?.status === 'DEPRECATED' ? (message ?? 'Deprecated by its publisher') : null,
        },
      },
    );
    await this.classifyPackage(p._id);
    await audit(actor, `capability.version_${status.toLowerCase()}`, { type: 'capability', id: `${ref}@${version}` }, { message });
  }

  // ── Classification ──────────────────────────────────────────────────────────

  /** Recompute a package's categories, technologies and keywords from its listing and latest version. */
  async classifyPackage(id: unknown, manifest?: CapabilityManifest) {
    const p = await CapabilityPackage.findById(id).lean();
    if (!p) return;
    const m = manifest ?? ((await Capability.findOne({ capabilityId: p.ref, version: p.latestVersion }, { manifest: 1 }).lean())?.manifest as CapabilityManifest | undefined);
    // The listing may have changed: its embedding is made again (see embedStale).
    await CapabilityPackage.updateOne({ _id: p._id }, { $set: classificationFields(p as never, m), $unset: { embedding: 1 } });
    this.facetCache.clear();
    if (this.embeddings.enabled) void this.embedStale(50).catch(() => undefined);
  }

  // ── Semantic suggestions (only with an embeddings API configured) ───────────

  /** What a package is, in a few hundred words, for the embedding model. */
  private embeddingText(p: AnyDoc): string {
    return [p.displayName ?? p.name, p.description ?? '', (p.tags ?? []).join(', '), [...(p.categories ?? []), ...(p.technologies ?? [])].join(', '), (p.readme ?? '').slice(0, 3000)].filter(Boolean).join('\n');
  }

  /**
   * Embeds the packages that have no embedding from the current model. Returns how many were embedded.
   * Runs in the background at startup and after a listing changes; a failing API leaves them for next time.
   */
  async embedStale(max = 5000): Promise<number> {
    if (!this.embeddings.enabled) return 0;
    const model = this.embeddings.model;
    let done = 0;
    while (done < max) {
      const batch = await CapabilityPackage.find({ 'embedding.model': { $ne: model } }).sort({ _id: 1 }).limit(64).lean();
      if (!batch.length) break;
      const vectors = await this.embeddings.embed(batch.map((p) => this.embeddingText(p)));
      await CapabilityPackage.bulkWrite(batch.map((p, i) => ({ updateOne: { filter: { _id: p._id }, update: { $set: { embedding: { model, vector: vectors[i] } } } } })), { ordered: false });
      done += batch.length;
    }
    if (done) this.vectorCache = null;
    return done;
  }

  async embedAll(actor: PlatformActor & { platformAdmin?: boolean }) {
    requirePlatformAdmin(actor.platformAdmin);
    if (!this.embeddings.enabled) throw new AppError('VALIDATION_FAILED', 'No embeddings API is configured (EMBEDDINGS_URL)');
    const embedded = await this.embedStale(50_000);
    await audit(actor, 'capability.embed', { type: 'registry', id: 'packages' }, { embedded, model: this.embeddings.model });
    return { embedded, model: this.embeddings.model };
  }

  /** Vectors of the public packages compared in memory (the most used ones, when there are more than this). */
  private static readonly SCAN_LIMIT = 5000;
  private vectorCache: { at: number; model: string; rows: Array<{ id: unknown; vector: Float32Array }> } | null = null;

  private async publicVectors() {
    const model = this.embeddings.model;
    if (this.vectorCache && this.vectorCache.model === model && Date.now() - this.vectorCache.at < 300_000) return this.vectorCache.rows;
    const docs = await CapabilityPackage.find({ visibility: 'PUBLIC', deprecated: null, 'embedding.model': model }, { 'embedding.vector': 1 })
      .sort({ curated: -1, curatedRank: 1, installs: -1 })
      .limit(RegistryService.SCAN_LIMIT)
      .lean();
    const rows = docs.map((d) => ({ id: d._id, vector: Float32Array.from((d.embedding as { vector: number[] }).vector) }));
    this.vectorCache = { at: Date.now(), model, rows };
    return rows;
  }

  /**
   * Public packages closest in meaning to a text, with their similarity. Empty without an embeddings API,
   * and when the API fails: suggestions then rest on the rules alone. With Atlas (`REGISTRY_SEARCH=atlas`)
   * the vector index "capability_embeddings" on `embedding.vector` is used; otherwise the most used
   * packages are compared in memory.
   */
  private async semanticNeighbors(text: string, type: string | undefined, limit = 30): Promise<Array<{ doc: AnyDoc; similarity: number }>> {
    if (!this.embeddings.enabled || text.trim().length < 8) return [];
    let query: number[];
    try {
      [query] = (await this.embeddings.embed([text])) as [number[]];
    } catch {
      return [];
    }
    const min = this.embeddings.minSimilarity;
    const common = { visibility: 'PUBLIC', deprecated: null, ...(type ? { type } : {}) };
    if (this.config.REGISTRY_SEARCH === 'atlas') {
      const rows = await CapabilityPackage.aggregate<AnyDoc>([
        { $vectorSearch: { index: 'capability_embeddings', path: 'embedding.vector', queryVector: query, numCandidates: 400, limit: limit * 2, filter: { visibility: 'PUBLIC' } } },
        { $addFields: { similarity: { $meta: 'vectorSearchScore' } } },
        { $match: common },
        { $project: { embedding: 0 } },
      ]);
      return rows.filter((r) => r.similarity >= min).slice(0, limit).map((doc) => ({ doc, similarity: doc.similarity as number }));
    }
    const scored = (await this.publicVectors())
      .map((r) => ({ id: r.id, similarity: cosine(query, r.vector) }))
      .filter((r) => r.similarity >= min)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit * 2);
    if (!scored.length) return [];
    const docs = new Map((await CapabilityPackage.find({ _id: { $in: scored.map((s) => s.id) }, ...common }).lean()).map((d) => [String(d._id), d]));
    return scored.filter((s) => docs.has(String(s.id))).slice(0, limit).map((s) => ({ doc: docs.get(String(s.id))!, similarity: s.similarity }));
  }

  /**
   * Classify packages whose classification is older than the current rules (every package with `all`).
   * Runs in batches and returns how many were updated. For administrators after the taxonomy changes.
   */
  async reclassify(actor: PlatformActor & { platformAdmin?: boolean }, all = false, max = 50_000) {
    requirePlatformAdmin(actor.platformAdmin);
    const classified = await this.reclassifyStale(all, max);
    await audit(actor, 'capability.reclassify', { type: 'registry', id: 'packages' }, { all, classified });
    return { classified, version: CLASSIFIER_VERSION };
  }

  /** Classify what the current rules have not seen yet (also run in the background at startup). */
  async reclassifyStale(all = false, max = 50_000): Promise<number> {
    const filter = all ? {} : { $or: [{ classifierVersion: { $lt: CLASSIFIER_VERSION } }, { classifierVersion: { $exists: false } }] };
    let done = 0;
    let lastId: unknown = null;
    while (done < max) {
      const batch = await CapabilityPackage.find({ ...filter, ...(lastId ? { _id: { $gt: lastId } } : {}) }).sort({ _id: 1 }).limit(200).lean();
      if (!batch.length) break;
      const latest = await Capability.find({ $or: batch.map((p) => ({ capabilityId: p.ref, version: p.latestVersion })) }, { capabilityId: 1, manifest: 1 }).lean();
      const byRef = new Map(latest.map((c) => [c.capabilityId, c.manifest as CapabilityManifest]));
      await CapabilityPackage.bulkWrite(
        batch.map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: classificationFields(p as never, byRef.get(p.ref)) } } })),
        { ordered: false },
      );
      done += batch.length;
      lastId = batch.at(-1)!._id;
    }
    if (done) this.facetCache.clear();
    return done;
  }

  /** Platform administrators can pin a package's categories; null hands them back to the classifier. */
  async setCategories(actor: PlatformActor & { platformAdmin?: boolean }, ref: string, categories: string[] | null) {
    requirePlatformAdmin(actor.platformAdmin);
    const p = await CapabilityPackage.findOne({ ref }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'Package not found');
    await CapabilityPackage.updateOne({ _id: p._id }, categories ? { $set: { categoryOverride: categories } } : { $unset: { categoryOverride: 1 } });
    await this.classifyPackage(p._id);
    await audit(actor, 'capability.categorize', { type: 'capability', id: ref }, { categories });
    return this.get(null, p.namespace, p.name).catch(() => null);
  }

  private facetCache = new Map<string, { at: number; value: { categories: Facet[]; technologies: Facet[] } }>();

  /** Categories and technologies with counts of public packages, for filters and landing pages. Cached for 10 minutes. */
  async facets(type?: string) {
    const key = type ?? '*';
    const hit = this.facetCache.get(key);
    if (hit && Date.now() - hit.at < 600_000) return hit.value;
    const match = { visibility: 'PUBLIC', ...(type ? { type } : {}) };
    const count = (field: string) => CapabilityPackage.aggregate<{ _id: string; count: number }>([{ $match: match }, { $unwind: `$${field}` }, { $group: { _id: `$${field}`, count: { $sum: 1 } } }]);
    const [cats, techs] = await Promise.all([count('categories'), count('technologies')]);
    const catCount = new Map(cats.map((c) => [c._id, c.count]));
    const techCount = new Map(techs.map((c) => [c._id, c.count]));
    const value = {
      categories: CATEGORIES.map((c) => ({ slug: c.slug, label: c.label, description: c.description, count: catCount.get(c.slug) ?? 0 })),
      technologies: TECHNOLOGIES.map((t) => ({ slug: t.slug, label: t.label, count: techCount.get(t.slug) ?? 0 }))
        .filter((t) => t.count > 0)
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    };
    this.facetCache.set(key, { at: Date.now(), value });
    return value;
  }

  // ── Suggestions ─────────────────────────────────────────────────────────────

  /**
   * Packages that fit a piece of work: a prompt, a task, a project, or a mix. The text is read for
   * technologies, categories and keywords (see @ao/core taxonomy); a project adds the stack its last
   * readiness check detected. Curated packages come first; nothing below the relevance threshold is suggested.
   */
  async suggest(viewer: Viewer, input: SuggestInput) {
    const parts: string[] = [input.text];
    let stack: { languages?: string[]; dependencies?: string[]; files?: string[] } = {};
    let projectId: unknown = null;
    let taskId: unknown = null;
    if (viewer && input.taskId) {
      const t = await Task.findOne({ _id: oid(input.taskId, 'Task'), organizationId: oid(viewer.organizationId) }, { title: 1, originalPrompt: 1, normalizedPrompt: 1, knowledge: 1, projectId: 1 }).lean();
      if (!t) throw new AppError('NOT_FOUND', 'Task not found');
      parts.push(t.title, t.normalizedPrompt ?? t.originalPrompt, t.knowledge ?? '');
      taskId = t._id;
      projectId = t.projectId;
    }
    if (viewer && (input.projectId || projectId)) {
      const p = await Project.findOne({ _id: projectId ?? oid(input.projectId!, 'Project'), organizationId: oid(viewer.organizationId) }, { name: 1, description: 1, knowledge: 1, readiness: 1 }).lean();
      if (!p) throw new AppError('NOT_FOUND', 'Project not found');
      parts.push(p.name, p.description ?? '', (p.knowledge ?? '').slice(0, 5000));
      stack = p.readiness?.stack ?? {};
      projectId = p._id;
    }
    const text = parts.filter(Boolean).join('\n');
    const signals = extractSignals({ text, ...stack });
    const candidates = await this.candidates(viewer, signals, input.type);
    const neighbors = await this.semanticNeighbors(text, input.type);
    let ranked = rankSuggestions(candidates, signals, input.limit);
    if (neighbors.length) {
      // Closeness in meaning adds to the rules' relevance (up to 10, like two technologies), and by itself
      // is enough to suggest a package the rules have no words for.
      const similarity = new Map(neighbors.map((n) => [n.doc.ref as string, n.similarity]));
      const pool = new Map<string, AnyDoc & SuggestCandidate>(candidates.map((c) => [c.ref as string, c]));
      for (const n of neighbors) if (!pool.has(n.doc.ref)) pool.set(n.doc.ref, { ...n.doc, name: n.doc.name, displayName: n.doc.displayName, trust: n.doc.trust, curated: Boolean(n.doc.curated), categories: n.doc.categories ?? [], technologies: n.doc.technologies ?? [], keywords: n.doc.keywords ?? [], description: n.doc.description ?? '' });
      ranked = [...pool.values()]
        .map((item) => {
          const rule = suggestionScore(item, signals);
          const sim = similarity.get(item.ref as string);
          const bonus = sim === undefined ? 0 : Math.max(SUGGESTION_THRESHOLD, Math.round(sim * 10));
          return { item, relevance: rule.relevance + bonus, score: rule.score + bonus, reasons: sim === undefined ? rule.reasons : [...rule.reasons, 'Close in meaning to what you described'] };
        })
        .filter((r) => r.relevance >= SUGGESTION_THRESHOLD)
        .sort((a, b) => Number(b.item.curated) - Number(a.item.curated) || b.score - a.score || a.item.name.localeCompare(b.item.name))
        .slice(0, input.limit)
        .map(({ item, score, reasons }) => ({ item, score: Math.round(score * 10) / 10, reasons }));
    }
    let installed = new Set<string>();
    if (viewer && ranked.length) {
      const scopes: Record<string, unknown>[] = [{ scope: 'ORGANIZATION' }, { scope: 'USER', userId: oid(viewer.userId) }];
      if (projectId) scopes.push({ scope: 'PROJECT', projectId });
      if (taskId) scopes.push({ scope: 'TASK', taskId });
      const rows = await CapabilityInstallation.find({ organizationId: oid(viewer.organizationId), status: 'ACTIVE', capabilityId: { $in: ranked.map((r) => r.item.ref) }, $or: scopes }, { capabilityId: 1 }).lean();
      installed = new Set(rows.map((r) => r.capabilityId));
    }
    const verified = await this.verifiedNamespaces(ranked.map((r) => r.item.namespace));
    return {
      items: ranked.map((r) => ({ package: toPackageDto(r.item, verified.has(r.item.namespace)), score: r.score, reasons: r.reasons, installed: installed.has(r.item.ref) })),
      signals: {
        technologies: [...signals.technologies.keys()],
        categories: [...signals.categories]
          .filter(([c, s]) => s >= 3 && c !== 'other')
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([c]) => c),
      },
    };
  }

  /** Packages similar to one package, for the "related" links on its page. */
  async related(viewer: Viewer, namespace: string, name: string, limit = 8) {
    const p = await this.findVisible(viewer, formatRef(namespace, name));
    if (!p) throw new AppError('NOT_FOUND', 'Package not found');
    const signals = signalsOfPackage({ categories: p.categories ?? [], technologies: p.technologies ?? [], keywords: p.keywords ?? [] });
    const candidates = (await this.candidates(viewer, signals, undefined)).filter((c) => c.ref !== p.ref);
    const ranked = rankSuggestions(candidates, signals, limit, RELATED_THRESHOLD);
    const verified = await this.verifiedNamespaces(ranked.map((r) => r.item.namespace));
    return { items: ranked.map((r) => toPackageDto(r.item, verified.has(r.item.namespace))) };
  }

  /**
   * Candidates for a set of signals: a few bounded, index-backed queries (by technology, keyword,
   * category and text) rather than one broad one, so the cost does not grow with the catalog.
   */
  private async candidates(viewer: Viewer, signals: Signals, type: string | undefined): Promise<Array<AnyDoc & SuggestCandidate>> {
    const techs = [...signals.technologies.keys()];
    const tokens = [...signals.tokens].slice(0, 60);
    const cats = [...signals.categories].filter(([c, s]) => s >= 2 && c !== 'other').map(([c]) => c);
    const branches: Record<string, unknown>[] = [];
    if (techs.length) branches.push({ technologies: { $in: techs } });
    if (tokens.length) branches.push({ keywords: { $in: tokens } });
    if (cats.length) branches.push({ categories: { $in: cats } });
    if (!branches.length) return [];
    const common = { deprecated: null, ...(type ? { type } : {}) };
    const queries: Promise<AnyDoc[]>[] = branches.map((b) => CapabilityPackage.find({ visibility: 'PUBLIC', ...common, ...b }).sort({ curated: -1, curatedRank: 1, installs: -1 }).limit(200).lean());
    if (tokens.length) {
      queries.push(
        CapabilityPackage.find({ visibility: 'PUBLIC', ...common, $text: { $search: tokens.slice(0, 20).join(' ') } }, { score: { $meta: 'textScore' } })
          .sort({ score: { $meta: 'textScore' } })
          .limit(100)
          .lean(),
      );
    }
    // The viewer's own and their organization's packages: few, so one query.
    if (viewer) queries.push(CapabilityPackage.find({ $and: [this.ownedFilter(viewer), { $or: branches }], ...common }).limit(200).lean());
    const byId = new Map<string, AnyDoc>();
    for (const rows of await Promise.all(queries)) for (const r of rows) byId.set(String(r._id), r);
    return [...byId.values()].map((r) => ({ ...r, name: r.name, displayName: r.displayName, trust: r.trust, curated: Boolean(r.curated), categories: r.categories ?? [], technologies: r.technologies ?? [], keywords: r.keywords ?? [], description: r.description ?? '' }));
  }


  // ── Search and catalog ──────────────────────────────────────────────────────

  /**
   * Marketplace search. Curated packages always come first; `tier: 'curated'` returns only them, and
   * `curatedCount` tells a client whether to offer everything else.
   */
  async search(viewer: Viewer, q: CatalogQuery) {
    const base: Record<string, unknown> = { ...(q.mine && viewer ? this.ownedFilter(viewer) : this.visibilityFilter(viewer)) };
    if (q.type) base.type = q.type;
    if (q.category) base.categories = q.category;
    if (q.technology) base.technologies = q.technology;
    const filter = q.tier === 'curated' ? { ...base, curated: true } : base;
    const skip = (q.page - 1) * q.limit;
    let rows: AnyDoc[];
    let curatedCount: number;
    if (q.q && this.config.REGISTRY_SEARCH === 'atlas') {
      rows = await this.atlasSearch(q.q, filter, skip, q.limit + 1);
      curatedCount = q.tier === 'curated' ? rows.length : (await this.atlasSearch(q.q, { ...base, curated: true }, 0, 101)).length;
    } else if (q.q) {
      const text = { $text: { $search: q.q } };
      rows = await CapabilityPackage.find({ ...filter, ...text }, { score: { $meta: 'textScore' } })
        .sort({ curated: -1, curatedRank: 1, score: { $meta: 'textScore' }, installs: -1 })
        .skip(skip)
        .limit(q.limit + 1)
        .lean();
      curatedCount = await CapabilityPackage.countDocuments({ ...base, ...text, curated: true }).limit(1000);
    } else {
      rows = await CapabilityPackage.find(filter).sort({ curated: -1, curatedRank: 1, installs: -1, name: 1 }).skip(skip).limit(q.limit + 1).lean();
      curatedCount = await CapabilityPackage.countDocuments({ ...base, curated: true }).limit(1000);
    }
    const hasMore = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    const verified = await this.verifiedNamespaces(items.map((i) => i.namespace));
    return { items: items.map((p) => toPackageDto(p, verified.has(p.namespace), Boolean(q.mine))), page: q.page, limit: q.limit, hasMore, curatedCount };
  }

  private ownedFilter(viewer: NonNullable<Viewer>) {
    return { $or: [{ ownerKind: 'organization', organizationId: oid(viewer.organizationId) }, { ownerKind: 'user', userId: oid(viewer.userId) }] };
  }

  /** Atlas Search (index "capability_packages" on displayName, name, tags, description). */
  private async atlasSearch(text: string, filter: Record<string, unknown>, skip: number, limit: number): Promise<AnyDoc[]> {
    return CapabilityPackage.aggregate([
      { $search: { index: 'capability_packages', text: { query: text, path: ['displayName', 'name', 'tags', 'description', 'namespace'], fuzzy: { maxEdits: 1 } } } },
      { $limit: 1000 },
      { $match: filter },
      { $addFields: { score: { $meta: 'searchScore' } } },
      { $sort: { curated: -1, curatedRank: 1, score: -1, installs: -1 } },
      { $skip: skip },
      { $limit: limit },
    ]);
  }

  /** One package with its versions, for the dashboard and the public page. */
  async get(viewer: Viewer, namespace: string, name: string, withReview = false) {
    const ref = formatRef(namespace, name);
    const p = await this.findVisible(viewer, ref);
    if (!p) throw new AppError('NOT_FOUND', 'Package not found');
    const versions = await Capability.find({ capabilityId: ref }, { version: 1, status: 1, permissions: 1, createdAt: 1 }).lean();
    versions.sort((a, b) => compareVersions(b.version, a.version));
    const latest = await Capability.findOne({ capabilityId: ref, version: p.latestVersion }).lean();
    const manifest = latest ? { ...(latest.manifest as AnyDoc) } : null;
    if (manifest?.plugin) manifest.plugin = { ...manifest.plugin, source: undefined };
    const verified = await this.verifiedNamespaces([p.namespace]);
    return {
      ...toPackageDto(p, verified.has(p.namespace), withReview),
      manifest,
      findings: (latest?.findings ?? []) as ReviewFinding[],
      versions: versions.slice(0, 100).map((v) => ({ version: v.version, status: v.status ?? 'ACTIVE', permissions: v.permissions ?? [], publishedAt: new Date(v.createdAt).toISOString() })),
    };
  }

  /** Public, indexable packages in _id order, for sitemaps (`page` is 1-based; `total` sizes the sitemap index). */
  async sitemap(page: number, limit: number) {
    const filter = { visibility: 'PUBLIC', indexable: true };
    const [rows, total] = await Promise.all([
      CapabilityPackage.find(filter, { namespace: 1, name: 1, type: 1, updatedAt: 1, curated: 1 }).sort({ _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      CapabilityPackage.countDocuments(filter),
    ]);
    return { items: rows.map((r) => ({ namespace: r.namespace, name: r.name, type: r.type, curated: Boolean(r.curated), updatedAt: new Date(r.updatedAt).toISOString() })), page, limit, total };
  }

  // ── Federation ──────────────────────────────────────────────────────────────

  /**
   * Mirrors servers from an MCP Registry (the official one by default). Only metadata is stored; the
   * servers run from their own npm/PyPI/OCI packages or URLs. Mirrored packages are UNVERIFIED until a
   * platform administrator raises their trust, and never replace a native package with the same reference.
   */
  async importMcpRegistry(actor: PlatformActor & { platformAdmin?: boolean }, input: { url: string; maxPages: number; cursor?: string }) {
    requirePlatformAdmin(actor.platformAdmin);
    const registry = new URL(input.url).host;
    let cursor = input.cursor ?? null;
    const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
    for (let page = 0; page < input.maxPages; page++) {
      const url = new URL(input.url);
      url.searchParams.set('limit', '100');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await this.fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new AppError('UPSTREAM_ERROR', `The registry answered ${res.status}`);
      const body = (await res.json()) as { servers?: unknown[] };
      for (const raw of body.servers ?? []) counts[await this.upsertFederated(fromMcpRegistry(raw, registry), registry)]++;
      cursor = mcpRegistryNextCursor(body);
      if (!cursor) break;
    }
    await audit(actor, 'capability.import', { type: 'registry', id: registry }, counts);
    return { ...counts, nextCursor: cursor };
  }

  private async upsertFederated(f: ReturnType<typeof fromMcpRegistry>, registry: string): Promise<'created' | 'updated' | 'unchanged' | 'skipped'> {
    if (!f) return 'skipped';
    let pub = await Publisher.findOne({ namespace: f.namespace }).lean();
    if (!pub) {
      try {
        pub = (await Publisher.create({ namespace: f.namespace, kind: 'upstream', displayName: f.manifest.publisher, upstreamRegistry: registry })).toObject();
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
        pub = await Publisher.findOne({ namespace: f.namespace }).lean();
      }
    }
    // The namespace was claimed by a person or organization here: theirs wins.
    if (!pub || pub.kind !== 'upstream') return 'skipped';
    const ref = formatRef(f.namespace, f.name);
    const existing = await CapabilityPackage.findOne({ ref }).lean();
    if (existing && existing.source !== 'federated') return 'skipped';
    if (existing && (await Capability.exists({ capabilityId: ref, version: f.manifest.version }))) return 'unchanged';
    const now = new Date();
    // Keep a trust level an administrator granted.
    const trust = existing && TRUST_RANK[existing.trust]! > TRUST_RANK.UNVERIFIED! ? existing.trust : 'UNVERIFIED';
    const manifest = { ...f.manifest, trust } as CapabilityManifest;
    const pkg = await CapabilityPackage.findOneAndUpdate(
      { ref },
      {
        $setOnInsert: { ref, namespace: f.namespace, name: f.name, type: f.type, ownerKind: 'upstream', visibility: 'PUBLIC', source: 'federated', review: { status: 'APPROVED', listed: true, findings: [] } },
        $set: {
          upstream: f.upstream,
          displayName: manifest.name,
          description: manifest.description,
          homepage: f.listing.homepage ?? null,
          repository: f.listing.repository ?? null,
          publisherName: manifest.publisher,
          latestVersion: manifest.version,
          trust,
          permissions: manifest.permissions,
          lastPublishedAt: now,
        },
      },
      { upsert: true, new: true },
    ).lean();
    await refreshIndexable({ _id: pkg!._id });
    await this.classifyPackage(pkg!._id, manifest);
    try {
      await Capability.create({
        packageId: pkg!._id,
        namespace: f.namespace,
        capabilityId: ref,
        version: manifest.version,
        type: f.type,
        name: manifest.name,
        description: manifest.description,
        publisher: manifest.publisher,
        trust,
        permissions: manifest.permissions,
        private: false,
        digest: manifestDigest(manifest),
        findings: reviewManifest(manifest),
        manifest,
      });
    } catch (e) {
      if (!isDuplicateKeyError(e)) throw e;
    }
    return existing ? 'updated' : 'created';
  }
}

type Facet = { slug: string; label: string; description?: string; count: number };

/** Names for a package's categories and technologies. */
export function describeClassification(p: { categories?: string[]; technologies?: string[] }) {
  return {
    categories: (p.categories ?? []).map((c) => ({ slug: c, label: getCategory(c)?.label ?? c })),
    technologies: (p.technologies ?? []).map((t) => ({ slug: t, label: getTechnology(t)?.label ?? t })),
  };
}

function listingSet(l: Listing | undefined): Record<string, unknown> {
  if (!l) return {};
  const out: Record<string, unknown> = {};
  if (l.readme !== undefined) out.readme = l.readme;
  if (l.categories) out.declaredCategories = [...new Set(l.categories)];
  if (l.tags) out.tags = [...new Set(l.tags.map((t) => t.toLowerCase()))];
  if (l.repository !== undefined) out.repository = l.repository;
  return out;
}

