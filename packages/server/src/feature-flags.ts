import { AppError, FEATURES, createLogger, featureDefinition } from '@ao/core';
import { Organization, oid } from '@ao/database';
import { featureEnabled, type ServerConfig } from './config.js';
import { audit } from './audit.js';
import type { PlatformActor } from './context.js';
import { readVersioned, updateVersioned } from './runtime-settings.js';

const log = createLogger('feature-flags');
const FLAGS_KEY = 'feature.flags';

interface FlagState {
  /** null: the flag's default applies. */
  enabled: boolean | null;
  /** Per-organization overrides, by organization id. */
  orgs: Record<string, boolean>;
}
type StoredFlags = Record<string, FlagState>;

export interface FeatureFlagView {
  key: string;
  name: string;
  description: string;
  stage: string;
  defaultEnabled: boolean;
  /** Platform-wide setting from the admin UI (null: default). */
  enabled: boolean | null;
  /** Forced on by the FEATURE_FLAGS environment variable. */
  forcedByEnvironment: boolean;
  /** Value for organizations without an override. */
  effective: boolean;
  organizations: Array<{ organizationId: string; name: string; enabled: boolean }>;
}

/**
 * Feature flags (CORE-010, spec §124). Evaluation is synchronous from memory, so it can sit on hot
 * paths; the stored state is reloaded periodically so every API instance converges within seconds.
 * Order: FEATURE_FLAGS environment variable (forces on) → organization override → platform setting →
 * the flag's default.
 */
export class FeatureFlags {
  private state: StoredFlags = {};
  private version = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly config: ServerConfig) {}

  forcedByEnvironment(key: string) {
    return featureEnabled(this.config, key);
  }

  enabled(key: string, organizationId?: string | null): boolean {
    if (this.forcedByEnvironment(key)) return true;
    const st = this.state[key];
    if (organizationId && st?.orgs[organizationId] !== undefined) return st.orgs[organizationId]!;
    if (st && st.enabled !== null) return st.enabled;
    return featureDefinition(key)?.defaultEnabled ?? false;
  }

  /** Every declared flag's value for one organization. */
  forOrganization(organizationId: string): Record<string, boolean> {
    return Object.fromEntries(FEATURES.map((f) => [f.key, this.enabled(f.key, organizationId)]));
  }

  async refresh() {
    const doc = await readVersioned<StoredFlags>(FLAGS_KEY, {});
    if (doc.version === this.version) return;
    this.state = doc.data;
    this.version = doc.version;
  }

  async start(intervalMs = 10_000) {
    await this.refresh();
    this.timer ??= setInterval(() => void this.refresh().catch((e) => log.warn({ err: String(e) }, 'could not reload feature flags')), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async list(): Promise<{ flags: FeatureFlagView[]; unknownEnvironmentFlags: string[] }> {
    await this.refresh();
    const orgIds = [...new Set(Object.values(this.state).flatMap((s) => Object.keys(s.orgs)))];
    const orgs = orgIds.length ? await Organization.find({ _id: { $in: orgIds.map((id) => oid(id)) } }, { name: 1 }).lean() : [];
    const names = new Map(orgs.map((o) => [String(o._id), o.name]));
    const flags = FEATURES.map((f) => {
      const st = this.state[f.key];
      return {
        key: f.key,
        name: f.name,
        description: f.description,
        stage: f.stage,
        defaultEnabled: f.defaultEnabled,
        enabled: st?.enabled ?? null,
        forcedByEnvironment: this.forcedByEnvironment(f.key),
        effective: this.enabled(f.key),
        organizations: Object.entries(st?.orgs ?? {})
          .map(([organizationId, enabled]) => ({ organizationId, name: names.get(organizationId) ?? '(deleted organization)', enabled }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    });
    const unknownEnvironmentFlags = this.config.FEATURE_FLAGS.split(',').map((s) => s.trim()).filter((k) => k && !featureDefinition(k));
    return { flags, unknownEnvironmentFlags };
  }

  /**
   * Sets a flag for everyone (`organizationId` omitted) or for one organization. `null` removes the
   * setting, so the default (or, for an organization, the platform setting) applies again.
   */
  async set(actor: PlatformActor, key: string, enabled: boolean | null, organizationId?: string) {
    if (!featureDefinition(key)) throw new AppError('NOT_FOUND', `Unknown feature flag: ${key}`);
    if (organizationId && !(await Organization.exists({ _id: oid(organizationId) }))) throw new AppError('NOT_FOUND', 'Organization not found');
    const saved = await updateVersioned<StoredFlags>(FLAGS_KEY, {}, (cur) => {
      const st = (cur[key] ??= { enabled: null, orgs: {} });
      if (!organizationId) st.enabled = enabled;
      else if (enabled === null) delete st.orgs[organizationId];
      else st.orgs[organizationId] = enabled;
      return cur;
    });
    this.state = saved.data;
    this.version = saved.version;
    await audit(actor, 'feature_flag.update', { type: 'feature_flag', id: key }, { enabled, organizationId: organizationId ?? null });
  }
}
