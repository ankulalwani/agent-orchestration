import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  claimResponse,
  discoveryReport,
  discoveryResponse,
  eventBatchRequest,
  eventBatchResponse,
  pairingPollRequest,
  pairingPollResponse,
  pairingStartRequest,
  pairingStartResponse,
  serverToWorker,
  transitionRequest,
  workerToServer,
  WORKER_PROTOCOL_VERSION,
  type ServerToWorker,
} from '@ao/contracts';
import { randomUUID } from 'node:crypto';
import { AppError, createLogger } from '@ao/core';
import { ALLOWED_ARTIFACT_TYPES, MAX_ARTIFACT_BYTES } from '@ao/server';
import type { Services } from '@ao/server';
import type { createRouter } from '../http.js';

const log = createLogger('worker-ws');
type Route = ReturnType<typeof createRouter>['route'];

/** Worker-facing endpoints (spec §13, §14, §107). Authenticated with the worker credential. */
export function workerRoutes(route: Route, s: Services) {
  route({ method: 'POST', path: '/worker/pairing', summary: 'Start device-code pairing', tag: 'worker-protocol', auth: 'none', body: pairingStartRequest, response: pairingStartResponse }, ({ body }) =>
    s.workers.startPairing(body),
  );
  route({ method: 'POST', path: '/worker/pairing/poll', summary: 'Poll pairing status', tag: 'worker-protocol', auth: 'none', body: pairingPollRequest, response: pairingPollResponse }, ({ body }) =>
    s.workers.pollPairing(body.pairingId, body.pollSecret),
  );
  route({ method: 'GET', path: '/worker/me', summary: 'Worker identity', tag: 'worker-protocol', auth: 'worker' }, async ({ worker }) => ({
    workerId: worker.workerId,
    organizationId: worker.organizationId,
    protocol: WORKER_PROTOCOL_VERSION,
    timing: s.timing,
  }));
  route(
    {
      method: 'POST',
      path: '/worker/projects/:projectId/readiness',
      summary: 'Submit repository facts for a readiness request',
      tag: 'worker-protocol',
      auth: 'worker',
      body: z.object({ requestId: z.string(), facts: z.record(z.unknown()).nullable(), error: z.string().max(2000).nullable().default(null) }),
    },
    async ({ worker, params, body }) => {
      await s.projects.completeReadiness(worker, params.projectId!, body.requestId, body.facts as never, body.error);
      return { ok: true };
    },
  );
  route(
    {
      method: 'POST',
      path: '/worker/tasks/:taskId/artifacts',
      summary: 'Upload an artifact (base64, ≤ 8 MB) for a task this worker owns',
      tag: 'worker-protocol',
      auth: 'worker',
      bodyLimit: 12 * 1024 * 1024,
      body: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/), contentType: z.enum(ALLOWED_ARTIFACT_TYPES as [string, ...string[]]), data: z.string().max(Math.ceil((MAX_ARTIFACT_BYTES * 4) / 3) + 4) }),
    },
    async ({ worker, params, body }) => {
      const task = await s.tasks.getLean(worker.organizationId, params.taskId!);
      if (String(task.workerId) !== worker.workerId) throw new AppError('LEASE_LOST', 'This worker does not own the task');
      const buf = Buffer.from(body.data, 'base64');
      if (buf.length > MAX_ARTIFACT_BYTES) throw new AppError('VALIDATION_FAILED', 'Artifact too large');
      const key = `${worker.organizationId}/${params.taskId}/${randomUUID().slice(0, 8)}-${body.name}`;
      await s.artifacts.put(key, buf, body.contentType);
      return { key };
    },
  );
  route(
    { method: 'POST', path: '/worker/discovery', summary: 'Report the Git repositories found on this worker; returns the checkouts to map', tag: 'worker-protocol', auth: 'worker', bodyLimit: 16 * 1024 * 1024, body: discoveryReport, response: discoveryResponse },
    ({ worker, body }) => s.discovery.report(worker, body),
  );
  route({ method: 'POST', path: '/worker/clones/:requestId/token', summary: 'Token for a requested clone (GitHub App repositories)', tag: 'worker-protocol', auth: 'worker' }, ({ worker, params }) =>
    s.discovery.cloneToken(worker, params.requestId!),
  );
  route(
    { method: 'POST', path: '/worker/clones/:requestId/result', summary: 'Outcome of a requested clone', tag: 'worker-protocol', auth: 'worker', body: z.object({ ok: z.boolean(), localPath: z.string().max(1000).nullable().default(null), error: z.string().max(2000).nullable().default(null) }) },
    ({ worker, params, body }) => s.discovery.cloneResult(worker, params.requestId!, body),
  );
  route({ method: 'POST', path: '/worker/tasks/:taskId/git-credentials', summary: "Short-lived GitHub App tokens for the task's repositories (push, pull requests)", tag: 'worker-protocol', auth: 'worker' }, ({ worker, params }) =>
    s.discovery.taskCredentials(worker, params.taskId!),
  );
  route({ method: 'GET', path: '/worker/offers', summary: 'Polling fallback for task offers', tag: 'worker-protocol', auth: 'worker' }, async ({ worker }) => ({
    taskIds: await s.tasks.offersFor(worker),
  }));
  route({ method: 'GET', path: '/worker/tasks/:taskId', summary: 'Claim payload for a task this worker still owns (reattach after restart)', tag: 'worker-protocol', auth: 'worker', response: claimResponse }, ({ worker, params }) =>
    s.tasks.ownedTaskInfo(worker, params.taskId!),
  );
  route({ method: 'POST', path: '/worker/tasks/:taskId/claim', summary: 'Atomically claim a task', tag: 'worker-protocol', auth: 'worker', response: claimResponse }, ({ worker, params }) =>
    s.tasks.claim(worker, params.taskId!),
  );
  route({ method: 'POST', path: '/worker/tasks/:taskId/transition', summary: 'Lease-checked, idempotent status transition', tag: 'worker-protocol', auth: 'worker', body: transitionRequest }, ({ worker, params, body }) =>
    s.tasks.transition(worker, params.taskId!, body),
  );
  route({ method: 'POST', path: '/worker/events', summary: 'Ingest buffered events (deduplicated)', tag: 'worker-protocol', auth: 'worker', body: eventBatchRequest, response: eventBatchResponse }, ({ worker, body }) =>
    s.tasks.ingestEvents(worker, body.events),
  );
  route(
    { method: 'POST', path: '/worker/heartbeat', summary: 'HTTP heartbeat (fallback when WS is unavailable)', tag: 'worker-protocol', auth: 'worker', body: z.object({ payload: z.any() }) },
    async ({ worker, body }) => {
      const parsed = workerToServer.parse({ type: 'heartbeat', payload: body.payload });
      if (parsed.type !== 'heartbeat') return;
      return s.workers.heartbeat(worker, parsed.payload);
    },
  );
}

