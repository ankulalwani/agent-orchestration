import { z } from 'zod';

/**
 * Control-plane configuration from environment (spec §104, §122).
 * Self-hosted defaults impose no task/worker/project limits (spec §2.1) and make no outbound calls.
 */
const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => ['true', '1', 'yes'].includes(v));

export const serverConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** `cloud`: a shared, multi-tenant installation. Only changes defaults (see REQUIRE_PUBLIC_CALLBACK_URLS). */
  DEPLOYMENT_MODE: z.enum(['self-hosted', 'cloud']).default('self-hosted'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:5173'),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/agent_orchestration'),
  REDIS_URL: z.string().optional(),
  /** ≥32 chars. Signs access tokens. */
  JWT_SECRET: z.string().min(32),
  /** 32-byte key, base64 or hex. Encrypts control-plane secrets at rest (spec §59). */
  ENCRYPTION_KEY: z.string().min(32),
  /** Comma-separated former ENCRYPTION_KEY values, kept only to decrypt and re-encrypt (key rotation). */
  ENCRYPTION_KEYS_PREVIOUS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((k) => k.trim()).filter(Boolean)),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  ALLOW_REGISTRATION: bool.default('true'),
  /**
   * The first account created becomes a platform administrator, so a new installation can be set up from the
   * browser. Turn off where the public can sign up first (a shared service), and grant the role with
   * `node dist/main.js platform-admin <email>` instead.
   */
  FIRST_USER_IS_PLATFORM_ADMIN: bool.default('true'),
  REQUIRE_EMAIL_VERIFICATION: bool.default('false'),
  TRUST_PROXY: bool.default('false'),
  /**
   * Integration callback URLs must be public https addresses, so tenants cannot make the server call its own
   * network (SSRF). Unset: on when DEPLOYMENT_MODE=cloud, off otherwise. See `requirePublicCallbackUrls()`.
   */
  REQUIRE_PUBLIC_CALLBACK_URLS: bool.optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  AUTH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(20),
  /** Error tracking (spec §61), off unless set: a Sentry-compatible DSN and/or a JSON webhook. */
  ERROR_TRACKING_DSN: z.string().url().optional(),
  ERROR_TRACKING_WEBHOOK_URL: z.string().url().optional(),
  ERROR_TRACKING_ENVIRONMENT: z.string().optional(),
  /** Service name attached to error reports. */
  ERROR_TRACKING_SERVICE: z.string().default('api'),
  /**
   * OAuth / OpenID Connect sign-in. Each provider is off unless its client id and secret are set.
   * Redirect URI to register with the provider: `${PUBLIC_URL}/api/v1/auth/oauth/<google|github|oidc>/callback`.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  /** GitHub Enterprise Server: e.g. https://github.example.com and https://github.example.com/api/v3 */
  GITHUB_URL: z.string().url().default('https://github.com'),
  GITHUB_API_URL: z.string().url().default('https://api.github.com'),
  /** Any OpenID Connect provider (Microsoft Entra ID, Okta, Keycloak, Auth0, GitLab, …). */
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_DISPLAY_NAME: z.string().default('Single sign-on'),
  OIDC_SCOPES: z.string().default('openid email profile'),
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().default('Agent Orchestration <no-reply@localhost>'),
  /** Expo push is an outbound call to a third party: disabled unless explicitly enabled (spec §127). */
  EXPO_PUSH_ENABLED: bool.default('false'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default('true'),
  ARTIFACT_DIR: z.string().default('./data/artifacts'),
  SCHEDULER_INTERVAL_MS: z.coerce.number().int().default(5000),
  SWEEP_INTERVAL_MS: z.coerce.number().int().default(10_000),
  METRICS_ENABLED: bool.default('true'),
  /** Anonymous usage telemetry; never contains code, prompts or secrets. Off by default (spec §128). */
  TELEMETRY_ENABLED: bool.default('false'),
  FEATURE_FLAGS: z.string().default(''),
  /** Marketplace search: MongoDB text index (works everywhere) or an Atlas Search index named "capability_packages". */
  REGISTRY_SEARCH: z.enum(['text', 'atlas']).default('text'),
  /**
   * Semantic suggestions in the marketplace: an OpenAI-compatible embeddings API (`<url>/embeddings`), for
   * example https://api.openai.com/v1 or a local Ollama (http://localhost:11434/v1). Unset: suggestions
   * use the built-in rules only, and no text leaves the server. With it, package listings and the text
   * someone asks suggestions for are sent to that API.
   */
  EMBEDDINGS_URL: z.string().url().optional(),
  EMBEDDINGS_API_KEY: z.string().optional(),
  EMBEDDINGS_MODEL: z.string().default('text-embedding-3-small'),
  /** Cosine similarity from which a package counts as close in meaning (depends on the model). */
  EMBEDDINGS_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.4),
  /** Serve public marketplace packages without sign-in (/catalog, for a marketing site). Unset: on when DEPLOYMENT_MODE=cloud. */
  PUBLIC_CATALOG: bool.optional(),
  /**
   * One-click worker install: Ed25519 release public keys (PEM) by key id, as JSON, e.g.
   * {"release-2026":"-----BEGIN PUBLIC KEY-----\n…"}. The install script checks the signed release against them
   * and gives them to the new worker for its later updates. Without a key, the install script refuses to install.
   */
  /**
   * Lets CI publish worker releases without an administrator's session: `Authorization: Bearer <token>` is accepted
   * only to upload a package and sign it with the server's signing key. 32+ random characters; unset: off.
   */
  RELEASE_PUBLISH_TOKEN: z.string().min(32).optional(),
  /** GitHub repository (owner/name) whose version tags the Updates page compares against. Checked only when an administrator asks. */
  UPDATE_CHECK_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/).default('ankulalwani/agent-orchestration'),
  /** Redeploy hook (Easypanel, Coolify, Portainer, a CI trigger) that pulls the newest image and restarts the server. Unset: the Updates page shows manual steps. */
  UPDATE_WEBHOOK_URL: z.string().url().optional(),
  WORKER_RELEASE_TRUSTED_KEYS: z
    .string()
    .default('')
    .transform((v, ctx) => {
      if (!v.trim()) return {} as Record<string, string>;
      try {
        return z.record(z.string().regex(/^[A-Za-z0-9._-]{1,100}$/), z.string().includes('PUBLIC KEY')).parse(JSON.parse(v));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Must be a JSON object of key id → PEM public key' });
        return z.NEVER;
      }
    }),
});
export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = serverConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid control-plane configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Whether /catalog answers without sign-in. */
export function publicCatalogEnabled(config: Pick<ServerConfig, 'PUBLIC_CATALOG' | 'DEPLOYMENT_MODE'>): boolean {
  return config.PUBLIC_CATALOG ?? config.DEPLOYMENT_MODE === 'cloud';
}

export function requirePublicCallbackUrls(config: Pick<ServerConfig, 'REQUIRE_PUBLIC_CALLBACK_URLS' | 'DEPLOYMENT_MODE'>): boolean {
  return config.REQUIRE_PUBLIC_CALLBACK_URLS ?? config.DEPLOYMENT_MODE === 'cloud';
}

export function featureEnabled(config: Pick<ServerConfig, 'FEATURE_FLAGS'>, flag: string): boolean {
  return config.FEATURE_FLAGS.split(',').map((s) => s.trim()).includes(flag);
}
