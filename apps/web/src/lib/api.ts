import { API_PREFIX, type AuthResponse } from '@ao/contracts';

/**
 * API client. The access token lives in memory only; the refresh token is an httpOnly SameSite=Strict
 * cookie set by the server for `x-client: web` requests, so neither token is readable by page scripts
 * from storage (spec §58).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;
const listeners = new Set<(s: AuthResponse | null) => void>();

export const getAccessToken = () => accessToken;
export function onSession(fn: (s: AuthResponse | null) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setSession(s: AuthResponse | null) {
  accessToken = s?.accessToken ?? null;
  for (const l of listeners) l(s);
}

async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(API_PREFIX + path, {
    method,
    credentials: 'include',
    headers: {
      'x-client': 'web',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiError(res.status, e.code ?? 'INTERNAL', e.message ?? `Request failed (${res.status})`, e.correlationId, e.context);
  }
  return data as T;
}

export async function refreshSession(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    try {
      const res = await raw('POST', '/auth/refresh', {});
      if (!res.ok || res.status === 204) {
        setSession(null);
        return null;
      }
      const s = (await res.json()) as AuthResponse;
      setSession(s);
      return s;
    } catch {
      return null;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  let res = await raw(method, path, body, headers);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await raw(method, path, body, headers);
  }
  return parse<T>(res);
}

/** The second step of a sign-in: a code, or a security key's answer to the challenge in `MFA_REQUIRED`'s context. */
export type SecondFactor = string | { securityKey: unknown };
const secondFactor = (f?: SecondFactor) => (!f ? {} : typeof f === 'string' ? { mfaCode: f } : { securityKey: f.securityKey });

/**
 * Throws ApiError with code `MFA_REQUIRED` when the account needs a second factor; call again with one.
 * Its `context.securityKey` holds the options for a security key, when the account has any.
 */
export async function login(email: string, password: string, second?: SecondFactor) {
  const s = await parse<AuthResponse>(await raw('POST', '/auth/login', { email, password, ...secondFactor(second) }));
  setSession(s);
  return s;
}

export async function register(input: { email: string; password: string; name: string; organizationName?: string; invitationToken?: string }) {
  const s = await parse<AuthResponse>(await raw('POST', '/auth/register', input));
  setSession(s);
  return s;
}

/** Finishes an OAuth sign-in with the ticket from the callback; `MFA_REQUIRED` works as for `login`. */
export async function completeOAuth(ticket: string, second?: SecondFactor) {
  const s = await parse<AuthResponse>(await raw('POST', '/auth/oauth/complete', { ticket, ...secondFactor(second) }));
  setSession(s);
  return s;
}

/** Browser navigation (not fetch) to a provider's sign-in page, through the API. */
export function oauthStartUrl(provider: string, opts: { next?: string; invitation?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.next) q.set('next', opts.next);
  if (opts.invitation) q.set('invitation', opts.invitation);
  return `${API_PREFIX}/auth/oauth/${provider}/start${q.size ? `?${q}` : ''}`;
}

export async function logout() {
  await raw('POST', '/auth/logout', {}).catch(() => undefined);
  setSession(null);
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});
export const patch = <T,>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const put = <T,>(p: string, b: unknown) => api<T>('PUT', p, b);
export const del = <T,>(p: string) => api<T>('DELETE', p);

/** Saves a file from the API (a link can't carry the access token). */
export async function download(path: string, filename: string) {
  let res = await raw('GET', path);
  if (res.status === 401 && (await refreshSession())) res = await raw('GET', path);
  if (!res.ok) await parse(res);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
