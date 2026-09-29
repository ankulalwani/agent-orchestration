import { AppError, createLogger, isAppError } from '@ao/core';
import { Setting, isDuplicateKeyError } from '@ao/database';
import { serverConfigSchema, type ServerConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import { audit } from './audit.js';
import type { PlatformActor } from './context.js';

const log = createLogger('server-settings');

/**
 * Settings that platform administrators can change from the web app while the server runs
 * (SELFHOST-002). Everything else (database, keys, ports, storage, intervals) is read once at startup
 * and stays environment-only. An environment variable always wins: a setting that is set in the
 * environment is shown as locked, so deployments managed through configuration files stay authoritative.
 */
export const EDITABLE_SETTINGS = [
  'WEB_URL',
  'ALLOW_REGISTRATION',
  'REQUIRE_EMAIL_VERIFICATION',
  'ACCESS_TOKEN_TTL_SEC',
  'REFRESH_TOKEN_TTL_DAYS',
  'CORS_ORIGINS',
  'RATE_LIMIT_PER_MINUTE',
  'AUTH_RATE_LIMIT_PER_MINUTE',
  'SMTP_URL',
  'SMTP_FROM',
  'EXPO_PUSH_ENABLED',
  'TELEMETRY_ENABLED',
  'ERROR_TRACKING_DSN',
  'ERROR_TRACKING_WEBHOOK_URL',
  'ERROR_TRACKING_ENVIRONMENT',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GITHUB_CLIENT_ID',
  'GITHUB_CLIENT_SECRET',
  'GITHUB_URL',
  'GITHUB_API_URL',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_DISPLAY_NAME',
  'OIDC_SCOPES',
] as const satisfies ReadonlyArray<keyof ServerConfig>;
export type EditableSetting = (typeof EDITABLE_SETTINGS)[number];
const EDITABLE = new Set<string>(EDITABLE_SETTINGS);
const POSITIVE = new Set(['ACCESS_TOKEN_TTL_SEC', 'REFRESH_TOKEN_TTL_DAYS', 'RATE_LIMIT_PER_MINUTE', 'AUTH_RATE_LIMIT_PER_MINUTE']);

/** Values that are secrets in their entirety. */
export const SECRET_SETTING = /^(JWT_SECRET|ENCRYPTION_KEY|ENCRYPTION_KEYS_PREVIOUS|S3_SECRET_ACCESS_KEY|S3_ACCESS_KEY_ID|.*_CLIENT_SECRET)$/;
/** URLs that may carry credentials. */
export const URL_WITH_CREDENTIALS = /^(MONGODB_URI|REDIS_URL|SMTP_URL|ERROR_TRACKING_DSN|ERROR_TRACKING_WEBHOOK_URL)$/;
/** Stored settings that are encrypted at rest. */
const ENCRYPTED = (key: string) => SECRET_SETTING.test(key) || URL_WITH_CREDENTIALS.test(key);

// ── Versioned documents in the `settings` collection ─────────────────────────
export interface Versioned<T> {
  version: number;
  data: T;
}

export async function readVersioned<T>(key: string, empty: T): Promise<Versioned<T>> {
  const doc = await Setting.findOne({ key }).lean();
  const v = doc?.value as Versioned<T> | undefined;
  return v && typeof v.version === 'number' ? v : { version: 0, data: empty };
}

/**
 * Read-modify-write with optimistic concurrency: two administrators saving at once (on the same or on
 * different API instances) never lose each other's change; the later one is re-applied on top.
 */
export async function updateVersioned<T>(key: string, empty: T, mutate: (current: T) => T): Promise<Versioned<T>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cur = await readVersioned(key, empty);
    const next: Versioned<T> = { version: cur.version + 1, data: mutate(structuredClone(cur.data)) };
    if (cur.version === 0) {
      try {
        await Setting.create({ key, value: next });
        return next;
      } catch (e) {
        if (isDuplicateKeyError(e)) continue;
        throw e;
      }
    }
    const r = await Setting.updateOne({ key, 'value.version': cur.version }, { $set: { value: next } });
    if (r.modifiedCount === 1) return next;
  }
  throw new AppError('CONFLICT', 'The settings were changed by someone else at the same time. Try again.');
}

// ── Server settings ──────────────────────────────────────────────────────────
const SETTINGS_KEY = 'server.config';
/** Plain values, and encrypted values for secrets and URLs that may carry credentials. */
interface StoredSettings {
  values: Record<string, string>;
  encrypted: Record<string, string>;
  updatedBy?: string;
  updatedAt?: string;
}
const EMPTY: StoredSettings = { values: {}, encrypted: {} };

export class RuntimeSettings {
  private stored: Record<string, string> = {};
  private version = 0;
  private readonly base: Partial<ServerConfig>;
  private timer: NodeJS.Timeout | null = null;
  private listeners = new Set<(changed: string[]) => void>();
  updatedAt: string | null = null;

