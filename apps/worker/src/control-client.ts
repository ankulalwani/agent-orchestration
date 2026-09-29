import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { AppError, backoffDelay, createLogger } from '@ao/core';
import {
  API_PREFIX,
  WORKER_PROTOCOL_VERSION,
  serverToWorker,
  type HeartbeatPayload,
  type ServerToWorker,
  type TaskDto,
  type TransitionRequest,
  type WorkerEvent,
} from '@ao/contracts';

const log = createLogger('control-client');

export class LeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`Lease lost for task ${taskId}`);
  }
}

export interface ClaimResult {
  claimed: boolean;
  reason?: string;
  task?: TaskDto;
  leaseExpiresAt?: string;
  policyLayers?: { platform: unknown; organization: unknown; project: unknown; task: unknown };
  localPath?: string;
  /** Every repository of the project with its checkout here, primary first. */
  repositories?: Array<{ repositoryId: string; name: string; localPath: string; primary: boolean; defaultBranch: string }>;
  capabilities?: Array<{ manifest: any; scope: string; config: Record<string, unknown> }>;
  knowledge?: string[];
  features?: Record<string, boolean>;
  environment?: { name: string; variables: Record<string, string>; secrets: Record<string, string>; missingSecrets: string[]; requiresApproval: boolean } | null;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'unauthorized';

/**
 * Worker ⇄ control-plane client (spec §14). Outbound HTTPS + WSS only. Reconnects with exponential
 * backoff and jitter. State-changing HTTP calls are retried with the same idempotency identifiers.
 */
export class ControlPlaneClient {
  state: ConnectionState = 'disconnected';
  latencyMs: number | null = null;
  lastConnectedAt: string | null = null;
  lastError: string | null = null;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private handlers: Array<(m: ServerToWorker) => void> = [];
  private stateListeners: Array<(s: ConnectionState) => void> = [];

  constructor(
    private baseUrl: string,
    private credential: string,
  ) {}

  onMessage(fn: (m: ServerToWorker) => void) {
    this.handlers.push(fn);
  }
  onState(fn: (s: ConnectionState) => void) {
    this.stateListeners.push(fn);
  }
  private setState(s: ConnectionState) {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────
  async request<T>(method: string, path: string, body?: unknown, opts: { retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(this.baseUrl.replace(/\/+$/, '') + API_PREFIX + path, {
          method,
          headers: { authorization: `Bearer ${this.credential}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30_000),
        });
      } catch (e) {
        if (attempt >= retries) throw new AppError('INTERNAL', `Control plane unreachable: ${(e as Error).message}`, { retryable: true });
        await sleep(backoffDelay(attempt, 1000, 30_000));
        continue;
      }
      const text = await res.text();
      const json = text ? JSON.parse(text) : undefined;
      if (res.ok) return json as T;
      const code = json?.error?.code as string | undefined;
      if (code === 'LEASE_LOST') throw new LeaseLostError(path.split('/')[2] ?? '');
      // A concurrency limit is a decision, not an overload: report it at once so the caller can choose another target.
      if ((res.status >= 500 || (res.status === 429 && code !== 'CONCURRENCY_LIMIT')) && attempt < retries) {
        await sleep(backoffDelay(attempt, 1000, 30_000));
        continue;
      }
      if (res.status === 401) this.setState('unauthorized');
      throw new AppError((code as never) ?? 'INTERNAL', json?.error?.message ?? `HTTP ${res.status}`, { retryable: res.status >= 500, context: json?.error?.context });
    }
  }

  claim(taskId: string) {
    return this.request<ClaimResult>('POST', `/worker/tasks/${taskId}/claim`, undefined, { retries: 2 });
  }

  /** Idempotent: retries reuse the same transitionId, so a retry after a lost response is harmless. */
  transition(taskId: string, req: Omit<TransitionRequest, 'transitionId'> & { transitionId?: string }, retries = 6) {
    return this.request<TaskDto>('POST', `/worker/tasks/${taskId}/transition`, { ...req, transitionId: req.transitionId ?? randomUUID() }, { retries });
  }

  getTask(taskId: string) {
    return this.request<ClaimResult>('GET', `/worker/tasks/${taskId}`, undefined, { retries: 2 });
  }

  sendEvents(events: WorkerEvent[]) {
    return this.request<{ accepted: number; duplicates: number }>('POST', '/worker/events', { events }, { retries: 0 });
  }

  offers() {
    return this.request<{ taskIds: string[] }>('GET', '/worker/offers', undefined, { retries: 0 });
  }

  httpHeartbeat(payload: HeartbeatPayload) {
    return this.request<{ revokedTaskIds: string[] }>('POST', '/worker/heartbeat', { payload }, { retries: 0 });
  }

  // ── WebSocket ────────────────────────────────────────────────────────────
  connect() {
    this.stopped = false;
    if (this.ws) return;
    this.setState('connecting');
    const url = this.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + API_PREFIX + '/worker/ws';
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.credential}` }, handshakeTimeout: 15_000 });
    this.ws = ws;
    ws.on('open', () => {
      this.attempt = 0;
      this.lastConnectedAt = new Date().toISOString();
      this.lastError = null;
      this.setState('connected');
      ws.send(JSON.stringify({ type: 'hello', protocol: WORKER_PROTOCOL_VERSION, version: process.env.AO_WORKER_VERSION ?? '0.1.1' }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = serverToWorker.parse(JSON.parse(raw.toString('utf8')));
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', nonce: msg.nonce }));
        if (msg.type === 'error' && (msg.code === 'UNAUTHENTICATED' || msg.code === 'REVOKED')) this.setState('unauthorized');
        for (const h of this.handlers) h(msg);
      } catch (e) {
        log.warn({ err: String(e) }, 'ignored malformed server message');
      }
    });
    ws.on('close', (code) => {
      this.ws = null;
      if (code === 4401) this.setState('unauthorized');
      else if (this.state !== 'unauthorized') this.setState('disconnected');
      this.scheduleReconnect();
    });
    ws.on('error', (e) => {
      this.lastError = e.message;
      log.warn({ err: e.message }, 'control-plane socket error');
    });
  }

  private scheduleReconnect() {
    if (this.stopped || this.state === 'unauthorized' || this.reconnectTimer) return;
    const delay = backoffDelay(this.attempt++, 1000, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  sendHeartbeat(payload: HeartbeatPayload): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'heartbeat', payload }));
    return true;
  }

  close() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.setState('disconnected');
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Device-code pairing (spec §13). Unauthenticated endpoints; returns the credential once. */
export async function startPairing(baseUrl: string, info: { name: string; hostname: string; os: 'windows' | 'macos' | 'linux'; arch: string; version: string }) {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + API_PREFIX + '/worker/pairing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info) });
  if (!res.ok) throw new AppError('INTERNAL', `Pairing failed: HTTP ${res.status}`);
  return (await res.json()) as { pairingId: string; userCode: string; pollSecret: string; verificationUrl: string; expiresAt: string; intervalSec: number };
}

export async function pollPairing(baseUrl: string, pairingId: string, pollSecret: string) {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + API_PREFIX + '/worker/pairing/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pairingId, pollSecret }) });
  if (!res.ok) throw new AppError('INTERNAL', `Pairing poll failed: HTTP ${res.status}`);
  return (await res.json()) as { status: 'PENDING' | 'DENIED' | 'EXPIRED' } | { status: 'APPROVED'; workerId: string; organizationId: string; credential: string };
}
