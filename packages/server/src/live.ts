import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { LiveMessage, ServerToWorker } from '@ao/contracts';

/**
 * In-process fan-out of live updates to browser/mobile sockets (spec §54) and of push messages to
 * connected workers. With several API instances, a bridge (Redis pub/sub, see `attachRedisBridge`)
 * relays messages so a browser or worker connected to another instance still receives them.
 */
export interface Bridge {
  publish(channel: string, payload: string): void;
}

export interface LiveHubOptions {
  /** How often each instance re-announces its connected workers to peers. */
  presenceIntervalMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export class LiveHub {
  readonly instanceId = randomUUID();
  private emitter = new EventEmitter();
  private workerSockets = new Map<string, (msg: ServerToWorker) => void>();
  private bridge: Bridge | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private readonly presenceIntervalMs: number;
  private readonly now: () => number;

  constructor(opts: LiveHubOptions = {}) {
    this.emitter.setMaxListeners(0);
    this.presenceIntervalMs = opts.presenceIntervalMs ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  private deliverOrg(organizationId: string, msg: LiveMessage) {
    for (const listener of this.emitter.listeners(`org:${organizationId}`)) {
      try {
        (listener as (m: LiveMessage) => void)(msg);
      } catch {
        // Isolated: a failing subscriber must not affect the publisher or other subscribers.
      }
    }
  }

  publishToOrg(organizationId: string, msg: LiveMessage) {
    this.deliverOrg(organizationId, msg);
    this.bridge?.publish('ao:org', JSON.stringify({ from: this.instanceId, organizationId, msg }));
  }

  subscribeOrg(organizationId: string, fn: (msg: LiveMessage) => void): () => void {
    const ch = `org:${organizationId}`;
    this.emitter.on(ch, fn);
    return () => this.emitter.off(ch, fn);
  }

  registerWorker(workerId: string, send: (msg: ServerToWorker) => void): () => void {
    this.workerSockets.set(workerId, send);
    this.bridge?.publish('ao:presence', JSON.stringify({ from: this.instanceId, workerId, connected: true }));
    return () => {
      if (this.workerSockets.get(workerId) === send) {
        this.workerSockets.delete(workerId);
        this.bridge?.publish('ao:presence', JSON.stringify({ from: this.instanceId, workerId, connected: false }));
      }
    };
  }

  /**
   * Workers connected to other instances, learned through the bridge. Each instance re-announces its
   * full list periodically; entries not refreshed for 3 intervals belong to a crashed instance and
   * are ignored.
   */
  private remoteWorkers = new Map<string, { instanceId: string; seenAt: number }>();

  isWorkerConnected(workerId: string) {
    if (this.workerSockets.has(workerId)) return true;
    const r = this.remoteWorkers.get(workerId);
    return Boolean(r && this.now() - r.seenAt < 3 * this.presenceIntervalMs);
  }

  /** Broadcast the workers connected to this instance (full snapshot). */
  announcePresence() {
    this.bridge?.publish('ao:presence', JSON.stringify({ from: this.instanceId, workers: [...this.workerSockets.keys()] }));
  }

  /** Ask peers for their snapshots (on start-up, so a new instance knows about existing workers). */
  requestPresence() {
    this.bridge?.publish('ao:presence-sync', JSON.stringify({ from: this.instanceId }));
  }

  stop() {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  connectedWorkerCount() {
    return this.workerSockets.size;
  }

  /** Delivers locally if the worker is connected here; otherwise relays through the bridge. */
  sendToWorker(workerId: string, msg: ServerToWorker): boolean {
    const send = this.workerSockets.get(workerId);
    if (send) {
      send(msg);
      return true;
    }
    this.bridge?.publish('ao:worker', JSON.stringify({ from: this.instanceId, workerId, msg }));
    return false;
  }

  /** Attach a pub/sub bridge. Returns the handler to call for every message received from peers. */
  attachBridge(bridge: Bridge) {
    this.bridge = bridge;
    this.stop();
    this.presenceTimer = setInterval(() => this.announcePresence(), this.presenceIntervalMs);
    this.presenceTimer.unref?.();
    return {
      receive: (channel: string, payload: string) => {
        let data: { from: string; organizationId?: string; workerId?: string; workers?: string[]; msg?: unknown; connected?: boolean };
        try {
          data = JSON.parse(payload);
        } catch {
          return;
        }
        if (data.from === this.instanceId) return; // our own message echoed back
        if (channel === 'ao:org' && data.organizationId) this.deliverOrg(data.organizationId, data.msg as LiveMessage);
        if (channel === 'ao:worker' && data.workerId) this.workerSockets.get(data.workerId)?.(data.msg as ServerToWorker);
        if (channel === 'ao:presence-sync') this.announcePresence();
        if (channel === 'ao:presence') {
          const seenAt = this.now();
          if (Array.isArray(data.workers)) {
            // Full snapshot from one instance: refresh its workers, drop the ones it no longer has.
            for (const [id, r] of this.remoteWorkers) if (r.instanceId === data.from && !data.workers.includes(id)) this.remoteWorkers.delete(id);
            for (const id of data.workers) this.remoteWorkers.set(id, { instanceId: data.from, seenAt });
          } else if (data.workerId) {
            if (data.connected) this.remoteWorkers.set(data.workerId, { instanceId: data.from, seenAt });
            else if (this.remoteWorkers.get(data.workerId)?.instanceId === data.from) this.remoteWorkers.delete(data.workerId);
          }
        }
      },
    };
  }
}

/** Connect a LiveHub to Redis pub/sub for multi-instance deployments. */
export async function attachRedisBridge(hub: LiveHub, redisUrl: string) {
  const { Redis } = await import('ioredis');
  const pub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const { receive } = hub.attachBridge({ publish: (ch, payload) => void pub.publish(ch, payload).catch(() => undefined) });
  pub.on('error', () => undefined); // ioredis reconnects by itself
  sub.on('error', () => undefined);
  await sub.subscribe('ao:org', 'ao:worker', 'ao:presence', 'ao:presence-sync');
  sub.on('message', (ch: string, payload: string) => receive(ch, payload));
  hub.requestPresence();
  // After a Redis outage, resubscription happens automatically; re-sync presence as well.
  sub.on('ready', () => hub.requestPresence());
  return async () => {
    hub.stop();
    sub.disconnect();
    pub.disconnect();
  };
}