  constructor(
    private readonly config: ServerConfig,
    readonly env: NodeJS.ProcessEnv,
    private readonly box: SecretBox,
  ) {
    // Values in effect before anything stored applies (environment or defaults).
    this.base = Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, config[k]]));
  }

  isEditable(key: string) {
    return EDITABLE.has(key);
  }

  lockedByEnvironment(key: string) {
    return this.env[key] !== undefined && this.env[key] !== '';
  }

  /** True when the value in effect comes from the web app (not the environment or a default). */
  isStored(key: string) {
    return key in this.stored && !this.lockedByEnvironment(key);
  }

  onChange(fn: (changed: string[]) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Loads stored settings if they changed since the last load. Returns the keys whose value changed. */
  async refresh(): Promise<string[]> {
    const doc = await readVersioned(SETTINGS_KEY, EMPTY);
    if (doc.version === this.version) return [];
    return this.apply(this.decrypt(doc.data), doc.version, doc.data.updatedAt ?? null);
  }

  /** Loads now, then polls so that changes made through another API instance apply here too. */
  async start(intervalMs = 10_000) {
    await this.refresh();
    this.timer ??= setInterval(() => void this.refresh().catch((e) => log.warn({ err: String(e) }, 'could not reload server settings')), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Changes settings. `null` or an empty string removes a stored value, so the default applies again.
   * Values are validated with the same rules as the environment variables before anything is saved.
   */
  async update(actor: PlatformActor, changes: Record<string, string | null>) {
    const keys = Object.keys(changes);
    if (!keys.length) throw new AppError('VALIDATION_FAILED', 'Nothing to change');
    const normalized: Record<string, string | null> = {};
    for (const key of keys) {
      if (!EDITABLE.has(key)) throw new AppError('VALIDATION_FAILED', `${key} can only be set through the environment (restart required)`, { context: { key } });
      if (this.lockedByEnvironment(key)) throw new AppError('CONFLICT', `${key} is set by an environment variable, which takes precedence. Remove it from the environment to manage it here.`, { context: { key } });
      const raw = changes[key];
      const value = raw == null || raw.trim() === '' ? null : raw.trim();
      if (value !== null) this.validate(key, value);
      normalized[key] = value;
    }
    const saved = await updateVersioned(SETTINGS_KEY, EMPTY, (cur) => {
      for (const [key, value] of Object.entries(normalized)) {
        delete cur.values[key];
        delete cur.encrypted[key];
        if (value === null) continue;
        if (ENCRYPTED(key)) cur.encrypted[key] = this.box.encrypt(value);
        else cur.values[key] = value;
      }
      return { ...cur, updatedBy: actor.userId, updatedAt: new Date().toISOString() };
    });
    const changed = this.apply(this.decrypt(saved.data), saved.version, saved.data.updatedAt ?? null);
    // Keys and whether they were cleared only: values can be secrets.
    await audit(actor, 'server.settings.update', null, { keys, cleared: keys.filter((k) => normalized[k] === null) });
    return { changed };
  }

  private validate(key: string, value: string) {
    const parsed = (serverConfigSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: Array<{ message: string }> } } }>)[key]!.safeParse(value);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', `${key}: ${parsed.error!.issues[0]?.message ?? 'invalid value'}`, { context: { key } });
    if (POSITIVE.has(key) && !((parsed.data as number) > 0)) throw new AppError('VALIDATION_FAILED', `${key} must be greater than 0`, { context: { key } });
    if (key === 'SMTP_URL' && !/^smtps?:\/\//i.test(value)) throw new AppError('VALIDATION_FAILED', 'SMTP_URL must start with smtp:// or smtps://', { context: { key } });
  }

  private decrypt(data: StoredSettings): Record<string, string> {
    const plain: Record<string, string> = { ...data.values };
    for (const [key, enc] of Object.entries(data.encrypted ?? {})) {
      try {
        plain[key] = this.box.decrypt(enc);
      } catch (e) {
        log.error({ key, err: (e as Error).message }, 'stored server setting could not be decrypted; using the environment or default value');
      }
    }
    return plain;
  }

  private apply(plain: Record<string, string>, version: number, updatedAt: string | null): string[] {
    const next: Record<string, unknown> = {};
    for (const key of EDITABLE_SETTINGS) {
      const value = plain[key];
      if (value === undefined || this.lockedByEnvironment(key)) {
        next[key] = this.base[key];
        continue;
      }
      try {
        this.validate(key, value);
        next[key] = (serverConfigSchema.shape[key] as { parse(v: unknown): unknown }).parse(value);
      } catch (e) {
        // E.g. a value stored by a newer version with stricter rules: never apply an invalid value.
        log.error({ key, err: isAppError(e) ? e.message : String(e) }, 'stored server setting is invalid; using the environment or default value');
        next[key] = this.base[key];
      }
    }
    const changed = EDITABLE_SETTINGS.filter((k) => JSON.stringify(this.config[k]) !== JSON.stringify(next[k]));
    Object.assign(this.config, next);
    this.stored = plain;
    this.version = version;
    this.updatedAt = updatedAt;
    if (changed.length) {
      log.info({ changed }, 'server settings changed');
      for (const l of this.listeners) {
        try {
          l(changed);
        } catch (e) {
          log.error({ err: String(e) }, 'applying a settings change failed');
        }
      }
    }
    return changed;
  }
}

/** Re-encrypts stored server settings with the current key (key rotation, SEC-007). */
export async function reencryptServerSettings(box: SecretBox): Promise<{ reencrypted: number; failed: string[] }> {
  const doc = await readVersioned(SETTINGS_KEY, EMPTY);
  const stale = Object.entries(doc.data.encrypted ?? {}).filter(([, enc]) => !box.isCurrent(enc));
  if (!stale.length) return { reencrypted: 0, failed: [] };
  const failed: string[] = [];
  let reencrypted = 0;
  await updateVersioned(SETTINGS_KEY, EMPTY, (cur) => {
    failed.length = 0;
    reencrypted = 0;
    for (const [key, enc] of Object.entries(cur.encrypted)) {
      if (box.isCurrent(enc)) continue;
      try {
        cur.encrypted[key] = box.encrypt(box.decrypt(enc));
        reencrypted++;
      } catch {
        failed.push(key); // left untouched, never overwritten
      }
    }
    return cur;
  });
  return { reencrypted, failed };
}
