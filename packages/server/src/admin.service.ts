import { AppError, redactString } from '@ao/core';
import { databaseHealthy, mongoose } from '@ao/database';
import { serverConfigSchema, type ServerConfig } from './config.js';
import type { DispatchQueue } from '@ao/queue';
import type { ArtifactStore } from './artifacts.js';
import { oauthProviders } from './oauth.service.js';
import { SECRET_SETTING as SECRET, URL_WITH_CREDENTIALS, type RuntimeSettings } from './runtime-settings.js';

/**
 * The server's effective configuration for platform administrators (SELFHOST-002): what is in effect
 * and where it came from (environment, web app or default), never a secret: secrets are reported only
 * as set / not set, and passwords inside URLs are masked. Some settings can be changed in the web app
 * (see RuntimeSettings); the rest come from environment variables only.
 */
type Group = 'General' | 'Security' | 'Database & queue' | 'Email' | 'Storage' | 'Sign-in' | 'Observability' | 'Limits & scheduling' | 'Other';

const GROUPS: Array<[RegExp, Group]> = [
  [/^(JWT_SECRET|ENCRYPTION_KEY|ENCRYPTION_KEYS_PREVIOUS|CORS_ORIGINS|TRUST_PROXY|REQUIRE_PUBLIC_CALLBACK_URLS|FIRST_USER_IS_PLATFORM_ADMIN|ALLOW_REGISTRATION|REQUIRE_EMAIL_VERIFICATION|ACCESS_TOKEN_TTL_SEC|REFRESH_TOKEN_TTL_DAYS)$/, 'Security'],
  [/^(MONGODB_URI|REDIS_URL)$/, 'Database & queue'],
  [/^SMTP_/, 'Email'],
  [/^(S3_|ARTIFACT_DIR)/, 'Storage'],
  [/^(GOOGLE_|GITHUB_|OIDC_)/, 'Sign-in'],
  [/^(METRICS_ENABLED|TELEMETRY_ENABLED|ERROR_TRACKING_|EXPO_PUSH_ENABLED)/, 'Observability'],
  [/(RATE_LIMIT_PER_MINUTE|_INTERVAL_MS)$/, 'Limits & scheduling'],
  [/^(NODE_ENV|DEPLOYMENT_MODE|PORT|HOST|PUBLIC_URL|WEB_URL|FEATURE_FLAGS|REGISTRY_SEARCH|PUBLIC_CATALOG|WORKER_RELEASE_TRUSTED_KEYS|RELEASE_PUBLISH_TOKEN|UPDATE_CHECK_REPO|UPDATE_WEBHOOK_URL)$/, 'General'],
];


export interface SettingView {
  key: string;
  group: Group;
  value: string | number | boolean | null;
  secret: boolean;
  source: 'environment' | 'admin' | 'default';
  /** Can be changed in the web app (unless set in the environment). */
  editable: boolean;
}

function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '••••';
    // A DSN's username is its key (e.g. https://<key>@sentry.example/1).
    if (u.username && !u.password) u.username = '••••';
    for (const k of [...u.searchParams.keys()]) if (/key|token|secret|pass|sig/i.test(k)) u.searchParams.set(k, '••••');
    return u.toString();
  } catch {
    return redactString(raw);
  }
}

export function settingsView(config: ServerConfig, env: NodeJS.ProcessEnv, runtime?: RuntimeSettings): SettingView[] {
  return Object.keys(serverConfigSchema.shape).map((key) => {
    const raw = (config as Record<string, unknown>)[key];
    const secret = SECRET.test(key);
    let value: SettingView['value'];
    if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) value = null;
    else if (secret) value = Array.isArray(raw) ? `set (${raw.length})` : 'set';
    else if (URL_WITH_CREDENTIALS.test(key) && typeof raw === 'string') value = maskUrl(raw);
    else if (Array.isArray(raw)) value = raw.join(', ');
    else value = raw as string | number | boolean;
    const source = env[key] !== undefined && env[key] !== '' ? 'environment' : runtime?.isStored(key) ? 'admin' : 'default';
    return { key, group: GROUPS.find(([re]) => re.test(key))?.[1] ?? 'Other', value, secret, source, editable: Boolean(runtime?.isEditable(key)) };
  });
}

export async function serverOverview(deps: { config: ServerConfig; env: NodeJS.ProcessEnv; runtime?: RuntimeSettings; queue: DispatchQueue; artifacts: ArtifactStore; mailerConfigured: boolean; version: string }) {
  const { config } = deps;
  let mongoVersion: string | null = null;
  try {
    mongoVersion = String((await mongoose.connection.db!.admin().serverInfo()).version);
  } catch {
    mongoVersion = null;
  }
  return {
    version: deps.version,
    node: process.versions.node,
    deploymentMode: config.DEPLOYMENT_MODE,
    status: {
      database: { ok: await databaseHealthy(), detail: mongoVersion ? `MongoDB ${mongoVersion}` : 'unreachable' },
      queue: { ok: await deps.queue.healthy(), detail: deps.queue.driver === 'bullmq' ? 'Redis (BullMQ); several API instances supported' : 'In-memory (single API instance)' },
      email: { ok: deps.mailerConfigured, detail: deps.mailerConfigured ? 'SMTP configured' : 'Not configured: emails are logged, not sent' },
      artifacts: { ok: true, detail: deps.artifacts.driver === 's3' ? `S3 bucket ${config.S3_BUCKET}` : `Local directory ${config.ARTIFACT_DIR}` },
      signIn: { ok: true, detail: ['Email and password', ...oauthProviders(config).map((p) => p.name)].join(', ') + (config.ALLOW_REGISTRATION ? '; open registration' : '; registration by invitation') },
      errorTracking: { ok: true, detail: config.ERROR_TRACKING_DSN || config.ERROR_TRACKING_WEBHOOK_URL ? 'On' : 'Off' },
      keyRotation: { ok: config.ENCRYPTION_KEYS_PREVIOUS.length === 0, detail: config.ENCRYPTION_KEYS_PREVIOUS.length ? `${config.ENCRYPTION_KEYS_PREVIOUS.length} previous key(s) still configured; remove them once "reencrypt-secrets" reports all secrets current` : 'No previous keys configured' },
    },
    settings: settingsView(config, deps.env, deps.runtime),
    settingsUpdatedAt: deps.runtime?.updatedAt ?? null,
  };
}

export function requirePlatformAdmin(isPlatformAdmin: boolean | undefined) {
  if (!isPlatformAdmin) throw new AppError('FORBIDDEN', 'Only server administrators can do this');
}
