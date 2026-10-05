import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { CATEGORY_SLUGS, classificationFields, compareVersions, createLogger, formatRef, PLATFORM_NAMESPACE, repositoryKey, repositoryName, sanitizeRepositoryName, slugifyNamespace } from '@ao/core';

const log = createLogger('migrations');

/**
 * Data migrations (spec §69 database/migrations). Applied in id order, each at most once, recorded in
 * `_migrations`. A lease-style lock ensures only one API instance migrates at a time; a crashed
 * instance's lock expires. Migrations must be idempotent (they may be retried after a crash).
 */
export interface Migration {
  id: string; // e.g. "0002-add-task-foo" — sorted lexicographically
  description: string;
  up(db: mongoose.mongo.Db): Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '0001-baseline',
    description: 'Baseline schema (indexes are created by ensureIndexes)',
    async up() {},
  },
  {
    id: '0002-task-counters',
    description: 'Backfill task counters added after the first schema version',
    async up(db) {
      for (const field of ['remediationCount', 'contextResetCount', 'limitHitCount', 'restartCount', 'retryCount', 'activeMs']) {
        await db.collection('tasks').updateMany({ [field]: { $exists: false } }, { $set: { [field]: 0 } });
      }
    },
  },
  {
    id: '0003-unique-identities',
    description: 'Replace the non-unique external-identity index with a unique one (OAuth sign-in)',
    async up(db) {
      const users = db.collection('users');
      const existing = await users.indexes().catch(() => []);
      if (existing.some((i) => i.name === 'identities.provider_1_identities.subject_1')) await users.dropIndex('identities.provider_1_identities.subject_1');
    },
  },
  {
    id: '0004-project-repositories',
    description: 'Give every project a primary repository (from repositoryUrl) and tie worker paths to it',
    async up(db) {
      const projects = db.collection('projects');
      for await (const p of projects.find({ $or: [{ repositories: { $exists: false } }, { repositories: { $size: 0 } }] })) {
        const repo = {
          _id: new mongoose.Types.ObjectId(),
          name: repositoryName(p.repositoryUrl, sanitizeRepositoryName(String(p.name ?? 'repository'))),
          key: repositoryKey(p.repositoryUrl),
          url: p.repositoryUrl ?? null,
          defaultBranch: p.defaultBranch ?? 'main',
          primary: true,
          source: 'manual',
          github: null,
        };
        const workerPaths = ((p.workerPaths ?? []) as Array<Record<string, unknown>>).map((w) => ({ ...w, repositoryId: w.repositoryId ?? repo._id }));
        // Conditional on the state read, so a retry after a crash never adds a second primary repository.
        await projects.updateOne({ _id: p._id, $or: [{ repositories: { $exists: false } }, { repositories: { $size: 0 } }] }, { $set: { repositories: [repo], workerPaths } });
      }
    },
  },
  {
    id: '0005-capability-registry',
    description: 'Namespace capabilities as "@namespace/name", create their packages and publishers, and re-key installations',
    async up(db) {
      const caps = db.collection('capabilities');
      const installs = db.collection('capabilityinstallations');
      const packages = db.collection('capabilitypackages');
      const publishers = db.collection('publishers');
      for (const [col, name] of [[caps, 'organizationId_1_capabilityId_1_version_1'], [installs, 'organizationId_1_scope_1_projectId_1_capabilityId_1']] as const) {
        const existing = await col.indexes().catch(() => []);
        if (existing.some((i) => i.name === name)) await col.dropIndex(name);
      }

      const namespaces = new Map<string, string>(); // organizationId → namespace
      async function orgNamespace(orgId: mongoose.Types.ObjectId): Promise<string> {
        const key = String(orgId);
        if (namespaces.has(key)) return namespaces.get(key)!;
        const found = await publishers.findOne({ kind: 'organization', organizationId: orgId });
        if (found) return namespaces.set(key, found.namespace).get(key)!;
        const org = await db.collection('organizations').findOne({ _id: orgId });
        const base = slugifyNamespace(String(org?.slug ?? org?.name ?? `org-${key.slice(-6)}`));
        let ns = base;
        for (let n = 2; ns === PLATFORM_NAMESPACE || (await publishers.findOne({ namespace: ns })); n++) ns = `${base.slice(0, 35)}-${n}`;
        const now = new Date();
        await publishers.insertOne({ namespace: ns, kind: 'organization', organizationId: orgId, userId: null, displayName: String(org?.name ?? ns), verified: false, upstreamRegistry: null, createdAt: now, updatedAt: now });
        return namespaces.set(key, ns).get(key)!;
      }
      if (!(await publishers.findOne({ namespace: PLATFORM_NAMESPACE }))) {
        const now = new Date();
        await publishers.insertOne({ namespace: PLATFORM_NAMESPACE, kind: 'platform', organizationId: null, userId: null, displayName: 'Platform', verified: true, upstreamRegistry: null, createdAt: now, updatedAt: now });
      }

      // Versions: capabilityId becomes the reference. Already-migrated documents have a namespace.
      for await (const c of caps.find({ namespace: { $in: [null, undefined] } })) {
        const ns = c.organizationId ? await orgNamespace(c.organizationId) : PLATFORM_NAMESPACE;
        const ref = formatRef(ns, String(c.capabilityId));
        await caps.updateOne(
          { _id: c._id },
          { $set: { namespace: ns, capabilityId: ref, status: 'ACTIVE', digest: createHash('sha256').update(JSON.stringify(c.manifest)).digest('hex'), findings: [] } },
        );
      }

      // One package per reference, listing the latest version.
      const refs: string[] = await caps.distinct('capabilityId', { packageId: { $in: [null, undefined] } });
      for (const ref of refs) {
        const versions = await caps.find({ capabilityId: ref }).toArray();
        const latest = versions.sort((a, b) => compareVersions(String(b.version), String(a.version)))[0]!;
        const m = latest.manifest as Record<string, any>;
        const platform = latest.organizationId === null;
        const now = new Date();
        const pkg = await packages.findOneAndUpdate(
          { ref },
          {
            $setOnInsert: {
              ref,
              namespace: latest.namespace,
              name: String(m.id),
              type: latest.type,
              ownerKind: platform ? 'platform' : 'organization',
              organizationId: latest.organizationId ?? null,
              userId: null,
              visibility: platform ? 'PUBLIC' : 'ORGANIZATION',
              source: 'native',
              displayName: String(m.name ?? m.id),
              description: String(m.description ?? ''),
              readme: null,
              categories: [],
              tags: [],
              homepage: m.homepage ?? null,
              repository: null,
              publisherName: String(m.publisher ?? latest.namespace),
              latestVersion: latest.version,
              trust: latest.trust,
              permissions: latest.permissions ?? [],
              compatibleAgents: m.compatibleAgents ?? [],
              lastPublishedAt: latest.createdAt ?? now,
              curated: platform && latest.trust === 'OFFICIAL',
              curatedRank: null,
              review: { status: platform ? 'APPROVED' : 'NONE', listed: true, requestedAt: null, requestedBy: null, reviewedAt: null, reviewedBy: null, notes: '', findings: [] },
              deprecated: null,
              installs: 0,
              createdBy: latest.createdBy ?? null,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true, returnDocument: 'after' },
        );
        await caps.updateMany({ capabilityId: ref }, { $set: { packageId: pkg!._id } });
      }

      // Installations: a bare id means the organization's own capability if it has one, else the platform's.
      for await (const i of installs.find({ capabilityId: { $not: /^@/ } })) {
        const own = formatRef(await orgNamespace(i.organizationId), String(i.capabilityId));
        const ref = (await caps.findOne({ capabilityId: own })) ? own : formatRef(PLATFORM_NAMESPACE, String(i.capabilityId));
        const version = await caps.findOne({ capabilityId: ref, version: i.version });
        await installs.updateOne(
          { _id: i._id },
          { $set: { capabilityId: ref, versionRange: i.version, digest: version?.digest ?? null, userId: null, installedBy: i.approvedBy ?? null } },
        );
      }
      const counts = await installs.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$capabilityId', n: { $sum: 1 } } }]).toArray();
      for (const c of counts) await packages.updateOne({ ref: c._id }, { $set: { installs: c.n } });
      // Same rule as isIndexable() in @ao/core.
      await packages.updateMany({}, [
        {
          $set: {
            indexable: {
              $or: [
                { $eq: ['$curated', true] },
                { $gte: [{ $ifNull: ['$installs', 0] }, 5] },
                { $gte: [{ $strLenCP: { $ifNull: ['$readme', ''] } }, 300] },
                { $and: [{ $eq: ['$source', 'native'] }, { $gte: [{ $strLenCP: { $ifNull: ['$description', ''] } }, 60] }] },
              ],
            },
          },
        },
      ]);
    },
  },
  {
    id: '0006-capability-categories',
    description: 'Classify packages into categories and technologies; publisher-chosen categories become hints',
    async up(db) {
      const packages = db.collection('capabilitypackages');
      const caps = db.collection('capabilities');
      const known = new Set<string>(CATEGORY_SLUGS);
      const cursor = packages.find({ classifierVersion: { $exists: false } }).batchSize(500);
      let ops: mongoose.mongo.AnyBulkWriteOperation[] = [];
      for await (const p of cursor) {
        const latest = await caps.findOne({ capabilityId: p.ref, version: p.latestVersion }, { projection: { manifest: 1 } });
        // Before this migration `categories` held whatever the publisher typed.
        const declared = [...new Set(((p.declaredCategories ?? p.categories ?? []) as string[]).map((c) => c.toLowerCase()).filter((c) => known.has(c)))].slice(0, 3);
        const fields = classificationFields({ ...(p as any), declaredCategories: declared }, latest?.manifest as never);
        ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { declaredCategories: declared, ...fields } } } });
        if (ops.length >= 500) {
          await packages.bulkWrite(ops, { ordered: false });
          ops = [];
        }
      }
      if (ops.length) await packages.bulkWrite(ops, { ordered: false });
    },
  },
  {
    id: '0007-usage-budgets',
    description: 'Give usage records their project and tasks their spend totals (spend budgets)',
    async up(db) {
      const usage = db.collection('usagerecords');
      const tasks = db.collection('tasks');
      const totals = usage.aggregate<{ _id: mongoose.Types.ObjectId; costUsd: number; inputTokens: number; outputTokens: number }>([
        { $match: { taskId: { $ne: null } } },
        { $group: { _id: '$taskId', costUsd: { $sum: { $ifNull: ['$costUsd', 0] } }, inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } }, outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } } } },
      ]);
      for await (const t of totals) {
        const task = await tasks.findOne({ _id: t._id }, { projection: { projectId: 1 } });
        if (!task) continue;
        await usage.updateMany({ taskId: t._id, projectId: null }, { $set: { projectId: task.projectId } });
        // Set, not incremented: a retry after a crash gives the same totals.
        await tasks.updateOne({ _id: t._id }, { $set: { usage: { costUsd: t.costUsd, inputTokens: t.inputTokens, outputTokens: t.outputTokens } } });
      }
    },
  },
];

