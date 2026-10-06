/**
 * Shared API contracts (spec §71). Used by API, web, mobile, worker and CLI.
 * Imports only the browser-safe subset of @ao/core.
 */
import { z } from 'zod';
import {
  AGENT_STATES,
  CAPABILITY_SCOPES,
  CATEGORY_SLUGS,
  PRIORITIES,
  ROLES,
  TASK_EVENT_TYPES,
  TASK_STATUSES,
  capabilityManifestSchema,
  policyLayerSchema,
} from '@ao/core/shared';

export * from './worker-protocol.js';

export const API_PREFIX = '/api/v1';

const id = z.string().min(1).max(64);
const email = z.string().trim().toLowerCase().email().max(254);
/** Minimum 10 chars; no maximum below 128 so passphrases work. */
const password = z.string().min(10, 'Password must be at least 10 characters').max(128);

// ── Pagination ────────────────────────────────────────────────────────────────
export const cursorQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CursorQuery = z.infer<typeof cursorQuery>;
export const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

// ── Errors ────────────────────────────────────────────────────────────────────
export const apiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    context: z.record(z.unknown()).optional(),
    correlationId: z.string().optional(),
    retryable: z.boolean().optional(),
  }),
});
export type ApiError = z.infer<typeof apiError>;

// ── Auth ──────────────────────────────────────────────────────────────────────
export const registerRequest = z.object({
  email,
  password,
  name: z.string().trim().min(1).max(120),
  organizationName: z.string().trim().min(1).max(120).optional(),
  /** Registering through an invitation joins that organization instead of creating one. */
  invitationToken: z.string().min(10).max(200).optional(),
});
/** `mfaCode`: a 6-digit authenticator code or a recovery code, sent after the server answered `MFA_REQUIRED`. */
/** A security key's answer to the challenge that came with `MFA_REQUIRED` (`context.securityKey`), as the browser returns it. */
const securityKeyAssertion = z.object({ id: z.string().max(2000) }).passthrough();
export const loginRequest = z.object({ email, password: z.string().min(1).max(128), mfaCode: z.string().trim().max(20).optional(), securityKey: securityKeyAssertion.optional() });
export const addSecurityKeyRequest = z.object({ name: z.string().trim().max(60).default(''), response: z.object({ id: z.string().max(2000) }).passthrough() });
export const securityKeyDto = z.object({ id: z.string(), name: z.string(), createdAt: z.string(), lastUsedAt: z.string().nullable() });
export type SecurityKeyDto = z.infer<typeof securityKeyDto>;
export const oauthProviderDto = z.object({ id: z.string(), name: z.string() });
export type OAuthProviderDto = z.infer<typeof oauthProviderDto>;
/** Exchanges the one-time ticket from the OAuth callback for a session (`mfaCode` when 2FA is on). */
export const oauthCompleteRequest = z.object({ ticket: z.string().min(10).max(200), mfaCode: z.string().trim().max(20).optional(), securityKey: securityKeyAssertion.optional() });
export const mfaSetupResponse = z.object({ secret: z.string(), otpauthUrl: z.string() });
export const mfaEnableRequest = z.object({ code: z.string().trim().min(6).max(20) });
export const mfaEnableResponse = z.object({ recoveryCodes: z.array(z.string()) });
export const mfaDisableRequest = z.object({ password: z.string().min(1).max(128), code: z.string().trim().min(6).max(20) });
export const refreshRequest = z.object({ refreshToken: z.string().min(10).max(200) });
export const passwordResetRequest = z.object({ email });
export const passwordResetConfirm = z.object({ token: z.string().min(10).max(200), password });
export const verifyEmailRequest = z.object({ token: z.string().min(10).max(200) });

export const userDto = z.object({
  id,
  email: z.string(),
  name: z.string(),
  emailVerified: z.boolean(),
  mfaEnabled: z.boolean().optional(),
  /** False when the account was created through an OAuth provider and no password was set yet. */
  hasPassword: z.boolean().optional(),
  identities: z.array(z.object({ provider: z.string(), email: z.string().nullable() })).optional(),
  platformAdmin: z.boolean().optional(),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof userDto>;

export const membershipDto = z.object({
  organizationId: id,
  organizationName: z.string(),
  organizationSlug: z.string(),
  role: z.enum(ROLES),
});
export type MembershipDto = z.infer<typeof membershipDto>;

export const authResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number(),
  user: userDto,
  memberships: z.array(membershipDto),
});
export type AuthResponse = z.infer<typeof authResponse>;

// ── Organizations / members / teams ────────────────────────────────────────────
export const createOrganizationRequest = z.object({ name: z.string().trim().min(1).max(120) });
export const organizationDto = z.object({
  id,
  name: z.string(),
  slug: z.string(),
  policy: policyLayerSchema.optional(),
  createdAt: z.string(),
});
export type OrganizationDto = z.infer<typeof organizationDto>;
export const updateOrganizationRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  policy: policyLayerSchema.optional(),
  /** Organization-wide knowledge for agents (spec §77). */
  knowledge: z.string().max(50_000).optional(),
  settings: z
    .object({
      requireWorkerApproval: z.boolean().optional(),
      retentionDays: z
        .object({ events: z.number().int().min(1).optional(), agentOutput: z.number().int().min(1).optional(), audit: z.number().int().min(30).optional() })
        .optional(),
    })
    .optional(),
});

export const memberDto = z.object({ userId: id, email: z.string(), name: z.string(), role: z.enum(ROLES), joinedAt: z.string(), mfaEnabled: z.boolean().optional(), inOtherOrganizations: z.boolean().optional(), /** Deactivated by the identity provider (SCIM): a member without access. */ suspended: z.boolean().optional() });
export type MemberDto = z.infer<typeof memberDto>;
export const addMemberRequest = z.object({ email, role: z.enum(ROLES) });
export const updateMemberRequest = z.object({ role: z.enum(ROLES) });
export const invitationDto = z.object({ id, email: z.string(), role: z.enum(ROLES), invitedByName: z.string(), expiresAt: z.string(), createdAt: z.string() });
export type InvitationDto = z.infer<typeof invitationDto>;
/** Adding an existing user is immediate; anyone else receives an emailed invitation. */
export const addMemberResponse = z.object({ status: z.enum(['added', 'invited']), invitation: invitationDto.optional(), inviteUrl: z.string().optional() });
export type AddMemberResponse = z.infer<typeof addMemberResponse>;
/** What the holder of an invitation link may see before accepting. */
export const invitationPreviewDto = z.object({ organizationName: z.string(), email: z.string(), role: z.enum(ROLES), invitedByName: z.string(), expiresAt: z.string(), accountExists: z.boolean() });
export type InvitationPreviewDto = z.infer<typeof invitationPreviewDto>;
export const acceptInvitationRequest = z.object({ token: z.string().min(10).max(200) });
export const teamDto = z.object({ id, name: z.string(), memberIds: z.array(id), createdAt: z.string() });
export const createTeamRequest = z.object({ name: z.string().trim().min(1).max(120), memberIds: z.array(id).default([]) });

