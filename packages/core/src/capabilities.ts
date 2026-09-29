import { z } from 'zod';
import type { ExecutionPolicy } from './policy.js';

/**
 * Capability platform model (spec §32–§40). Skills, MCP servers, plugins and integrations are
 * distinct types sharing one manifest envelope.
 */

export const CAPABILITY_TYPES = ['skill', 'mcp', 'plugin', 'integration'] as const;
export type CapabilityType = (typeof CAPABILITY_TYPES)[number];

export const CAPABILITY_SCOPES = ['PLATFORM', 'ORGANIZATION', 'PROJECT', 'TASK'] as const;
export type CapabilityScope = (typeof CAPABILITY_SCOPES)[number];

export const TRUST_LEVELS = ['OFFICIAL', 'VERIFIED', 'COMMUNITY', 'UNVERIFIED', 'LOCAL'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** Known permission identifiers (spec §39). Manifests may use namespaced sub-permissions. */
export const KNOWN_PERMISSIONS = [
  'filesystem.read',
  'filesystem.write',
  'filesystem.project.read',
  'filesystem.project.write',
  'network.outbound',
  'git.read',
  'git.write',
  'browser.control',
  'shell',
  'secrets.read',
  'process.execute',
] as const;

export const HIGH_RISK_PERMISSIONS = ['shell', 'secrets.read', 'process.execute', 'filesystem.write', 'browser.control'];

/**
 * Plugin hooks (CAP-012). A plugin is an ES module exporting a function per hook (`prepare`,
 * `verify`, `completed`), run by workers in a restricted Node.js process:
 * - `task.prepare`: before the agent starts; may return `{ instructions }` added to the agent's prompt.
 * - `task.verify`: after the agent finishes, with the other verification checks; may return
 *   `{ checks: [{ name, passed, summary }] }`. A failed check sends the agent back to fix it.
 * - `task.completed`: after the task completed (notifications, bookkeeping); the result is ignored.
 */
export const PLUGIN_HOOKS = ['task.prepare', 'task.verify', 'task.completed'] as const;
export type PluginHook = (typeof PLUGIN_HOOKS)[number];
export const PLUGIN_SOURCE_MAX_BYTES = 512 * 1024;

export const pluginHookResultSchemas = {
  'task.prepare': z.object({ instructions: z.string().max(20_000).optional() }).strict(),
  'task.verify': z.object({ checks: z.array(z.object({ name: z.string().min(1).max(120), passed: z.boolean(), summary: z.string().max(4000).default('') })).max(20).default([]) }).strict(),
  'task.completed': z.unknown(),
} as const;

const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, 'Must be semver (x.y.z)');
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'Lowercase id: a-z, 0-9, . _ -');

export const capabilityManifestSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(120),
    version: semver,
    type: z.enum(CAPABILITY_TYPES),
    description: z.string().max(2000).default(''),
    publisher: z.string().max(120).default('local'),
    trust: z.enum(TRUST_LEVELS).default('LOCAL'),
    homepage: z.string().url().optional(),
    compatibleAgents: z.array(z.string()).default([]), // empty = all
    platforms: z.array(z.enum(['windows', 'macos', 'linux'])).default(['windows', 'macos', 'linux']),
    requires: z.array(z.string()).default([]), // tools, e.g. "node", "python>=3.10"
    dependencies: z.array(z.object({ id: idSchema, version: z.string().default('*') })).default([]),
    recommendedMcp: z.array(z.string()).default([]),
    permissions: z.array(z.string().regex(/^[a-z]+(\.[a-z]+)*$/)).default([]),
    /** Task-analyzer hints: files/keywords that suggest this capability is relevant. */
    triggers: z
      .object({
        files: z.array(z.string()).default([]),
        dependencies: z.array(z.string()).default([]),
        keywords: z.array(z.string()).default([]),
      })
      .default({}),
    configuration: z
      .array(
        z.object({
          key: z.string(),
          description: z.string().default(''),
          required: z.boolean().default(false),
          secret: z.boolean().default(false),
          default: z.union([z.string(), z.number(), z.boolean()]).optional(),
        }),
      )
      .default([]),
    // Type-specific payloads:
    skill: z.object({ instructions: z.string().min(1) }).optional(),
    mcp: z
      .object({
        transport: z.enum(['stdio', 'http', 'sse']),
        command: z.array(z.string()).min(1).optional(),
        url: z.string().url().optional(),
        env: z.record(z.string()).default({}),
      })
      .optional(),
    plugin: z
      .object({
        entry: z.string().default('plugin.mjs'),
        /** Hooks the plugin implements (see PLUGIN_HOOKS). Unknown names are ignored by workers. */
        hooks: z.array(z.string()).default([]),
        /** The plugin's code: one self-contained ES module (bundle dependencies into it). */
        source: z.string().max(PLUGIN_SOURCE_MAX_BYTES).optional(),
        /** SHA-256 of `source`, set by the control plane when the manifest is registered. */
        sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        timeoutMs: z.number().int().min(1000).max(300_000).default(30_000),
        memoryMb: z.number().int().min(32).max(2048).default(256),
      })
      .optional(),
    integration: z.object({ service: z.string(), authType: z.enum(['api_key', 'oauth', 'none']) }).optional(),
    install: z.object({ command: z.array(z.string()).optional() }).optional(),
    uninstall: z.object({ command: z.array(z.string()).optional() }).optional(),
    healthCheck: z.object({ command: z.array(z.string()).min(1), timeoutMs: z.number().int().default(10_000) }).optional(),
  })
  .superRefine((m, ctx) => {
    if (m.type === 'skill' && !m.skill) ctx.addIssue({ code: 'custom', message: 'skill manifests need a "skill.instructions" block' });
    if (m.type === 'mcp') {
      if (!m.mcp) ctx.addIssue({ code: 'custom', message: 'mcp manifests need an "mcp" block' });
      else if (m.mcp.transport === 'stdio' && !m.mcp.command) ctx.addIssue({ code: 'custom', message: 'stdio MCP needs "command"' });
      else if (m.mcp.transport !== 'stdio' && !m.mcp.url) ctx.addIssue({ code: 'custom', message: 'http/sse MCP needs "url"' });
    }
    if (m.type === 'plugin' && !m.plugin) ctx.addIssue({ code: 'custom', message: 'plugin manifests need a "plugin" block' });
    if (m.plugin?.source) {
      const unknown = m.plugin.hooks.filter((h) => !(PLUGIN_HOOKS as readonly string[]).includes(h));
      if (unknown.length) ctx.addIssue({ code: 'custom', message: `Unknown plugin hook(s): ${unknown.join(', ')}. Known: ${PLUGIN_HOOKS.join(', ')}` });
      if (!m.plugin.hooks.length) ctx.addIssue({ code: 'custom', message: 'A plugin with code must list the hooks it implements' });
    }
    if (m.type === 'integration' && !m.integration) ctx.addIssue({ code: 'custom', message: 'integration manifests need an "integration" block' });
  });
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

