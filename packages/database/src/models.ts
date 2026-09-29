import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';
import { PRIORITIES, ROLES, TASK_STATUSES, TASK_EVENT_TYPES, CAPABILITY_SCOPES, PACKAGE_SOURCES, PUBLISHER_KINDS, REVIEW_STATUSES, VERSION_STATUSES, VISIBILITIES } from '@ao/core';

/**
 * MongoDB models (spec §17). MongoDB is the durable source of truth.
 * Every organization-owned collection carries `organizationId` and is indexed by it (spec §18).
 */

const opts = { timestamps: true, minimize: false } as const;
const Mixed = Schema.Types.Mixed;

// ── Identity ──────────────────────────────────────────────────────────────────
const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    emailVerified: { type: Boolean, default: false },
    platformAdmin: { type: Boolean, default: false },
    disabled: { type: Boolean, default: false },
    // TOTP multi-factor authentication (spec §56). Secrets are encrypted; recovery codes are hashed.
    mfa: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      pendingSecretEnc: { type: String, select: false },
      recoveryCodeHashes: { type: [String], select: false, default: undefined },
      /** Last accepted TOTP time step: a code is accepted only once. */
      lastStep: { type: Number, select: false, default: null },
    },
    /** False for accounts created through an OAuth provider until a password is set (password reset). */
    hasPassword: { type: Boolean, default: true },
    /** External sign-in identities (OAuth / OpenID Connect) linked to this user. */
    identities: [{ provider: String, subject: String, email: String, linkedAt: Date, _id: false }],
    failedLoginCount: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  opts,
);
userSchema.index({ email: 1 }, { unique: true });
// One user per external identity. (Replaces a non-unique index; see migration 0003.)
userSchema.index(
  { 'identities.provider': 1, 'identities.subject': 1 },
  { unique: true, name: 'identity_unique', partialFilterExpression: { 'identities.subject': { $exists: true } } },
);

const organizationSchema = new Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true },
    policy: { type: Mixed, default: {} },
    /** Organization-wide knowledge given to agents in every task (spec §77). */
    knowledge: { type: String, default: '' },
    settings: {
      requireWorkerApproval: { type: Boolean, default: false },
      retentionDays: { events: { type: Number, default: 180 }, agentOutput: { type: Number, default: 30 }, audit: { type: Number, default: 730 } },
    },
    /** Data owned by extensions (see docs/PUBLIC_PRIVATE_BOUNDARY.md); the core never reads it. */
    cloud: { type: Mixed, default: null },
  },
  opts,
);
organizationSchema.index({ slug: 1 }, { unique: true });

const membershipSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true, ref: 'Organization' },
    userId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
    role: { type: String, enum: ROLES, required: true },
  },
  opts,
);
membershipSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1 });

const teamSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    memberIds: [{ type: Schema.Types.ObjectId }],
  },
  opts,
);
teamSchema.index({ organizationId: 1, name: 1 }, { unique: true });

const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    tokenHash: { type: String, required: true },
    familyId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    replacedByHash: { type: String, default: null },
    userAgent: String,
    ip: String,
  },
  opts,
);
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Personal API tokens for scripts, CI and IDE extensions: one organization, a role no higher than the
 * owner's. Stored hashed; `prefix` identifies the token in lists.
 */
const apiTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true },
    prefix: { type: String, required: true },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  opts,
);
apiTokenSchema.index({ tokenHash: 1 }, { unique: true });
apiTokenSchema.index({ userId: 1 });

/**
 * Device sign-in for the CLI and mobile app (sign in through the web app, whatever the method: password,
 * SSO, two-factor). The poll secret is stored hashed; the user code is short-lived and single-use.
 */
const deviceLoginSchema = new Schema(
  {
    userCode: { type: String, required: true },
    pollSecretHash: { type: String, required: true },
    clientName: { type: String, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'DENIED', 'CONSUMED'], default: 'PENDING' },
    userId: { type: Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, required: true },
  },
  opts,
);
deviceLoginSchema.index({ userCode: 1 }, { unique: true });
deviceLoginSchema.index({ pollSecretHash: 1 }, { unique: true });
deviceLoginSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

const oneTimeTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    purpose: { type: String, enum: ['password_reset', 'email_verify'], required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  opts,
);
oneTimeTokenSchema.index({ tokenHash: 1 }, { unique: true });
oneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Projects ──────────────────────────────────────────────────────────────────
const projectSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    /** The primary repository's URL, kept in step with `repositories` for older clients. */
    repositoryUrl: { type: String, default: null },
    defaultBranch: { type: String, default: 'main' },
    /**
     * The project's repositories (one is primary). Agents see all of them side by side; the primary one
     * holds the task state. `key` identifies a repository wherever it is cloned (see @ao/core
     * repositoryKey): `<host>/<owner>/<name>` or `local:<root commit>`.
     */
    repositories: [
      {
        name: { type: String, required: true },
        key: { type: String, default: null },
        url: { type: String, default: null },
        defaultBranch: { type: String, default: 'main' },
        primary: { type: Boolean, default: false },
        source: { type: String, enum: ['manual', 'github', 'discovered'], default: 'manual' },
        /** GitHub App data for repositories synced from an installation. */
        github: { type: Mixed, default: null },
      },
    ],
    policy: { type: Mixed, default: {} },
    environments: { type: [Mixed], default: [] },
    knowledge: { type: String, default: '' },
    /** Where each worker has each repository. `repositoryId` null (older workers) means the primary one. */
    workerPaths: [
      {
        workerId: { type: Schema.Types.ObjectId, required: true },
        repositoryId: { type: Schema.Types.ObjectId, default: null },
        localPath: { type: String, required: true },
        _id: false,
      },
    ],
    archived: { type: Boolean, default: false },
    /** Tasks currently holding a project slot. Updated atomically at claim/release (spec §19 concurrency). */
    activeTaskIds: { type: [Schema.Types.ObjectId], default: [] },
    /** Latest AI-readiness analysis (spec §41). */
    readiness: { type: Mixed, default: null },
  },
  opts,
);
projectSchema.index({ organizationId: 1, name: 1 }, { unique: true });
projectSchema.index({ 'workerPaths.workerId': 1 });
projectSchema.index({ organizationId: 1, 'repositories.key': 1 });

// ── Workers ───────────────────────────────────────────────────────────────────
const workerSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    hostname: { type: String, default: '' },
    os: { type: String, enum: ['windows', 'macos', 'linux'], required: true },
    arch: { type: String, default: '' },
    version: { type: String, default: '' },
    status: { type: String, enum: ['PENDING_APPROVAL', 'ONLINE', 'OFFLINE', 'DISABLED'], default: 'OFFLINE' },
    approved: { type: Boolean, default: false },
    approvedBy: { type: Schema.Types.ObjectId, default: null },
    pairedBy: { type: Schema.Types.ObjectId, default: null },
    labels: { type: [String], default: [] },
    maxConcurrentTasks: { type: Number, default: 2 },
    credentialHash: { type: String, select: false },
    lastHeartbeatAt: { type: Date, default: null },
    latencyMs: { type: Number, default: null },
    metrics: { type: Mixed, default: null },
    agents: { type: [Mixed], default: [] },
    providers: { type: [Mixed], default: [] },
    tools: { type: [String], default: [] },
    lastSequence: { type: Number, default: 0 },
  },
  opts,
);
workerSchema.index({ organizationId: 1, status: 1 });
workerSchema.index({ credentialHash: 1 }, { unique: true, sparse: true });
workerSchema.index({ status: 1, lastHeartbeatAt: 1 });

const workerPairingSchema = new Schema(
  {
    userCode: { type: String, required: true },
    pollSecretHash: { type: String, required: true },
    name: String,
    hostname: String,
    os: String,
    arch: String,
    version: String,
    status: { type: String, enum: ['PENDING', 'APPROVED', 'DENIED', 'CONSUMED'], default: 'PENDING' },
    organizationId: { type: Schema.Types.ObjectId, default: null },
    workerId: { type: Schema.Types.ObjectId, default: null },
    approvedBy: { type: Schema.Types.ObjectId, default: null },
    expiresAt: { type: Date, required: true },
  },
  opts,
);
workerPairingSchema.index({ userCode: 1 }, { unique: true });
workerPairingSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 }); // keep an hour for "expired" responses

