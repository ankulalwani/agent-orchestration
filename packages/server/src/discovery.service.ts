import type { z } from 'zod';
import { AppError, createLogger, localRepositoryKey, newSecretToken, repositoryKey, sanitizeRepositoryName, sha256 } from '@ao/core';
import { DiscoveredRepository, GitHubState, Project, Task, Worker, oid } from '@ao/database';
import type { GitHubService } from './github.service.js';
import type { DiscoveredSuggestionDto, RepositoryMapping, acceptDiscoveredRequest, discoveryReport, dismissDiscoveredRequest } from '@ao/contracts';
import { requirePermission, type Actor, type WorkerActor } from './context.js';
import type { LiveHub } from './live.js';
import type { ProjectService } from './project.service.js';
import { audit } from './audit.js';

const log = createLogger('discovery');

/** Identity keys of a reported repository: its remotes (origin first), then its root commit. */
export function discoveredKeys(r: { remotes: Array<{ name: string; url: string }>; rootCommit: string | null }): string[] {
  const remotes = [...r.remotes].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
  const keys = remotes.map((x) => repositoryKey(x.url)).filter((k): k is string => Boolean(k));
  if (r.rootCommit) keys.push(localRepositoryKey(r.rootCommit));
  return [...new Set(keys)];
}

/**
 * Repositories found on workers' disks (discovery). A repository that is in a project is mapped on the
 * worker automatically (the worker only accepts folders it reported itself); any other is suggested in
 * the dashboard until someone creates a project for it, adds it to one, or dismisses it.
 */
export class DiscoveryService {
  constructor(
    private live: LiveHub,
    private projects: ProjectService,
    private github: GitHubService | null = null,
  ) {}

  /** A worker's full scan: replaces what it reported before. Returns the checkouts it should map. */
  async report(worker: WorkerActor, input: z.output<typeof discoveryReport>): Promise<{ mappings: RepositoryMapping[] }> {
    const wid = oid(worker.workerId);
    const org = oid(worker.organizationId);
    const seenAt = new Date();
    if (input.repos.length) {
      await DiscoveredRepository.bulkWrite(
        input.repos.map((r) => ({
          updateOne: {
            filter: { workerId: wid, localPath: r.localPath },
            update: { $set: { organizationId: org, name: r.name, keys: discoveredKeys(r), remotes: r.remotes, rootCommit: r.rootCommit, branch: r.branch, lastSeenAt: seenAt }, $setOnInsert: { status: 'suggested' } },
            upsert: true,
          },
        })) as never,
        { ordered: false },
      );
    }
    // Folders that are gone (or no longer repositories) are forgotten.
    await DiscoveredRepository.deleteMany({ workerId: wid, lastSeenAt: { $lt: seenAt } });
    const byWorker = await this.match(worker.organizationId, { workerId: wid });
    return { mappings: byWorker.get(worker.workerId) ?? [] };
  }

  /**
   * Matches discovered repositories to project repositories by key. Returns, per worker, the checkouts
   * it should add: matched folders for repositories it has no checkout of yet.
   */
  private async match(organizationId: string, filter: Record<string, unknown> = {}) {
    const docs = await DiscoveredRepository.find({ organizationId: oid(organizationId), ...filter }).sort({ localPath: 1 }).lean();
    const keys = [...new Set(docs.flatMap((d) => d.keys))];
    const projects = keys.length ? await Project.find({ organizationId: oid(organizationId), archived: { $ne: true }, 'repositories.key': { $in: keys } }, { repositories: 1, workerPaths: 1 }).lean() : [];
    const byKey = new Map<string, { projectId: string; repositoryId: string; primary: boolean; paths: Array<{ workerId: unknown; repositoryId?: unknown }> }>();
    for (const p of projects) for (const r of p.repositories) if (r.key) byKey.set(r.key, { projectId: String(p._id), repositoryId: String(r._id), primary: Boolean(r.primary), paths: p.workerPaths });
    const out = new Map<string, RepositoryMapping[]>();
    for (const d of docs) {
      const m = d.keys.map((k) => byKey.get(k)).find(Boolean);
      if (!m) {
        // Its repository left the project it was in: suggest it again.
        if (d.status === 'mapped') await DiscoveredRepository.updateOne({ _id: d._id }, { status: 'suggested', projectId: null, repositoryId: null });
        continue;
      }
      if (d.status !== 'mapped' || String(d.projectId) !== m.projectId || String(d.repositoryId) !== m.repositoryId) {
        await DiscoveredRepository.updateOne({ _id: d._id }, { status: 'mapped', projectId: oid(m.projectId), repositoryId: oid(m.repositoryId) });
      }
      const workerId = String(d.workerId);
      const hasCheckout = m.paths.some((w) => String(w.workerId) === workerId && (String(w.repositoryId ?? '') === m.repositoryId || (!w.repositoryId && m.primary)));
      const list = out.get(workerId) ?? [];
      // One folder per repository and worker (the first found, by path) if the worker has none yet.
      if (!hasCheckout && !list.some((x) => x.repositoryId === m.repositoryId)) list.push({ projectId: m.projectId, repositoryId: m.repositoryId, localPath: d.localPath });
      out.set(workerId, list);
    }
    return out;
  }

