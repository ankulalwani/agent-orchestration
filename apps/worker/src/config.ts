import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { policyLayerSchema } from '@ao/core';
import { providerConfigSchema } from '@ao/providers';

/**
 * Worker configuration (spec §11, §13). Stored as JSON in the worker's data directory. It never
 * contains secrets: credentials live in the OS credential store (see credentials.ts).
 */

/**
 * A hosted control plane offered as a one-click choice when pairing, if this build has one: AO_HOSTED_URL, or a
 * HOSTED_URL file in the worker package (written by `scripts/package-worker.mjs --hosted-url <url>`). Without
 * one, the worker pairs only with a server URL the user enters.
 */
export const HOSTED_CONTROL_PLANE_URL: string | null = (() => {
  if (process.env.AO_HOSTED_URL) return process.env.AO_HOSTED_URL;
  try {
    const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    return fs.readFileSync(path.join(packageRoot, 'HOSTED_URL'), 'utf8').trim() || null;
  } catch {
    return null;
  }
})();

export const workerConfigSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().default(os.hostname()),
  /** `hosted` = the build's hosted service (HOSTED_CONTROL_PLANE_URL), `self-hosted` = a server URL the user entered (spec §13). */
  connectionMode: z.enum(['hosted', 'self-hosted']).nullable().default(null),
  controlPlaneUrl: z.string().url().nullable().default(null),
  workerId: z.string().nullable().default(null),
  organizationId: z.string().nullable().default(null),
  localPort: z.number().int().min(1024).max(65535).default(47821),
  /** Bind address for the local UI/API. Loopback only by default (spec §12). */
  localHost: z.string().default('127.0.0.1'),
  labels: z.array(z.string()).default([]),
  maxConcurrentTasks: z.number().int().min(1).max(32).default(2),
  /**
   * Checkouts on this machine: a project's repository and its folder. Without `repositoryId` (mappings
   * made before projects had several repositories) the folder is the project's primary repository.
   */
  projects: z.array(z.object({ projectId: z.string(), repositoryId: z.string().optional(), localPath: z.string(), name: z.string().optional() })).default([]),
  /**
   * Finding Git repositories on this machine. Repositories the control plane knows are mapped
   * automatically; others are suggested in the dashboard. `roots` empty = every fixed drive.
   */
  discovery: z
    .object({
      enabled: z.boolean().default(true),
      roots: z.array(z.string()).default([]),
      /** Folder names or absolute paths never scanned, in addition to the built-in list. */
      exclude: z.array(z.string()).default([]),
      intervalHours: z.number().min(1).max(168).default(6),
      maxDepth: z.number().int().min(1).max(20).default(8),
    })
    .default({}),
  /** Where new repositories are cloned (one folder per repository). Null: cloning to this worker is off. */
  projectsRoot: z.string().nullable().default(null),
  /**
   * Add-on models: the providers below, which any harness can use through the worker's model gateway.
   * Harnesses run on their own login by default; `onHarnessLimit` decides what happens when that login
   * reaches its usage limit and add-on models (or another harness) are available.
   */
  addons: z.object({ onHarnessLimit: z.enum(['ask', 'switch']).default('ask') }).default({}),
  providers: z.array(providerConfigSchema).default([]),
  agents: z
    .record(z.object({ enabled: z.boolean().default(true), settings: z.record(z.unknown()).default({}) }))
    .default({}),
  /** Worker-level policy layer (inserted between project and task layers). */
  policy: policyLayerSchema.default({}),
  enableMockAgent: z.boolean().default(false),
  /**
   * Plugin code (CAP-012) runs on this machine only if the organization has plugin execution turned
   * on and this is true. Plugins run in a restricted Node.js process (see plugins.ts).
   */
  plugins: z.object({ enabled: z.boolean().default(true) }).default({}),
  git: z
    .object({
      authorName: z.string().optional(),
      authorEmail: z.string().optional(),
      /**
       * Accounts for opening pull/merge requests through the REST API (GIT-004), by remote host. The
       * token is in the credential store under `git-hosting:<host>`. Without one, `gh` is used.
       */
      hosting: z.array(z.object({ host: z.string().min(1), kind: z.enum(['github', 'gitlab']), apiBaseUrl: z.string().url() })).default([]),
    })
    .default({}),
  updates: z
    .object({
      policy: z.enum(['manual', 'automatic']).default('manual'),
      channel: z.enum(['stable', 'beta']).default('stable'),
      /** Signed release manifest URL (spec §66). */
      manifestUrl: z.string().url().nullable().default(null),
      /** Trusted Ed25519 public keys (PEM) by key id. Unsigned updates are never accepted. */
      trustedKeys: z.record(z.string()).default({}),
    })
    .default({}),
  /**
   * Error tracking (spec §61), off unless set: a Sentry-compatible DSN and/or a JSON webhook.
   * Environment variables AO_ERROR_TRACKING_DSN / AO_ERROR_TRACKING_WEBHOOK_URL take precedence.
   */
  errorTracking: z
    .object({ dsn: z.string().url().nullable().default(null), webhookUrl: z.string().url().nullable().default(null) })
    .default({}),
  /** Anonymous telemetry to the configured control plane only; never code/prompts/secrets (spec §128). */
  telemetry: z.boolean().default(false),
});
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function defaultDataDir(): string {
  if (process.env.AO_WORKER_HOME) return process.env.AO_WORKER_HOME;
  if (process.platform === 'win32') return path.join(process.env.PROGRAMDATA && process.env.AO_SYSTEM_SERVICE ? process.env.PROGRAMDATA : process.env.APPDATA ?? os.homedir(), 'AgentOrchestration', 'worker');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AgentOrchestration', 'worker');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'agent-orchestration', 'worker');
}

export class ConfigStore {
  readonly file: string;
  private current: WorkerConfig;
  private listeners: Array<(c: WorkerConfig) => void> = [];

  constructor(readonly dataDir = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'config.json');
    this.current = this.load();
  }

  private load(): WorkerConfig {
    if (!fs.existsSync(this.file)) return workerConfigSchema.parse({});
    return workerConfigSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
  }

  get(): WorkerConfig {
    return this.current;
  }

  update(patch: Partial<WorkerConfig> | ((c: WorkerConfig) => WorkerConfig)): WorkerConfig {
    const next = workerConfigSchema.parse(typeof patch === 'function' ? patch(structuredClone(this.current)) : { ...this.current, ...patch });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file); // atomic replace
    this.current = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(fn: (c: WorkerConfig) => void) {
    this.listeners.push(fn);
  }
}