// ── Tasks ─────────────────────────────────────────────────────────────────────
const taskSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    originalPrompt: { type: String, required: true, immutable: true },
    /** `code` (default) or `review` (FUT-003). */
    kind: { type: String, enum: ['code', 'review', 'plan'], default: 'code' },
    /** Tasks created by applying a plan point to the plan task. */
    parentTaskId: { type: Schema.Types.ObjectId, default: null },
    /** Plan tasks: tasks created from the plan ({ at, by, taskIds }). */
    planApplied: { type: Mixed, default: null },
    /** Review tasks: { base, head, fetchHead?, pullRequest? }. */
    review: { type: Mixed, default: null },
    /** Where the task came from when not created by a person: an integration delivery (spec §74). */
    source: { type: Mixed, default: null },
    /** Task-specific knowledge (context, links, constraints) given to the agent with the prompt (spec §77). */
    knowledge: { type: String, default: '' },
    normalizedPrompt: { type: String, default: null },
    generatedPlan: { type: String, default: null },
    priority: { type: String, enum: PRIORITIES, default: 'NORMAL' },
    status: { type: String, enum: TASK_STATUSES, default: 'QUEUED' },
    statusReason: { type: String, default: null },
    workerId: { type: Schema.Types.ObjectId, default: null },
    agentId: { type: String, default: null },
    providerId: { type: String, default: null },
    modelId: { type: String, default: null },
    sessionId: { type: String, default: null },
    dependencies: [{ type: Schema.Types.ObjectId }],
    requirements: { type: Mixed, default: {} },
    policy: { type: Mixed, default: {} },
    capabilityIds: { type: [String], default: [] },
    environment: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, required: true },
    idempotencyKey: { type: String, default: undefined },
    queuedAt: { type: Date, default: () => new Date() },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    retryCount: { type: Number, default: 0 },
    restartCount: { type: Number, default: 0 },
    limitHitCount: { type: Number, default: 0 },
    contextResetCount: { type: Number, default: 0 },
    remediationCount: { type: Number, default: 0 },
    fallbackStep: { type: Number, default: -1 },
    leaseExpiresAt: { type: Date, default: null },
    waitingUntil: { type: Date, default: null },
    lastCheckpoint: { type: Mixed, default: null },
    progress: { percent: { type: Number, default: null }, currentStep: { type: String, default: null }, message: { type: String, default: null } },
    verificationStatus: { type: String, enum: ['NOT_RUN', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED'], default: 'NOT_RUN' },
    verificationRuns: { type: [Mixed], default: [] },
    gitStatus: { type: String, enum: ['NONE', 'PENDING', 'COMMITTED', 'PUSHED', 'PR_OPENED', 'BLOCKED', 'FAILED'], default: 'NONE' },
    gitResult: { type: Mixed, default: null },
    completionReport: { type: Mixed, default: null },
    pendingInteraction: { type: Mixed, default: null },
    /** Recent idempotent transition ids (bounded). */
    appliedTransitionIds: { type: [String], default: [], select: false },
    correlationId: { type: String, required: true },
    activeMs: { type: Number, default: 0 },
    /** Set by the scheduler when a task has been offered; not a claim. */
    offeredTo: { type: Schema.Types.ObjectId, default: null },
    offeredAt: { type: Date, default: null },
    blockedReason: { type: String, default: null },
  },
  opts,
);
taskSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
taskSchema.index({ organizationId: 1, projectId: 1, createdAt: -1 });
taskSchema.index({ projectId: 1, status: 1 });
taskSchema.index({ workerId: 1, status: 1 });
taskSchema.index({ status: 1, leaseExpiresAt: 1 });
taskSchema.index({ status: 1, waitingUntil: 1 });
taskSchema.index({ status: 1, priority: 1, queuedAt: 1 });
taskSchema.index({ dependencies: 1 });
taskSchema.index(
  { organizationId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);
taskSchema.index({ organizationId: 1, title: 'text', originalPrompt: 'text' });

const taskEventSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    taskId: { type: Schema.Types.ObjectId, required: true },
    workerId: { type: Schema.Types.ObjectId, default: null },
    eventId: { type: String, required: true },
    type: { type: String, enum: TASK_EVENT_TYPES, required: true },
    timestamp: { type: Date, required: true },
    sequence: { type: Number, default: null },
    payload: { type: Mixed, default: {} },
    correlationId: { type: String, default: null },
    ephemeral: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
taskEventSchema.index({ eventId: 1 }, { unique: true });
taskEventSchema.index({ taskId: 1, timestamp: 1, sequence: 1 });
taskEventSchema.index({ organizationId: 1, createdAt: -1 });

// ── Audit (immutable) ─────────────────────────────────────────────────────────
const auditSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, default: null },
    actorType: { type: String, enum: ['user', 'worker', 'system'], required: true },
    actorId: { type: String, default: null },
    action: { type: String, required: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    metadata: { type: Mixed, default: {} },
    ip: { type: String, default: null },
    correlationId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
auditSchema.index({ organizationId: 1, createdAt: -1 });
auditSchema.index({ action: 1, createdAt: -1 });
const immutable = function (this: unknown, next: (err?: Error) => void) {
  next(new Error('Audit log entries are immutable'));
};
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace'] as const) {
  auditSchema.pre(op, immutable);
}
auditSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('Audit log entries are immutable'));
  next();
});