/** Worker WebSocket: push offers/control, receive heartbeats. Auth via Authorization header. */
export function workerSocket(app: FastifyInstance, s: Services, prefix: string) {
  app.get(prefix + '/worker/ws', { websocket: true }, async (socket, req) => {
    // Attach listeners synchronously; messages arriving before auth completes are buffered, not lost.
    const pending: Buffer[] = [];
    let handle: ((raw: Buffer) => Promise<void>) | null = null;
    let onClose: (() => void) | null = null;
    socket.on('message', (raw: Buffer) => (handle ? void handle(raw) : pending.push(raw)));
    socket.on('close', () => onClose?.());
    const h = req.headers.authorization;
    let worker;
    try {
      if (!h?.startsWith('Bearer aow_')) throw new Error('missing credential');
      worker = await s.workers.authenticate(h.slice(7));
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHENTICATED', message: 'Invalid worker credential' } satisfies ServerToWorker));
      socket.close(4401, 'unauthenticated');
      return;
    }
    if (socket.readyState !== socket.OPEN) return; // closed while authenticating
    const send = (msg: ServerToWorker) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(serverToWorker.parse(msg)));
    };
    const unregister = s.live.registerWorker(worker.workerId, send);
    send({ type: 'welcome', workerId: worker.workerId, heartbeatMs: s.timing.heartbeatMs, leaseMs: s.timing.leaseMs });
    log.info({ workerId: worker.workerId }, 'worker connected');

    handle = async (raw: Buffer) => {
      try {
        const msg = workerToServer.parse(JSON.parse(raw.toString('utf8')));
        if (msg.type === 'heartbeat') {
          const ack = await s.workers.heartbeat(worker, msg.payload);
          send({ type: 'heartbeat.ack', ...ack });
        }
      } catch (e) {
        send({ type: 'error', code: 'BAD_MESSAGE', message: 'Invalid message' });
        log.warn({ err: String(e), workerId: worker.workerId }, 'bad worker message');
      }
    };
    onClose = () => {
      unregister();
      log.info({ workerId: worker.workerId }, 'worker disconnected');
    };
    for (const raw of pending.splice(0)) await handle(raw);
    // Offer any tasks already waiting for this worker.
    for (const taskId of await s.tasks.offersFor(worker)) send({ type: 'task.offer', taskId });
    // And the clones asked of it while it was offline.
    await s.discovery.deliverQueuedClones({ ...worker, correlationId: req.correlationId }).catch((e) => log.warn({ err: String(e), workerId: worker.workerId }, 'queued clones were not sent'));
  });
}
