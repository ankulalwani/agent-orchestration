import { AppError, analyzeReadiness, newId, parseRef, policyLayerSchema, repositoryKey, repositoryName, sanitizeRepositoryName, type CapabilityManifest, type ReadinessReport, type RepoFacts } from '@ao/core';
import { Capability, CapabilityInstallation, CapabilityPackage, Project, Task, Worker, isDuplicateKeyError, oid } from '@ao/database';
import type { z } from 'zod';
import type { addRepositoryRequest, createProjectRequest, updateProjectRequest, updateRepositoryRequest } from '@ao/contracts';
import { requirePermission, type Actor, type WorkerActor } from './context.js';
import type { LiveHub } from './live.js';
import { toProjectDto } from './dto.js';
import { audit } from './audit.js';

/** Where a repository added to a project came from (defaults: added by hand, identity from its URL). */
export interface RepositoryOrigin {
  source?: 'manual' | 'github' | 'discovered';
  /** Identity key when it can't be derived from the URL (repositories without a remote: `local:<root commit>`). */
  key?: string;
  name?: string;
  github?: { installationId: number; repoId: number; fullName: string; private: boolean; archived: boolean; accessible: boolean } | null;
}

type ProjectLike = { repositories?: Array<{ _id: unknown; name: string; primary?: boolean | null; defaultBranch?: string | null }>; workerPaths?: Array<{ workerId: unknown; repositoryId?: unknown; localPath: string }> };

/**
 * A worker's checkouts of a project's repositories, primary first. `complete` when it has every one:
 * only then can it run the project's tasks, since agents see all repositories side by side.
 */
export function workerCheckouts(project: ProjectLike, workerId: string) {
  const repos = [...(project.repositories ?? [])].sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)));
  const primaryId = repos.find((r) => r.primary)?._id;
  const paths = (project.workerPaths ?? []).filter((w) => String(w.workerId) === workerId);
  const repositories = repos.flatMap((r) => {
    const w = paths.find((p) => String(p.repositoryId ?? primaryId) === String(r._id));
    return w ? [{ repositoryId: String(r._id), name: r.name, localPath: w.localPath, primary: Boolean(r.primary), defaultBranch: r.defaultBranch ?? 'main' }] : [];
  });
  return { complete: repos.length > 0 && repositories.length === repos.length, repositories, primaryPath: repositories.find((r) => r.primary)?.localPath ?? null };
}

export class ProjectService {
  /** Called when an organization's projects gained or changed repositories (worker discoveries are matched again). */
  private listeners: Array<(organizationId: string) => void> = [];
  onRepositoriesChanged(fn: (organizationId: string) => void) {
    this.listeners.push(fn);
  }
  private changed(organizationId: string) {
    for (const fn of this.listeners) fn(organizationId);
  }

  async list(actor: Actor) {
    requirePermission(actor, 'project.read');
    const ps = await Project.find({ organizationId: oid(actor.organizationId), archived: { $ne: true } }).sort({ name: 1 }).lean();
    return ps.map(toProjectDto);
  }

  async get(actor: Actor, id: string) {
    requirePermission(actor, 'project.read');
    const p = await Project.findOne({ _id: oid(id, 'Project'), organizationId: oid(actor.organizationId) }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'Project not found');
    return toProjectDto(p);
  }

