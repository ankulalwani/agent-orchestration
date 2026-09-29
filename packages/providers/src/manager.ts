import { NATIVE_PROVIDER_KIND, backoffDelay, createLogger, isNativeProvider, maskSecret, nativeProviderId } from '@ao/core';
import { createProvider, providerConfigSchema, type Fetch, type ModelInfo, type ModelProvider, type ProviderConfig } from './providers.js';

const log = createLogger('providers');

export interface CredentialLookup {
  get(ref: string): Promise<string | null>;
}

interface ProviderState {
  config: ProviderConfig;
  provider: ModelProvider;
  healthy: boolean;
  lastCheckedAt: number | null;
  nextCheckAt: number;
  failures: number;
  models: ModelInfo[];
  error: string | null;
  /** Observed limit (from agent execution or a 429 during health checks). */
  limitedUntil: number | null;
  limitedUnknownReset: boolean;
  credentialMasked: string | null;
}

/**
 * Worker-side provider manager (spec §6, §51, §108). Keeps multiple providers per worker, tracks
 * health and observed limits, and polls conservatively: health checks run at most every
 * `minCheckIntervalMs`, back off exponentially with jitter on failure, and are skipped while a
 * provider is known to be limited.
 */
/** How long to wait before trying a harness's own login again after a limit with no reset time. */
const NATIVE_UNKNOWN_RESET_RETRY_MS = 15 * 60_000;

export class ProviderManager {
  private states = new Map<string, ProviderState>();
  /**
   * Limits of harnesses' own logins (`native:<agentId>`), which have no configuration here. A limit
   * without a reset time is retried after a while rather than given an invented reset time.
   */
  private native = new Map<string, { until: number | null; retryAfter: number }>();

  constructor(
    private credentials: CredentialLookup,
    private opts: { minCheckIntervalMs?: number; maxBackoffMs?: number; fetchImpl?: Fetch } = {},
  ) {}

  async configure(configs: unknown[]) {
    const next = new Map<string, ProviderState>();
    for (const raw of configs) {
      const config = providerConfigSchema.parse(raw);
      if (!config.enabled) continue;
      const key = config.credentialRef ? await this.credentials.get(config.credentialRef) : null;
      const prev = this.states.get(config.id);
      next.set(config.id, {
        config,
        provider: createProvider(config, key, this.opts.fetchImpl),
        healthy: prev?.healthy ?? true,
        lastCheckedAt: prev?.lastCheckedAt ?? null,
        nextCheckAt: 0,
        failures: 0,
        models: prev?.models ?? config.models,
        error: null,
        limitedUntil: prev?.limitedUntil ?? null,
        limitedUnknownReset: prev?.limitedUnknownReset ?? false,
        credentialMasked: key ? maskSecret(key) : null,
      });
    }
    this.states = next;
  }

  get(id: string) {
    return this.states.get(id);
  }

  async credentialFor(id: string): Promise<string | null> {
    const s = this.states.get(id);
    return s?.config.credentialRef ? this.credentials.get(s.config.credentialRef) : null;
  }

  /** Record a limit observed during execution. `retryAt` null = unknown reset (never invented). */
  markLimited(id: string, retryAt: number | null) {
    if (isNativeProvider(id)) {
      this.native.set(id, { until: retryAt, retryAfter: retryAt ?? Date.now() + NATIVE_UNKNOWN_RESET_RETRY_MS });
      return;
    }
    const s = this.states.get(id);
    if (!s) return;
    s.limitedUntil = retryAt;
    s.limitedUnknownReset = retryAt === null;
    s.nextCheckAt = retryAt ?? Date.now() + backoffDelay(Math.min(s.failures, 5), this.opts.minCheckIntervalMs ?? 60_000, this.opts.maxBackoffMs ?? 30 * 60_000);
  }

  clearLimit(id: string) {
    this.native.delete(id);
    const s = this.states.get(id);
    if (s) {
      s.limitedUntil = null;
      s.limitedUnknownReset = false;
    }
  }

  isLimited(id: string, at = Date.now()) {
    const n = this.native.get(id);
    if (n) return n.until ? n.until > at : at < n.retryAfter;
    const s = this.states.get(id);
    if (!s) return false;
    if (s.limitedUnknownReset) return true;
    return Boolean(s.limitedUntil && s.limitedUntil > at);
  }

  /** Refresh due providers. Safe to call often; it rate-limits itself. */
  async refresh(force = false) {
    const now = Date.now();
    const minInterval = this.opts.minCheckIntervalMs ?? 5 * 60_000;
    await Promise.all(
      [...this.states.values()].map(async (s) => {
        if (!force && now < s.nextCheckAt) return;
        if (s.limitedUntil && s.limitedUntil <= now) this.clearLimit(s.config.id);
        const h = await s.provider.healthCheck();
        s.lastCheckedAt = now;
        s.healthy = h.healthy;
        s.error = h.error ?? null;
        if (h.limitedUntil !== undefined) this.markLimited(s.config.id, h.limitedUntil);
        if (h.healthy) {
          s.failures = 0;
          // A successful health check after an unknown-reset limit means the provider answers again.
          if (s.limitedUnknownReset) this.clearLimit(s.config.id);
          try {
            s.models = await s.provider.listModels();
          } catch (e) {
            log.warn({ provider: s.config.id, err: String(e) }, 'listModels failed');
          }
          s.nextCheckAt = now + minInterval;
        } else {
          s.failures++;
          s.nextCheckAt = now + backoffDelay(s.failures, minInterval, this.opts.maxBackoffMs ?? 60 * 60_000);
        }
      }),
    );
  }

  /**
   * The harnesses' own logins as providers (one per installed agent that can run on its own login):
   * always available unless they reported a limit.
   */
  nativeInventory(agents: Array<{ id: string; name: string }>, at = Date.now()) {
    return agents.map((a) => {
      const id = nativeProviderId(a.id);
      const n = this.native.get(id);
      const limited = this.isLimited(id, at);
      return {
        id,
        kind: NATIVE_PROVIDER_KIND,
        name: `${a.name} (own login)`,
        healthy: true,
        lastCheckedAt: null,
        limited,
        limitedUntil: limited && n?.until ? new Date(n.until).toISOString() : null,
        models: [{ id: 'default', name: "The harness's own model choice" }],
        capabilities: { listModels: false, health: false, usage: false, limits: false, keyless: true, customBaseUrl: false },
        credentialMasked: null,
        baseUrl: null,
        error: null,
        order: -1,
      };
    });
  }

  /** Snapshot for heartbeats/UI. Secrets are only ever shown masked. */
  inventory() {
    return [...this.states.values()].map((s, order) => ({
      id: s.config.id,
      kind: s.config.kind,
      name: s.config.name,
      healthy: s.healthy,
      lastCheckedAt: s.lastCheckedAt ? new Date(s.lastCheckedAt).toISOString() : null,
      limited: this.isLimited(s.config.id),
      limitedUntil: s.limitedUntil ? new Date(s.limitedUntil).toISOString() : null,
      models: s.config.restrictModels && s.config.models.length ? s.config.models.map((m) => ({ ...(s.models.find((x) => x.id === m.id) ?? {}), ...m })) : s.models,
      capabilities: s.provider.capabilities,
      credentialMasked: s.credentialMasked,
      baseUrl: s.config.baseUrl,
      error: s.error,
      order,
    }));
  }
}
