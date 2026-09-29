import { capabilityManifestSchema, compareVersions, HIGH_RISK_PERMISSIONS, SCOPE_RANK, type CapabilityManifest, type CapabilityScope, type CapabilityType } from './capabilities.js';
import { classify, extractSignals, packageText, type Signals } from './taxonomy.js';

/**
 * Capability registry and marketplace model. A package is identified by "@namespace/name"; its versions
 * are immutable manifests. Packages start private to their owner (a person or an organization) and
 * reach other organizations only after a review. Curated packages are shown first everywhere.
 */

export const PLATFORM_NAMESPACE = 'platform';
export const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** PRIVATE: the owner only. ORGANIZATION: the owning organization. UNLISTED: anyone with the reference. PUBLIC: listed in the marketplace. */
export const VISIBILITIES = ['PRIVATE', 'ORGANIZATION', 'UNLISTED', 'PUBLIC'] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const REVIEW_STATUSES = ['NONE', 'PENDING', 'APPROVED', 'REJECTED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const VERSION_STATUSES = ['ACTIVE', 'DEPRECATED', 'YANKED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
/** native: uploaded to this registry. federated: metadata mirrored from an upstream registry. */
export const PACKAGE_SOURCES = ['native', 'federated'] as const;
export type PackageSource = (typeof PACKAGE_SOURCES)[number];
export const PUBLISHER_KINDS = ['platform', 'organization', 'user', 'upstream'] as const;
export type PublisherKind = (typeof PUBLISHER_KINDS)[number];

export const TRUST_RANK: Record<string, number> = { OFFICIAL: 4, VERIFIED: 3, COMMUNITY: 2, LOCAL: 1, UNVERIFIED: 0 };

// ── References ────────────────────────────────────────────────────────────────

export function formatRef(namespace: string, name: string): string {
  return `@${namespace}/${name}`;
}

export function isRef(value: string): boolean {
  return value.startsWith('@') && value.includes('/');
}

/** "@acme/react-review" → { namespace: "acme", name: "react-review" }. Bare names have no namespace. */
export function parseRef(value: string): { namespace: string | null; name: string } {
  const m = /^@([a-z0-9][a-z0-9-]{1,38})\/([a-z0-9][a-z0-9._-]{1,63})$/.exec(value);
  if (m) return { namespace: m[1]!, name: m[2]! };
  return { namespace: null, name: value };
}

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Lowercase, dashes only, 2–39 characters: "Acme Inc." → "acme-inc". */
export function slugifyNamespace(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 39)
    .replace(/-+$/, '');
  return s.length >= 2 ? s : `${s || 'ns'}-x`.slice(0, 39);
}

function slugifyName(input: string): string {
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|-+$/g, '')
    .slice(0, 64);
  return s.length >= 2 ? s : `${s || 'x'}-mcp`;
}

// ── Versions ──────────────────────────────────────────────────────────────────

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/**
 * Minimal range support: "*", "1.2.3", "^1.2.3", "~1.2.3", ">=1.2.3". Pre-releases match only an exact range.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = SEMVER.exec(version);
  if (!v) return false;
  const r = range.trim();
  if (r === '*' || r === '' || r === 'latest') return !v[4];
  if (SEMVER.test(r)) return version === r;
  const m = /^(\^|~|>=)(\d+)\.(\d+)\.(\d+)$/.exec(r);
  if (!m || v[4]) return false;
  const [maj, min] = [Number(v[1]), Number(v[2])];
  const [rmaj, rmin] = [Number(m[2]), Number(m[3])];
  const base = `${m[2]}.${m[3]}.${m[4]}`;
  if (compareVersions(version, base) < 0) return false;
  if (m[1] === '>=') return true;
  if (m[1] === '~') return maj === rmaj && min === rmin;
  // Caret: the left-most non-zero part stays fixed.
  if (rmaj > 0) return maj === rmaj;
  if (rmin > 0) return maj === 0 && min === rmin;
  return version === base;
}

/** The highest version that satisfies the range, or null. */
export function latestSatisfying(versions: string[], range = '*'): string | null {
  const ok = versions.filter((v) => satisfiesRange(v, range)).sort(compareVersions);
  return ok.at(-1) ?? null;
}

// ── Automated review ──────────────────────────────────────────────────────────