  /** `origin`: where the repository came from, for projects created from GitHub or from a worker's disk. */
  async create(actor: Actor, input: z.output<typeof createProjectRequest>, origin: RepositoryOrigin = {}) {
    requirePermission(actor, 'project.create');
    const key = origin.key ?? repositoryKey(input.repositoryUrl);
    if (key) await this.assertRepositoryFree(actor.organizationId, key);
    try {
      const p = await Project.create({
        ...input,
        repositoryUrl: input.repositoryUrl || null,
        repositories: [
          {
            name: origin.name ?? repositoryName(input.repositoryUrl, sanitizeRepositoryName(input.name)),
            key,
            url: input.repositoryUrl || null,
            defaultBranch: input.defaultBranch,
            primary: true,
            source: origin.source ?? 'manual',
            github: origin.github ?? null,
          },
        ],
        policy: policyLayerSchema.parse(input.policy ?? {}),
        organizationId: oid(actor.organizationId),
      });
      await audit(actor, 'project.create', { type: 'project', id: String(p._id) }, { name: input.name });
      if (key) this.changed(actor.organizationId);
      return toProjectDto(p.toObject());
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A project with this name already exists');
      throw e;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateProjectRequest>) {
    requirePermission(actor, 'project.update');
    if (input.policy !== undefined) requirePermission(actor, 'policy.manage');
    const set: Record<string, unknown> = { ...input, ...(input.policy ? { policy: policyLayerSchema.parse(input.policy) } : {}) };
    // repositoryUrl and defaultBranch are the primary repository's (kept for older clients).
    if (input.repositoryUrl !== undefined || input.defaultBranch !== undefined) {
      const current = await Project.findOne({ _id: oid(id, 'Project'), organizationId: oid(actor.organizationId) }, { repositories: 1 }).lean();
      const primary = current?.repositories?.find((r) => r.primary);
      if (primary) {
        if (input.repositoryUrl !== undefined) {
          const key = repositoryKey(input.repositoryUrl);
          if (key && key !== primary.key) await this.assertRepositoryFree(actor.organizationId, key);
          set.repositoryUrl = input.repositoryUrl || null;
          set['repositories.$[primary].url'] = input.repositoryUrl || null;
          set['repositories.$[primary].key'] = key;
        }
        if (input.defaultBranch !== undefined) set['repositories.$[primary].defaultBranch'] = input.defaultBranch;
      }
    }
    const usesPrimary = Object.keys(set).some((k) => k.includes('$[primary]'));
    const p = await Project.findOneAndUpdate({ _id: oid(id, 'Project'), organizationId: oid(actor.organizationId) }, { $set: set }, { new: true, ...(usesPrimary ? { arrayFilters: [{ 'primary.primary': true }] } : {}) }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'Project not found');
    await audit(actor, 'project.update', { type: 'project', id }, { fields: Object.keys(input) });
    return toProjectDto(p);
  }

  // ── Repositories: a project has one or more; agents see all of them side by side ──
  private async loadForUpdate(actor: Actor, id: string) {
    requirePermission(actor, 'project.update');
    const p = await Project.findOne({ _id: oid(id, 'Project'), organizationId: oid(actor.organizationId), archived: { $ne: true } });
    if (!p) throw new AppError('NOT_FOUND', 'Project not found');
    return p;
  }

  /** A repository belongs to at most one project of an organization. */
  private async assertRepositoryFree(organizationId: string, key: string) {
    const other = await Project.findOne({ organizationId: oid(organizationId), archived: { $ne: true }, 'repositories.key': key }, { name: 1 }).lean();
    if (other) throw new AppError('CONFLICT', `This repository is already in project "${other.name}". Move it from there instead.`);
  }

  private static uniqueName(taken: string[], wanted: string) {
    let name = wanted;
    for (let i = 2; taken.includes(name.toLowerCase()); i++) name = `${wanted}-${i}`;
    return name;
  }

  private static assertIdle(p: { name: string; activeTaskIds?: unknown[] }) {
    if (p.activeTaskIds?.length) throw new AppError('CONFLICT', `Project "${p.name}" has running tasks; wait for them to finish first`);
  }

  /** Keeps the primary repository's URL and branch on the project (older clients read them there). */
  private static syncPrimary(p: InstanceType<typeof Project>) {
    const repos = p.repositories;
    if (repos.length && !repos.some((r) => r.primary)) repos[0]!.primary = true;
    const primary = repos.find((r) => r.primary);
    p.repositoryUrl = primary?.url ?? null;
    if (primary) p.defaultBranch = primary.defaultBranch ?? 'main';
  }

  async addRepository(actor: Actor, id: string, input: z.output<typeof addRepositoryRequest>, origin: RepositoryOrigin = {}) {
    if ('fromProjectId' in input) return this.moveRepository(actor, input.fromProjectId, input.repositoryId, id);
    const p = await this.loadForUpdate(actor, id);
    const key = origin.key ?? repositoryKey(input.url);
    if (!key && origin.source !== 'discovered') throw new AppError('VALIDATION_FAILED', 'Not a Git remote URL (https, ssh or git@host:owner/repo)');
    if (key) await this.assertRepositoryFree(actor.organizationId, key);
    const name = ProjectService.uniqueName(p.repositories.map((r) => r.name.toLowerCase()), input.name ?? origin.name ?? repositoryName(input.url));
    p.repositories.push({ name, key: key ?? null, url: input.url || null, defaultBranch: input.defaultBranch ?? 'main', primary: p.repositories.length === 0, source: origin.source ?? 'manual', github: origin.github ?? null });
    ProjectService.syncPrimary(p);
    await p.save();
    await audit(actor, 'project.repository_add', { type: 'project', id }, { name, key });
    if (key) this.changed(actor.organizationId);
    return toProjectDto(p.toObject());
  }

  async updateRepository(actor: Actor, id: string, repositoryId: string, input: z.output<typeof updateRepositoryRequest>) {
    const p = await this.loadForUpdate(actor, id);
    const repo = p.repositories.id(oid(repositoryId, 'Repository'));
    if (!repo) throw new AppError('NOT_FOUND', 'Repository not found');
    if (input.name) {
      if (p.repositories.some((r) => r !== repo && r.name.toLowerCase() === input.name!.toLowerCase())) throw new AppError('CONFLICT', `The project already has a repository named "${input.name}"`);
      repo.name = input.name;
    }
    if (input.defaultBranch) repo.defaultBranch = input.defaultBranch;
    if (input.primary) for (const r of p.repositories) r.primary = r === repo;
    ProjectService.syncPrimary(p);
    await p.save();
    await audit(actor, 'project.repository_update', { type: 'project', id }, { repositoryId, fields: Object.keys(input) });
    return toProjectDto(p.toObject());
  }

  /**
   * Moves a repository, with every worker's checkout of it, to another project. A project left without
   * repositories is archived (its tasks and history stay).
   */
  async moveRepository(actor: Actor, fromId: string, repositoryId: string, toId: string) {
    if (fromId === toId) throw new AppError('VALIDATION_FAILED', 'The repository is already in this project');
    const [from, to] = await Promise.all([this.loadForUpdate(actor, fromId), this.loadForUpdate(actor, toId)]);
    ProjectService.assertIdle(from);
    ProjectService.assertIdle(to);
    const repo = from.repositories.id(oid(repositoryId, 'Repository'));
    if (!repo) throw new AppError('NOT_FOUND', 'Repository not found');
    const moved = repo.toObject();
    const paths = from.workerPaths.filter((w) => String(w.repositoryId) === repositoryId || (!w.repositoryId && repo.primary));
    from.repositories.pull(repo._id);
    for (const w of paths) from.workerPaths.pull(w);
    ProjectService.syncPrimary(from);
    if (!from.repositories.length) from.archived = true;
    const name = ProjectService.uniqueName(to.repositories.map((r) => r.name.toLowerCase()), moved.name);
    to.repositories.push({ ...moved, name, primary: to.repositories.length === 0 });
    for (const w of paths) to.workerPaths.push({ workerId: w.workerId, repositoryId: repo._id, localPath: w.localPath });
    ProjectService.syncPrimary(to);
    await from.save();
    await to.save();
    await audit(actor, 'project.repository_move', { type: 'project', id: toId }, { repositoryId, fromProjectId: fromId, archivedSource: from.archived });
    return toProjectDto(to.toObject());
  }

  /** Moves a repository out into a new project of its own, named after it. */
  async splitRepository(actor: Actor, id: string, repositoryId: string) {
    requirePermission(actor, 'project.create');
    const p = await this.loadForUpdate(actor, id);
    const repo = p.repositories.id(oid(repositoryId, 'Repository'));
    if (!repo) throw new AppError('NOT_FOUND', 'Repository not found');
    if (p.repositories.length < 2) throw new AppError('VALIDATION_FAILED', "This is the project's only repository");
    const target = await this.createEmpty(actor, repo.name);
    return this.moveRepository(actor, id, repositoryId, target);
  }

  /** A project without repositories yet, named `name` (or `name (2)`, … when taken). */
  async createEmpty(actor: Actor, name: string, extra: { description?: string } = {}): Promise<string> {
    for (let i = 1; ; i++) {
      try {
        const p = await Project.create({ organizationId: oid(actor.organizationId), name: i === 1 ? name : `${name} (${i})`, description: extra.description ?? '', repositories: [] });
        await audit(actor, 'project.create', { type: 'project', id: String(p._id) }, { name: p.name });
        return String(p._id);
      } catch (e) {
        if (!isDuplicateKeyError(e) || i > 50) throw e;
      }
    }
  }

  /**
   * Ask a connected worker that has this project to collect repository facts (spec §41). The analysis
   * itself runs on the control plane against the org's registry, so private capability definitions
   * never need to be sent to workers.
   */
  async requestReadiness(actor: Actor, id: string, live: LiveHub) {
    requirePermission(actor, 'project.read');
    const p = await Project.findOne({ _id: oid(id, 'Project'), organizationId: oid(actor.organizationId) }).lean();
    if (!p) throw new AppError('NOT_FOUND', 'Project not found');
    const candidate = p.workerPaths.map((w) => String(w.workerId)).find((w) => live.isWorkerConnected(w));
    if (!candidate) throw new AppError('NO_ELIGIBLE_WORKER', 'No connected worker has this project mapped. Map it in a worker UI (Projects) and make sure the worker is online.');
    const requestId = newId();
    await Project.updateOne(
      { _id: p._id },
      { readiness: { status: 'PENDING', requestId, workerId: candidate, requestedAt: new Date().toISOString(), completedAt: null, error: null, report: p.readiness?.report ?? null } },
    );
    live.sendToWorker(candidate, { type: 'project.analyze', projectId: id, requestId });
    await audit(actor, 'project.readiness_requested', { type: 'project', id });
    return this.get(actor, id);
  }

  async completeReadiness(worker: WorkerActor, projectId: string, requestId: string, facts: RepoFacts | null, error: string | null) {
    const p = await Project.findOne({ _id: oid(projectId, 'Project'), organizationId: oid(worker.organizationId) }).lean();
    if (!p?.readiness || p.readiness.requestId !== requestId || p.readiness.workerId !== worker.workerId) throw new AppError('CONFLICT', 'No matching readiness request');
    let report: ReadinessReport | null = null;
    if (facts) {
      // Suggestions come from curated packages and the organization's own, not the whole marketplace.
      const candidates = await CapabilityPackage.find(
        { $or: [{ curated: true }, { ownerKind: 'platform' }, { ownerKind: 'organization', organizationId: p.organizationId }] },
        { ref: 1, latestVersion: 1 },
      )
        .sort({ curated: -1, curatedRank: 1 })
        .limit(1000)
        .lean();
      const [w, caps, installs] = await Promise.all([
        Worker.findById(oid(worker.workerId)).lean(),
        candidates.length ? Capability.find({ $or: candidates.map((c) => ({ capabilityId: c.ref, version: c.latestVersion })) }).lean() : [],
        CapabilityInstallation.find({ organizationId: p.organizationId, status: 'ACTIVE', enabled: true, $or: [{ scope: 'ORGANIZATION' }, { scope: 'PROJECT', projectId: p._id }] }).lean(),
      ]);
      report = analyzeReadiness({
        repo: facts,
        worker: {
          agents: ((w?.agents ?? []) as Array<{ id: string; installed: boolean }>).map((a) => ({ id: a.id, installed: a.installed })),
          providers: ((w?.providers ?? []) as Array<{ id: string; healthy: boolean }>).map((x) => ({ id: x.id, healthy: x.healthy })),
          tools: w?.tools ?? [],
        },
        capabilities: caps.map((c) => c.manifest as CapabilityManifest),
        installedCapabilityIds: installs.map((i) => parseRef(i.capabilityId).name),
      });
    }
    await Project.updateOne(
      { _id: p._id, 'readiness.requestId': requestId },
      {
        $set: {
          'readiness.status': report ? 'COMPLETED' : 'FAILED',
          'readiness.completedAt': new Date().toISOString(),
          'readiness.error': error,
          'readiness.report': report,
          // The stack drives capability suggestions and per-task skill selection.
          ...(facts ? { 'readiness.stack': { languages: facts.languages.slice(0, 20), dependencies: facts.dependencies.slice(0, 500), files: facts.files.slice(0, 200) } } : {}),
        },
      },
    );
  }

  /** Archive rather than delete: tasks and history must remain (spec §126 — never delete active task data). */
  async archive(actor: Actor, id: string) {
    requirePermission(actor, 'project.delete');
    const active = await Task.countDocuments({ projectId: oid(id), status: { $nin: ['COMPLETED', 'FAILED', 'CANCELLED'] } });
    if (active) throw new AppError('CONFLICT', 'Project has active tasks; cancel them first');
    const r = await Project.updateOne({ _id: oid(id, 'Project'), organizationId: oid(actor.organizationId) }, { archived: true });
    if (!r.matchedCount) throw new AppError('NOT_FOUND', 'Project not found');
    await audit(actor, 'project.archive', { type: 'project', id });
  }
}
