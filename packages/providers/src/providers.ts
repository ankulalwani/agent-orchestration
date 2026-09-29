import { AppError, parseRetryAfter, redactString } from '@ao/core';
import { z } from 'zod';
import { googleAccessToken, resolveAwsCredentials, resolveGoogleCredential, signAwsRequest, type GoogleCredential } from './cloud-auth.js';

/**
 * Model provider abstraction (spec §5, §6). A provider is an API/model source, distinct from an agent.
 * Not every provider supports every operation: `capabilities` says which methods are meaningful, and
 * unsupported methods return `{ supported: false }` rather than fabricating data.
 */

export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'openrouter', 'azure-openai', 'ollama', 'openai-compatible', 'bedrock', 'vertex', 'deepseek', 'groq', 'nvidia-nim', 'lmstudio', 'mock'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  costTier?: 'low' | 'medium' | 'high';
  speedTier?: 'fast' | 'medium' | 'slow';
  qualityTier?: 'high' | 'medium' | 'low';
}

export interface ProviderHealth {
  healthy: boolean;
  checkedAt: string;
  latencyMs: number | null;
  error?: string;
  /** Set when the provider answered 429 during the check. */
  limitedUntil?: number | null;
}

export type Unsupported = { supported: false; reason: string };
export type UsageInfo = { supported: true; usedUsd?: number | null; limitUsd?: number | null; raw?: Record<string, unknown> } | Unsupported;
export type LimitInfo = { supported: true; requestsRemaining?: number | null; tokensRemaining?: number | null; resetAt?: number | null } | Unsupported;

export interface ProviderCapabilities {
  listModels: boolean;
  health: boolean;
  usage: boolean;
  limits: boolean;
  /** Credential not needed (local providers). */
  keyless: boolean;
  customBaseUrl: boolean;
}

export const providerConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
  kind: z.enum(PROVIDER_KINDS),
  name: z.string().min(1).max(120),
  baseUrl: z.string().url().nullable().default(null),
  /** Name of the credential in the worker's credential store. Never the secret itself. */
  credentialRef: z.string().nullable().default(null),
  /** Use the agent's own login (e.g. Claude subscription) instead of an API key. */
  useAgentLogin: z.boolean().default(false),
  /** Manually declared models (needed for providers without a list endpoint, or to add metadata). */
  models: z.array(z.object({ id: z.string(), name: z.string().optional(), contextWindow: z.number().optional(), costTier: z.enum(['low', 'medium', 'high']).optional(), speedTier: z.enum(['fast', 'medium', 'slow']).optional(), qualityTier: z.enum(['high', 'medium', 'low']).optional() })).default([]),
  extra: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  /**
   * Use only the models listed above, even when the provider lists more (e.g. OpenRouter's catalogue):
   * how add-on models are chosen.
   */
  restrictModels: z.boolean().default(false),
});
export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  authenticate(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  healthCheck(): Promise<ProviderHealth>;
  getUsage(): Promise<UsageInfo>;
  getLimits(): Promise<LimitInfo>;
}

export type Fetch = typeof fetch;

export class ProviderHttpError extends AppError {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAt: number | null,
  ) {
    super(status === 429 ? 'RATE_LIMITED' : status === 401 || status === 403 ? 'UNAUTHENTICATED' : 'PROVIDER_ERROR', message, {
      retryable: status === 429 || status >= 500,
      context: { status },
    });
  }
}

abstract class HttpProvider implements ModelProvider {
  abstract readonly kind: ProviderKind;
  abstract readonly capabilities: ProviderCapabilities;
  protected abstract defaultBaseUrl: string;

  constructor(
    protected config: ProviderConfig,
    protected apiKey: string | null,
    protected fetchImpl: Fetch = fetch,
  ) {}

  get id() {
    return this.config.id;
  }
  get name() {
    return this.config.name;
  }
  protected get baseUrl() {
    return (this.config.baseUrl ?? this.defaultBaseUrl).replace(/\/+$/, '');
  }

  protected abstract headers(): Record<string, string>;

