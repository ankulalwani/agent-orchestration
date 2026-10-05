import { z } from 'zod';

/**
 * Execution policy (spec §104). Resolved by layering scopes:
 * platform defaults → organization → project → worker → task (spec §9 fallback scoping, §34 inheritance).
 * Later layers override earlier ones; arrays are replaced, objects merged.
 */

export const FALLBACK_STEP_KINDS = ['WAIT', 'FALLBACK_AGENT', 'FALLBACK_PROVIDER', 'FALLBACK_MODEL', 'ASK_USER', 'FAIL'] as const;
export type FallbackStepKind = (typeof FALLBACK_STEP_KINDS)[number];

export const fallbackStepSchema = z.object({
  kind: z.enum(FALLBACK_STEP_KINDS),
  agentId: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  /** WAIT only: maximum time to wait before moving to the next step. */
  maxWaitMs: z.number().int().positive().optional(),
});
export type FallbackStep = z.infer<typeof fallbackStepSchema>;

export const GIT_POLICIES = ['NONE', 'COMMIT', 'COMMIT_AND_PUSH', 'PULL_REQUEST'] as const;
export type GitPolicy = (typeof GIT_POLICIES)[number];

export const CAPABILITY_INSTALL_POLICIES = ['ASK', 'AUTO', 'RESTRICTED'] as const;
export type CapabilityInstallPolicy = (typeof CAPABILITY_INSTALL_POLICIES)[number];

export const VERIFICATION_STEP_KINDS = ['git_status', 'install', 'typecheck', 'lint', 'build', 'test', 'browser', 'smoke', 'custom'] as const;
export type VerificationStepKind = (typeof VERIFICATION_STEP_KINDS)[number];

export const verificationStepSchema = z.object({
  kind: z.enum(VERIFICATION_STEP_KINDS),
  name: z.string().optional(),
  /** Explicit argv; never a shell string. If absent, the step is auto-detected from project files. */
  command: z.array(z.string()).min(1).optional(),
  required: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(10 * 60_000),
  /** browser/smoke: URL to probe after starting the app. */
  url: z.string().url().optional(),
  /**
   * browser/smoke: start the app for this step (argv, run in the project) and stop it afterwards.
   * The step waits until `url` answers, up to `readyTimeoutMs`.
   */
  start: z.object({ command: z.array(z.string()).min(1), readyTimeoutMs: z.number().int().positive().default(120_000), env: z.record(z.string()).default({}) }).optional(),
  /**
   * browser: QA route discovery (spec §76). Besides `url`, visit the app's pages: same-origin links
   * found while crawling and routes from file-based routers (Next.js, SvelteKit, Nuxt, Remix, Astro).
   */
  discover: z
    .object({
      maxPages: z.number().int().min(1).max(200).default(25),
      maxDepth: z.number().int().min(0).max(10).default(3),
      /** Extra paths to always visit, e.g. ["/checkout"]. */
      paths: z.array(z.string().startsWith('/')).default([]),
      /** Path prefixes never visited, e.g. ["/logout", "/admin"]. */
      exclude: z.array(z.string().startsWith('/')).default(['/logout', '/signout', '/sign-out']),
    })
    .optional(),
});
export type VerificationStep = z.infer<typeof verificationStepSchema>;

