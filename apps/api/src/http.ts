import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { AppError, captureError, isAppError, newCorrelationId } from '@ao/core';
import { API_TOKEN_PREFIX, type Actor, type ApiTokenScope, type Services, type WorkerActor } from '@ao/server';

/** Route metadata collected for the generated OpenAPI document (spec §71). */
export interface RouteSpec {
  method: HTTPMethods;
  path: string;
  summary: string;
  tag: string;
  auth: 'none' | 'user' | 'org' | 'worker';
  permission?: string;
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  response?: ZodTypeAny;
  /** `user` routes: accept personal API tokens too (by default only signed-in sessions). `org` routes always accept them. */
  allowTokens?: boolean;
  /** Per-route request body limit in bytes (default: the server-wide 2 MB). */
  bodyLimit?: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    userId?: string;
    platformAdmin?: boolean;
    /** Set when the request authenticated with a personal API token. */
    apiToken?: ApiTokenScope;
    actor?: Actor;
    worker?: WorkerActor;
  }
}

type Ctx<B, Q> = {
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: Record<string, string>;
  actor: Actor;
  worker: WorkerActor;
  userId: string;
};

export function createRouter(app: FastifyInstance, services: Services, prefix: string) {
  const specs: RouteSpec[] = [];

  async function authenticateUser(req: FastifyRequest, allowTokens: boolean) {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ') || h.startsWith('Bearer aow_')) throw new AppError('UNAUTHENTICATED', 'Sign in required');
    if (h.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) {
      if (!allowTokens) throw new AppError('FORBIDDEN', 'API tokens cannot be used for this; sign in instead');
      const t = await services.apiTokens.authenticate(h.slice(7));
      req.userId = t.userId;
      req.apiToken = t.scope;
      req.platformAdmin = false;
      return;
    }
    const claims = await services.auth.verifyAccess(h.slice(7));
    req.userId = claims.sub;
    req.platformAdmin = claims.pa;
  }

  async function authenticateWorker(req: FastifyRequest) {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer aow_')) throw new AppError('UNAUTHENTICATED', 'Worker credential required');
    req.worker = { ...(await services.workers.authenticate(h.slice(7))), correlationId: req.correlationId };
  }

  function route<B extends ZodTypeAny = z.ZodUndefined, Q extends ZodTypeAny = z.ZodUndefined>(
    spec: Omit<RouteSpec, 'body' | 'query'> & { body?: B; query?: Q },
    handler: (ctx: Ctx<z.output<B>, z.output<Q>>) => Promise<unknown>,
  ) {
    specs.push(spec as RouteSpec);
    app.route({
      method: spec.method,
      url: prefix + spec.path,
      ...(spec.bodyLimit ? { bodyLimit: spec.bodyLimit } : {}),
      // Sign-in routes get a strict limit against guessing. Not refresh: it needs a valid refresh token, and
      // every page load uses it, so a strict limit would sign out people who browse quickly.
      config: spec.auth === 'none' && spec.tag === 'auth' && !['/auth/refresh', '/auth/device/poll'].includes(spec.path) ? { rateLimit: { max: () => services.config.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } } : {},
      handler: async (req, reply) => {
        if (spec.auth === 'user' || spec.auth === 'org') await authenticateUser(req, spec.auth === 'org' || Boolean(spec.allowTokens));
        if (spec.auth === 'worker') await authenticateWorker(req);
        const params = (req.params ?? {}) as Record<string, string>;
        if (spec.auth === 'org') {
          // A token works in its own organization only (others look like they don't exist), with its role.
          if (req.apiToken && req.apiToken.organizationId !== params.orgId) throw new AppError('NOT_FOUND', 'Organization not found');
          req.actor = await services.orgs.resolveActor(req.userId!, params.orgId!, req.correlationId, req.ip, req.platformAdmin);
          if (req.apiToken) req.actor.role = req.apiToken.role;
        }
        const body = spec.body ? spec.body.parse(req.body ?? {}) : undefined;
        const query = spec.query ? spec.query.parse(req.query ?? {}) : undefined;
        const result = await handler({ req, reply, body, query, params, actor: req.actor!, worker: req.worker!, userId: req.userId! });
        if (reply.sent) return;
        if (result === undefined) return reply.code(204).send();
        return reply.send(result);
      },
    });
  }

  return { route, specs };
}

/** Request details for error reports: route pattern, never the URL (which may carry tokens) or bodies. */
function requestContext(req: FastifyRequest) {
  return { correlationId: req.correlationId, tags: { component: 'http', method: req.method, route: req.routeOptions?.url ?? 'unknown' } };
}

export function installErrorHandling(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : newCorrelationId();
    reply.header('x-correlation-id', req.correlationId);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request validation failed',
          context: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
          correlationId: req.correlationId,
        },
      });
    }
    if (isAppError(err)) {
      if (err.httpStatus >= 500) {
        req.log.error({ err: err.message, code: err.code }, 'request failed');
        captureError(err, requestContext(req));
      }
      return reply.code(err.httpStatus).send({ error: { ...err.toJSON(), correlationId: req.correlationId } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'Too many requests', retryable: true, correlationId: req.correlationId } });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.code(e.statusCode).send({ error: { code: 'VALIDATION_FAILED', message: e.message ?? 'Bad request', correlationId: req.correlationId } });
    }
    // Unknown errors: log internally, never leak details (spec §112).
    req.log.error({ err: String(err) }, 'unhandled error');
    captureError(err, requestContext(req));
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. Reference: ' + req.correlationId, correlationId: req.correlationId, retryable: true } });
  });
}