// ── Projects ──────────────────────────────────────────────────────────────────
export const environmentProfile = z.object({
  name: z.enum(['development', 'testing', 'staging', 'production']),
  /** References to secrets by name, never values (spec §78). */
  secretRefs: z.array(z.string()).default([]),
  variables: z.record(z.string()).default({}),
  requiresApproval: z.boolean().default(false),
});
export const createProjectRequest = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(''),
  repositoryUrl: z.string().max(500).optional(),
  defaultBranch: z.string().max(200).default('main'),
  policy: policyLayerSchema.optional(),
  environments: z.array(environmentProfile).default([]),
  knowledge: z.string().max(50_000).default(''),
});
export const updateProjectRequest = createProjectRequest.partial();

/** Folder-safe name of a repository inside its project (also its folder in a new clone). */
const repositoryNameField = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, ".", "_" and "-"').refine((n) => !/^\.+$/.test(n), 'Not a valid name');
export const repositoryDto = z.object({
  id,
  name: z.string(),
  /** Identity wherever the repository is cloned: `<host>/<owner>/<name>` or `local:<root commit>`. */
  key: z.string().nullable(),
  url: z.string().nullable(),
  defaultBranch: z.string(),
  primary: z.boolean(),
  source: z.enum(['manual', 'github', 'discovered']),
  github: z
    .object({ installationId: z.number(), repoId: z.number(), fullName: z.string(), private: z.boolean(), archived: z.boolean(), accessible: z.boolean() })
    .nullable(),
});
export type RepositoryDto = z.infer<typeof repositoryDto>;
/** Add a repository to a project: a new one by URL, or one moved from another project of the organization. */
export const addRepositoryRequest = z.union([
  z.object({ url: z.string().trim().min(1).max(500), name: repositoryNameField.optional(), defaultBranch: z.string().max(200).optional() }),
  z.object({ fromProjectId: id, repositoryId: id }),
]);
export const updateRepositoryRequest = z.object({ name: repositoryNameField.optional(), defaultBranch: z.string().min(1).max(200).optional(), primary: z.literal(true).optional() });