export interface ScopedCapability {
  manifest: CapabilityManifest;
  scope: CapabilityScope;
  enabled: boolean;
  /** Configuration values (non-secret) and secret references. */
  config?: Record<string, unknown>;
}

const SCOPE_RANK: Record<CapabilityScope, number> = { PLATFORM: 0, ORGANIZATION: 1, PROJECT: 2, TASK: 3 };

/**
 * Effective capabilities = platform + org + project + task, where a more specific scope overrides a
 * broader one for the same id (including disabling it), spec §34.
 */
export function resolveEffectiveCapabilities(items: ScopedCapability[]): ScopedCapability[] {
  const byId = new Map<string, ScopedCapability>();
  for (const item of [...items].sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope])) {
    byId.set(item.manifest.id, item);
  }
  return [...byId.values()].filter((c) => c.enabled);
}

export type PermissionDecision = { decision: 'allow' } | { decision: 'require_approval'; reasons: string[] } | { decision: 'block'; reasons: string[] };

/** Evaluate a manifest against organization policy (spec §38, §39). Never silently grants risky permissions. */
export function evaluateCapabilityPolicy(
  m: Pick<CapabilityManifest, 'trust' | 'permissions' | 'type'>,
  policy: ExecutionPolicy['capabilities'],
): PermissionDecision {
  const blocked = m.permissions.filter((p) => policy.blockedPermissions.some((b) => p === b || p.startsWith(`${b}.`)));
  const reasons: string[] = [];
  if (blocked.length) return { decision: 'block', reasons: blocked.map((p) => `Permission "${p}" is blocked by policy`) };
  if (!policy.allowedTrust.includes(m.trust)) {
    if (policy.installPolicy === 'RESTRICTED') return { decision: 'block', reasons: [`Trust level ${m.trust} is not allowed`] };
    reasons.push(`Trust level ${m.trust} is not pre-approved`);
  }
  for (const p of m.permissions) {
    if (policy.approvalRequiredPermissions.some((a) => p === a || p.startsWith(`${a}.`))) reasons.push(`Requests "${p}"`);
  }
  if (m.type === 'plugin') reasons.push('Plugins run code inside the orchestration platform');
  if (policy.installPolicy === 'ASK') reasons.push('Installation policy is ASK');
  if (policy.installPolicy === 'RESTRICTED' && reasons.length) return { decision: 'block', reasons };
  return reasons.length ? { decision: 'require_approval', reasons } : { decision: 'allow' };
}

/** Parse "node>=18" style requirements. */
export function parseRequirement(req: string): { tool: string; op?: '>=' | '='; version?: string } {
  const m = /^([a-zA-Z0-9:_.-]+?)(?:(>=|=)(\d+(?:\.\d+){0,2}))?$/.exec(req.trim());
  if (!m) return { tool: req.trim() };
  return { tool: m[1]!, op: m[2] as '>=' | '=' | undefined, version: m[3] };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
