import { createHash, randomBytes } from 'node:crypto';
import { AppError, createLogger } from '@ao/core';
import type { ProviderConfig } from '@ao/providers';

const log = createLogger('provider-oauth');
const PENDING_TTL_MS = 10 * 60_000;

/**
 * Provider sign-in for model access (PROV-006): instead of pasting an API key, the user signs in with
 * the provider in the browser and the worker receives a key for this machine. The callback goes to
 * the worker's loopback UI, so no client registration or public redirect URL is needed.
 *
 * Supported: OpenRouter (OAuth PKCE, https://openrouter.ai/docs/use-cases/oauth-pkce). Other providers
 * either have no OAuth for API access (Anthropic, OpenAI) or use the agent's own login or cloud
 * credentials (Claude/Codex/Gemini login, AWS profiles, Google ADC), which are supported separately.
 */
interface OAuthFlow {
  /** Browser URL that starts the sign-in. */
  authorizeUrl(p: ProviderConfig, callbackUrl: string, challenge: string): string;
  /** Exchanges the code for an API key. */
  exchange(p: ProviderConfig, code: string, verifier: string, fetchImpl: typeof fetch): Promise<string>;
}

const openRouter: OAuthFlow = {
  authorizeUrl(p, callbackUrl, challenge) {
    const origin = new URL(p.baseUrl ?? 'https://openrouter.ai/api/v1').origin;
    return `${origin}/auth?${new URLSearchParams({ callback_url: callbackUrl, code_challenge: challenge, code_challenge_method: 'S256' })}`;
  },
  async exchange(p, code, verifier, fetchImpl) {
    const api = (p.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const res = await fetchImpl(`${api}/auth/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as { key?: string; error?: { message?: string } | string };
    if (!res.ok || typeof body.key !== 'string' || !body.key) {
      const msg = typeof body.error === 'string' ? body.error : body.error?.message;
      throw new AppError('PROVIDER_ERROR', `OpenRouter did not issue a key (HTTP ${res.status}${msg ? `: ${msg}` : ''})`);
    }
    return body.key;
  },
};

const FLOWS: Partial<Record<ProviderConfig['kind'], OAuthFlow>> = { openrouter: openRouter };

export function supportsProviderOAuth(kind: string) {
  return kind in FLOWS;
}

export class ProviderOAuth {
  private pending = new Map<string, { providerId: string; verifier: string; expiresAt: number }>();

  constructor(private fetchImpl: typeof fetch = fetch) {}

  /** Returns the URL to open in the browser. The state is single-use and expires after 10 minutes. */
  start(p: ProviderConfig, callbackBase: string): { url: string } {
    const flow = FLOWS[p.kind];
    if (!flow) throw new AppError('VALIDATION_FAILED', `Sign-in is not available for ${p.kind} providers. Enter an API key instead.`);
    this.sweep();
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    this.pending.set(state, { providerId: p.id, verifier, expiresAt: Date.now() + PENDING_TTL_MS });
    return { url: flow.authorizeUrl(p, `${callbackBase}/oauth/provider/callback/${state}`, challenge) };
  }

  /** Completes a sign-in: returns the provider id and the issued key. The state can't be used again. */
  async complete(state: string, code: string, providers: ProviderConfig[]): Promise<{ providerId: string; key: string }> {
    this.sweep();
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending) throw new AppError('VALIDATION_FAILED', 'This sign-in link has expired or was already used. Start again from the worker.');
    const p = providers.find((x) => x.id === pending.providerId);
    if (!p || !FLOWS[p.kind]) throw new AppError('NOT_FOUND', 'The provider was removed during sign-in');
    const key = await FLOWS[p.kind]!.exchange(p, code, pending.verifier, this.fetchImpl);
    log.info({ providerId: p.id }, 'provider sign-in completed');
    return { providerId: p.id, key };
  }

  private sweep() {
    const now = Date.now();
    for (const [s, v] of this.pending) if (v.expiresAt < now) this.pending.delete(s);
  }
}