export const projectDto = z.object({
  id,
  organizationId: id,
  name: z.string(),
  description: z.string(),
  repositoryUrl: z.string().nullable(),
  defaultBranch: z.string(),
  repositories: z.array(repositoryDto),
  policy: policyLayerSchema.optional(),
  environments: z.array(environmentProfile),
  knowledge: z.string(),
  workerPaths: z.array(z.object({ workerId: id, repositoryId: id.nullable(), localPath: z.string() })),
  readiness: z
    .object({
      status: z.enum(['PENDING', 'COMPLETED', 'FAILED']),
      requestId: z.string(),
      workerId: z.string(),
      requestedAt: z.string(),
      completedAt: z.string().nullable(),
      error: z.string().nullable(),
      report: z.record(z.unknown()).nullable(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type ProjectDto = z.infer<typeof projectDto>;

// ── Tasks ─────────────────────────────────────────────────────────────────────
export const taskRequirements = z.object({
  os: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
  labels: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  agentCapabilities: z.array(z.string()).optional(),
  minContextWindow: z.number().int().positive().optional(),
  workerId: z.string().optional(),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
});
// ── Reviews (FUT-003) ─────────────────────────────────────────────────────────
export const TASK_KINDS = ['code', 'review', 'plan'] as const;
export const reviewRequest = z.object({
  /** Branch or ref the changes are compared against (e.g. main). */
  base: z.string().min(1).max(200),
  /** Branch or ref with the changes. */
  head: z.string().min(1).max(200),
  /** Ref to fetch from origin for the head, e.g. pull/12/head or refs/merge-requests/3/head. */
  fetchHead: z.string().max(200).optional(),
  pullRequest: z.object({ url: z.string().url(), number: z.number().int() }).optional(),
});
export const REVIEW_VERDICTS = ['approve', 'comment', 'request_changes'] as const;
/** What a review agent writes to .agent-orchestration/progress/<task>.review.json. */
export const reviewResult = z.object({
  summary: z.string().min(1).max(20_000),
  verdict: z.enum(REVIEW_VERDICTS),
  comments: z
    .array(z.object({ path: z.string().min(1).max(500), line: z.number().int().positive().optional(), severity: z.enum(['blocker', 'major', 'minor', 'nit']).default('minor'), body: z.string().min(1).max(4000) }))
    .max(100)
    .default([]),
});
export type ReviewResult = z.infer<typeof reviewResult>;

// ── Plans (FUT-001, AI project manager) ──────────────────────────────────────
/** What a planning agent writes to .agent-orchestration/progress/<task>.plan.json. */
export const planResult = z
  .object({
    summary: z.string().min(1).max(20_000),
    tasks: z
      .array(
        z.object({
          key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and dashes'),
          title: z.string().trim().min(1).max(200),
          prompt: z.string().trim().min(1).max(50_000),
          dependsOn: z.array(z.string()).max(30).default([]),
          priority: z.enum(PRIORITIES).default('NORMAL'),
        }),
      )
      .min(1)
      .max(30),
  })
  .superRefine((p, ctx) => {
    const keys = new Set<string>();
    for (const t of p.tasks) {
      if (keys.has(t.key)) ctx.addIssue({ code: 'custom', message: `Duplicate task key "${t.key}"` });
      keys.add(t.key);
    }
    for (const t of p.tasks) for (const d of t.dependsOn) if (!keys.has(d)) ctx.addIssue({ code: 'custom', message: `"${t.key}" depends on unknown task "${d}"` });
  });
export type PlanResult = z.infer<typeof planResult>;

/** One attempt of a task that several agents try: the agent, and optionally the provider and model it uses. */
export const taskAttemptInput = z.object({ agentId: z.string().trim().min(1).max(64), providerId: z.string().trim().min(1).max(64).optional(), modelId: z.string().trim().min(1).max(200).optional() });
export const createTaskRequest = z.object({
  projectId: id,
  /** `review`: the agent reviews the changes between `review.base` and `review.head` and changes nothing. */
  kind: z.enum(TASK_KINDS).optional(),
  review: reviewRequest.optional(),
  title: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(100_000),
  /** Task-specific knowledge for the agent, next to organization and project knowledge (spec §77). */
  knowledge: z.string().max(50_000).optional(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  dependencies: z.array(id).max(100).default([]),
  requirements: taskRequirements.default({}),
  policy: policyLayerSchema.optional(),
  environment: z.string().optional(),
  capabilityIds: z.array(z.string()).default([]),
  requirePlanApproval: z.boolean().optional(),
  /**
   * Run the task as several attempts, each pinned to one agent (and optionally a model). The first
   * attempt that passes verification wins; the others are cancelled. Code tasks only. The response is
   * the first attempt; `attempt.groupId` finds the others.
   */
  attempts: z.array(taskAttemptInput).min(2).max(4).optional(),
  /**
   * Follow up on a finished task of the same project: work on its branch, and add to its pull request
   * instead of opening another one.
   */
  continuesTaskId: id.optional(),
  /** Client-supplied idempotency key (spec §105). Same key + same org → same task. */
  idempotencyKey: z.string().min(8).max(100).optional(),
});
export type CreateTaskRequest = z.input<typeof createTaskRequest>;

export const TASK_ACTIONS = ['pause', 'resume', 'cancel', 'retry', 'restart', 'input', 'approve', 'deny'] as const;
export const taskActionRequest = z.object({
  action: z.enum(TASK_ACTIONS),
  input: z.string().max(20_000).optional(),
  reason: z.string().max(2000).optional(),
});
export type TaskActionRequest = z.infer<typeof taskActionRequest>;

export const checkpointDto = z.object({
  taskId: z.string(),
  phase: z.string(),
  completedSteps: z.array(z.string()),
  remainingSteps: z.array(z.string()),
  changedFiles: z.array(z.string()),
  testsRun: z.array(z.object({ name: z.string(), passed: z.boolean(), summary: z.string().optional() })),
  knownIssues: z.array(z.string()),
  nextAction: z.string(),
  createdAt: z.string(),
  sessionId: z.string().optional(),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  reason: z.enum(['periodic', 'limit', 'context', 'crash', 'fallback', 'pause', 'verification', 'manual']).optional(),
});

export const verificationStepResult = z.object({
  kind: z.string(),
  name: z.string(),
  command: z.string().optional(),
  required: z.boolean(),
  status: z.enum(['passed', 'failed', 'skipped', 'error']),
  exitCode: z.number().nullable().optional(),
  durationMs: z.number(),
  outputTail: z.string().optional(),
  artifacts: z.array(z.object({ name: z.string(), key: z.string(), contentType: z.string() })).default([]),
});
export type VerificationStepResult = z.infer<typeof verificationStepResult>;
export const verificationRunDto = z.object({
  attempt: z.number(),
  status: z.enum(['passed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string(),
  steps: z.array(verificationStepResult),
});
export type VerificationRunDto = z.infer<typeof verificationRunDto>;

export const gitResultDto = z.object({
  policy: z.string(),
  branch: z.string().nullable(),
  baseBranch: z.string().nullable().optional(),
  commit: z.string().nullable(),
  pushed: z.boolean(),
  pullRequestUrl: z.string().nullable().optional(),
  filesChanged: z.array(z.object({ path: z.string(), status: z.string() })),
  diffStat: z.string().optional(),
  blocked: z.array(z.string()).default([]),
  warnings: z.array(z.string()).optional(),
  /** CI checks of the pushed commit, when the policy waits for them (`verification.ci`). */
  ci: z.object({ commit: z.string(), state: z.enum(['success', 'failure', 'pending', 'none', 'unknown']), checks: z.array(z.object({ name: z.string(), state: z.string(), url: z.string().nullable() })) }).optional(),
  /**
   * Projects with several repositories: the result in each of the other repositories (the fields above
   * are the primary repository's, except filesChanged and blocked, which cover all, prefixed "<name>/").
   */
  repositories: z
    .array(z.object({ name: z.string(), branch: z.string().nullable(), commit: z.string().nullable(), pushed: z.boolean(), pullRequestUrl: z.string().nullable().optional(), filesChanged: z.array(z.object({ path: z.string(), status: z.string() })), blocked: z.array(z.string()).default([]) }))
    .optional(),
});
export type GitResultDto = z.infer<typeof gitResultDto>;

export const completionReportDto = z.object({
  summary: z.string(),
  requirements: z.array(z.object({ text: z.string(), status: z.enum(['done', 'partial', 'not_done', 'unknown']) })),
  implementation: z.string(),
  filesChanged: z.array(z.string()),
  testsExecuted: z.array(z.string()),
  verification: z.string(),
  git: gitResultDto.nullable(),
  knownLimitations: z.array(z.string()),
  remainingWork: z.array(z.string()),
  warnings: z.array(z.string()),
  agentId: z.string().nullable(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  durationMs: z.number(),
  recoveryEvents: z.array(z.string()),
  /** Verbatim report written by the agent, if any. Stored separately from verified facts above. */
  agentReport: z.string().optional(),
  /** Review tasks: the validated review. */
  review: reviewResult.optional(),
  /** Plan tasks: the proposed tasks (created when someone applies the plan). */
  plan: planResult.optional(),
});
export type CompletionReportDto = z.infer<typeof completionReportDto>;

export const pendingInteraction = z.object({
  kind: z.enum(['input', 'approval']),
  question: z.string(),
  requestedAt: z.string(),
  options: z.array(z.string()).optional(),
});

export const taskDto = z.object({
  id,
  organizationId: id,
  projectId: id,
  title: z.string(),
  originalPrompt: z.string(),
  knowledge: z.string().optional(),
  kind: z.enum(TASK_KINDS).optional(),
  review: reviewRequest.nullable().optional(),
  parentTaskId: z.string().nullable().optional(),
  /** Plan tasks: the tasks created from the plan, once applied. */
  planApplied: z.object({ at: z.string(), by: z.string(), taskIds: z.array(z.string()) }).nullable().optional(),
  /** Where a task came from when not created by a person: an integration delivery, or a schedule (`kind: "schedule"`). */
  source: z.object({ integrationId: z.string().optional(), scheduleId: z.string().optional(), /** The item's id in the other system, when replies need one (Linear). */ externalId: z.string().optional(), kind: z.string(), name: z.string(), url: z.string().nullable(), ref: z.string().nullable(), refType: z.enum(['issue', 'pr']).optional() }).nullable().optional(),
  normalizedPrompt: z.string().nullable(),
  generatedPlan: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  status: z.enum(TASK_STATUSES),
  statusReason: z.string().nullable(),
  /** Why the task last stopped (failed or needed recovery); kept after a retry. */
  failureCategory: z.string().nullable().optional(),
  workerId: z.string().nullable(),
  agentId: z.string().nullable(),
  providerId: z.string().nullable(),
  modelId: z.string().nullable(),
  sessionId: z.string().nullable(),
  dependencies: z.array(z.string()),
  requirements: taskRequirements,
  policy: policyLayerSchema.optional(),
  capabilityIds: z.array(z.string()),
  environment: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  retryCount: z.number(),
  restartCount: z.number(),
  limitHitCount: z.number(),
  contextResetCount: z.number(),
  remediationCount: z.number(),
  fallbackStep: z.number(),
  leaseExpiresAt: z.string().nullable(),
  waitingUntil: z.string().nullable(),
  lastCheckpoint: checkpointDto.nullable(),
  progress: z.object({ percent: z.number().nullable(), currentStep: z.string().nullable(), message: z.string().nullable() }),
  verificationStatus: z.enum(['NOT_RUN', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED']),
  verificationRuns: z.array(verificationRunDto),
  gitStatus: z.enum(['NONE', 'PENDING', 'COMMITTED', 'PUSHED', 'PR_OPENED', 'BLOCKED', 'FAILED']),
  gitResult: gitResultDto.nullable(),
  completionReport: completionReportDto.nullable(),
  pendingInteraction: pendingInteraction.nullable(),
  correlationId: z.string(),
  activeMs: z.number(),
  /** A follow-up: the task whose branch (and pull request) this one continues. */
  continues: z.object({ taskId: z.string(), branch: z.string(), pullRequestUrl: z.string().nullable() }).nullable().optional(),
  /** Set on the attempts of a task that several agents try: its group, its place in it, and the attempt that won. */
  attempt: z.object({ groupId: z.string(), index: z.number(), of: z.number(), agentId: z.string(), winnerTaskId: z.string().nullable() }).nullable().optional(),
  /** Spend of the task's agent sessions so far, as agents and providers report it. */
  usage: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number() }).optional(),
});
export type TaskDto = z.infer<typeof taskDto>;

// ── Scheduled tasks ───────────────────────────────────────────────────────────
/** The task a schedule creates on each run. `{date}` in the title and prompt becomes the run's date (YYYY-MM-DD). */
export const scheduledTaskInput = createTaskRequest.omit({ projectId: true, dependencies: true, idempotencyKey: true });
export const SCHEDULE_OVERLAP = ['skip', 'allow'] as const;
export const createScheduleRequest = z.object({
  name: z.string().trim().min(1).max(100),
  projectId: id,
  /** Five fields: minute hour day-of-month month day-of-week; or @hourly, @daily, @weekly, @monthly. */
  cron: z.string().trim().min(1).max(100),
  /** IANA time zone the expression is read in. */
  timeZone: z.string().trim().min(1).max(64).default('UTC'),
  enabled: z.boolean().default(true),
  /** `skip`: no new task while the task of the previous run is unfinished. */
  overlap: z.enum(SCHEDULE_OVERLAP).default('skip'),
  task: scheduledTaskInput,
});
export const updateScheduleRequest = createScheduleRequest.partial();
export const scheduleDto = z.object({
  id,
  organizationId: id,
  projectId: id,
  name: z.string(),
  cron: z.string(),
  timeZone: z.string(),
  enabled: z.boolean(),
  overlap: z.enum(SCHEDULE_OVERLAP),
  task: scheduledTaskInput,
  createdBy: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastTaskId: z.string().nullable(),
  /** `created`, `skipped: …` or `failed: …`. */
  lastResult: z.string().nullable(),
  runCount: z.number(),
  createdAt: z.string(),
});
export type ScheduleDto = z.infer<typeof scheduleDto>;

// ── Task templates ────────────────────────────────────────────────────────────
/** A variable of a template: `{{name}}` in its title, prompt or background. */
export const templateVariable = z.object({
  name: z.string().regex(/^[A-Za-z][\w-]{0,39}$/, 'Use letters, digits, "_" and "-", starting with a letter'),
  label: z.string().trim().max(100).default(''),
  default: z.string().max(2000).default(''),
  required: z.boolean().default(true),
});
export const createTaskTemplateRequest = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
  /** Offer the template for this project only; null: every project. */
  projectId: id.nullable().default(null),
  /** The task it creates; title, prompt and background may contain `{{variable}}`. */
  task: scheduledTaskInput,
  /** Labels, defaults and whether a value is needed. Variables used in the text but not listed are required. */
  variables: z.array(templateVariable).max(30).default([]),
});
export const updateTaskTemplateRequest = createTaskTemplateRequest.partial();
export const taskTemplateDto = z.object({
  id,
  organizationId: id,
  name: z.string(),
  description: z.string(),
  projectId: z.string().nullable(),
  task: scheduledTaskInput,
  /** Every variable the text uses, with the stored label, default and required flag. */
  variables: z.array(templateVariable),
  createdBy: z.string(),
  useCount: z.number(),
  createdAt: z.string(),
});
export type TaskTemplateDto = z.infer<typeof taskTemplateDto>;
export const useTaskTemplateRequest = z.object({
  projectId: id,
  values: z.record(z.string().max(40), z.string().max(20_000)).default({}),
  dependencies: z.array(id).max(100).default([]),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

// ── Analytics ─────────────────────────────────────────────────────────────────
/** Outcome figures of the tasks that finished (completed or failed) in a period. */
const analyticsFigures = z.object({
  finished: z.number(),
  completed: z.number(),
  failed: z.number(),
  /** Completed / finished, 0–1; null when nothing finished. */
  successRate: z.number().nullable(),
  /** Completed tasks whose first verification passed (no remediation) / completed, 0–1. */
  firstPassRate: z.number().nullable(),
  avgRemediations: z.number(),
  costUsd: z.number(),
  costPerCompletedUsd: z.number().nullable(),
  /** Average agent and verification time of completed tasks. */
  avgActiveMs: z.number().nullable(),
  /** Average time from creation to completion of completed tasks. */
  avgLeadMs: z.number().nullable(),
});
export const analyticsQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), projectId: z.string().optional() });
/** `format=csv&table=<name>` returns one table of the view as a CSV file. */
export const analyticsExportQuery = analyticsQuery.extend({ format: z.enum(['json', 'csv']).default('json'), table: z.string().max(40).optional() });
export const analyticsDto = z.object({
  since: z.string(),
  days: z.number(),
  totals: analyticsFigures.extend({ created: z.number() }),
  /** The same figures for the period of the same length just before this one. */
  previous: analyticsFigures.extend({ created: z.number() }),
  /** One entry per UTC day of the period, oldest first. */
  daily: z.array(z.object({ date: z.string(), completed: z.number(), failed: z.number(), costUsd: z.number() })),
  /** By the agent, provider and model a task finished on. */
  byAgent: z.array(analyticsFigures.extend({ agentId: z.string() })),
  byModel: z.array(analyticsFigures.extend({ providerId: z.string(), modelId: z.string() })),
  byProject: z.array(analyticsFigures.extend({ projectId: z.string(), name: z.string() })),
});
export type AnalyticsDto = z.infer<typeof analyticsDto>;

/** Spend of agent sessions, as agents and providers reported it. */
const spendFigures = z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), sessions: z.number() });
const budgetForecastLine = z.object({
  scope: z.enum(['organization', 'project']),
  projectId: z.string().nullable(),
  name: z.string(),
  limitUsd: z.number().nullable(),
  spentUsd: z.number(),
  /** Spend at the end of the month if the rest of it goes like the days so far. */
  forecastUsd: z.number(),
  state: z.enum(['ok', 'warning', 'exceeded']),
  /** The forecast is above the limit. */
  forecastExceeds: z.boolean(),
});
/** Spend in the period, by the day the agent session ended, and this month's budgets. */
export const analyticsCostDto = z.object({
  since: z.string(),
  days: z.number(),
  totals: spendFigures,
  previous: spendFigures,
  daily: z.array(z.object({ date: z.string(), costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
  byProject: z.array(spendFigures.extend({ projectId: z.string(), name: z.string() })),
  byModel: z.array(spendFigures.extend({ providerId: z.string(), modelId: z.string() })),
  byAgent: z.array(spendFigures.extend({ agentId: z.string() })),
  /** Usage events: `execution` (an agent session ended), `limit` (a provider limit was hit), `fallback` (a switch to another agent or model). */
  byKind: z.array(z.object({ kind: z.string(), count: z.number(), costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), durationMs: z.number() })),
  topTasks: z.array(z.object({ taskId: z.string(), title: z.string(), projectId: z.string(), status: z.string(), costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number() })),
  /** The current calendar month (UTC), whatever the period. */
  budgets: z.array(budgetForecastLine),
});
export type AnalyticsCostDto = z.infer<typeof analyticsCostDto>;

export const analyticsWorkersDto = z.object({
  since: z.string(),
  days: z.number(),
  workers: z.array(
    z.object({
      workerId: z.string(),
      name: z.string(),
      status: z.string(),
      os: z.string(),
      finished: z.number(),
      completed: z.number(),
      failed: z.number(),
      successRate: z.number().nullable(),
      firstPassRate: z.number().nullable(),
      avgActiveMs: z.number().nullable(),
      costUsd: z.number(),
      sessions: z.number(),
      /** Time agents ran on the worker. */
      sessionMs: z.number(),
      /** Time online in the period; null when no heartbeat was counted (before the upgrade that added it). */
      onlineMs: z.number().nullable(),
      /** Online time / period, 0–1. */
      onlineShare: z.number().nullable(),
      /** Agent time / (online time × tasks the worker runs at once), 0–1. */
      utilization: z.number().nullable(),
      /** Tasks that stopped (failed or need recovery) on this worker. */
      stops: z.number(),
      /** Of those, stopped because the worker was lost. */
      workerLost: z.number(),
    }),
  ),
});
export type AnalyticsWorkersDto = z.infer<typeof analyticsWorkersDto>;

const recoveryCounters = z.object({ limitHits: z.number(), fallbacks: z.number(), contextResets: z.number(), restarts: z.number(), remediations: z.number() });
/**
 * What went wrong. Stops are tasks that failed or need recovery, by the day they stopped; they are counted
 * since the release that added the category. The counters are of the tasks that finished in the period.
 */
export const analyticsReliabilityDto = z.object({
  since: z.string(),
  days: z.number(),
  totals: recoveryCounters.extend({ finished: z.number(), stops: z.number(), previousStops: z.number(), stillStopped: z.number(), recovered: z.number() }),
  daily: z.array(z.object({ date: z.string(), stops: z.number() })),
  /** `recovered`: retried and completed since; `stillStopped`: failed or waiting for recovery now. */
  byCategory: z.array(z.object({ category: z.string(), stops: z.number(), stillStopped: z.number(), recovered: z.number() })),
  byAgent: z.array(recoveryCounters.extend({ agentId: z.string(), finished: z.number() })),
  /** Verification steps of the tasks that finished or stopped in the period, every run counted. */
  verificationSteps: z.array(z.object({ name: z.string(), kind: z.string(), runs: z.number(), failed: z.number(), failureRate: z.number().nullable(), avgDurationMs: z.number().nullable() })),
});
export type AnalyticsReliabilityDto = z.infer<typeof analyticsReliabilityDto>;

const durationStats = z.object({ avgMs: z.number().nullable(), p50Ms: z.number().nullable(), p90Ms: z.number().nullable() });
/** How long completed tasks took, and where finished tasks came from. */
export const analyticsFlowDto = z.object({
  since: z.string(),
  days: z.number(),
  /** Completed tasks the times are of; `capped` when only the most recent ones were used. */
  samples: z.number(),
  capped: z.boolean(),
  times: z.object({
    /** Creation to the first agent start. */
    startWait: durationStats,
    /** Agent and verification time. */
    active: durationStats,
    /** Creation to completion. */
    lead: durationStats,
  }),
  byCreator: z.array(analyticsFigures.extend({ userId: z.string(), name: z.string() })),
  /** `manual`, `schedule`, or the kind of the integration that created the task. */
  bySource: z.array(analyticsFigures.extend({ source: z.string() })),
  byKind: z.array(analyticsFigures.extend({ kind: z.string() })),
  byPriority: z.array(analyticsFigures.extend({ priority: z.string() })),
});
export type AnalyticsFlowDto = z.infer<typeof analyticsFlowDto>;

// ── Weekly digest ─────────────────────────────────────────────────────────────
/** A weekly summary of the analytics, sent by email and to chat channels. Times are UTC. */
export const digestSettingsRequest = z.object({
  enabled: z.boolean(),
  /** 0 (Sunday) to 6 (Saturday). */
  weekday: z.number().int().min(0).max(6),
  hourUtc: z.number().int().min(0).max(23),
  emails: z.array(z.string().trim().toLowerCase().email().max(254)).max(20),
  chatChannelIds: z.array(id).max(20),
});
export const digestSettingsDto = digestSettingsRequest.extend({ lastSentAt: z.string().nullable() });
export type DigestSettingsDto = z.infer<typeof digestSettingsDto>;
export const digestPreviewDto = z.object({ subject: z.string(), text: z.string(), sentTo: z.string().nullable() });

// ── Chat channels (Slack, Microsoft Teams) ────────────────────────────────────
export const CHAT_KINDS = ['slack', 'teams'] as const;
/** Notifications a chat channel can receive. */
export const CHAT_EVENTS = [
  'task.approval_required',
  'task.input_required',
  'task.recovery_required',
  'task.failed',
  'task.completed',
  'task.provider_limit',
  'worker.offline',
  'budget.warning',
  'budget.exceeded',
] as const;
export const DEFAULT_CHAT_EVENTS = ['task.approval_required', 'task.input_required', 'task.recovery_required', 'task.failed', 'budget.exceeded'] as const;
export const createChatChannelRequest = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(CHAT_KINDS),
  /** Incoming webhook URL of the Slack app, or of the Teams channel (workflow or connector). */
  webhookUrl: z.string().trim().url().max(2000),
  /** Slack only: the app's signing secret. With it, Approve/Deny buttons and the slash command work. */
  signingSecret: z.string().trim().max(200).optional(),
  events: z.array(z.enum(CHAT_EVENTS)).max(CHAT_EVENTS.length).default([...DEFAULT_CHAT_EVENTS]),
  /** Only tasks of these projects; empty: all projects. */
  projectIds: z.array(id).max(100).default([]),
  enabled: z.boolean().default(true),
});
export const updateChatChannelRequest = createChatChannelRequest.omit({ kind: true }).partial();
export const chatChannelDto = z.object({
  id,
  name: z.string(),
  kind: z.enum(CHAT_KINDS),
  enabled: z.boolean(),
  events: z.array(z.string()),
  projectIds: z.array(z.string()),
  /** Host of the webhook URL; the URL itself is a credential and is never returned. */
  webhookHost: z.string(),
  /** Slack with a signing secret: buttons and commands are accepted at `requestUrl`. */
  interactive: z.boolean(),
  requestUrl: z.string().nullable(),
  lastDeliveryAt: z.string().nullable(),
  lastDeliveryResult: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatChannelDto = z.infer<typeof chatChannelDto>;
/** A member's identity in the organization's chat workspace, so their actions there run with their role. */
export const chatIdentityRequest = z.object({ slackUserId: z.string().trim().regex(/^[UW][A-Z0-9]{5,20}$/, 'A Slack member ID looks like U012AB3CD').nullable() });

// ── Spend budgets ─────────────────────────────────────────────────────────────
const budgetLine = z.object({ limitUsd: z.number().nullable(), spentUsd: z.number(), inputTokens: z.number(), outputTokens: z.number(), state: z.enum(['ok', 'warning', 'exceeded']) });
/** Spend of the current calendar month (UTC) against the limits of the execution policy. */
export const budgetStatusDto = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  warnAt: z.number(),
  organization: budgetLine,
  projects: z.array(budgetLine.extend({ projectId: z.string(), name: z.string() })),
  /** Limits for one task, from the organization's policy (projects and tasks may lower them). */
  task: z.object({ limitUsd: z.number().nullable(), limitTokens: z.number().nullable() }),
});
export type BudgetStatusDto = z.infer<typeof budgetStatusDto>;

export const taskListQuery = cursorQuery.extend({
  projectId: z.string().optional(),
  status: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(',').filter(Boolean) : undefined))
    .pipe(z.array(z.enum(TASK_STATUSES)).optional()),
  workerId: z.string().optional(),
  /** The attempts of one task that several agents try. */
  attemptGroupId: z.string().optional(),
  q: z.string().max(200).optional(),
});

export const taskEventDto = z.object({
  id: z.string(),
  eventId: z.string(),
  taskId: z.string(),
  workerId: z.string().nullable(),
  type: z.enum(TASK_EVENT_TYPES),
  timestamp: z.string(),
  sequence: z.number().nullable(),
  payload: z.record(z.unknown()),
  correlationId: z.string().nullable(),
});
export type TaskEventDto = z.infer<typeof taskEventDto>;

// ── Workers ───────────────────────────────────────────────────────────────────
export const agentInventoryDto = z.object({
  id: z.string(),
  name: z.string(),
  installed: z.boolean(),
  version: z.string().nullable().optional(),
  path: z.string().nullable().optional(),
  authenticated: z.boolean().nullable().optional(),
  supportedProviders: z.array(z.string()),
  capabilities: z.array(z.string()),
  state: z.enum(AGENT_STATES).optional(),
  notes: z.array(z.string()).default([]),
});
export type AgentInventoryDto = z.infer<typeof agentInventoryDto>;

export const modelInfoDto = z.object({
  id: z.string(),
  name: z.string().optional(),
  contextWindow: z.number().optional(),
  costTier: z.enum(['low', 'medium', 'high']).optional(),
  speedTier: z.enum(['fast', 'medium', 'slow']).optional(),
  qualityTier: z.enum(['high', 'medium', 'low']).optional(),
});
export const providerInventoryDto = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  healthy: z.boolean(),
  lastCheckedAt: z.string().nullable().optional(),
  limited: z.boolean().default(false),
  limitedUntil: z.string().nullable().optional(),
  models: z.array(modelInfoDto),
  capabilities: z.object({ listModels: z.boolean(), usage: z.boolean(), limits: z.boolean(), health: z.boolean() }).partial().default({}),
  credentialMasked: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});