export interface ReviewFinding {
  /** block: cannot be published. warn: shown to reviewers and installers. */
  level: 'block' | 'warn';
  code: string;
  message: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/AKIA[0-9A-Z]{16}/, 'an AWS access key'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36}\b/, 'a GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?)/i, 'tells the agent to ignore its instructions'],
  [/disregard .{0,30}(?:system|previous|prior) (?:prompt|instructions|rules)/i, 'tells the agent to disregard its instructions'],
  [/(?:send|upload|post|exfiltrate|transmit)\b.{0,60}\b(?:secrets?|tokens?|credentials?|api keys?|\.env|ssh keys?|passwords?)/i, 'asks the agent to send credentials somewhere'],
  [/do not (?:tell|inform|mention|reveal)\b.{0,30}\b(?:the )?(?:user|human|operator)/i, 'asks the agent to hide actions from the user'],
  [/curl\s[^|\n]{0,200}\|\s*(?:ba|z)?sh\b/i, 'pipes a download into a shell'],
  [/base64\s+(?:-d|--decode)\s*\|/i, 'decodes and runs hidden content'],
];

function manifestText(m: CapabilityManifest): string {
  return [m.description, m.skill?.instructions ?? '', ...(m.mcp?.command ?? []), m.mcp?.url ?? '', ...Object.values(m.mcp?.env ?? {}), ...(m.install?.command ?? [])].join('\n');
}

/**
 * Checks run on every publish request before a person reviews it. Pure and deterministic, so the same
 * manifest always gets the same findings. `previous` is the latest earlier version, if any.
 */
export function reviewManifest(m: CapabilityManifest, previous?: CapabilityManifest | null): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  const text = manifestText(m);
  for (const [re, what] of SECRET_PATTERNS) {
    if (re.test(text) || (m.plugin?.source && re.test(m.plugin.source))) out.push({ level: 'block', code: 'SECRET', message: `Contains what looks like ${what}. Use a secret configuration value instead.` });
  }
  for (const [re, what] of INJECTION_PATTERNS) {
    if (re.test(text)) out.push({ level: 'block', code: 'UNSAFE_INSTRUCTIONS', message: `The ${m.type} ${what}.` });
  }
  if (m.type === 'plugin' && !m.plugin?.source) out.push({ level: 'block', code: 'PLUGIN_WITHOUT_CODE', message: 'A published plugin must include its code so it can be reviewed and pinned.' });
  const risky = m.permissions.filter((p) => HIGH_RISK_PERMISSIONS.some((h) => p === h || p.startsWith(`${h}.`)));
  if (risky.length) out.push({ level: 'warn', code: 'HIGH_RISK_PERMISSIONS', message: `Requests high-risk permissions: ${risky.join(', ')}.` });
  if (previous) {
    const added = m.permissions.filter((p) => !previous.permissions.includes(p));
    if (added.length) out.push({ level: 'warn', code: 'PERMISSION_ESCALATION', message: `Adds permissions since ${previous.version}: ${added.join(', ')}. Installations must approve the upgrade.` });
  }
  if (m.description.trim().length < 30) out.push({ level: 'warn', code: 'SHORT_DESCRIPTION', message: 'The description is shorter than 30 characters; people and search engines need more to go on.' });
  return out;
}

/** Permissions a new version adds over an installed one. Non-empty means the upgrade needs approval. */
export function addedPermissions(from: Pick<CapabilityManifest, 'permissions'>, to: Pick<CapabilityManifest, 'permissions'>): string[] {
  return to.permissions.filter((p) => !from.permissions.includes(p));
}

// ── Per-task selection ────────────────────────────────────────────────────────

export interface RelevanceContext {
  /** Task title and description. */
  text: string;
  /** Repository files and dependency names, when known. */
  files?: string[];
  dependencies?: string[];
}

export interface SelectableCapability {
  manifest: CapabilityManifest;
  scope: CapabilityScope | string;
  /** Always delivered (task scope or requested by the task). */
  pinned?: boolean;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 1));

const contextSignals = new WeakMap<RelevanceContext, Signals>();
const manifestTechnologies = new WeakMap<CapabilityManifest, string[]>();

/** Technologies a manifest is about (see @ao/core taxonomy), computed once per manifest object. */
function technologiesOf(m: CapabilityManifest): string[] {
  let t = manifestTechnologies.get(m);
  if (!t) manifestTechnologies.set(m, (t = classify(packageText({ name: m.id, displayName: m.name, description: m.description, manifest: m })).technologies));
  return t;
}

