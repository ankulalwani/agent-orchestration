import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { API_PREFIX, liveMessage } from '@ao/contracts';
import { databaseHealthy } from '@ao/database';
import { MAX_WORKER_PACKAGE_BYTES, type Services } from '@ao/server';
import { AppError } from '@ao/core';
import { createRouter, installErrorHandling } from './http.js';
import { userRoutes } from './routes/user-routes.js';
import { workerRoutes, workerSocket } from './routes/worker-routes.js';
import { buildOpenApi } from './openapi.js';

/**
 * Extension point (spec §70, docs/PUBLIC_PRIVATE_BOUNDARY.md). Runs after the security plugins and before
 * the core routes, so a distribution can add `preHandler` hooks (for example usage limits) and its own
 * routes without forking the core. The core never depends on an extension.
 */
export type ControlPlaneExtension = (app: FastifyInstance, services: Services) => Promise<void> | void;

export interface BuildAppOptions {
  /** Serve the built web app from this directory (single-container deployments). */
  webDistDir?: string;
  logger?: boolean;
  extend?: ControlPlaneExtension;
}

export async function buildApp(services: Services, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const cfg = services.config;
  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] } : false,
    trustProxy: cfg.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  installErrorHandling(app);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        imgSrc: ["'self'", 'data:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  // CORS origins and rate limits are read per request: administrators can change them while the
  // server runs (Server settings, SELFHOST-002).
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || cfg.CORS_ORIGINS.split(',').map((o) => o.trim()).includes(origin)),
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-client', 'x-correlation-id', 'idempotency-key'],
    exposedHeaders: ['x-correlation-id'],
  });
  await app.register(rateLimit, { max: () => cfg.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', allowList: (req) => req.url.startsWith(API_PREFIX + '/worker/') && req.headers.authorization?.startsWith('Bearer aow_') === true });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.addHook('onResponse', async (req, reply) => {
    services.metrics.httpRequests.inc({ method: req.method, route: req.routeOptions?.url ?? 'unknown', status: String(reply.statusCode) });
  });

  // Health & metrics (spec §61).
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply) => {
    const mongo = await databaseHealthy();
    const queue = await services.queue.healthy();
    const ok = mongo && queue;
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', mongo, queue, queueDriver: services.queue.driver });
  });
  if (cfg.METRICS_ENABLED) {
    app.get('/metrics', async (_req, reply) => {
      reply.header('content-type', services.metrics.registry.contentType);
      return services.metrics.registry.metrics();
    });
  }
  app.get(API_PREFIX + '/server-info', async () => ({
    name: 'Agent Orchestration',
    apiVersion: 'v1',
    deploymentMode: cfg.DEPLOYMENT_MODE,
    registrationOpen: cfg.ALLOW_REGISTRATION,
  }));

  if (opts.extend) await opts.extend(app, services);

  // Integration webhooks (spec §74): the raw body is needed to check the signature.
  await app.register(async (scope) => {
    scope.addContentTypeParser(['application/json', 'text/plain'], { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post(API_PREFIX + '/hooks/:id', async (req, reply) => {
      const r = await services.integrations.deliver((req.params as { id: string }).id, req.headers, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      return reply.code(r.status === 'created' ? 201 : 200).send(r);
    });
    // GitHub App webhooks: signed with the app's webhook secret.
    scope.post(API_PREFIX + '/github/webhook', async (req, reply) => {
      const r = await services.github.webhook(req.headers, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      return reply.code(r.code).send({ status: r.status });
    });
  });
  // GitHub redirects the browser back here (app created, installed, member authorized); each ends on the dashboard.
  const q = (req: { query: unknown }, k: string) => {
    const v = (req.query as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : undefined;
  };
  app.get(API_PREFIX + '/github/app/callback', async (req, reply) => reply.redirect(await services.github.completeManifest(q(req, 'code'), q(req, 'state'))));
  app.get(API_PREFIX + '/github/app/setup', async (req, reply) => reply.redirect(await services.github.completeInstall(q(req, 'installation_id'), q(req, 'state'))));
  app.get(API_PREFIX + '/github/user/callback', async (req, reply) => reply.redirect(await services.github.completeUserAuthorization(q(req, 'code'), q(req, 'state'))));

  // Worker releases (WORKER-012): uploads are raw bytes; downloads are public (releases are signed).
  await app.register(async (scope) => {
    scope.addContentTypeParser(['application/gzip', 'application/octet-stream', 'application/x-gzip'], { parseAs: 'buffer', bodyLimit: MAX_WORKER_PACKAGE_BYTES }, (_req, body, done) => done(null, body));
    scope.put(API_PREFIX + '/admin/worker-releases/:channel/:version/package', { bodyLimit: MAX_WORKER_PACKAGE_BYTES }, async (req) => {
      const h = req.headers.authorization;
      if (!h?.startsWith('Bearer ') || h.startsWith('Bearer aow_') || h.startsWith('Bearer aot_')) throw new AppError('UNAUTHENTICATED', 'Sign in as a server administrator');
      const claims = await services.auth.verifyAccess(h.slice(7));
      if (!claims.pa) throw new AppError('FORBIDDEN', 'Only server administrators can publish worker releases');
      const { channel, version } = req.params as { channel: string; version: string };
      return services.workerReleases.uploadPackage({ userId: claims.sub, correlationId: req.correlationId, ip: req.ip }, channel, version, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    });
  });
  app.get(API_PREFIX + '/worker-releases/:channel/manifest.json', async (req) => services.workerReleases.manifest((req.params as { channel: string }).channel));
  app.get(API_PREFIX + '/worker-releases/:channel/:version/package.tgz', async (req, reply) => {
    const { channel, version } = req.params as { channel: string; version: string };
    const body = await services.workerReleases.package(channel, version);
    return reply.type('application/gzip').header('content-disposition', `attachment; filename="agent-orchestration-worker-${version}.tgz"`).send(body);
  });

  // One-click worker install (public; the scripts hold nothing secret). `curl … | sh` and `irm … | iex` fetch these.
  const text = (reply: FastifyReply, type: string, body: string) => reply.type(type).header('cache-control', 'no-cache').send(body);
  app.get(API_PREFIX + '/install/worker.sh', async (_req, reply) => text(reply, 'text/x-shellscript; charset=utf-8', services.workerInstall.shellScript()));
  app.get(API_PREFIX + '/install/worker.ps1', async (_req, reply) => text(reply, 'text/plain; charset=utf-8', services.workerInstall.powershellScript()));
  app.get(API_PREFIX + '/install/bootstrap.mjs', async (_req, reply) => text(reply, 'text/javascript; charset=utf-8', services.workerInstall.bootstrap()));
  app.get(API_PREFIX + '/install/config', async () => services.workerInstall.settings());
  app.get(API_PREFIX + '/install/commands', async () => services.workerInstall.commands());

  const { route, specs } = createRouter(app, services, API_PREFIX);
  userRoutes(route, services);
  workerRoutes(route, services);
  workerSocket(app, services, API_PREFIX);
  app.get(API_PREFIX + '/openapi.json', async () => buildOpenApi(specs, cfg.PUBLIC_URL));

  // Browser/mobile live stream (spec §54). First message must authenticate: {type:'auth', token, organizationId}.
  app.get(API_PREFIX + '/live', { websocket: true }, (socket, req) => {
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => socket.close(4401, 'auth timeout'), 10_000);
    socket.on('message', async (raw: Buffer) => {
      if (unsubscribe) return; // only the auth message is accepted from clients
      try {
        const msg = z.object({ type: z.literal('auth'), token: z.string(), organizationId: z.string() }).parse(JSON.parse(raw.toString('utf8')));
        const claims = await services.auth.verifyAccess(msg.token);
        const actor = await services.orgs.resolveActor(claims.sub, msg.organizationId, req.correlationId);
        clearTimeout(timer);
        unsubscribe = services.live.subscribeOrg(actor.organizationId, (m) => {
          // A subscriber must never throw back into the publisher (e.g. a worker heartbeat).
          const parsed = liveMessage.safeParse(m);
          if (!parsed.success) return void req.log.warn({ issues: parsed.error.issues.length }, 'dropped invalid live message');
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(parsed.data));
        });
        socket.send(JSON.stringify({ type: 'ready' }));
      } catch {
        socket.close(4401, 'unauthenticated');
      }
    });
    socket.on('close', () => {
      clearTimeout(timer);
      unsubscribe?.();
    });
  });

  // One not-found handler: JSON 404 for API/unknown routes, SPA fallback when serving the web build.
  const serveWeb = Boolean(opts.webDistDir && fs.existsSync(path.join(opts.webDistDir, 'index.html')));
  if (serveWeb) await app.register(fastifyStatic, { root: path.resolve(opts.webDistDir!), wildcard: false });
  app.setNotFoundHandler((req, reply) => {
    if (serveWeb && req.method === 'GET' && !req.url.startsWith('/api/') && !['/healthz', '/readyz', '/metrics'].includes(req.url)) return reply.sendFile('index.html');
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', correlationId: req.correlationId } });
  });

  return app;
}