export type ProviderInventoryDto = z.infer<typeof providerInventoryDto>;

export const systemMetricsDto = z.object({
  cpuCount: z.number(),
  cpuLoadPercent: z.number().nullable(),
  totalMemoryMb: z.number(),
  freeMemoryMb: z.number(),
  freeDiskMb: z.number().nullable(),
  totalDiskMb: z.number().nullable(),
  uptimeSec: z.number(),
});
export type SystemMetricsDto = z.infer<typeof systemMetricsDto>;

export const workerDto = z.object({
  id,
  organizationId: id,
  name: z.string(),
  hostname: z.string(),
  os: z.enum(['windows', 'macos', 'linux']),
  arch: z.string(),
  version: z.string(),
  status: z.enum(['PENDING_APPROVAL', 'ONLINE', 'OFFLINE', 'DISABLED']),
  approved: z.boolean(),
  labels: z.array(z.string()),
  maxConcurrentTasks: z.number(),
  lastHeartbeatAt: z.string().nullable(),
  latencyMs: z.number().nullable(),
  metrics: systemMetricsDto.partial().nullable(),
  agents: z.array(agentInventoryDto),
  providers: z.array(providerInventoryDto),
  tools: z.array(z.string()),
  activeTaskIds: z.array(z.string()),
  createdAt: z.string(),
});
export type WorkerDto = z.infer<typeof workerDto>;
export const updateWorkerRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  labels: z.array(z.string().max(64)).max(50).optional(),
  maxConcurrentTasks: z.number().int().min(1).max(64).optional(),
  status: z.enum(['DISABLED', 'OFFLINE']).optional(),
});
export const approvePairingRequest = z.object({ userCode: z.string().trim().toUpperCase().regex(/^[A-Z]{4}-\d{4}$/), organizationId: id, name: z.string().max(120).optional() });
export const setProjectPathRequest = z.object({ projectId: id, localPath: z.string().min(1).max(1000) });