// ── Notifications ─────────────────────────────────────────────────────────────
const notificationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: '' },
    taskId: { type: Schema.Types.ObjectId, default: null },
    workerId: { type: Schema.Types.ObjectId, default: null },
    readAt: { type: Date, default: null },
    channels: { type: [String], default: ['in_app'] },
  },
  opts,
);
notificationSchema.index({ userId: 1, organizationId: 1, createdAt: -1 });

const pushTokenSchema = new Schema(
  { userId: { type: Schema.Types.ObjectId, required: true }, token: { type: String, required: true }, platform: String },
  opts,
);
pushTokenSchema.index({ token: 1 }, { unique: true });

// ── Capabilities ──────────────────────────────────────────────────────────────
/** Owner of a namespace ("@acme"). Organizations and people get one on first publish; upstream namespaces are mirrored. */
const publisherSchema = new Schema(
  {
    namespace: { type: String, required: true },
    kind: { type: String, enum: PUBLISHER_KINDS, required: true },
    organizationId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, default: null },
    displayName: { type: String, default: '' },
    verified: { type: Boolean, default: false },
    upstreamRegistry: { type: String, default: null },
  },
  opts,
);
publisherSchema.index({ namespace: 1 }, { unique: true });
publisherSchema.index({ organizationId: 1 }, { unique: true, partialFilterExpression: { kind: 'organization' } });
publisherSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { kind: 'user' } });

