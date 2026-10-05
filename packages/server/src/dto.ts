import type {
  NotificationDto,
  ProjectDto,
  RepositoryDto,
  TaskDto,
  TaskEventDto,
  UserDto,
  WorkerDto,
} from '@ao/contracts';

/* Mappers from Mongo documents to API DTOs. Documents may be lean objects or hydrated docs. */

type AnyDoc = Record<string, any>;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d ? new Date(d as string).toISOString() : null);
const str = (v: unknown) => (v == null ? null : String(v));

export function toUserDto(u: AnyDoc): UserDto {
  return {
    id: String(u._id),
    email: u.email,
    name: u.name,
    emailVerified: Boolean(u.emailVerified),
    mfaEnabled: Boolean(u.mfa?.enabled),
    hasPassword: u.hasPassword !== false,
    identities: ((u.identities ?? []) as Array<{ provider: string; email?: string | null }>).map((i) => ({ provider: i.provider, email: i.email ?? null })),
    platformAdmin: Boolean(u.platformAdmin),
    createdAt: iso(u.createdAt)!,
  };
}

export function toRepositoryDto(r: AnyDoc): RepositoryDto {
  return {
    id: String(r._id),
    name: r.name,
    key: r.key ?? null,
    url: r.url ?? null,
    defaultBranch: r.defaultBranch ?? 'main',
    primary: Boolean(r.primary),
    source: r.source ?? 'manual',
    github: r.github ?? null,
  };
}

export function toProjectDto(p: AnyDoc): ProjectDto {
  const repositories = ((p.repositories ?? []) as AnyDoc[]).map(toRepositoryDto);
  const primaryId = repositories.find((r) => r.primary)?.id ?? null;
  return {
    id: String(p._id),
    organizationId: String(p.organizationId),
    name: p.name,
    description: p.description ?? '',
    repositoryUrl: p.repositoryUrl ?? null,
    defaultBranch: p.defaultBranch ?? 'main',
    repositories,
    policy: p.policy ?? {},
    environments: p.environments ?? [],
    knowledge: p.knowledge ?? '',
    workerPaths: (p.workerPaths ?? []).map((w: AnyDoc) => ({ workerId: String(w.workerId), repositoryId: w.repositoryId ? String(w.repositoryId) : primaryId, localPath: w.localPath })),
    readiness: p.readiness ?? null,
    createdAt: iso(p.createdAt)!,
  };
}