  /** After projects gained repositories: map matching folders on connected workers now. */
  async rematch(organizationId: string) {
    const byWorker = await this.match(organizationId, { status: { $ne: 'mapped' } });
    for (const [workerId, mappings] of byWorker) {
      if (mappings.length && this.live.isWorkerConnected(workerId)) this.live.sendToWorker(workerId, { type: 'repositories.map', mappings });
    }
  }

  async suggestions(actor: Actor): Promise<DiscoveredSuggestionDto[]> {
    requirePermission(actor, 'project.read');
    const docs = await DiscoveredRepository.find({ organizationId: oid(actor.organizationId), status: 'suggested' }).sort({ name: 1, localPath: 1 }).lean();
    const workers = new Map((await Worker.find({ _id: { $in: [...new Set(docs.map((d) => String(d.workerId)))].map((w) => oid(w)) } }, { name: 1 }).lean()).map((w) => [String(w._id), w.name]));
    const groups = new Map<string, DiscoveredSuggestionDto>();
    for (const d of docs) {
      const key = d.keys[0] ?? null;
      const g = groups.get(key ?? `id:${d._id}`) ?? { key, name: d.name, remotes: (d.remotes ?? []).map((r) => ({ name: r.name ?? '', url: r.url ?? '' })), locations: [] };
      g.locations.push({ id: String(d._id), workerId: String(d.workerId), workerName: workers.get(String(d.workerId)) ?? 'worker', localPath: d.localPath, branch: d.branch ?? null, lastSeenAt: new Date(d.lastSeenAt).toISOString() });
      groups.set(key ?? `id:${d._id}`, g);
    }
    return [...groups.values()];
  }

  /** Creates a project for a found repository (or adds it to one) and maps it where it was found. */
  async accept(actor: Actor, input: z.output<typeof acceptDiscoveredRequest>) {
    requirePermission(actor, input.projectId ? 'project.update' : 'project.create');
    const docs = await DiscoveredRepository.find({ _id: { $in: input.ids.map((i) => oid(i)) }, organizationId: oid(actor.organizationId) }).lean();
    if (!docs.length) throw new AppError('NOT_FOUND', 'Repository not found');
    const first = docs[0]!;
    const key = first.keys[0] ?? null;
    if (docs.some((d) => (d.keys[0] ?? null) !== key)) throw new AppError('VALIDATION_FAILED', 'These folders are different repositories; accept them one at a time');
    const remote = [...(first.remotes ?? [])].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin')).find((r) => repositoryKey(r.url ?? '') === key);
    const url = remote?.url ?? '';
    const name = sanitizeRepositoryName(first.name);
    const origin = { source: 'discovered' as const, key: key ?? undefined, name };
    let project;
    if (input.projectId) project = await this.projects.addRepository(actor, input.projectId, { url, name }, origin);
    else {
      const wanted = input.name ?? first.name;
      for (let i = 1; ; i++) {
        try {
          project = await this.projects.create(actor, { name: i === 1 ? wanted : `${wanted} (${i})`, description: '', repositoryUrl: url || undefined, defaultBranch: first.branch ?? 'main', environments: [], knowledge: '' }, origin);
          break;
        } catch (e) {
          if (!(e instanceof AppError && e.code === 'CONFLICT' && e.message.includes('name')) || i > 20) throw e;
        }
      }
    }
    // The repository just added: by key, or (no key) the last one.
    const repo = key ? project.repositories.find((r) => r.key === key)! : project.repositories[project.repositories.length - 1]!;
    const perWorker = new Map<string, RepositoryMapping>();
    for (const d of docs) if (!perWorker.has(String(d.workerId))) perWorker.set(String(d.workerId), { projectId: project.id, repositoryId: repo.id, localPath: d.localPath });
    await DiscoveredRepository.updateMany({ _id: { $in: docs.map((d) => d._id) } }, { status: 'mapped', projectId: oid(project.id), repositoryId: oid(repo.id) });
    for (const [workerId, mapping] of perWorker) if (this.live.isWorkerConnected(workerId)) this.live.sendToWorker(workerId, { type: 'repositories.map', mappings: [mapping] });
    await audit(actor, 'discovery.accepted', { type: 'project', id: project.id }, { key, locations: docs.length });
    // Clones of the same repository on other workers.
    if (key) await this.rematch(actor.organizationId).catch((e) => log.warn({ err: String(e) }, 'rematch failed'));
    return project;
  }