export const executionPolicySchema = z.object({
  leaseMs: z.number().int().positive(),
  heartbeatMs: z.number().int().positive(),
  offlineThresholdMs: z.number().int().positive(),
  maxRestarts: z.number().int().min(0),
  maxRemediationAttempts: z.number().int().min(0),
  maxContextResets: z.number().int().min(0),
  /** No output + no CPU + no file change for this long ⇒ suspected hang (spec §31). */
  hangTimeoutMs: z.number().int().positive(),
  /** Hard cap on active execution time; excludes WAITING_* time. 0 = unlimited (self-hosted default). */
  maxExecutionMs: z.number().int().min(0),
  onWorkerLost: z.enum(['REQUEUE', 'RECOVERY_REQUIRED']),
  concurrency: z.object({
    perProject: z.number().int().min(1),
    perWorker: z.number().int().min(1),
    perOrganization: z.number().int().min(0), // 0 = unlimited
    perAgent: z.record(z.number().int().min(1)),
    perProvider: z.record(z.number().int().min(1)),
  }),
  agents: z.object({
    preferred: z.array(z.string()),
    allowed: z.array(z.string()).nullable(), // null = any
    blocked: z.array(z.string()),
  }),
  models: z.object({
    preferred: z.array(z.object({ providerId: z.string(), modelId: z.string() })),
    allowedProviders: z.array(z.string()).nullable(),
    blockedProviders: z.array(z.string()),
    maxCostTier: z.enum(['low', 'medium', 'high']).nullable(),
    optimizeFor: z.enum(['quality', 'cost', 'speed']),
  }),
  fallback: z.object({
    chain: z.array(fallbackStepSchema),
    /** Initial poll interval when a limit has no known reset time; grows exponentially with jitter. */
    limitPollBaseMs: z.number().int().positive(),
    limitPollMaxMs: z.number().int().positive(),
  }),
  git: z.object({
    policy: z.enum(GIT_POLICIES),
    branchPrefix: z.string(),
    workOnBranch: z.boolean(),
    allowForcePush: z.literal(false).or(z.boolean()),
  }),
  verification: z.object({
    enabled: z.boolean(),
    steps: z.array(verificationStepSchema),
    autoDetect: z.boolean(),
    /**
     * After the task branch is pushed (Git policy COMMIT_AND_PUSH or PULL_REQUEST), wait for the
     * commit's CI checks on GitHub or GitLab. Failed checks go back to the agent like a failed
     * verification step. Needs a hosting token for the remote on the worker (or the GitHub App).
     */
    ci: z.object({
      enabled: z.boolean(),
      /** How long to wait for the checks to finish. */
      timeoutMs: z.number().int().positive(),
      pollMs: z.number().int().positive(),
      /** How long to wait for the first check to appear before deciding there are none. */
      startGraceMs: z.number().int().min(0),
      /** true: no checks, unreadable checks or a timeout stop the task for a person; false: they are warnings. */
      required: z.boolean(),
    }),
  }),
  capabilities: z.object({
    installPolicy: z.enum(CAPABILITY_INSTALL_POLICIES),
    allowedTrust: z.array(z.enum(['OFFICIAL', 'VERIFIED', 'COMMUNITY', 'UNVERIFIED', 'LOCAL'])),
    approvalRequiredPermissions: z.array(z.string()),
    blockedPermissions: z.array(z.string()),
  }),
  requireApprovalFor: z.object({
    production: z.boolean(),
    push: z.boolean(),
    plan: z.boolean(),
  }),
  /**
   * OS-level sandbox for agent processes (SEC-014): `off`, `preferred` (used where the worker has one)
   * or `required` (the task stops with RECOVERY_REQUIRED on a worker without one).
   */
  sandbox: z.object({
    mode: z.enum(['off', 'preferred', 'required']),
    network: z.boolean(),
    /** Extra paths the agent may write to. */
    writable: z.array(z.string()),
    /** Extra paths the agent may not read (added to ~/.ssh, ~/.gnupg, … and the worker's data folder). */
    hidden: z.array(z.string()),
  }),
  /**
   * Spend limits, in US dollars and tokens as agents and providers report them. `null` = no limit.
   * `task*` limits cover one task over its whole life; the monthly limits cover the calendar month (UTC).
   * A task that reaches a limit stops with RECOVERY_REQUIRED, and queued tasks do not start.
   * The organization limit is read from the platform and organization layers only, the project limit
   * from those and the project layer; a task's own layer can lower the task limits, never raise them.
   */
  budget: z.object({
    taskUsd: z.number().positive().nullable(),
    taskTokens: z.number().int().positive().nullable(),
    projectMonthlyUsd: z.number().positive().nullable(),
    organizationMonthlyUsd: z.number().positive().nullable(),
    /** Administrators are warned once a month when spend passes this share of a monthly limit. */
    warnAt: z.number().min(0).max(1),
  }),
});
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>;

export type DeepPartial<T> = T extends Array<unknown>
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> | null }
    : T;
export type PolicyLayer = DeepPartial<ExecutionPolicy>;

export const DEFAULT_POLICY: ExecutionPolicy = {
  leaseMs: 5 * 60_000,
  heartbeatMs: 15_000,
  offlineThresholdMs: 60_000,
  maxRestarts: 5,
  maxRemediationAttempts: 3,
  maxContextResets: 10,
  hangTimeoutMs: 15 * 60_000,
  maxExecutionMs: 0,
  onWorkerLost: 'REQUEUE',
  concurrency: { perProject: 1, perWorker: 2, perOrganization: 0, perAgent: {}, perProvider: {} },
  agents: { preferred: [], allowed: null, blocked: [] },
  models: { preferred: [], allowedProviders: null, blockedProviders: [], maxCostTier: null, optimizeFor: 'quality' },
  fallback: {
    chain: [{ kind: 'WAIT' }],
    limitPollBaseMs: 60_000,
    limitPollMaxMs: 30 * 60_000,
  },
  git: { policy: 'COMMIT', branchPrefix: 'ao/', workOnBranch: true, allowForcePush: false },
  verification: { enabled: true, steps: [], autoDetect: true, ci: { enabled: false, timeoutMs: 30 * 60_000, pollMs: 30_000, startGraceMs: 2 * 60_000, required: false } },
  sandbox: { mode: 'off', network: true, writable: [], hidden: [] },
  capabilities: {
    installPolicy: 'ASK',
    allowedTrust: ['OFFICIAL', 'VERIFIED', 'LOCAL'],
    approvalRequiredPermissions: ['shell', 'secrets.read', 'browser.control', 'process.execute', 'git.write'],
    blockedPermissions: [],
  },
  requireApprovalFor: { production: true, push: false, plan: false },
  budget: { taskUsd: null, taskTokens: null, projectMonthlyUsd: null, organizationMonthlyUsd: null, warnAt: 0.8 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function mergeInto(base: Record<string, unknown>, layer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    // Records keyed by arbitrary ids (perAgent/perProvider) and nested objects merge; arrays replace.
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? mergeInto(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

/** Resolve an effective policy. Layers are applied in order; `undefined` fields are skipped. */
export function resolvePolicy(...layers: Array<PolicyLayer | object | null | undefined>): ExecutionPolicy {
  let acc: Record<string, unknown> = structuredClone(DEFAULT_POLICY) as unknown as Record<string, unknown>;
  for (const layer of layers) if (layer) acc = mergeInto(acc, layer as Record<string, unknown>);
  const parsed = executionPolicySchema.parse(acc);
  // Force push is never enabled implicitly (spec §42): only an explicit task/project layer may set it.
  return parsed;
}

export const policyLayerSchema = executionPolicySchema.deepPartial();