  protected async get(path: string): Promise<{ json: any; headers: Headers }> {
    const res = await this.fetchImpl(this.baseUrl + path, { headers: { accept: 'application/json', ...this.headers() }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderHttpError(res.status, `${this.name}: HTTP ${res.status} ${redactString(body).slice(0, 200)}`, parseRetryAfter(res.headers.get('retry-after')));
    }
    return { json: await res.json(), headers: res.headers };
  }

  async authenticate() {
    if (!this.capabilities.keyless && !this.apiKey && !this.config.useAgentLogin) throw new AppError('UNAUTHENTICATED', `${this.name}: no credential configured`);
    if (this.capabilities.listModels && this.apiKey) await this.listModels();
  }

  protected abstract fetchModels(): Promise<ModelInfo[]>;

  /** Remote models merged with manually declared metadata (manual entries win for metadata). */
  async listModels(): Promise<ModelInfo[]> {
    const manual = this.config.models;
    if (!this.capabilities.listModels || (!this.apiKey && !this.capabilities.keyless)) return manual;
    const remote = await this.fetchModels();
    const byId = new Map(remote.map((m) => [m.id, m]));
    for (const m of manual) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
    return [...byId.values()];
  }

  async healthCheck(): Promise<ProviderHealth> {
    const t0 = Date.now();
    const checkedAt = new Date().toISOString();
    if (!this.capabilities.health) return { healthy: true, checkedAt, latencyMs: null, error: 'Health checks not supported; assumed healthy' };
    if (!this.capabilities.keyless && !this.apiKey) {
      return this.config.useAgentLogin
        ? { healthy: true, checkedAt, latencyMs: null, error: 'Uses agent login; health observed during execution' }
        : { healthy: false, checkedAt, latencyMs: null, error: 'No credential configured' };
    }
    try {
      await this.fetchModels();
      return { healthy: true, checkedAt, latencyMs: Date.now() - t0 };
    } catch (e) {
      const err = e as ProviderHttpError;
      return { healthy: false, checkedAt, latencyMs: Date.now() - t0, error: redactString(String(err.message ?? e)), limitedUntil: err.status === 429 ? (err.retryAt ?? null) : undefined };
    }
  }

  async getUsage(): Promise<UsageInfo> {
    return { supported: false, reason: `${this.name} does not expose usage through its API` };
  }
  async getLimits(): Promise<LimitInfo> {
    return { supported: false, reason: `${this.name} reports limits only on inference responses` };
  }
}

const ownIds = (json: any): ModelInfo[] => (json?.data ?? []).map((m: any) => ({ id: String(m.id), name: m.display_name ?? m.name ?? undefined }));

export class AnthropicProvider extends HttpProvider {
  readonly kind = 'anthropic' as const;
  readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: false, customBaseUrl: true };
  protected defaultBaseUrl = 'https://api.anthropic.com';
  protected headers(): Record<string, string> {
    return this.apiKey ? { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' } : {};
  }
  protected async fetchModels() {
    const { json } = await this.get('/v1/models?limit=1000');
    return ownIds(json);
  }
}

export class OpenAIProvider extends HttpProvider {
  readonly kind: ProviderKind = 'openai';
  readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: false, customBaseUrl: true };
  protected defaultBaseUrl = 'https://api.openai.com/v1';
  protected headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
  protected async fetchModels() {
    return ownIds((await this.get('/models')).json);
  }
}

/** Any OpenAI-compatible endpoint (vLLM, LM Studio, LiteLLM, …). Key optional. */
export class OpenAICompatibleProvider extends OpenAIProvider {
  override readonly kind: ProviderKind = 'openai-compatible';
  override readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: true, customBaseUrl: true };
  protected override defaultBaseUrl = 'http://127.0.0.1:8000/v1';
}