const LOCK_ID = '__lock__';

export async function runMigrations(migrations: Migration[] = MIGRATIONS, opts: { lockTtlMs?: number; owner?: string } = {}) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');
  const col = db.collection<{ _id: string; appliedAt?: Date; description?: string; owner?: string; expiresAt?: Date }>('_migrations');
  const owner = opts.owner ?? `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const now = new Date();
  // Acquire (or take over an expired) lock atomically.
  let lock;
  try {
    lock = await col.findOneAndUpdate(
      { _id: LOCK_ID, $or: [{ expiresAt: { $lt: now } }, { owner }] },
      { $set: { owner, expiresAt: new Date(now.getTime() + (opts.lockTtlMs ?? 5 * 60_000)) } },
      { upsert: true, returnDocument: 'after' },
    );
  } catch (e: any) {
    if (e?.code === 11000) return { applied: [] as string[], skipped: 'locked' as const };
    throw e;
  }
  if (!lock) return { applied: [] as string[], skipped: 'locked' as const };
  const applied: string[] = [];
  try {
    const done = new Set((await col.find({ _id: { $ne: LOCK_ID } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id));
    for (const m of [...migrations].sort((a, b) => a.id.localeCompare(b.id))) {
      if (done.has(m.id)) continue;
      log.info({ id: m.id }, 'applying migration');
      await m.up(db);
      await col.insertOne({ _id: m.id, appliedAt: new Date(), description: m.description });
      applied.push(m.id);
    }
  } finally {
    await col.deleteOne({ _id: LOCK_ID, owner });
  }
  return { applied, skipped: null };
}
