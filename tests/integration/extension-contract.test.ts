/**
 * The extension contract (docs/PUBLIC_PRIVATE_BOUNDARY.md): what a distribution built on this core may rely on
 * when it passes `extend` to `buildApp`/`startControlPlane`. Also: the self-hosted API has no limits (spec §2.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { API_PREFIX } from '@ao/contracts';
import type { Services } from '@ao/server';
import { buildApp, type ControlPlaneExtension } from '../../apps/api/src/app.js';
import { makeServices } from '../helpers.js';

describe('control-plane extension contract', () => {
  let s: Services;
  let core: FastifyInstance;
  let extended: FastifyInstance;
  const seen: string[] = [];
  let received: Services | null = null;

  const extension: ControlPlaneExtension = async (app, services) => {
    received = services;
    // A hook sees core routes and may answer instead of them (for example a usage limit).
    app.addHook('preHandler', async (req, reply) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.method === 'POST' && /\/tasks\/?$/.test(req.url) && req.headers['x-test-limit'] === 'reached') {
        return reply.code(402).send({ error: { code: 'LIMIT_REACHED', message: 'limit reached' } });
      }
    });
    // Its own routes under the API prefix, using the core services.
    app.get(`${API_PREFIX}/extension/me`, async (req) => {
      const claims = await services.auth.verifyAccess(String(req.headers.authorization).slice(7));
      return { userId: claims.sub };
    });
  };

  beforeAll(async () => {
    await startTestDatabase();
    s = (await makeServices()).services;
    core = await buildApp(s);
    extended = await buildApp(s, { extend: extension });
  });
  afterAll(async () => {
    await core.close();
    await extended.close();
    await stopTestDatabase();
  });

  const call = (app: FastifyInstance, method: 'GET' | 'POST', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url: API_PREFIX + url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as never });

  async function signup(app: FastifyInstance, name: string) {
    const b = (await call(app, 'POST', '/auth/register', undefined, { email: `${name}-${Date.now()}@example.com`, password: 'contract-password-1', name })).json();
    const orgId = b.memberships[0].organizationId as string;
    const project = (await call(app, 'POST', `/orgs/${orgId}/projects`, b.accessToken, { name: 'p' })).json();
    return { token: b.accessToken as string, orgId, projectId: project.id as string };
  }

  it('receives the same services instance as the core', () => {
    expect(received).toBe(s);
  });

  it('adds routes that use core authentication', async () => {
    const u = await signup(extended, 'ext-routes');
    const r = await call(extended, 'GET', '/extension/me', u.token);
    expect(r.statusCode).toBe(200);
    expect(r.json().userId).toBeTruthy();
    expect((await call(core, 'GET', '/extension/me', u.token)).statusCode).toBe(404);
  });

  it('runs its hooks before core routes and can answer instead of them', async () => {
    const u = await signup(extended, 'ext-hooks');
    const task = { projectId: u.projectId, title: 't', prompt: 'p' };
    const blocked = await call(extended, 'POST', `/orgs/${u.orgId}/tasks`, u.token, task, { 'x-test-limit': 'reached' });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe('LIMIT_REACHED');
    expect(seen).toContain(`POST ${API_PREFIX}/orgs/${u.orgId}/tasks`);
    expect((await call(extended, 'POST', `/orgs/${u.orgId}/tasks`, u.token, task)).statusCode).toBe(201);
  });

  it('the self-hosted API has no usage limits (spec §2.1)', async () => {
    const u = await signup(core, 'no-limits');
    for (let i = 0; i < 25; i++) {
      expect((await call(core, 'POST', `/orgs/${u.orgId}/tasks`, u.token, { projectId: u.projectId, title: `t${i}`, prompt: 'p' })).statusCode).toBe(201);
    }
    expect((await call(core, 'GET', '/server-info')).json()).toMatchObject({ deploymentMode: 'self-hosted' });
  });
});