export function toTaskDto(t: AnyDoc): TaskDto {
  return {
    id: String(t._id),
    organizationId: String(t.organizationId),
    projectId: String(t.projectId),
    title: t.title,
    originalPrompt: t.originalPrompt,
    knowledge: t.knowledge ?? '',
    source: t.source ?? null,
    kind: t.kind ?? 'code',
    review: t.review ?? null,
    parentTaskId: t.parentTaskId ? String(t.parentTaskId) : null,
    planApplied: t.planApplied ? { at: new Date(t.planApplied.at).toISOString(), by: String(t.planApplied.by), taskIds: (t.planApplied.taskIds ?? []).map(String) } : null,
    normalizedPrompt: t.normalizedPrompt ?? null,
    generatedPlan: t.generatedPlan ?? null,
    priority: t.priority,
    status: t.status,
    statusReason: t.statusReason ?? null,
    workerId: str(t.workerId),
    agentId: t.agentId ?? null,
    providerId: t.providerId ?? null,
    modelId: t.modelId ?? null,
    sessionId: t.sessionId ?? null,
    dependencies: (t.dependencies ?? []).map(String),
    requirements: t.requirements ?? {},
    policy: t.policy ?? {},
    capabilityIds: t.capabilityIds ?? [],
    environment: t.environment ?? null,
    createdBy: String(t.createdBy),
    createdAt: iso(t.createdAt)!,
    queuedAt: iso(t.queuedAt ?? t.createdAt)!,
    startedAt: iso(t.startedAt),
    completedAt: iso(t.completedAt),
    retryCount: t.retryCount ?? 0,
    restartCount: t.restartCount ?? 0,
    limitHitCount: t.limitHitCount ?? 0,
    contextResetCount: t.contextResetCount ?? 0,
    remediationCount: t.remediationCount ?? 0,
    fallbackStep: t.fallbackStep ?? -1,
    leaseExpiresAt: iso(t.leaseExpiresAt),
    waitingUntil: iso(t.waitingUntil),
    lastCheckpoint: t.lastCheckpoint ?? null,
    progress: {
      percent: t.progress?.percent ?? null,
      currentStep: t.progress?.currentStep ?? null,
      message: t.progress?.message ?? null,
    },
    verificationStatus: t.verificationStatus ?? 'NOT_RUN',
    verificationRuns: t.verificationRuns ?? [],
    gitStatus: t.gitStatus ?? 'NONE',
    gitResult: t.gitResult ?? null,
    completionReport: t.completionReport ?? null,
    pendingInteraction: t.pendingInteraction ?? null,
    correlationId: t.correlationId,
    activeMs: t.activeMs ?? 0,
    continues: t.continues ? { taskId: String(t.continues.taskId), branch: t.continues.branch, pullRequestUrl: t.continues.pullRequestUrl ?? null } : null,
    attempt: t.attempt ? { groupId: String(t.attempt.groupId), index: t.attempt.index, of: t.attempt.of, agentId: t.attempt.agentId, winnerTaskId: t.attempt.winnerTaskId ? String(t.attempt.winnerTaskId) : null } : null,
    usage: { costUsd: t.usage?.costUsd ?? 0, inputTokens: t.usage?.inputTokens ?? 0, outputTokens: t.usage?.outputTokens ?? 0 },
  };
}

export function toTaskEventDto(e: AnyDoc): TaskEventDto {
  return {
    id: String(e._id),
    eventId: e.eventId,
    taskId: String(e.taskId),
    workerId: str(e.workerId),
    type: e.type,
    timestamp: iso(e.timestamp)!,
    sequence: e.sequence ?? null,
    payload: e.payload ?? {},
    correlationId: e.correlationId ?? null,
  };
}

export function toWorkerDto(w: AnyDoc, activeTaskIds: string[] = []): WorkerDto {
  return {
    id: String(w._id),
    organizationId: String(w.organizationId),
    name: w.name,
    hostname: w.hostname ?? '',
    os: w.os,
    arch: w.arch ?? '',
    version: w.version ?? '',
    status: w.status,
    approved: Boolean(w.approved),
    labels: w.labels ?? [],
    maxConcurrentTasks: w.maxConcurrentTasks ?? 1,
    lastHeartbeatAt: iso(w.lastHeartbeatAt),
    latencyMs: w.latencyMs ?? null,
    metrics: w.metrics ?? null,
    agents: w.agents ?? [],
    providers: w.providers ?? [],
    tools: w.tools ?? [],
    activeTaskIds,
    createdAt: iso(w.createdAt)!,
  };
}

export function toNotificationDto(n: AnyDoc): NotificationDto {
  return {
    id: String(n._id),
    type: n.type,
    title: n.title,
    body: n.body ?? '',
    taskId: str(n.taskId),
    workerId: str(n.workerId),
    read: Boolean(n.readAt),
    createdAt: iso(n.createdAt)!,
  };
}

/** Opaque cursor over (createdAt desc, _id desc). */
export function encodeCursor(doc: AnyDoc): string {
  return Buffer.from(`${new Date(doc.createdAt).getTime()}:${String(doc._id)}`).toString('base64url');
}
export function decodeCursor(cursor?: string): { t: Date; id: string } | null {
  if (!cursor) return null;
  const [t, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (!t || !id || !/^[a-f0-9]{24}$/i.test(id) || Number.isNaN(Number(t))) return null;
  return { t: new Date(Number(t)), id };
}
