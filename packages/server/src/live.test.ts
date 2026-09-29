import { describe, expect, it } from 'vitest';
import { LiveHub } from './live.js';

/** Two API instances connected by an in-memory bus standing in for Redis pub/sub. */
function pair() {
  const handlers: Array<(ch: string, p: string) => void> = [];
  const bus = { publish: (ch: string, p: string) => handlers.forEach((h) => h(ch, p)) };
  const a = new LiveHub();
  const b = new LiveHub();
  handlers.push(a.attachBridge(bus).receive, b.attachBridge(bus).receive);
  return { a, b };
}

describe('LiveHub bridge (multi-instance)', () => {
  it('delivers org updates to subscribers on other instances exactly once', () => {
    const { a, b } = pair();
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    a.subscribeOrg('o1', (m) => gotA.push(m));
    b.subscribeOrg('o1', (m) => gotB.push(m));
    a.publishToOrg('o1', { type: 'notification', notification: { id: 'n', type: 't', title: 'x', body: '', taskId: null, workerId: null, read: false, createdAt: '' } });
    expect(gotA).toHaveLength(1); // local, no echo duplicate
    expect(gotB).toHaveLength(1); // relayed
  });

  it('routes worker messages to the instance holding the socket and tracks presence', () => {
    const { a, b } = pair();
    const received: unknown[] = [];
    const unregister = b.registerWorker('w1', (m) => received.push(m));
    expect(a.isWorkerConnected('w1')).toBe(true); // learned via presence
    expect(a.sendToWorker('w1', { type: 'task.offer', taskId: 't1' })).toBe(false); // relayed, not local
    expect(received).toEqual([{ type: 'task.offer', taskId: 't1' }]);
    unregister();
    expect(a.isWorkerConnected('w1')).toBe(false);
  });

  it('an instance that starts later learns about workers already connected elsewhere', () => {
    const handlers: Array<(ch: string, p: string) => void> = [];
    const bus = { publish: (ch: string, p: string) => handlers.forEach((h) => h(ch, p)) };
    const a = new LiveHub();
    handlers.push(a.attachBridge(bus).receive);
    a.registerWorker('w-early', () => undefined);
    const late = new LiveHub(); // e.g. a new replica after a scale-up or restart
    const { receive } = late.attachBridge(bus);
    handlers.push(receive);
    // The late instance asks for a snapshot when it attaches; the reply arrives through the bus.
    late.requestPresence();
    expect(late.isWorkerConnected('w-early')).toBe(true);
  });

  it('forgets workers of an instance that stopped refreshing its presence (crashed replica)', () => {
    let now = 1_000_000;
    const handlers: Array<(ch: string, p: string) => void> = [];
    const bus = { publish: (ch: string, p: string) => handlers.forEach((h) => h(ch, p)) };
    const a = new LiveHub({ presenceIntervalMs: 1000, now: () => now });
    const b = new LiveHub({ presenceIntervalMs: 1000, now: () => now });
    handlers.push(a.attachBridge(bus).receive, b.attachBridge(bus).receive);
    b.registerWorker('w1', () => undefined);
    expect(a.isWorkerConnected('w1')).toBe(true);
    // b refreshes while alive...
    now += 2000;
    b.announcePresence();
    expect(a.isWorkerConnected('w1')).toBe(true);
    // ...then dies without saying goodbye.
    now += 3500;
    expect(a.isWorkerConnected('w1')).toBe(false);
    a.stop();
    b.stop();
  });

  it('a throwing subscriber does not break publishing', () => {
    const hub = new LiveHub();
    const ok: unknown[] = [];
    hub.subscribeOrg('o', () => {
      throw new Error('boom');
    });
    hub.subscribeOrg('o', (m) => ok.push(m));
    expect(() => hub.publishToOrg('o', { type: 'notification', notification: { id: 'n', type: 't', title: 'x', body: '', taskId: null, workerId: null, read: false, createdAt: '' } })).not.toThrow();
    expect(ok).toHaveLength(1);
  });
});
