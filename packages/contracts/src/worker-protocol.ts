/**
 * Worker ⇄ control-plane protocol (spec §13, §14, §107).
 * HTTP for state-changing calls (claim, transition, events) so every call is individually
 * authenticated, idempotent and retryable. WebSocket for push (offers, control) and heartbeats.
 */
import { z } from 'zod';
import { TASK_EVENT_TYPES, TASK_STATUSES } from '@ao/core/shared';

export const WORKER_PROTOCOL_VERSION = 1;

const osEnum = z.enum(['windows', 'macos', 'linux']);

export const pairingStartRequest = z.object({
  name: z.string().trim().min(1).max(120),
  hostname: z.string().max(255),
  os: osEnum,
  arch: z.string().max(32),
  version: z.string().max(32),
});
export const pairingStartResponse = z.object({
  pairingId: z.string(),
  userCode: z.string(),
  /** Secret known only to the worker; required to poll. Prevents hijacking by code guessing. */
  pollSecret: z.string(),
  verificationUrl: z.string(),
  expiresAt: z.string(),
  intervalSec: z.number(),
});
export const pairingPollRequest = z.object({ pairingId: z.string(), pollSecret: z.string() });
export const pairingPollResponse = z.discriminatedUnion('status', [
  z.object({ status: z.literal('PENDING') }),
  z.object({ status: z.literal('DENIED') }),
  z.object({ status: z.literal('EXPIRED') }),
  z.object({
    status: z.literal('APPROVED'),
    workerId: z.string(),
    organizationId: z.string(),
    /** Long-lived worker credential. Returned exactly once. */
    credential: z.string(),
  }),
]);

export const workerEvent = z.object({
  eventId: z.string().uuid(),
  workerId: z.string(),
  taskId: z.string(),
  timestamp: z.string(),
  sequence: z.number().int().nonnegative(),
  type: z.enum(TASK_EVENT_TYPES),
  payload: z.record(z.unknown()).default({}),
  correlationId: z.string().optional(),
});
export type WorkerEvent = z.infer<typeof workerEvent>;
export const eventBatchRequest = z.object({ events: z.array(workerEvent).min(1).max(500) });
export const eventBatchResponse = z.object({ accepted: z.number(), duplicates: z.number(), highestSequence: z.number() });

export const claimResponse = z.object({
  claimed: z.boolean(),
  reason: z.string().optional(),
  task: z.unknown().optional(), // TaskDto; typed at the call site to avoid a circular import
  leaseExpiresAt: z.string().optional(),
  /** Policy layers (platform → organization → project → task); the worker inserts its own layer before task. */
  policyLayers: z.object({ platform: z.unknown(), organization: z.unknown(), project: z.unknown(), task: z.unknown() }).optional(),
  /** Checkout of the project's primary repository on this worker. */
  localPath: z.string().optional(),
  /** Every repository of the project with its checkout on this worker (the primary one first). */
  repositories: z.array(z.object({ repositoryId: z.string(), name: z.string(), localPath: z.string(), primary: z.boolean(), defaultBranch: z.string() })).optional(),
  capabilities: z.array(z.unknown()).optional(),
  knowledge: z.array(z.string()).optional(),
  /** Feature flags in effect for the task's organization (CORE-010). */
  features: z.record(z.boolean()).optional(),
  /** The task's environment profile, with secret values (spec §78). */
  environment: z
    .object({ name: z.string(), variables: z.record(z.string()), secrets: z.record(z.string()), missingSecrets: z.array(z.string()), requiresApproval: z.boolean() })
    .nullable()
    .optional(),
});