/** One package ("@namespace/name") with its marketplace listing. Versions live in `capabilities`. */
const capabilityPackageSchema = new Schema(
  {
    ref: { type: String, required: true },
    namespace: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ['skill', 'mcp', 'plugin', 'integration'], required: true },
    ownerKind: { type: String, enum: PUBLISHER_KINDS, required: true },
    organizationId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, default: null },
    visibility: { type: String, enum: VISIBILITIES, default: 'PRIVATE' },
    source: { type: String, enum: PACKAGE_SOURCES, default: 'native' },
    upstream: { registry: String, id: String, url: String, _id: false },
    // Listing
    displayName: { type: String, required: true },
    description: { type: String, default: '' },
    readme: { type: String, default: null },
    tags: { type: [String], default: [] },
    homepage: { type: String, default: null },
    repository: { type: String, default: null },
    publisherName: { type: String, default: '' },
    // Classification (see @ao/core taxonomy), recomputed whenever the listing or latest version changes
    /** Effective categories: `categoryOverride` when a platform administrator set one, else the classifier's. */
    categories: { type: [String], default: [] },
    /** Categories the publisher chose; a strong hint to the classifier. */
    declaredCategories: { type: [String], default: [] },
    categoryOverride: { type: [String], default: undefined },
    technologies: { type: [String], default: [] },
    /** Words a matching task or search would use: name parts, tags, triggers, technologies. */
    keywords: { type: [String], default: [] },
    classifierVersion: { type: Number, default: 0 },
    // Latest active version, denormalized for search and filtering
    latestVersion: { type: String, required: true },
    trust: { type: String, required: true },
    permissions: { type: [String], default: [] },
    compatibleAgents: { type: [String], default: [] },
    lastPublishedAt: { type: Date, default: () => new Date() },
    // Curation and review
    curated: { type: Boolean, default: false },
    curatedRank: { type: Number, default: null },
    review: {
      status: { type: String, enum: REVIEW_STATUSES, default: 'NONE' },
      listed: { type: Boolean, default: true },
      requestedAt: { type: Date, default: null },
      requestedBy: { type: Schema.Types.ObjectId, default: null },
      reviewedAt: { type: Date, default: null },
      reviewedBy: { type: Schema.Types.ObjectId, default: null },
      notes: { type: String, default: '' },
      findings: { type: Mixed, default: [] },
    },
    deprecated: { type: String, default: null },
    installs: { type: Number, default: 0 },
    /** Worth a search engine's attention (see isIndexable in @ao/core); maintained on every relevant change. */
    indexable: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  opts,
);
capabilityPackageSchema.index({ ref: 1 }, { unique: true });
capabilityPackageSchema.index({ visibility: 1, type: 1, curated: -1, curatedRank: 1, installs: -1 });
capabilityPackageSchema.index({ visibility: 1, indexable: 1, _id: 1 });
capabilityPackageSchema.index({ visibility: 1, categories: 1, curated: -1, curatedRank: 1, installs: -1 });
capabilityPackageSchema.index({ visibility: 1, technologies: 1, curated: -1, curatedRank: 1, installs: -1 });
capabilityPackageSchema.index({ keywords: 1 });
capabilityPackageSchema.index({ classifierVersion: 1 });
capabilityPackageSchema.index({ organizationId: 1 });
capabilityPackageSchema.index({ userId: 1 });
capabilityPackageSchema.index({ 'review.status': 1, 'review.requestedAt': 1 });
capabilityPackageSchema.index({ 'upstream.registry': 1, 'upstream.id': 1 }, { sparse: true });
capabilityPackageSchema.index(
  { displayName: 'text', name: 'text', description: 'text', tags: 'text', namespace: 'text' },
  { name: 'package_text', weights: { displayName: 10, name: 10, tags: 5, namespace: 3, description: 1 } },
);

/** One immutable version of a package. `capabilityId` is the package reference ("@namespace/name"). */
const capabilitySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, default: null }, // owning organization; null = platform, a person or upstream
    packageId: { type: Schema.Types.ObjectId, default: null },
    namespace: { type: String, default: null },
    capabilityId: { type: String, required: true },
    version: { type: String, required: true },
    type: { type: String, enum: ['skill', 'mcp', 'plugin', 'integration'], required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    publisher: { type: String, default: 'local' },
    trust: { type: String, required: true },
    permissions: { type: [String], default: [] },
    private: { type: Boolean, default: true },
    status: { type: String, enum: VERSION_STATUSES, default: 'ACTIVE' },
    /** SHA-256 of the canonical manifest; installations pin it. */
    digest: { type: String, default: null },
    findings: { type: Mixed, default: [] },
    manifest: { type: Mixed, required: true },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  opts,
);
capabilitySchema.index({ capabilityId: 1, version: 1 }, { unique: true, name: 'ref_version_unique' });
capabilitySchema.index({ packageId: 1, createdAt: -1 });
capabilitySchema.index({ organizationId: 1, capabilityId: 1 });

const capabilityInstallationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    capabilityId: { type: String, required: true },
    version: { type: String, required: true },
    /** Range used for upgrades ("^1.2.0"); `version` is the pinned, installed version. */
    versionRange: { type: String, default: '*' },
    digest: { type: String, default: null },
    scope: { type: String, enum: CAPABILITY_SCOPES, required: true },
    projectId: { type: Schema.Types.ObjectId, default: null },
    userId: { type: Schema.Types.ObjectId, default: null },
    taskId: { type: Schema.Types.ObjectId, default: null },
    enabled: { type: Boolean, default: true },
    status: { type: String, enum: ['ACTIVE', 'PENDING_APPROVAL', 'BLOCKED', 'DISABLED'], default: 'ACTIVE' },
    approvalReasons: { type: [String], default: [] },
    approvedBy: { type: Schema.Types.ObjectId, default: null },
    installedBy: { type: Schema.Types.ObjectId, default: null },
    config: { type: Mixed, default: {} },
  },
  opts,
);
capabilityInstallationSchema.index(
  { organizationId: 1, scope: 1, projectId: 1, userId: 1, taskId: 1, capabilityId: 1 },
  { unique: true, name: 'installation_scope_unique' },
);