// ── Capabilities ──────────────────────────────────────────────────────────────
export const packageListingInput = z.object({
  readme: z.string().max(100_000).nullable().optional(),
  /** Up to three categories from the taxonomy; the classifier treats them as a strong hint. */
  categories: z.array(z.enum(CATEGORY_SLUGS)).max(3).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  repository: z.string().url().max(500).nullable().optional(),
});
export const registerCapabilityRequest = z.object({
  manifest: capabilityManifestSchema,
  /** Legacy flag: false makes an organization package visible to the organization (the default anyway). */
  private: z.boolean().default(true),
  /** Who owns the package: the organization (needs capability.manage) or the signed-in person. */
  owner: z.enum(['organization', 'user']).default('organization'),
  /** Before review: PRIVATE (owner only) or ORGANIZATION. Wider visibility comes from publishing. */
  visibility: z.enum(['PRIVATE', 'ORGANIZATION']).optional(),
  listing: packageListingInput.optional(),
});
export const installCapabilityRequest = z.object({
  /** "@namespace/name", or a bare name (the organization's own package first, then the platform's). */
  capabilityId: z.string(),
  version: z.string().optional(),
  /** Range for later upgrades; defaults to "^<installed version>". */
  versionRange: z.string().max(40).optional(),
  scope: z.enum(CAPABILITY_SCOPES).exclude(['PLATFORM']),
  projectId: z.string().optional(),
  taskId: z.string().optional(),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()).default({}),
});
export const catalogQuery = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['skill', 'mcp', 'plugin', 'integration']).optional(),
  category: z.string().max(40).optional(),
  technology: z.string().max(40).optional(),
  /** curated: curated packages only. all: everything visible, curated first. */
  tier: z.enum(['curated', 'all']).default('all'),
  /** Include the caller's own and their organization's private packages (dashboard only). */
  mine: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).max(200).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(24),
});
export const publishPackageRequest = z.object({
  /** false: UNLISTED (installable by reference, not shown in the marketplace). */
  listed: z.boolean().default(true),
});
export const reviewPackageRequest = z.object({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().max(4000).default(''),
  trust: z.enum(['OFFICIAL', 'VERIFIED', 'COMMUNITY']).optional(),
});
export const curatePackageRequest = z.object({ curated: z.boolean(), rank: z.number().int().min(0).max(100_000).nullable().optional() });
export const versionStatusRequest = z.object({ status: z.enum(['ACTIVE', 'DEPRECATED', 'YANKED']), message: z.string().max(500).optional() });
export const importRegistryRequest = z.object({
  url: z.string().url().default('https://registry.modelcontextprotocol.io/v0/servers'),
  maxPages: z.number().int().min(1).max(1000).default(10),
  cursor: z.string().max(500).optional(),
});
export const packageDto = z.object({
  id,
  ref: z.string(),
  namespace: z.string(),
  name: z.string(),
  type: z.string(),
  displayName: z.string(),
  description: z.string(),
  readme: z.string().nullable(),
  categories: z.array(z.string()),
  technologies: z.array(z.string()),
  tags: z.array(z.string()),
  homepage: z.string().nullable(),
  repository: z.string().nullable(),
  publisherName: z.string(),
  publisherVerified: z.boolean(),
  ownerKind: z.string(),
  visibility: z.string(),
  source: z.string(),
  latestVersion: z.string(),
  trust: z.string(),
  permissions: z.array(z.string()),
  compatibleAgents: z.array(z.string()),
  curated: z.boolean(),
  curatedRank: z.number().nullable(),
  installs: z.number(),
  deprecated: z.string().nullable(),
  indexable: z.boolean(),
  review: z.object({ status: z.string(), listed: z.boolean(), notes: z.string(), findings: z.array(z.object({ level: z.string(), code: z.string(), message: z.string() })) }).optional(),
  lastPublishedAt: z.string(),
  createdAt: z.string(),
});
export type PackageDto = z.infer<typeof packageDto>;
export const catalogPageDto = z.object({
  items: z.array(packageDto),
  page: z.number(),
  limit: z.number(),
  hasMore: z.boolean(),
  /** Curated matches for the query; the dashboard falls back to all results when this is 0. */
  curatedCount: z.number(),
});
// Stacks: packages that belong together (a framework's skills and MCP servers), installed in one step.
export const stackItemInput = z.object({
  ref: z.string().regex(/^@[a-z0-9][a-z0-9-]{1,38}\/[a-z0-9][a-z0-9._-]{1,63}$/, 'Use a package reference like @namespace/name'),
  versionRange: z.string().max(40).optional(),
  /** Why the package is in the stack. */
  note: z.string().trim().max(200).default(''),
});
export const createStackRequest = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/, 'Use lower-case letters, digits and dashes'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
  readme: z.string().max(20_000).optional(),
  items: z.array(stackItemInput).min(1).max(30),
});
export const updateStackRequest = createStackRequest.omit({ slug: true }).partial();
export const stackDto = z.object({
  id,
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  readme: z.string().nullable(),
  /** `platform`: offered to everyone. `organization`: the organization's own. */
  ownerKind: z.enum(['platform', 'organization']),
  /** `package` is null when the viewer cannot see it (withdrawn, or private to someone else). */
  items: z.array(z.object({ ref: z.string(), versionRange: z.string().nullable(), note: z.string(), package: packageDto.nullable() })),
  /** From the stack's packages. */
  categories: z.array(z.string()),
  technologies: z.array(z.string()),
  installs: z.number(),
  createdAt: z.string(),
});
export type StackDto = z.infer<typeof stackDto>;
export const installStackRequest = z.object({ scope: z.enum(['ORGANIZATION', 'PROJECT', 'USER']).default('ORGANIZATION'), projectId: z.string().optional() });
export const installStackResponse = z.object({ results: z.array(z.object({ ref: z.string(), status: z.enum(['installed', 'pending_approval', 'failed']), version: z.string().nullable(), reason: z.string().nullable() })) });
export type InstallStackResponse = z.infer<typeof installStackResponse>;