/** How well a capability's triggers and technologies match a task. 0 = no signal. */
export function relevanceScore(m: CapabilityManifest, ctx: RelevanceContext): number {
  const text = ctx.text.toLowerCase();
  const tokens = words(ctx.text);
  let score = 0;
  for (const k of m.triggers.keywords) if (k && (tokens.has(k.toLowerCase()) || text.includes(k.toLowerCase()))) score += 3;
  for (const d of m.triggers.dependencies) if (ctx.dependencies?.includes(d) || tokens.has(d.toLowerCase())) score += 3;
  for (const f of m.triggers.files) {
    const needle = f.replace(/\*+/g, '').replace(/^\.?\//, '').toLowerCase();
    if (needle && ctx.files?.some((x) => x.toLowerCase().includes(needle))) score += 2;
  }
  for (const w of words(`${m.id} ${m.name}`)) if (tokens.has(w)) score += 1;
  let signals = contextSignals.get(ctx);
  if (!signals) contextSignals.set(ctx, (signals = extractSignals({ text: ctx.text, files: ctx.files, dependencies: ctx.dependencies })));
  for (const t of technologiesOf(m)) if (signals.technologies.has(t)) score += 2;
  return score;
}

export const SKILL_SELECTION_DEFAULTS = { maxSkills: 12, tokenBudget: 24_000 };

/** Rough token count for a skill's instructions (4 characters per token). */
export const skillTokens = (m: CapabilityManifest) => Math.ceil((m.skill?.instructions.length ?? 0) / 4);

/**
 * Chooses which skills go into the agent's prompt. When everything fits the limits, everything is
 * delivered (small setups behave as before). Otherwise pinned skills come first, then the most relevant,
 * the more specific scope winning ties, until the count or token budget is reached. Other types
 * (MCP servers, plugins, integrations) are always delivered.
 */
export function selectForTask<T extends SelectableCapability>(items: T[], ctx: RelevanceContext, opts: Partial<typeof SKILL_SELECTION_DEFAULTS> = {}): { selected: T[]; deferred: T[] } {
  const { maxSkills, tokenBudget } = { ...SKILL_SELECTION_DEFAULTS, ...opts };
  const skills = items.filter((i) => i.manifest.type === 'skill');
  const others = items.filter((i) => i.manifest.type !== 'skill');
  const total = skills.reduce((n, s) => n + skillTokens(s.manifest), 0);
  if (skills.length <= maxSkills && total <= tokenBudget) return { selected: items, deferred: [] };
  const rank = (i: T) => SCOPE_RANK[i.scope as CapabilityScope] ?? 0;
  const ordered = skills
    .map((i) => ({ i, score: i.pinned ? Number.POSITIVE_INFINITY : relevanceScore(i.manifest, ctx) }))
    .sort((a, b) => b.score - a.score || rank(b.i) - rank(a.i) || a.i.manifest.id.localeCompare(b.i.manifest.id));
  const selected: T[] = [];
  const deferred: T[] = [];
  let used = 0;
  for (const { i } of ordered) {
    const cost = skillTokens(i.manifest);
    if (i.pinned || (selected.length < maxSkills && used + cost <= tokenBudget)) {
      selected.push(i);
      used += cost;
    } else deferred.push(i);
  }
  return { selected: [...others, ...selected], deferred };
}

// ── Marketplace ordering ──────────────────────────────────────────────────────

export interface RankablePackage {
  curated: boolean;
  curatedRank?: number | null;
  trust: string;
  installs?: number;
  name: string;
}

/** Curated first (by their rank), then trust, then popularity, then name. */
export function comparePackages(a: RankablePackage, b: RankablePackage): number {
  return (
    Number(b.curated) - Number(a.curated) ||
    (a.curatedRank ?? 1e9) - (b.curatedRank ?? 1e9) ||
    (TRUST_RANK[b.trust] ?? 0) - (TRUST_RANK[a.trust] ?? 0) ||
    (b.installs ?? 0) - (a.installs ?? 0) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Whether a public package page is worth indexing by search engines. Thin, mirrored pages without a
 * description or any use would count against the site, so they are served with noindex until they
 * earn it.
 */
export function isIndexable(p: { curated: boolean; installs?: number; description: string; readme?: string | null; source: string }): boolean {
  if (p.curated) return true;
  if ((p.installs ?? 0) >= 5) return true;
  if (p.source === 'native') return p.description.length >= 60 || (p.readme?.length ?? 0) >= 300;
  return (p.readme?.length ?? 0) >= 300;
}

// ── Federation: the official MCP Registry ─────────────────────────────────────

export interface FederatedPackage {
  namespace: string;
  name: string;
  type: CapabilityType;
  manifest: CapabilityManifest;
  listing: { repository?: string; homepage?: string };
  upstream: { registry: string; id: string; url?: string };
}

type AnyRecord = Record<string, any>;

function coerceSemver(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().replace(/^v/, '') : '';
  if (SEMVER.test(s)) return s;
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
  return m ? `${m[1]}.${m[2] ?? 0}.${m[3] ?? 0}` : '0.0.0';
}

/**
 * Maps one entry of the official MCP Registry (registry.modelcontextprotocol.io, `GET /v0/servers`) to a
 * registry package. Accepts both the `{ server, _meta }` wrapper and a bare server object, and the
 * camelCase and snake_case field spellings. Returns null for entries that cannot be run.
 */
export function fromMcpRegistry(raw: unknown, registry = 'mcp-registry'): FederatedPackage | null {
  const entry = raw as AnyRecord;
  const s: AnyRecord = entry?.server && typeof entry.server === 'object' ? entry.server : entry;
  if (!s || typeof s.name !== 'string') return null;
  const [prefix, rest] = s.name.includes('/') ? [s.name.slice(0, s.name.indexOf('/')), s.name.slice(s.name.indexOf('/') + 1)] : [registry, s.name];
  const namespace = slugifyNamespace(prefix);
  const name = slugifyName(rest);
  const pkgs: AnyRecord[] = Array.isArray(s.packages) ? s.packages : [];
  const remotes: AnyRecord[] = Array.isArray(s.remotes) ? s.remotes : [];

  let mcp: CapabilityManifest['mcp'] | undefined;
  let permissions: string[] = ['network.outbound'];
  const envVars: AnyRecord[] = [];
  const pkg = pkgs.find((p) => ['npm', 'pypi', 'oci', 'docker'].includes(String(p.registryType ?? p.registry_type ?? p.registry_name ?? '').toLowerCase()));
  if (pkg) {
    const kind = String(pkg.registryType ?? pkg.registry_type ?? pkg.registry_name).toLowerCase();
    const id = String(pkg.identifier ?? pkg.name ?? '');
    const ver = pkg.version ? String(pkg.version) : '';
    if (!id) return null;
    const command = kind === 'npm' ? ['npx', '-y', ver ? `${id}@${ver}` : id] : kind === 'pypi' ? ['uvx', ver ? `${id}==${ver}` : id] : ['docker', 'run', '-i', '--rm', ver ? `${id}:${ver}` : id];
    mcp = { transport: 'stdio', command, env: {} };
    permissions = ['process.execute', 'network.outbound'];
    envVars.push(...(pkg.environmentVariables ?? pkg.environment_variables ?? []));
  } else {
    const remote = remotes.find((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url));
    if (!remote) return null;
    mcp = { transport: String(remote.type ?? remote.transport_type) === 'sse' ? 'sse' : 'http', url: remote.url, env: {} };
  }
  const repository = typeof s.repository?.url === 'string' ? s.repository.url : undefined;
  const homepage = typeof s.websiteUrl === 'string' ? s.websiteUrl : typeof s.website_url === 'string' ? s.website_url : undefined;
  const parsed = capabilityManifestSchema.safeParse({
    id: name,
    name: typeof s.title === 'string' && s.title ? s.title : rest,
    version: coerceSemver(s.version ?? s.version_detail?.version ?? pkg?.version),
    type: 'mcp',
    description: typeof s.description === 'string' ? s.description.slice(0, 2000) : '',
    publisher: prefix,
    trust: 'UNVERIFIED',
    homepage: homepage ?? (repository && /^https?:\/\//.test(repository) ? repository : undefined),
    permissions,
    configuration: envVars
      .filter((e) => typeof e?.name === 'string')
      .map((e) => ({ key: e.name, description: String(e.description ?? ''), required: Boolean(e.isRequired ?? e.is_required), secret: Boolean(e.isSecret ?? e.is_secret) })),
    mcp,
  });
  if (!parsed.success) return null;
  return { namespace, name, type: 'mcp', manifest: parsed.data, listing: { repository, homepage }, upstream: { registry, id: s.name, url: repository } };
}

/** The next cursor of an MCP Registry list response, or null on the last page. */
export function mcpRegistryNextCursor(body: unknown): string | null {
  const b = body as AnyRecord;
  const c = b?.metadata?.nextCursor ?? b?.metadata?.next_cursor ?? null;
  return typeof c === 'string' && c ? c : null;
}