// ── Providers / secrets / usage ───────────────────────────────────────────────
const providerConfigSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    providerId: { type: String, required: true },
    kind: { type: String, required: true },
    name: { type: String, required: true },
    baseUrl: { type: String, default: null },
    enabled: { type: Boolean, default: true },
    models: { type: [Mixed], default: [] },
  },
  opts,
);
providerConfigSchema.index({ organizationId: 1, providerId: 1 }, { unique: true });

const secretSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    valueEnc: { type: String, required: true, select: false },
    masked: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  opts,
);
secretSchema.index({ organizationId: 1, name: 1 }, { unique: true });

const usageRecordSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, default: null },
    taskId: { type: Schema.Types.ObjectId, default: null },
    workerId: { type: Schema.Types.ObjectId, default: null },
    agentId: String,
    providerId: String,
    modelId: String,
    kind: { type: String, enum: ['execution', 'limit', 'fallback', 'verification'], required: true },
    durationMs: { type: Number, default: 0 },
    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    costUsd: { type: Number, default: null },
    eventId: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
usageRecordSchema.index({ organizationId: 1, createdAt: -1 });
usageRecordSchema.index({ eventId: 1 }, { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } });

const settingSchema = new Schema({ key: { type: String, required: true }, value: { type: Mixed } }, opts);
settingSchema.index({ key: 1 }, { unique: true });

// ── Integrations (inbound webhooks that create tasks, spec §74) ────────────────
const integrationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    projectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    kind: { type: String, enum: ['github', 'gitlab', 'generic'], required: true },
    enabled: { type: Boolean, default: true },
    /** Webhook secret (HMAC key, or GitLab's token), encrypted. */
    secretEnc: { type: String, required: true, select: false },
    settings: { type: Mixed, default: {} },
    /** Tasks are created on behalf of this member. */
    createdBy: { type: Schema.Types.ObjectId, required: true },
    lastDeliveryAt: { type: Date, default: null },
    lastDeliveryResult: { type: String, default: null },
    deliveries: { type: Number, default: 0 },
  },
  opts,
);
integrationSchema.index({ organizationId: 1, name: 1 }, { unique: true });

// ── Invitations ───────────────────────────────────────────────────────────────
/** Invitation for someone who may not have an account yet (spec §18). The token is stored hashed. */
const invitationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, required: true },
    tokenHash: { type: String, required: true },
    invitedBy: { type: Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    acceptedBy: { type: Schema.Types.ObjectId, default: null },
    revokedAt: { type: Date, default: null },
  },
  opts,
);
invitationSchema.index({ tokenHash: 1 }, { unique: true });
invitationSchema.index({ organizationId: 1, email: 1, createdAt: -1 });

// ── OAuth sign-in ─────────────────────────────────────────────────────────────
/** An authorization request in flight: state, PKCE verifier and nonce, single use, 10 minutes. */
const oauthStateSchema = new Schema(
  {
    stateHash: { type: String, required: true },
    provider: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    nonce: { type: String, required: true },
    mode: { type: String, enum: ['login', 'link'], required: true },
    userId: { type: Schema.Types.ObjectId, default: null },
    next: { type: String, default: '/' },
    invitationToken: { type: String, default: null },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  opts,
);
oauthStateSchema.index({ stateHash: 1 }, { unique: true });
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Short-lived, single-use ticket that the web app exchanges for a session (plus 2FA if enabled). */
const oauthTicketSchema = new Schema(
  {
    ticketHash: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    provider: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  opts,
);
oauthTicketSchema.index({ ticketHash: 1 }, { unique: true });
oauthTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Concurrency slots ─────────────────────────────────────────────────────────
/**
 * Organization-, agent- and provider-level concurrency slots (spec §19, §46). One document per
 * (organization, scope, key); `taskIds` are the tasks holding a slot, reserved with a conditional
 * update so a limit can never be exceeded. Rebuilt from task truth by the reconcile sweep.
 */
const concurrencySlotSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    scope: { type: String, enum: ['organization', 'agent', 'provider'], required: true },
    key: { type: String, default: '' },
    taskIds: { type: [Schema.Types.ObjectId], default: [] },
  },
  opts,
);
concurrencySlotSchema.index({ organizationId: 1, scope: 1, key: 1 }, { unique: true });
concurrencySlotSchema.index({ taskIds: 1 });

