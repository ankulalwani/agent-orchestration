import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { API_PREFIX, type AuthResponse } from '@ao/contracts';

/**
 * Mobile API client. Works with any self-hosted control plane (spec §53): the server URL is chosen at
 * sign-in. A distribution can preset a default server at build time with EXPO_PUBLIC_HOSTED_URL (or
 * `expo.extra.hostedUrl`); without one, sign-in asks for the server URL. Tokens are kept in the platform
 * keystore (Keychain / Keystore) via expo-secure-store, never in plain storage.
 */
export const HOSTED_URL: string = process.env.EXPO_PUBLIC_HOSTED_URL || ((Constants.expoConfig?.extra as { hostedUrl?: string } | undefined)?.hostedUrl ?? '');

const K = { server: 'ao.server', refresh: 'ao.refresh', org: 'ao.org' };
let server: string | null = null;
let accessToken: string | null = null;
let refreshing: Promise<AuthResponse | null> | null = null;
const listeners = new Set<(s: AuthResponse | null) => void>();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const getServer = () => server;
export const getAccessToken = () => accessToken;
export function onSession(fn: (s: AuthResponse | null) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
async function setSession(s: AuthResponse | null) {
  accessToken = s?.accessToken ?? null;
  if (s?.refreshToken) await SecureStore.setItemAsync(K.refresh, s.refreshToken);
  if (!s) await SecureStore.deleteItemAsync(K.refresh);
  for (const l of listeners) l(s);
}

export function normalizeServer(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(u)) throw new Error('Enter a full URL, e.g. https://orchestrator.example.com');
  return u;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'INTERNAL', data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

function raw(method: string, path: string, body?: unknown) {
  if (!server) throw new ApiError(0, 'NO_SERVER', 'No server selected');
  return fetch(server + API_PREFIX + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Restore a previous session at app start. */
export async function restore(): Promise<AuthResponse | null> {
  server = await SecureStore.getItemAsync(K.server);
  if (!server) return null;
  return refresh();
}

export async function refresh(): Promise<AuthResponse | null> {
  refreshing ??= (async () => {
    try {
      const token = await SecureStore.getItemAsync(K.refresh);
      if (!token || !server) return null;
      const res = await fetch(server + API_PREFIX + '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) });
      if (!res.ok) {
        await setSession(null);
        return null;
      }
      const s = (await res.json()) as AuthResponse;
      await setSession(s);
      return s;
    } catch {
      return null; // offline: keep the stored refresh token and retry later
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Throws ApiError with code `MFA_REQUIRED` when the account needs a second factor; call again with `mfaCode`. */
export async function signIn(serverUrl: string, email: string, password: string, mfaCode?: string) {
  server = normalizeServer(serverUrl);
  const s = await parse<AuthResponse>(await raw('POST', '/auth/login', { email, password, ...(mfaCode ? { mfaCode } : {}) }));
  await SecureStore.setItemAsync(K.server, server);
  await setSession(s);
  return s;
}

/**
 * Sign-in through the web app (device sign-in): works with every method the server offers, including
 * Google, GitHub and company SSO. Start, open `verificationUrl` in the browser, then poll.
 */
export async function startBrowserSignIn(serverUrl: string, clientName: string) {
  server = normalizeServer(serverUrl);
  return parse<{ userCode: string; pollSecret: string; verificationUrl: string; expiresAt: string; intervalSec: number }>(await raw('POST', '/auth/device/start', { clientName }));
}

/** null while waiting for approval; the session once approved. Throws if it was denied or expired. */
export async function pollBrowserSignIn(pollSecret: string): Promise<AuthResponse | null> {
  const r = await parse<{ status: 'pending' } | ({ status: 'approved' } & AuthResponse)>(await raw('POST', '/auth/device/poll', { pollSecret }));
  if (r.status === 'pending') return null;
  await SecureStore.setItemAsync(K.server, server!);
  await setSession(r);
  return r;
}

export async function signOut() {
  const token = await SecureStore.getItemAsync(K.refresh);
  if (token && server) await fetch(server + API_PREFIX + '/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: token }) }).catch(() => undefined);
  await setSession(null);
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  if (res.status === 401 && (await refresh())) res = await raw(method, path, body);
  return parse<T>(res);
}

export const get = <T,>(p: string) => api<T>('GET', p);
export const post = <T,>(p: string, b?: unknown) => api<T>('POST', p, b ?? {});

export async function savedOrg() {
  return SecureStore.getItemAsync(K.org);
}
export async function saveOrg(id: string) {
  await SecureStore.setItemAsync(K.org, id);
}