export const facetsQuery = z.object({ type: z.enum(['skill', 'mcp', 'plugin', 'integration']).optional() });
const facetDto = z.object({ slug: z.string(), label: z.string(), description: z.string().optional(), count: z.number() });
export const facetsDto = z.object({ categories: z.array(facetDto), technologies: z.array(facetDto) });
export const suggestRequest = z.object({
  /** A prompt, task description or project description. */
  text: z.string().max(20_000).default(''),
  /** Adds the project's name, description, knowledge and detected stack. */
  projectId: z.string().optional(),
  /** Adds the task's title and prompt (and its project). */
  taskId: z.string().optional(),
  type: z.enum(['skill', 'mcp', 'plugin', 'integration']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const publicSuggestQuery = z.object({
  q: z.string().trim().min(1).max(2000),
  type: z.enum(['skill', 'mcp', 'plugin', 'integration']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export const suggestionDto = z.object({
  package: packageDto,
  score: z.number(),
  reasons: z.array(z.string()),
  /** Already installed for the task, project, person or organization. */
  installed: z.boolean(),
});
export const suggestionsDto = z.object({
  items: z.array(suggestionDto),
  /** What the text was understood to be about. */
  signals: z.object({ technologies: z.array(z.string()), categories: z.array(z.string()) }),
});
export const categoryOverrideRequest = z.object({ categories: z.array(z.enum(CATEGORY_SLUGS)).min(1).max(3).nullable() });
export const capabilityDto = z.object({
  id,
  capabilityId: z.string(),
  status: z.string(),
  organizationId: z.string().nullable(),
  version: z.string(),
  type: z.string(),
  name: z.string(),
  description: z.string(),
  publisher: z.string(),
  trust: z.string(),
  permissions: z.array(z.string()),
  private: z.boolean(),
  manifest: z.record(z.unknown()),
  createdAt: z.string(),
});
export const capabilityInstallationDto = z.object({
  id,
  capabilityId: z.string(),
  version: z.string(),
  versionRange: z.string(),
  scope: z.enum(CAPABILITY_SCOPES),
  projectId: z.string().nullable(),
  userId: z.string().nullable(),
  taskId: z.string().nullable(),
  enabled: z.boolean(),
  status: z.enum(['ACTIVE', 'PENDING_APPROVAL', 'BLOCKED', 'DISABLED']),
  approvalReasons: z.array(z.string()),
  config: z.record(z.unknown()),
  createdAt: z.string(),
});

// ── Providers (org-level configuration; credentials live on workers) ──────────
export const providerConfigDto = z.object({
  id,
  organizationId: id,
  providerId: z.string(),
  kind: z.string(),
  name: z.string(),
  baseUrl: z.string().nullable(),
  enabled: z.boolean(),
  models: z.array(modelInfoDto),
  createdAt: z.string(),
});

// ── Audit / notifications ─────────────────────────────────────────────────────
export const auditEntryDto = z.object({
  id,
  organizationId: z.string().nullable(),
  actorType: z.enum(['user', 'worker', 'system']),
  actorId: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  metadata: z.record(z.unknown()),
  ip: z.string().nullable(),
  createdAt: z.string(),
});
export const notificationDto = z.object({
  id,
  type: z.string(),
  title: z.string(),
  body: z.string(),
  taskId: z.string().nullable(),
  workerId: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});
export type NotificationDto = z.infer<typeof notificationDto>;

// ── Dashboard ─────────────────────────────────────────────────────────────────
export const overviewDto = z.object({
  activeTasks: z.number(),
  waitingTasks: z.number(),
  completedToday: z.number(),
  failedTasks: z.number(),
  recoveryRequired: z.number(),
  verificationFailures: z.number(),
  workersOnline: z.number(),
  workersOffline: z.number(),
  pendingApprovals: z.number(),
  providerHealth: z.array(z.object({ providerId: z.string(), healthy: z.number(), unhealthy: z.number(), limited: z.number() })),
  needsAttention: z.array(z.object({ taskId: z.string(), title: z.string(), status: z.enum(TASK_STATUSES), reason: z.string().nullable() })),
});
export type OverviewDto = z.infer<typeof overviewDto>;

// ── Live stream (browser ⇄ API WebSocket) ─────────────────────────────────────
export const liveMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.updated'), task: taskDto }),
  z.object({ type: z.literal('task.event'), event: taskEventDto }),
  z.object({ type: z.literal('worker.updated'), worker: workerDto }),
  z.object({ type: z.literal('notification'), notification: notificationDto }),
]);
export type LiveMessage = z.infer<typeof liveMessage>;

// ── Device sign-in (CLI, mobile) ──────────────────────────────────────────────
export const deviceLoginStartRequest = z.object({ clientName: z.string().trim().min(1).max(100) });
export const deviceLoginStartResponse = z.object({ userCode: z.string(), pollSecret: z.string(), verificationUrl: z.string(), expiresAt: z.string(), intervalSec: z.number() });
export const deviceLoginPollRequest = z.object({ pollSecret: z.string().min(20).max(200) });
export const deviceLoginDecision = z.object({ approve: z.boolean() });
export const resetMfaRequest = z.object({ reason: z.string().trim().min(5, 'Say why (at least 5 characters)').max(500) });
export const createApiTokenRequest = z.object({
  name: z.string().trim().min(1).max(100),
  organizationId: id,
  role: z.enum(ROLES).optional(),
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

// ── Integrations (spec §74) ───────────────────────────────────────────────────
export const INTEGRATION_KINDS = ['github', 'gitlab', 'jira', 'linear', 'generic'] as const;
/** linear: the webhook's signing secret comes from Linear, so it is set here instead of generated. */
export const setIntegrationSecretRequest = z.object({ secret: z.string().trim().min(8).max(500) });
export const integrationSettings = z.object({
  /** github/gitlab: issues with this label become tasks (when opened with it, or when it is added). Empty: every new issue. */
  label: z.string().max(100).default(''),
  /** github/gitlab: a comment starting with this creates a task from the rest of the comment. Empty: off. */
  command: z.string().max(40).default('/agent'),
  /** generic: templates filled from the JSON payload with {{path.to.value}}. */
  titleTemplate: z.string().max(500).default('{{title}}'),
  promptTemplate: z.string().max(20_000).default('{{prompt}}'),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  requirePlanApproval: z.boolean().default(false),
  /** github/gitlab: name of an organization secret holding an API token, to comment on the issue when the task is created and when it ends. */
  replyTokenSecret: z.string().max(64).default(''),
  /** github/gitlab: API base URL for GitHub Enterprise or self-managed GitLab. */
  apiBaseUrl: z.string().url().or(z.literal('')).default(''),
  /** generic: the result (task id, status, summary, link) is POSTed here, signed like incoming deliveries. */
  callbackUrl: z.string().url().or(z.literal('')).default(''),
  /** github/gitlab: review pull/merge requests with an agent (FUT-003): when opened, or on every push. */
  reviews: z.enum(['off', 'opened', 'every_push']).default('off'),
  /**
   * github: feedback on a pull request that a task opened becomes a follow-up task on the same branch:
   * for reviews that request changes, or for every review with a text. Comment commands on such a pull
   * request follow up too. Off by default.
   */
  followUps: z.enum(['off', 'changes_requested', 'all_reviews']).default('off'),
});
export type IntegrationSettings = z.infer<typeof integrationSettings>;
export const createIntegrationRequest = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(INTEGRATION_KINDS),
  projectId: id,
  enabled: z.boolean().default(true),
  settings: integrationSettings.default({}),
});
// Settings are merged into the current ones: only the fields sent change (no defaults filled in).
export const updateIntegrationRequest = createIntegrationRequest.omit({ kind: true, settings: true }).partial().extend({ settings: integrationSettings.partial().optional() });

// ── Server administration ─────────────────────────────────────────────────────
export const updateServerSettingsRequest = z.object({ values: z.record(z.string().max(100), z.string().max(4000).nullable()) });
export const setFeatureFlagRequest = z.object({ enabled: z.boolean().nullable() });

// ── GitHub App: repository sync (created and installed from the dashboard) ────────────────────
export const githubInstallationDto = z.object({
  installationId: z.number(),
  accountLogin: z.string(),
  accountType: z.enum(['User', 'Organization']),
  repositorySelection: z.string(),
  suspended: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  repositoryCount: z.number(),
});
export type GithubInstallationDto = z.infer<typeof githubInstallationDto>;
export const githubStatusDto = z.object({
  app: z
    .object({ appId: z.number(), slug: z.string(), name: z.string(), htmlUrl: z.string(), ownerLogin: z.string().nullable(), public: z.boolean(), webhookActive: z.boolean(), createdAt: z.string() })
    .nullable(),
  installations: z.array(githubInstallationDto),
  /** The signed-in member's authorization of the app (needed to create repositories in their personal account). */
  user: z.object({ login: z.string() }).nullable(),
  /** GitHub can only deliver webhooks to a public PUBLIC_URL; otherwise repositories are synced by polling. */
  webhookUrl: z.string(),
  publicUrlIsLocal: z.boolean(),
  githubUrl: z.string(),
});
export type GithubStatusDto = z.infer<typeof githubStatusDto>;
const githubLogin = z.string().trim().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, 'Not a GitHub account name');
export const githubManifestRequest = z.object({
  /** Create the app in this GitHub organization; without it, in the signed-in GitHub user's account. */
  organization: githubLogin.optional(),
  /** Public apps can be installed on other accounts too (each installation must be started from the dashboard). */
  public: z.boolean().default(true),
});
export const githubRedirectResponse = z.object({ url: z.string() });
/** Creating the app is a form POST of the manifest to GitHub, made by the browser. */
export const githubManifestResponse = z.object({ postUrl: z.string(), manifest: z.string() });
export const createGithubRepositoryRequest = z.object({
  /** The account to create it in: an organization the app is installed on, or the member's own login. */
  owner: githubLogin,
  name: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/, 'Use letters, digits, ".", "_" and "-"'),
  private: z.boolean().default(true),
  description: z.string().max(350).default(''),
  /** Add the new repository to this project; without it, a new project is created for it. */
  projectId: id.optional(),
  /** Workers to clone the new repository to (into their projects folder). */
  cloneToWorkerIds: z.array(id).max(50).default([]),
});
export const githubSyncResponse = z.object({ installations: z.number(), repositories: z.number(), projectsCreated: z.number(), errors: z.array(z.string()) });

// ── Repositories found on workers ─────────────────────────────────────────────
/** A repository found on one or more workers that matches no project yet (grouped by identity). */
export const discoveredSuggestionDto = z.object({
  /** Identity (`<host>/<owner>/<name>` or `local:<root commit>`); null for a repository with no remote and no commits. */
  key: z.string().nullable(),
  name: z.string(),
  remotes: z.array(z.object({ name: z.string(), url: z.string() })),
  locations: z.array(z.object({ id, workerId: id, workerName: z.string(), localPath: z.string(), branch: z.string().nullable(), lastSeenAt: z.string() })),
});
export type DiscoveredSuggestionDto = z.infer<typeof discoveredSuggestionDto>;
export const acceptDiscoveredRequest = z.object({
  /** The locations (discovered repository ids) of one repository; every worker listed gets it mapped. */
  ids: z.array(id).min(1).max(100),
  /** Add it to this project; without it, a new project is created, named `name` or after the folder. */
  projectId: id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
});
export const dismissDiscoveredRequest = z.object({ ids: z.array(id).min(1).max(100) });