// ── GitHub App (repository sync) ──────────────────────────────────────────────
/**
 * The organization's GitHub App, created from the dashboard with GitHub's app-manifest flow. Its
 * credentials are encrypted with ENCRYPTION_KEY and never returned by the API.
 */
const githubAppSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    appId: { type: Number, required: true },
    slug: { type: String, required: true },
    name: { type: String, required: true },
    htmlUrl: { type: String, required: true },
    ownerLogin: { type: String, default: null },
    ownerType: { type: String, default: null },
    clientId: { type: String, required: true },
    clientSecretEnc: { type: String, required: true, select: false },
    privateKeyEnc: { type: String, required: true, select: false },
    webhookSecretEnc: { type: String, default: null, select: false },
    /** Public apps can be installed on any account; installations still have to be started from here. */
    public: { type: Boolean, default: true },
    webhookActive: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, default: null },
  },
  opts,
);
githubAppSchema.index({ organizationId: 1 }, { unique: true });
githubAppSchema.index({ appId: 1 }, { unique: true });

/** An installation of the app on a GitHub account; its repositories are synced into projects. */
const githubInstallationSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    appId: { type: Number, required: true },
    installationId: { type: Number, required: true },
    accountLogin: { type: String, required: true },
    accountType: { type: String, enum: ['User', 'Organization'], required: true },
    accountId: { type: Number, default: null },
    repositorySelection: { type: String, default: 'all' },
    suspended: { type: Boolean, default: false },
    lastSyncAt: { type: Date, default: null },
    lastSyncError: { type: String, default: null },
    repositoryCount: { type: Number, default: 0 },
    /** Lease so only one API instance syncs an installation at a time. */
    syncLockUntil: { type: Date, default: null },
  },
  opts,
);
githubInstallationSchema.index({ installationId: 1 }, { unique: true });
githubInstallationSchema.index({ organizationId: 1 });

/** A member's authorization of the app (user-to-server token), needed to create repositories in their personal account. */
const githubUserTokenSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    login: { type: String, required: true },
    githubUserId: { type: Number, required: true },
    accessTokenEnc: { type: String, required: true, select: false },
    refreshTokenEnc: { type: String, default: null, select: false },
    expiresAt: { type: Date, default: null },
    refreshExpiresAt: { type: Date, default: null },
  },
  opts,
);
githubUserTokenSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

/** Single-use state for the GitHub redirects (app creation, installation, member authorization). */
const githubStateSchema = new Schema(
  {
    stateHash: { type: String, required: true },
    /** `clone`: a worker was asked to clone a repository (its token request is checked against this). */
    purpose: { type: String, enum: ['manifest', 'install', 'user', 'clone'], required: true },
    organizationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    data: { type: Mixed, default: {} },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  opts,
);
githubStateSchema.index({ stateHash: 1 }, { unique: true });
githubStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Repositories found on workers ─────────────────────────────────────────────
/**
 * A Git repository a worker found on its disks. Matched to a project repository by key, it is mapped
 * on the worker automatically; otherwise it is suggested in the dashboard until accepted or dismissed.
 */
const discoveredRepositorySchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, required: true },
    workerId: { type: Schema.Types.ObjectId, required: true },
    localPath: { type: String, required: true },
    name: { type: String, required: true },
    /** Identity keys: one per recognisable remote, plus `local:<root commit>`. */
    keys: { type: [String], default: [] },
    remotes: [{ name: String, url: String, _id: false }],
    rootCommit: { type: String, default: null },
    branch: { type: String, default: null },
    status: { type: String, enum: ['suggested', 'mapped', 'dismissed'], default: 'suggested' },
    projectId: { type: Schema.Types.ObjectId, default: null },
    repositoryId: { type: Schema.Types.ObjectId, default: null },
    lastSeenAt: { type: Date, required: true },
  },
  opts,
);
discoveredRepositorySchema.index({ workerId: 1, localPath: 1 }, { unique: true });
discoveredRepositorySchema.index({ organizationId: 1, status: 1 });
discoveredRepositorySchema.index({ organizationId: 1, keys: 1 });