export const transitionRequest = z.object({
  to: z.enum(TASK_STATUSES),
  reason: z.string().max(2000).optional(),
  /** Idempotency: the same transitionId applied twice is a no-op. */
  transitionId: z.string().uuid(),
  patch: z
    .object({
      agentId: z.string().nullable(),
      providerId: z.string().nullable(),
      modelId: z.string().nullable(),
      sessionId: z.string().nullable(),
      waitingUntil: z.string().nullable(),
      lastCheckpoint: z.record(z.unknown()).nullable(),
      progress: z.object({ percent: z.number().nullable(), currentStep: z.string().nullable(), message: z.string().nullable() }).partial(),
      verificationStatus: z.enum(['NOT_RUN', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED']),
      verificationRun: z.record(z.unknown()),
      gitStatus: z.enum(['NONE', 'PENDING', 'COMMITTED', 'PUSHED', 'PR_OPENED', 'BLOCKED', 'FAILED']),
      gitResult: z.record(z.unknown()).nullable(),
      completionReport: z.record(z.unknown()).nullable(),
      pendingInteraction: z.object({ kind: z.enum(['input', 'approval']), question: z.string(), options: z.array(z.string()).optional() }).nullable(),
      generatedPlan: z.string().nullable(),
      incRestart: z.boolean(),
      incLimitHit: z.boolean(),
      incContextReset: z.boolean(),
      incRemediation: z.boolean(),
      fallbackStep: z.number().int(),
      activeMsDelta: z.number().int().nonnegative(),
    })
    .partial()
    .default({}),
});
export type TransitionRequest = z.input<typeof transitionRequest>;

/** System metrics; every field optional because some platforms cannot report all of them. */
const heartbeatMetrics = z
  .object({
    cpuCount: z.number(),
    cpuLoadPercent: z.number().nullable(),
    totalMemoryMb: z.number(),
    freeMemoryMb: z.number(),
    freeDiskMb: z.number().nullable(),
    totalDiskMb: z.number().nullable(),
    uptimeSec: z.number(),
  })
  .partial();

export const heartbeatPayload = z.object({
  metrics: heartbeatMetrics,
  activeTasks: z.array(z.object({ taskId: z.string(), status: z.enum(TASK_STATUSES) })),
  inventory: z
    .object({
      agents: z.array(z.record(z.unknown())),
      providers: z.array(z.record(z.unknown())),
      tools: z.array(z.string()),
      /** Checkouts on this worker. `repositoryId` omitted (older workers) means the project's primary repository. */
      projects: z.array(z.object({ projectId: z.string(), repositoryId: z.string().optional(), localPath: z.string() })),
    })
    .optional(),
  sentAt: z.string(),
});
export type HeartbeatPayload = z.infer<typeof heartbeatPayload>;

/** A Git repository a worker found on its disks (discovery). */
export const discoveredRepositoryReport = z.object({
  localPath: z.string().min(1).max(1000),
  name: z.string().min(1).max(200),
  remotes: z.array(z.object({ name: z.string().max(200), url: z.string().max(1000) })).max(20),
  rootCommit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  branch: z.string().max(250).nullable(),
});
export type DiscoveredRepositoryReport = z.infer<typeof discoveredRepositoryReport>;
export const discoveryReport = z.object({ scannedAt: z.string(), repos: z.array(discoveredRepositoryReport).max(10_000) });
/** A checkout the worker should add to its projects: always one of the folders it reported itself. */
export const repositoryMapping = z.object({ projectId: z.string(), repositoryId: z.string(), localPath: z.string() });
export type RepositoryMapping = z.infer<typeof repositoryMapping>;
export const discoveryResponse = z.object({ mappings: z.array(repositoryMapping) });

/** Worker → server WebSocket messages. */
export const workerToServer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), protocol: z.number(), version: z.string() }),
  z.object({ type: z.literal('heartbeat'), payload: heartbeatPayload }),
  z.object({ type: z.literal('pong'), nonce: z.string() }),
]);
export type WorkerToServer = z.infer<typeof workerToServer>;

/** Server → worker WebSocket messages. */
export const serverToWorker = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), workerId: z.string(), heartbeatMs: z.number(), leaseMs: z.number() }),
  z.object({
    type: z.literal('heartbeat.ack'),
    serverTime: z.string(),
    leasesRenewedUntil: z.string().nullable(),
    /** Tasks the worker reported as active but no longer owns (cancelled, lease lost): stop them. */
    revokedTaskIds: z.array(z.string()).default([]),
  }),
  z.object({ type: z.literal('task.offer'), taskId: z.string() }),
  z.object({
    type: z.literal('task.control'),
    taskId: z.string(),
    action: z.enum(['pause', 'resume', 'cancel', 'input', 'approve', 'deny', 'restart']),
    input: z.string().optional(),
  }),
  z.object({ type: z.literal('project.analyze'), projectId: z.string(), requestId: z.string() }),
  /** Map these discovered folders (a suggestion was accepted, or a synced repository matched one). */
  z.object({ type: z.literal('repositories.map'), mappings: z.array(repositoryMapping) }),
  /**
   * Clone a project repository into the worker's projects folder, then map it. For GitHub App
   * repositories the worker fetches a short-lived token for this request (POST /worker/clones/:id/token).
   */
  z.object({
    type: z.literal('repository.clone'),
    requestId: z.string(),
    projectId: z.string(),
    repositoryId: z.string(),
    name: z.string(),
    url: z.string(),
    defaultBranch: z.string(),
    viaGithubApp: z.boolean(),
  }),
  z.object({ type: z.literal('ping'), nonce: z.string() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);
export type ServerToWorker = z.infer<typeof serverToWorker>;