/** Presets of OpenAI-compatible services: the same API at a known address. */
export class DeepSeekProvider extends OpenAIProvider {
  override readonly kind: ProviderKind = 'deepseek';
  protected override defaultBaseUrl = 'https://api.deepseek.com/v1';
}
export class GroqProvider extends OpenAIProvider {
  override readonly kind: ProviderKind = 'groq';
  protected override defaultBaseUrl = 'https://api.groq.com/openai/v1';
}
export class NvidiaNimProvider extends OpenAIProvider {
  override readonly kind: ProviderKind = 'nvidia-nim';
  protected override defaultBaseUrl = 'https://integrate.api.nvidia.com/v1';
}
export class LmStudioProvider extends OpenAICompatibleProvider {
  override readonly kind: ProviderKind = 'lmstudio';
  protected override defaultBaseUrl = 'http://127.0.0.1:1234/v1';
}

/**
 * The OpenAI-compatible chat completions base URL of a provider (…/chat/completions is appended), for
 * the worker's model gateway. Null for kinds that have none.
 */
export function chatCompletionsBaseUrl(config: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string | null {
  const b = config.baseUrl?.replace(/\/+$/, '');
  switch (config.kind) {
    case 'openai':
      return b ?? 'https://api.openai.com/v1';
    case 'openrouter':
      return b ?? 'https://openrouter.ai/api/v1';
    case 'google':
      return `${b ?? 'https://generativelanguage.googleapis.com/v1beta'}/openai`;
    case 'ollama':
      return `${b ?? 'http://127.0.0.1:11434'}/v1`;
    case 'anthropic':
      return `${b ?? 'https://api.anthropic.com'}/v1`;
    case 'deepseek':
      return b ?? 'https://api.deepseek.com/v1';
    case 'groq':
      return b ?? 'https://api.groq.com/openai/v1';
    case 'nvidia-nim':
      return b ?? 'https://integrate.api.nvidia.com/v1';
    case 'lmstudio':
      return b ?? 'http://127.0.0.1:1234/v1';
    case 'openai-compatible':
      return b ?? 'http://127.0.0.1:8000/v1';
    default:
      return null;
  }
}

export class GoogleProvider extends HttpProvider {
  readonly kind = 'google' as const;
  readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: false, customBaseUrl: true };
  protected defaultBaseUrl = 'https://generativelanguage.googleapis.com/v1beta';
  protected headers(): Record<string, string> {
    return this.apiKey ? { 'x-goog-api-key': this.apiKey } : {};
  }
  protected async fetchModels() {
    const { json } = await this.get('/models?pageSize=1000');
    return (json?.models ?? []).map((m: any) => ({ id: String(m.name).replace(/^models\//, ''), name: m.displayName, contextWindow: m.inputTokenLimit }));
  }
}

export class OpenRouterProvider extends HttpProvider {
  readonly kind = 'openrouter' as const;
  readonly capabilities = { listModels: true, health: true, usage: true, limits: true, keyless: false, customBaseUrl: true };
  protected defaultBaseUrl = 'https://openrouter.ai/api/v1';
  protected headers(): Record<string, string> {
    return this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {};
  }
  protected async fetchModels() {
    const { json } = await this.get('/models');
    return (json?.data ?? []).map((m: any) => ({ id: String(m.id), name: m.name, contextWindow: m.context_length }));
  }
  private async keyInfo() {
    return (await this.get('/key')).json?.data ?? {};
  }
  override async getUsage(): Promise<UsageInfo> {
    if (!this.apiKey) return { supported: false, reason: 'No credential' };
    const d = await this.keyInfo();
    return { supported: true, usedUsd: typeof d.usage === 'number' ? d.usage : null, limitUsd: typeof d.limit === 'number' ? d.limit : null, raw: { label: d.label, is_free_tier: d.is_free_tier } };
  }
  override async getLimits(): Promise<LimitInfo> {
    if (!this.apiKey) return { supported: false, reason: 'No credential' };
    const d = await this.keyInfo();
    return { supported: true, requestsRemaining: typeof d.limit_remaining === 'number' ? d.limit_remaining : null, resetAt: null };
  }
}

export class AzureOpenAIProvider extends HttpProvider {
  readonly kind = 'azure-openai' as const;
  readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: false, customBaseUrl: true };
  protected defaultBaseUrl = '';
  protected headers(): Record<string, string> {
    return this.apiKey ? { 'api-key': this.apiKey } : {};
  }
  protected async fetchModels() {
    if (!this.config.baseUrl) throw new AppError('VALIDATION_FAILED', 'Azure OpenAI requires the resource endpoint as base URL');
    const apiVersion = this.config.extra.apiVersion ?? '2024-10-21';
    return ownIds((await this.get(`/openai/models?api-version=${encodeURIComponent(apiVersion)}`)).json);
  }
}

export class OllamaProvider extends HttpProvider {
  readonly kind = 'ollama' as const;
  readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: true, customBaseUrl: true };
  protected defaultBaseUrl = 'http://127.0.0.1:11434';
  protected headers(): Record<string, string> {
    return {};
  }
  protected async fetchModels() {
    const { json } = await this.get('/api/tags');
    return (json?.models ?? []).map((m: any) => ({ id: String(m.name), name: m.name, costTier: 'low' as const }));
  }
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Health result when credentials exist only where the agent resolves them (SSO, instance roles, …). */
const resolvedByAgent = (checkedAt: string, what: string): ProviderHealth => ({
  healthy: true,
  checkedAt,
  latencyMs: null,
  error: `No ${what} credentials found for a health check (stored key, environment or credentials file); the agent resolves them itself and problems show up when it runs`,
});

/**
 * AWS Bedrock (PROV-003): `ListFoundationModels`, signed with SigV4, is both the health check and the
 * model list. Credentials: the key stored for this provider (`KEY_ID:SECRET[:TOKEN]` or JSON), else
 * AWS_* environment variables, else the shared credentials profile (`extra.profile`). Region:
 * `extra.region`. `baseUrl` overrides the endpoint (e.g. a VPC endpoint).
 */
export class BedrockProvider extends HttpProvider {
  readonly kind = 'bedrock' as const;
  readonly capabilities = { listModels: true, health: true, usage: false, limits: false, keyless: true, customBaseUrl: true };
  protected defaultBaseUrl = '';
  private get region() {
    return this.config.extra.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
  }
  protected override get baseUrl() {
    return (this.config.baseUrl ?? `https://bedrock.${this.region}.amazonaws.com`).replace(/\/+$/, '');
  }
  protected headers(): Record<string, string> {
    return {};
  }
  private creds() {
    return resolveAwsCredentials(this.apiKey, this.config.extra.profile);
  }
  override async listModels(): Promise<ModelInfo[]> {
    if (!this.creds()) return this.config.models;
    const remote = await this.fetchModels();
    const byId = new Map(remote.map((m) => [m.id, m]));
    for (const m of this.config.models) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
    return [...byId.values()];
  }
  protected async fetchModels(): Promise<ModelInfo[]> {
    const c = this.creds();
    if (!c) throw new AppError('UNAUTHENTICATED', `${this.name}: no AWS credentials found`);
    const url = `${this.baseUrl}/foundation-models`;
    // x-amz-content-sha256 (hash of the empty body) is signed as the AWS SDKs do.
    const headers = signAwsRequest({ method: 'GET', url, headers: { accept: 'application/json', 'x-amz-content-sha256': EMPTY_SHA256 }, region: this.region, service: 'bedrock', credentials: c.credentials });
    const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new ProviderHttpError(res.status, `${this.name}: HTTP ${res.status} ${redactString(body).slice(0, 200)}`, parseRetryAfter(res.headers.get('retry-after')));
    }
    const json = (await res.json()) as { modelSummaries?: Array<{ modelId: string; modelName?: string }> };
    return (json.modelSummaries ?? []).map((m) => ({ id: m.modelId, name: m.modelName }));
  }
  override async healthCheck(): Promise<ProviderHealth> {
    if (!this.creds()) return resolvedByAgent(new Date().toISOString(), 'AWS');
    return super.healthCheck();
  }
}

/**
 * Google Vertex AI (PROV-003): exchanges the credential for an OAuth access token, then reads the
 * project's Vertex AI location (`GET /v1/projects/{project}/locations/{location}`), which proves the
 * token, the project and the API are usable. Credential: the service-account key or gcloud
 * application-default JSON stored for this provider, else GOOGLE_APPLICATION_CREDENTIALS, else gcloud's
 * ADC file. `extra.project` (or the credential's project) and `extra.region` (default us-central1).
 * Models stay the manually declared list: Vertex has no simple per-project list of usable models.
 */
export class VertexProvider extends HttpProvider {
  readonly kind = 'vertex' as const;
  readonly capabilities = { listModels: false, health: true, usage: false, limits: false, keyless: true, customBaseUrl: true };
  protected defaultBaseUrl = '';
  private token: { accessToken: string; expiresAt: number } | null = null;
  private get location() {
    return this.config.extra.region ?? this.config.extra.location ?? 'us-central1';
  }
  protected override get baseUrl() {
    return (this.config.baseUrl ?? (this.location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${this.location}-aiplatform.googleapis.com`)).replace(/\/+$/, '');
  }
  protected headers(): Record<string, string> {
    return this.token ? { authorization: `Bearer ${this.token.accessToken}` } : {};
  }
  private cred() {
    return resolveGoogleCredential(this.apiKey);
  }
  private project(c: GoogleCredential) {
    return this.config.extra.project ?? (c.type === 'service_account' ? c.project_id : c.quota_project_id);
  }
  protected async fetchModels(): Promise<ModelInfo[]> {
    const r = this.cred();
    if (!r) throw new AppError('UNAUTHENTICATED', `${this.name}: no Google credentials found`);
    const project = this.project(r.credential);
    if (!project) throw new AppError('VALIDATION_FAILED', `${this.name}: set the Google Cloud project (extra.project)`);
    if (!this.token || this.token.expiresAt - Date.now() < 60_000) this.token = await googleAccessToken(r.credential, this.fetchImpl);
    await this.get(`/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(this.location)}`);
    return this.config.models;
  }
  override async healthCheck(): Promise<ProviderHealth> {
    if (!this.cred()) return resolvedByAgent(new Date().toISOString(), 'Google Cloud');
    try {
      return await super.healthCheck();
    } catch (e) {
      return { healthy: false, checkedAt: new Date().toISOString(), latencyMs: null, error: redactString(String((e as Error).message)) };
    }
  }
}

/** Providers without remote checks: the declared model list is used as-is. */
export class ManualProvider extends HttpProvider {
  readonly kind: ProviderKind;
  readonly capabilities = { listModels: false, health: false, usage: false, limits: false, keyless: true, customBaseUrl: false };
  protected defaultBaseUrl = '';
  constructor(config: ProviderConfig, apiKey: string | null, fetchImpl?: Fetch) {
    super(config, apiKey, fetchImpl);
    this.kind = config.kind;
  }
  protected headers(): Record<string, string> {
    return {};
  }
  protected async fetchModels() {
    return this.config.models;
  }
}

export function createProvider(config: ProviderConfig, apiKey: string | null, fetchImpl?: Fetch): ModelProvider {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicProvider(config, apiKey, fetchImpl);
    case 'openai':
      return new OpenAIProvider(config, apiKey, fetchImpl);
    case 'openai-compatible':
      return new OpenAICompatibleProvider(config, apiKey, fetchImpl);
    case 'google':
      return new GoogleProvider(config, apiKey, fetchImpl);
    case 'openrouter':
      return new OpenRouterProvider(config, apiKey, fetchImpl);
    case 'azure-openai':
      return new AzureOpenAIProvider(config, apiKey, fetchImpl);
    case 'ollama':
      return new OllamaProvider(config, apiKey, fetchImpl);
    case 'bedrock':
      return new BedrockProvider(config, apiKey, fetchImpl);
    case 'vertex':
      return new VertexProvider(config, apiKey, fetchImpl);
    case 'deepseek':
      return new DeepSeekProvider(config, apiKey, fetchImpl);
    case 'groq':
      return new GroqProvider(config, apiKey, fetchImpl);
    case 'nvidia-nim':
      return new NvidiaNimProvider(config, apiKey, fetchImpl);
    case 'lmstudio':
      return new LmStudioProvider(config, apiKey, fetchImpl);
    default:
      return new ManualProvider(config, apiKey, fetchImpl);
  }
}