// ── Registration ──────────────────────────────────────────────────────────────
function model<T extends Schema>(name: string, schema: T) {
  return (mongoose.models[name] as Model<InferSchemaType<T>>) ?? mongoose.model(name, schema);
}

export const User = model('User', userSchema);
export const Organization = model('Organization', organizationSchema);
export const Membership = model('Membership', membershipSchema);
export const Team = model('Team', teamSchema);
export const RefreshToken = model('RefreshToken', refreshTokenSchema);
export const OneTimeToken = model('OneTimeToken', oneTimeTokenSchema);
export const ApiToken = model('ApiToken', apiTokenSchema);
export const Integration = model('Integration', integrationSchema);
export const DeviceLogin = model('DeviceLogin', deviceLoginSchema);
export const Project = model('Project', projectSchema);
export const Worker = model('Worker', workerSchema);
export const WorkerPairing = model('WorkerPairing', workerPairingSchema);
export const Task = model('Task', taskSchema);
export const TaskEvent = model('TaskEvent', taskEventSchema);
export const AuditLog = model('AuditLog', auditSchema);
export const Notification = model('Notification', notificationSchema);
export const PushToken = model('PushToken', pushTokenSchema);
export const Publisher = model('Publisher', publisherSchema);
export const CapabilityPackage = model('CapabilityPackage', capabilityPackageSchema);
export const Capability = model('Capability', capabilitySchema);
export const CapabilityInstallation = model('CapabilityInstallation', capabilityInstallationSchema);
export const ProviderConfig = model('ProviderConfig', providerConfigSchema);
export const Secret = model('Secret', secretSchema);
export const UsageRecord = model('UsageRecord', usageRecordSchema);
export const Setting = model('Setting', settingSchema);
export const ConcurrencySlot = model('ConcurrencySlot', concurrencySlotSchema);
export const Invitation = model('Invitation', invitationSchema);
export const OAuthState = model('OAuthState', oauthStateSchema);
export const OAuthTicket = model('OAuthTicket', oauthTicketSchema);
export const GitHubApp = model('GitHubApp', githubAppSchema);
export const GitHubInstallation = model('GitHubInstallation', githubInstallationSchema);
export const GitHubUserToken = model('GitHubUserToken', githubUserTokenSchema);
export const GitHubState = model('GitHubState', githubStateSchema);
export const DiscoveredRepository = model('DiscoveredRepository', discoveredRepositorySchema);

export const ALL_MODELS = [
  User, Organization, Membership, Team, RefreshToken, OneTimeToken, Project, Worker, WorkerPairing, Task,
  TaskEvent, AuditLog, Notification, PushToken, Capability, CapabilityInstallation, ProviderConfig, Secret,
  UsageRecord, Setting, ConcurrencySlot, Invitation, OAuthState, OAuthTicket, ApiToken, Integration, DeviceLogin,
  GitHubApp, GitHubInstallation, GitHubUserToken, GitHubState, DiscoveredRepository, Publisher, CapabilityPackage,
];

export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };
export type WorkerDoc = InferSchemaType<typeof workerSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };
export type ProjectDoc = InferSchemaType<typeof projectSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };
export type UserDoc = InferSchemaType<typeof userSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };
export type OrganizationDoc = InferSchemaType<typeof organizationSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date; updatedAt: Date };
export type TaskEventDoc = InferSchemaType<typeof taskEventSchema> & { _id: mongoose.Types.ObjectId; createdAt: Date };