  // ── Cloning repositories to workers ────────────────────────────────────────
  /**
   * Asks workers to clone a project repository into their projects folder (workers without one, or
   * offline, are skipped with the reason). The worker maps the clone itself when it is done.
   */
  async requestClone(actor: Actor, projectId: string, repositoryId: string, workerIds: string[]) {
    requirePermission(actor, 'project.update');
    const project = await Project.findOne({ _id: oid(projectId, 'Project'), organizationId: oid(actor.organizationId) }).lean();
    const repo = project?.repositories.find((r) => String(r._id) === repositoryId);
    if (!project || !repo) throw new AppError('NOT_FOUND', 'Repository not found');
    if (!repo.url) throw new AppError('VALIDATION_FAILED', 'This repository has no remote URL to clone from');
    const workers = await Worker.find({ _id: { $in: workerIds.map((w) => oid(w, 'Worker')) }, organizationId: oid(actor.organizationId) }).lean();
    const requested: string[] = [];
    const skipped: Array<{ workerId: string; reason: string }> = [];
    for (const id of workerIds) {
      const w = workers.find((x) => String(x._id) === id);
      if (!w) skipped.push({ workerId: id, reason: 'Worker not found' });
      else if (!(w.tools ?? []).includes('clone')) skipped.push({ workerId: id, reason: `${w.name} has no projects folder (set one in its local UI → Projects)` });
      else if (project.workerPaths.some((p) => String(p.workerId) === id && String(p.repositoryId) === repositoryId)) skipped.push({ workerId: id, reason: `${w.name} already has it` });
      else if (!this.live.isWorkerConnected(id)) skipped.push({ workerId: id, reason: `${w.name} is offline` });
      else {
        const requestId = newSecretToken(18);
        await GitHubState.create({ stateHash: sha256(requestId), purpose: 'clone', organizationId: oid(actor.organizationId), userId: oid(actor.userId), data: { workerId: id, projectId, repositoryId }, expiresAt: new Date(Date.now() + 60 * 60_000) });
        this.live.sendToWorker(id, { type: 'repository.clone', requestId, projectId, repositoryId, name: repo.name, url: repo.url, defaultBranch: repo.defaultBranch ?? 'main', viaGithubApp: Boolean(repo.github) });
        requested.push(id);
      }
    }
    await audit(actor, 'project.repository_clone_requested', { type: 'project', id: projectId }, { repositoryId, requested, skipped: skipped.length });
    return { requested, skipped };
  }

  private async cloneRequest(worker: WorkerActor, requestId: string) {
    const s = await GitHubState.findOne({ stateHash: sha256(requestId), purpose: 'clone', usedAt: null, expiresAt: { $gt: new Date() }, organizationId: oid(worker.organizationId) }).lean();
    const data = s?.data as { workerId: string; projectId: string; repositoryId: string } | undefined;
    if (!s || data?.workerId !== worker.workerId) throw new AppError('FORBIDDEN', 'No such clone request for this worker');
    return { state: s, ...data };
  }

  /** A token for one clone: limited to that repository, valid about an hour. Null for repositories not from the GitHub App. */
  async cloneToken(worker: WorkerActor, requestId: string) {
    const req = await this.cloneRequest(worker, requestId);
    const project = await Project.findById(oid(req.projectId)).lean();
    const repo = project?.repositories.find((r) => String(r._id) === req.repositoryId);
    if (!repo || !this.github) return { token: null };
    const [t] = await this.github.repositoryTokens(worker.organizationId, [{ id: String(repo._id), name: repo.name, github: repo.github as never }]);
    return t ? { token: t.token, host: t.host, expiresAt: t.expiresAt } : { token: null };
  }

  async cloneResult(worker: WorkerActor, requestId: string, result: { ok: boolean; localPath?: string | null; error?: string | null }) {
    const req = await this.cloneRequest(worker, requestId);
    await GitHubState.updateOne({ _id: req.state._id }, { usedAt: new Date() });
    await audit(worker, result.ok ? 'project.repository_cloned' : 'project.repository_clone_failed', { type: 'project', id: req.projectId }, { repositoryId: req.repositoryId, localPath: result.localPath ?? null, error: result.error ?? null });
    return { ok: true };
  }

  /**
   * Credentials for a task's repositories that come from the GitHub App, so the worker can push the task
   * branch and open pull requests without a token of its own. Only for a task this worker holds.
   */
  async taskCredentials(worker: WorkerActor, taskId: string) {
    const task = await Task.findOne({ _id: oid(taskId, 'Task'), organizationId: oid(worker.organizationId) }, { workerId: 1, projectId: 1, status: 1 }).lean();
    if (!task || String(task.workerId) !== worker.workerId) throw new AppError('LEASE_LOST', 'This worker does not hold the task');
    const project = await Project.findById(task.projectId).lean();
    if (!project || !this.github) return { repositories: [] };
    const repos = project.repositories.map((r) => ({ id: String(r._id), name: r.name, github: r.github as never }));
    return { repositories: await this.github.repositoryTokens(worker.organizationId, repos) };
  }

  async dismiss(actor: Actor, input: z.output<typeof dismissDiscoveredRequest>) {
    requirePermission(actor, 'project.update');
    const r = await DiscoveredRepository.updateMany({ _id: { $in: input.ids.map((i) => oid(i)) }, organizationId: oid(actor.organizationId), status: 'suggested' }, { status: 'dismissed' });
    await audit(actor, 'discovery.dismissed', null, { count: r.modifiedCount });
    return { dismissed: r.modifiedCount };
  }
}
