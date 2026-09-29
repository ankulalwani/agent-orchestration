import { z } from 'zod';
import {
  acceptInvitationRequest,
  addMemberRequest,
  acceptDiscoveredRequest,
  discoveredSuggestionDto,
  dismissDiscoveredRequest,
  addRepositoryRequest,
  addMemberResponse,
  invitationDto,
  invitationPreviewDto,
  approvePairingRequest,
  authResponse,
  createOrganizationRequest,
  createProjectRequest,
  createTaskRequest,
  createTeamRequest,
  cursorQuery,
  installCapabilityRequest,
  catalogQuery,
  categoryOverrideRequest,
  facetsDto,
  facetsQuery,
  publicSuggestQuery,
  suggestRequest,
  suggestionsDto,
  catalogPageDto,
  curatePackageRequest,
  importRegistryRequest,
  packageListingInput,
  publishPackageRequest,
  reviewPackageRequest,
  versionStatusRequest,
  loginRequest,
  mfaDisableRequest,
  mfaEnableRequest,
  mfaEnableResponse,
  mfaSetupResponse,
  oauthCompleteRequest,
  oauthProviderDto,
  overviewDto,
  passwordResetConfirm,
  passwordResetRequest,
  projectDto,
  refreshRequest,
  registerCapabilityRequest,
  registerRequest,
  taskActionRequest,
  taskDto,
  taskListQuery,
  updateMemberRequest,
  updateOrganizationRequest,
  updateServerSettingsRequest,
  createApiTokenRequest,
  resetMfaRequest,
  deviceLoginStartRequest,
  deviceLoginStartResponse,
  deviceLoginPollRequest,
  deviceLoginDecision,
  createIntegrationRequest,
  createGithubRepositoryRequest,
  githubManifestRequest,
  githubManifestResponse,
  githubRedirectResponse,
  githubStatusDto,
  githubSyncResponse,
  updateIntegrationRequest,
  setFeatureFlagRequest,
  updateProjectRequest,
  updateRepositoryRequest,
  updateWorkerRequest,
  verifyEmailRequest,
  workerDto,
} from '@ao/contracts';
import { AppError } from '@ao/core';
import { publicCatalogEnabled, requirePermission, requirePlatformAdmin, serverOverview, type Services } from '@ao/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { createRouter } from '../http.js';

type Route = ReturnType<typeof createRouter>['route'];

const REFRESH_COOKIE = 'ao_rt';

/**
 * Browser clients (header `x-client: web`) receive the refresh token as an httpOnly, SameSite=Strict
 * cookie scoped to the auth path, and it is omitted from the JSON body. Refreshing via cookie requires
 * the custom `x-client: web` header, which cross-site forms cannot send (CSRF protection, spec §58).
 * Mobile/CLI clients receive the token in the body and store it in the platform keystore.
 */
function deliverSession(req: FastifyRequest, reply: FastifyReply, session: z.infer<typeof authResponse>, secure: boolean) {
  if (req.headers['x-client'] === 'web') {
    reply.setCookie(REFRESH_COOKIE, session.refreshToken, { httpOnly: true, sameSite: 'strict', secure, path: '/api/v1/auth', maxAge: 30 * 86400 });
    return { ...session, refreshToken: '' };
  }
  return session;
}

export function userRoutes(route: Route, s: Services) {
  const secure = s.config.PUBLIC_URL.startsWith('https://');
  const meta = (req: FastifyRequest) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });

  // ── Auth ───────────────────────────────────────────────────────────────────
  route({ method: 'POST', path: '/auth/register', summary: 'Create an account and organization', tag: 'auth', auth: 'none', body: registerRequest, response: authResponse }, async ({ req, reply, body }) =>
    deliverSession(req, reply, await s.auth.register(body, meta(req)), secure),
  );
  route({ method: 'POST', path: '/auth/login', summary: 'Sign in', tag: 'auth', auth: 'none', body: loginRequest, response: authResponse }, async ({ req, reply, body }) =>
    deliverSession(req, reply, await s.auth.login(body.email, body.password, meta(req), body.mfaCode), secure),
  );
  route({ method: 'POST', path: '/auth/refresh', summary: 'Rotate refresh token', tag: 'auth', auth: 'none', body: refreshRequest.partial(), response: authResponse }, async ({ req, reply, body }) => {
    const fromCookie = req.headers['x-client'] === 'web' ? req.cookies[REFRESH_COOKIE] : undefined;
    const token = body.refreshToken ?? fromCookie;
    // No session at all is not an error (e.g. a first visit); an invalid token still yields 401.
    if (!token) {
      reply.code(204);
      return undefined;
    }
    return deliverSession(req, reply, await s.auth.refresh(token, meta(req)), secure);
  });
  route({ method: 'POST', path: '/auth/logout', summary: 'Revoke session', tag: 'auth', auth: 'none', body: refreshRequest.partial() }, async ({ req, reply, body }) => {
    const token = body.refreshToken ?? req.cookies[REFRESH_COOKIE];
    if (token) await s.auth.logout(token);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  });
  route({ method: 'POST', path: '/auth/password-reset', summary: 'Request a password reset email', tag: 'auth', auth: 'none', body: passwordResetRequest }, async ({ body }) => {
    await s.auth.requestPasswordReset(body.email);
    return { ok: true };
  });
  route({ method: 'POST', path: '/auth/password-reset/confirm', summary: 'Set a new password', tag: 'auth', auth: 'none', body: passwordResetConfirm }, async ({ body }) => {
    await s.auth.confirmPasswordReset(body.token, body.password);
    return { ok: true };
  });
  route({ method: 'POST', path: '/auth/verify-email', summary: 'Verify email address', tag: 'auth', auth: 'none', body: verifyEmailRequest }, async ({ body }) => {
    await s.auth.verifyEmail(body.token);
    return { ok: true };
  });
  route({ method: 'POST', path: '/invitations/preview', summary: 'Show an invitation before accepting it', tag: 'auth', auth: 'none', body: acceptInvitationRequest, response: invitationPreviewDto }, ({ body }) =>
    s.invitations.preview(body.token),
  );
  route({ method: 'POST', path: '/invitations/accept', summary: 'Accept an invitation as the signed-in user', tag: 'auth', auth: 'user', body: acceptInvitationRequest }, ({ userId, body }) =>
    s.invitations.accept(userId, body.token),
  );
  // ── OAuth / OpenID Connect ──────────────────────────────────────────────────
  route({ method: 'GET', path: '/auth/oauth/providers', summary: 'Configured sign-in providers', tag: 'auth', auth: 'none', response: z.array(oauthProviderDto) }, async () => s.oauth.list());
  route(
    { method: 'GET', path: '/auth/oauth/:provider/start', summary: 'Start signing in with a provider (redirects to it)', tag: 'auth', auth: 'none', query: z.object({ next: z.string().max(500).optional(), invitation: z.string().max(200).optional() }) },
    async ({ reply, params, query }) => reply.redirect(await s.oauth.start(params.provider!, { next: query.next, invitationToken: query.invitation }), 302),
  );
  route(
    { method: 'GET', path: '/auth/oauth/:provider/callback', summary: 'Provider redirect target (redirects to the web app)', tag: 'auth', auth: 'none', query: z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }) },
    async ({ reply, params, query }) => reply.redirect(await s.oauth.callback(params.provider!, query), 302),
  );
  route({ method: 'POST', path: '/auth/oauth/complete', summary: 'Exchange the sign-in ticket for a session', tag: 'auth', auth: 'none', body: oauthCompleteRequest, response: authResponse }, async ({ req, reply, body }) =>
    deliverSession(req, reply, await s.oauth.complete(body.ticket, body.mfaCode, meta(req)), secure),
  );
  route({ method: 'POST', path: '/me/oauth/:provider/link', summary: 'Start connecting a provider to your account (returns its URL)', tag: 'auth', auth: 'user' }, async ({ userId, params }) => ({
    url: await s.oauth.start(params.provider!, { linkUserId: userId, next: '/settings' }),
  }));
  route({ method: 'DELETE', path: '/me/identities/:provider', summary: 'Disconnect a provider from your account', tag: 'auth', auth: 'user' }, async ({ userId, params }) => {
    await s.oauth.unlink(userId, params.provider!);
  });
  route({ method: 'POST', path: '/me/mfa/setup', summary: 'Start two-factor setup (returns a new TOTP secret)', tag: 'auth', auth: 'user', response: mfaSetupResponse }, ({ userId }) =>
    s.auth.setupMfa(userId),
  );
  route({ method: 'POST', path: '/me/mfa/enable', summary: 'Confirm a code and turn on two-factor authentication', tag: 'auth', auth: 'user', body: mfaEnableRequest, response: mfaEnableResponse }, ({ userId, body }) =>
    s.auth.enableMfa(userId, body.code),
  );
  route({ method: 'POST', path: '/me/mfa/disable', summary: 'Turn off two-factor authentication', tag: 'auth', auth: 'user', body: mfaDisableRequest }, async ({ userId, body }) => {
    await s.auth.disableMfa(userId, body.password, body.code);
  });
  // ── Server administration (platform administrators) ─────────────────────────
  const overview = () =>
    serverOverview({ config: s.config, env: s.settings.env, runtime: s.settings, queue: s.queue, artifacts: s.artifacts, mailerConfigured: Boolean((s.mailer as { configured?: boolean }).configured), version: process.env.AO_VERSION ?? '0.1.0' });
  const platformActor = (req: FastifyRequest) => ({ userId: req.userId!, correlationId: req.correlationId, ip: req.ip });
  route({ method: 'GET', path: '/admin/server', summary: 'Effective server configuration and status (secrets never included)', tag: 'admin', auth: 'user' }, async ({ req }) => {
    requirePlatformAdmin(req.platformAdmin);
    await s.settings.refresh();
    return overview();
  });
  route({ method: 'PATCH', path: '/admin/server/settings', summary: 'Change server settings that can be managed in the web app (null clears a value)', tag: 'admin', auth: 'user', body: updateServerSettingsRequest }, async ({ req, body }) => {
    requirePlatformAdmin(req.platformAdmin);
    await s.settings.update(platformActor(req), body.values);
    return overview();
  });
  route({ method: 'GET', path: '/admin/features', summary: 'Feature flags with their platform and organization settings', tag: 'admin', auth: 'user' }, async ({ req }) => {
    requirePlatformAdmin(req.platformAdmin);
    return s.features.list();
  });
  route({ method: 'PUT', path: '/admin/features/:key', summary: 'Turn a feature flag on or off for everyone (null: back to its default)', tag: 'admin', auth: 'user', body: setFeatureFlagRequest }, async ({ req, params, body }) => {
    requirePlatformAdmin(req.platformAdmin);
    await s.features.set(platformActor(req), params.key!, body.enabled);
    return s.features.list();
  });
  route({ method: 'PUT', path: '/admin/features/:key/orgs/:organizationId', summary: 'Turn a feature flag on or off for one organization (null: remove the override)', tag: 'admin', auth: 'user', body: setFeatureFlagRequest }, async ({ req, params, body }) => {
    requirePlatformAdmin(req.platformAdmin);
    await s.features.set(platformActor(req), params.key!, body.enabled, params.organizationId!);
    return s.features.list();
  });
  route({ method: 'GET', path: '/admin/worker-releases', summary: 'Worker releases hosted by this server', tag: 'admin', auth: 'user' }, async ({ req }) => {
    requirePlatformAdmin(req.platformAdmin);
    return s.workerReleases.list();
  });
  route({ method: 'PUT', path: '/admin/worker-releases/:channel/manifest', summary: 'Publish a signed manifest for an uploaded worker package', tag: 'admin', auth: 'user', body: z.record(z.unknown()) }, async ({ req, params, body }) => {
    requirePlatformAdmin(req.platformAdmin);
    return s.workerReleases.publish(platformActor(req), params.channel!, body);
  });
  route({ method: 'GET', path: '/admin/users', summary: 'People on this server (search by email or name)', tag: 'admin', auth: 'user', query: z.object({ q: z.string().max(100).optional() }) }, async ({ req, query }) => {
    requirePlatformAdmin(req.platformAdmin);
    return s.auth.searchUsers(query.q);
  });
  route({ method: 'POST', path: '/admin/users/:userId/reset-mfa', summary: "Turn off someone's two-factor authentication (they are signed out and emailed)", tag: 'admin', auth: 'user', body: resetMfaRequest }, async ({ req, params, body }) => {
    requirePlatformAdmin(req.platformAdmin);
    await s.auth.resetMfaFor({ ...platformActor(req), platformAdmin: true }, params.userId!, body.reason);
  });
  route({ method: 'GET', path: '/admin/organizations', summary: 'All organizations on this server (for feature flag overrides)', tag: 'admin', auth: 'user', query: z.object({ q: z.string().max(100).optional() }) }, async ({ req, query }) => {
    requirePlatformAdmin(req.platformAdmin);
    return s.orgs.searchAll(query.q);
  });
  // ── Marketplace administration: reviews, curation, federation ───────────────
  const registryAdmin = (req: FastifyRequest) => ({ ...platformActor(req), platformAdmin: req.platformAdmin });
  route({ method: 'GET', path: '/admin/registry/reviews', summary: 'Packages waiting for a publish review', tag: 'admin', auth: 'user' }, async ({ req }) => s.registry.reviewQueue(req.platformAdmin));
  route({ method: 'POST', path: '/admin/registry/packages/:namespace/:name/review', summary: 'Approve or reject a publish request', tag: 'admin', auth: 'user', body: reviewPackageRequest }, async ({ req, params, body }) =>
    s.registry.review(registryAdmin(req), `@${params.namespace}/${params.name}`, body),
  );
  route({ method: 'POST', path: '/admin/registry/packages/:namespace/:name/curate', summary: 'Mark a package curated (shown first) or not', tag: 'admin', auth: 'user', body: curatePackageRequest }, async ({ req, params, body }) =>
    s.registry.curate(registryAdmin(req), `@${params.namespace}/${params.name}`, body.curated, body.rank),
  );
  route({ method: 'POST', path: '/admin/registry/import/mcp-registry', summary: 'Mirror servers from an MCP Registry (metadata only)', tag: 'admin', auth: 'user', body: importRegistryRequest }, async ({ req, body }) =>
    s.registry.importMcpRegistry(registryAdmin(req), body),
  );
  route({ method: 'POST', path: '/admin/registry/packages/:namespace/:name/categories', summary: 'Pin a package’s categories (null: back to automatic)', tag: 'admin', auth: 'user', body: categoryOverrideRequest }, async ({ req, params, body }) =>
    s.registry.setCategories(registryAdmin(req), `@${params.namespace}/${params.name}`, body.categories),
  );
  route({ method: 'POST', path: '/admin/registry/reclassify', summary: 'Re-run automatic categorization (stale packages, or all)', tag: 'admin', auth: 'user', body: z.object({ all: z.boolean().default(false) }) }, async ({ req, body }) =>
    s.registry.reclassify(registryAdmin(req), body.all),
  );
  // ── Public catalog (marketplace pages, sitemaps). Off unless PUBLIC_CATALOG / DEPLOYMENT_MODE=cloud. ──
  const catalogOn = (reply: FastifyReply) => {
    if (!publicCatalogEnabled(s.config)) throw new AppError('NOT_FOUND', 'Not found');
    reply.header('cache-control', 'public, max-age=300, stale-while-revalidate=3600');
  };
  route({ method: 'GET', path: '/catalog/packages', summary: 'Public marketplace search (curated first)', tag: 'registry', auth: 'none', query: catalogQuery.omit({ mine: true }), response: catalogPageDto }, async ({ reply, query }) => {
    catalogOn(reply);
    return s.registry.search(null, query);
  });
  route({ method: 'GET', path: '/catalog/packages/:namespace/:name', summary: 'One public package', tag: 'registry', auth: 'none' }, async ({ reply, params }) => {
    catalogOn(reply);
    return s.registry.get(null, params.namespace!, params.name!);
  });
  route({ method: 'GET', path: '/catalog/packages/:namespace/:name/related', summary: 'Public packages similar to one package', tag: 'registry', auth: 'none' }, async ({ reply, params }) => {
    catalogOn(reply);
    return s.registry.related(null, params.namespace!, params.name!);
  });
  route({ method: 'GET', path: '/catalog/facets', summary: 'Categories and technologies with package counts', tag: 'registry', auth: 'none', query: facetsQuery, response: facetsDto }, async ({ reply, query }) => {
    catalogOn(reply);
    return s.registry.facets(query.type);
  });
  route({ method: 'GET', path: '/catalog/suggest', summary: 'Public packages that fit a description of the work (curated first)', tag: 'registry', auth: 'none', query: publicSuggestQuery, response: suggestionsDto }, async ({ reply, query }) => {
    catalogOn(reply);
    return s.registry.suggest(null, { text: query.q, type: query.type, limit: query.limit });
  });
  route({ method: 'GET', path: '/catalog/sitemap', summary: 'Indexable public packages in stable order', tag: 'registry', auth: 'none', query: z.object({ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(50_000).default(10_000) }) }, async ({ reply, query }) => {
    catalogOn(reply);
    return s.registry.sitemap(query.page, query.limit);
  });
  // ── Device sign-in for the CLI and mobile app (approved in the web app) ────
  route({ method: 'POST', path: '/auth/device/start', summary: 'Start a device sign-in: returns a code to approve in the web app', tag: 'auth', auth: 'none', body: deviceLoginStartRequest, response: deviceLoginStartResponse }, ({ req, body }) =>
    s.deviceLogins.start(body.clientName, meta(req)),
  );
  route({ method: 'POST', path: '/auth/device/poll', summary: 'Poll a device sign-in: pending, or the session once approved', tag: 'auth', auth: 'none', body: deviceLoginPollRequest }, ({ req, body }) =>
    s.deviceLogins.poll(body.pollSecret, meta(req)),
  );
  route({ method: 'GET', path: '/auth/device/:code', summary: 'What a device sign-in code is for (to approve it)', tag: 'auth', auth: 'user' }, ({ params }) => s.deviceLogins.describe(params.code!));
  route({ method: 'POST', path: '/auth/device/:code/decision', summary: 'Approve or deny a device sign-in', tag: 'auth', auth: 'user', body: deviceLoginDecision }, async ({ req, params, body }) => {
    await s.deviceLogins.decide(req.userId!, params.code!, body.approve, req.correlationId);
  });

  // ── Personal API tokens (managed with a signed-in session only) ────────────
  route({ method: 'GET', path: '/me/tokens', summary: 'Your API tokens (never the token values)', tag: 'auth', auth: 'user' }, ({ userId }) => s.apiTokens.list(userId));
  route({ method: 'POST', path: '/me/tokens', summary: 'Create an API token for one organization; the value is returned once', tag: 'auth', auth: 'user', body: createApiTokenRequest }, ({ userId, body }) => s.apiTokens.create(userId, body));
  route({ method: 'DELETE', path: '/me/tokens/:id', summary: 'Revoke an API token', tag: 'auth', auth: 'user' }, async ({ userId, params }) => {
    await s.apiTokens.revoke(userId, params.id!);
  });
  route({ method: 'GET', path: '/me', summary: 'Current user and memberships', tag: 'auth', auth: 'user', allowTokens: true }, async ({ userId, req }) => {
    const session = await s.auth.memberships(userId);
    const { User } = await import('@ao/database');
    const u = await User.findById(userId).lean();
    if (!u) throw new AppError('UNAUTHENTICATED', 'User not found');
    const { toUserDto } = await import('@ao/server');
    const t = req.apiToken;
    // With an API token: only the token's organization, with the token's role.
    if (t) return { user: { ...toUserDto(u), platformAdmin: false }, memberships: session.filter((m) => m.organizationId === t.organizationId).map((m) => ({ ...m, role: t.role })), token: t };
    return { user: toUserDto(u), memberships: session };
  });
  route({ method: 'POST', path: '/me/push-tokens', summary: 'Register a mobile push token', tag: 'notifications', auth: 'user', body: z.object({ token: z.string().max(300), platform: z.string().max(20).optional() }) }, async ({ userId, body }) => {
    await s.queries.registerPushToken(userId, body.token, body.platform);
  });

  // ── Organizations ──────────────────────────────────────────────────────────
  route({ method: 'POST', path: '/orgs', summary: 'Create organization', tag: 'organizations', auth: 'user', body: createOrganizationRequest }, async ({ userId, body }) => {
    const org = await s.auth.createOrganizationFor(userId, body.name);
    return { id: String(org._id), name: org.name, slug: org.slug };
  });
  // ── GitHub App: repository sync ─────────────────────────────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/github', summary: 'GitHub App status, installations and your GitHub connection', tag: 'github', auth: 'org', response: githubStatusDto }, ({ actor }) => s.github.status(actor));
  route({ method: 'POST', path: '/orgs/:orgId/github/app/manifest', summary: 'Start creating the GitHub App (the browser posts the manifest to GitHub)', tag: 'github', auth: 'org', permission: 'settings.manage', body: githubManifestRequest, response: githubManifestResponse }, ({ actor, body }) =>
    s.github.startManifest(actor, body),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/github/app', summary: 'Remove the GitHub App configuration (projects stay)', tag: 'github', auth: 'org', permission: 'settings.manage' }, async ({ actor }) => {
    await s.github.removeApp(actor);
    return { ok: true };
  });
  route({ method: 'POST', path: '/orgs/:orgId/github/installations', summary: 'Link to install the app on a GitHub account', tag: 'github', auth: 'org', permission: 'settings.manage', response: githubRedirectResponse }, ({ actor }) => s.github.startInstall(actor));
  route({ method: 'DELETE', path: '/orgs/:orgId/github/installations/:installationId', summary: 'Forget an installation (projects stay)', tag: 'github', auth: 'org', permission: 'settings.manage' }, async ({ actor, params }) => {
    await s.github.forgetInstallation(actor, Number(params.installationId));
    return { ok: true };
  });
  route({ method: 'POST', path: '/orgs/:orgId/github/sync', summary: 'Sync repositories from every installation now', tag: 'github', auth: 'org', permission: 'settings.manage', response: githubSyncResponse }, ({ actor }) =>
    s.github.syncOrganization(actor, actor.organizationId),
  );
  route({ method: 'POST', path: '/orgs/:orgId/github/user', summary: 'Link to authorize the app with your GitHub account', tag: 'github', auth: 'org', response: githubRedirectResponse }, ({ actor }) => s.github.startUserAuthorization(actor));
  route({ method: 'DELETE', path: '/orgs/:orgId/github/user', summary: 'Forget your GitHub authorization', tag: 'github', auth: 'org' }, async ({ actor }) => {
    await s.github.disconnectUser(actor);
    return { ok: true };
  });
  route({ method: 'GET', path: '/orgs/:orgId/github/owners', summary: 'GitHub accounts new repositories can be created in', tag: 'github', auth: 'org' }, ({ actor }) => s.github.repositoryOwners(actor));
  route({ method: 'POST', path: '/orgs/:orgId/github/repositories', summary: 'Create a GitHub repository and add it to a (new) project', tag: 'github', auth: 'org', permission: 'project.create', body: createGithubRepositoryRequest, response: projectDto }, ({ actor, body }) =>
    s.github.createRepository(actor, body),
  );

  // ── Repositories found on workers ───────────────────────────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/discovered', summary: 'Repositories found on workers that are in no project yet', tag: 'projects', auth: 'org', response: z.array(discoveredSuggestionDto) }, ({ actor }) => s.discovery.suggestions(actor));
  route({ method: 'POST', path: '/orgs/:orgId/discovered/accept', summary: 'Create a project for a found repository (or add it to one) and map it where it was found', tag: 'projects', auth: 'org', body: acceptDiscoveredRequest, response: projectDto }, ({ actor, body }) =>
    s.discovery.accept(actor, body),
  );
  route({ method: 'POST', path: '/orgs/:orgId/discovered/dismiss', summary: 'Stop suggesting found repositories', tag: 'projects', auth: 'org', body: dismissDiscoveredRequest }, ({ actor, body }) => s.discovery.dismiss(actor, body));

  // ── Integrations: webhooks that create tasks (spec §74) ─────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/integrations', summary: 'Integrations (inbound webhooks that create tasks)', tag: 'integrations', auth: 'org', permission: 'settings.manage' }, ({ actor }) => s.integrations.list(actor));
  route({ method: 'POST', path: '/orgs/:orgId/integrations', summary: 'Create an integration; the webhook secret is returned once', tag: 'integrations', auth: 'org', permission: 'settings.manage', body: createIntegrationRequest }, ({ actor, body }) => s.integrations.create(actor, body));
  route({ method: 'PATCH', path: '/orgs/:orgId/integrations/:id', summary: 'Change an integration', tag: 'integrations', auth: 'org', permission: 'settings.manage', body: updateIntegrationRequest }, ({ actor, params, body }) => s.integrations.update(actor, params.id!, body));
  route({ method: 'POST', path: '/orgs/:orgId/integrations/:id/rotate-secret', summary: 'Replace the webhook secret; the new one is returned once', tag: 'integrations', auth: 'org', permission: 'settings.manage' }, ({ actor, params }) => s.integrations.rotateSecret(actor, params.id!));
  route({ method: 'DELETE', path: '/orgs/:orgId/integrations/:id', summary: 'Delete an integration', tag: 'integrations', auth: 'org', permission: 'settings.manage' }, async ({ actor, params }) => {
    await s.integrations.remove(actor, params.id!);
  });
  route({ method: 'POST', path: '/orgs/:orgId/tasks/:id/apply-plan', summary: 'Create the tasks a completed plan proposes (idempotent)', tag: 'tasks', auth: 'org', permission: 'task.create' }, ({ actor, params }) => s.tasks.applyPlan(actor, params.id!));
  route({ method: 'POST', path: '/orgs/:orgId/members/:userId/reset-mfa', summary: "Turn off a member's two-factor authentication (only members of this organization alone)", tag: 'organizations', auth: 'org', permission: 'member.remove', body: resetMfaRequest }, async ({ actor, params, body }) => {
    await s.auth.resetMfaFor({ ...actor, platformAdmin: false }, params.userId!, body.reason);
  });
  route({ method: 'GET', path: '/orgs/:orgId/features', summary: 'Feature flags in effect for this organization', tag: 'organizations', auth: 'org', permission: 'org.read' }, async ({ actor }) =>
    s.features.forOrganization(actor.organizationId),
  );
  route({ method: 'GET', path: '/orgs/:orgId', summary: 'Get organization', tag: 'organizations', auth: 'org', permission: 'org.read' }, ({ actor }) => s.orgs.get(actor));
  route({ method: 'PATCH', path: '/orgs/:orgId', summary: 'Update organization, policy, settings', tag: 'organizations', auth: 'org', permission: 'org.update', body: updateOrganizationRequest }, ({ actor, body }) =>
    s.orgs.update(actor, body),
  );
  route({ method: 'GET', path: '/orgs/:orgId/members', summary: 'List members', tag: 'organizations', auth: 'org', permission: 'member.read' }, ({ actor }) => s.orgs.listMembers(actor));
  route({ method: 'POST', path: '/orgs/:orgId/members', summary: 'Add a member, or invite someone without an account', tag: 'organizations', auth: 'org', permission: 'member.invite', body: addMemberRequest, response: addMemberResponse }, ({ actor, body }) =>
    s.invitations.addOrInvite(actor, body.email, body.role),
  );
  route({ method: 'GET', path: '/orgs/:orgId/invitations', summary: 'List pending invitations', tag: 'organizations', auth: 'org', permission: 'member.read', response: z.array(invitationDto) }, ({ actor }) =>
    s.invitations.list(actor),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/invitations/:invitationId', summary: 'Revoke an invitation', tag: 'organizations', auth: 'org', permission: 'member.invite' }, ({ actor, params }) =>
    s.invitations.revoke(actor, params.invitationId!),
  );
  route({ method: 'PATCH', path: '/orgs/:orgId/members/:userId', summary: 'Change member role', tag: 'organizations', auth: 'org', permission: 'member.update_role', body: updateMemberRequest }, ({ actor, params, body }) =>
    s.orgs.updateMemberRole(actor, params.userId!, body.role),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/members/:userId', summary: 'Remove member', tag: 'organizations', auth: 'org', permission: 'member.remove' }, ({ actor, params }) =>
    s.orgs.removeMember(actor, params.userId!),
  );
  route({ method: 'GET', path: '/orgs/:orgId/teams', summary: 'List teams', tag: 'organizations', auth: 'org' }, ({ actor }) => s.orgs.listTeams(actor));
  route({ method: 'POST', path: '/orgs/:orgId/teams', summary: 'Create team', tag: 'organizations', auth: 'org', permission: 'team.manage', body: createTeamRequest }, ({ actor, body }) =>
    s.orgs.createTeam(actor, body.name, body.memberIds),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/teams/:teamId', summary: 'Delete team', tag: 'organizations', auth: 'org', permission: 'team.manage' }, ({ actor, params }) =>
    s.orgs.deleteTeam(actor, params.teamId!),
  );

  // ── Projects ───────────────────────────────────────────────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/projects', summary: 'List projects', tag: 'projects', auth: 'org', response: z.array(projectDto) }, ({ actor }) => s.projects.list(actor));
  route({ method: 'POST', path: '/orgs/:orgId/projects', summary: 'Create project', tag: 'projects', auth: 'org', permission: 'project.create', body: createProjectRequest, response: projectDto }, ({ actor, body }) =>
    s.projects.create(actor, body),
  );
  route({ method: 'GET', path: '/orgs/:orgId/projects/:projectId', summary: 'Get project', tag: 'projects', auth: 'org', response: projectDto }, ({ actor, params }) =>
    s.projects.get(actor, params.projectId!),
  );
  route({ method: 'PATCH', path: '/orgs/:orgId/projects/:projectId', summary: 'Update project', tag: 'projects', auth: 'org', permission: 'project.update', body: updateProjectRequest, response: projectDto }, ({ actor, params, body }) =>
    s.projects.update(actor, params.projectId!, body),
  );
  route({ method: 'POST', path: '/orgs/:orgId/projects/:projectId/readiness', summary: 'Run the AI readiness analysis on a worker that has the project', tag: 'projects', auth: 'org', response: projectDto }, ({ actor, params }) =>
    s.projects.requestReadiness(actor, params.projectId!, s.live),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/projects/:projectId', summary: 'Archive project', tag: 'projects', auth: 'org', permission: 'project.delete' }, ({ actor, params }) =>
    s.projects.archive(actor, params.projectId!),
  );
  route({ method: 'POST', path: '/orgs/:orgId/projects/:projectId/repositories', summary: 'Add a repository (by URL, or moved from another project)', tag: 'projects', auth: 'org', permission: 'project.update', body: addRepositoryRequest, response: projectDto }, ({ actor, params, body }) =>
    s.projects.addRepository(actor, params.projectId!, body),
  );
  route({ method: 'PATCH', path: '/orgs/:orgId/projects/:projectId/repositories/:repositoryId', summary: 'Rename a repository, change its branch, or make it primary', tag: 'projects', auth: 'org', permission: 'project.update', body: updateRepositoryRequest, response: projectDto }, ({ actor, params, body }) =>
    s.projects.updateRepository(actor, params.projectId!, params.repositoryId!, body),
  );
  route(
    { method: 'POST', path: '/orgs/:orgId/projects/:projectId/repositories/:repositoryId/clone', summary: "Clone a repository into workers' projects folders", tag: 'projects', auth: 'org', permission: 'project.update', body: z.object({ workerIds: z.array(z.string()).min(1).max(50) }) },
    ({ actor, params, body }) => s.discovery.requestClone(actor, params.projectId!, params.repositoryId!, body.workerIds),
  );
  route({ method: 'POST', path: '/orgs/:orgId/projects/:projectId/repositories/:repositoryId/split', summary: 'Move a repository into a new project of its own', tag: 'projects', auth: 'org', permission: 'project.update', response: projectDto }, ({ actor, params }) =>
    s.projects.splitRepository(actor, params.projectId!, params.repositoryId!),
  );

  // ── Tasks ──────────────────────────────────────────────────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/tasks', summary: 'List tasks (cursor)', tag: 'tasks', auth: 'org', query: taskListQuery }, ({ actor, query }) => s.tasks.list(actor, query));
  route({ method: 'POST', path: '/orgs/:orgId/tasks', summary: 'Create task', tag: 'tasks', auth: 'org', permission: 'task.create', body: createTaskRequest, response: taskDto }, async ({ actor, body, reply, req }) => {
    const key = req.headers['idempotency-key'];
    const t = await s.tasks.create(actor, { ...body, idempotencyKey: body.idempotencyKey ?? (typeof key === 'string' ? key : undefined) });
    reply.code(201);
    return t;
  });
  route({ method: 'GET', path: '/orgs/:orgId/tasks/:taskId', summary: 'Get task', tag: 'tasks', auth: 'org', response: taskDto }, ({ actor, params }) => s.tasks.get(actor, params.taskId!));
  route(
    {
      method: 'GET',
      path: '/orgs/:orgId/tasks/:taskId/events',
      summary: 'Task timeline (ascending, cursor)',
      tag: 'tasks',
      auth: 'org',
      query: z.object({ after: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(200), includeOutput: z.coerce.boolean().default(false) }),
    },
    ({ actor, params, query }) => s.tasks.events(actor, params.taskId!, query),
  );
  route({ method: 'POST', path: '/orgs/:orgId/tasks/:taskId/actions', summary: 'Pause/resume/cancel/retry/restart/input/approve/deny', tag: 'tasks', auth: 'org', permission: 'task.control', body: taskActionRequest, response: taskDto }, ({ actor, params, body }) =>
    s.tasks.action(actor, params.taskId!, body),
  );

  route({ method: 'GET', path: '/orgs/:orgId/tasks/:taskId/artifacts/:name', summary: 'Download a task artifact', tag: 'tasks', auth: 'org' }, async ({ actor, params, reply }) => {
    requirePermission(actor, 'task.read');
    await s.tasks.getLean(actor.organizationId, params.taskId!); // tenant + existence check
    const obj = await s.artifacts.get(`${actor.organizationId}/${params.taskId}/${params.name}`);
    if (!obj) throw new AppError('NOT_FOUND', 'Artifact not found');
    reply.header('content-type', obj.contentType).header('content-disposition', `inline; filename="${params.name}"`).header('x-content-type-options', 'nosniff');
    return reply.send(obj.body);
  });

  // ── Workers (user-facing) ──────────────────────────────────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/workers', summary: 'List workers', tag: 'workers', auth: 'org', response: z.array(workerDto) }, ({ actor }) => s.workers.list(actor));
  route({ method: 'GET', path: '/orgs/:orgId/workers/:workerId', summary: 'Get worker', tag: 'workers', auth: 'org', response: workerDto }, ({ actor, params }) => s.workers.get(actor, params.workerId!));
  route({ method: 'PATCH', path: '/orgs/:orgId/workers/:workerId', summary: 'Update worker', tag: 'workers', auth: 'org', permission: 'worker.manage', body: updateWorkerRequest }, ({ actor, params, body }) =>
    s.workers.update(actor, params.workerId!, body),
  );
  route({ method: 'POST', path: '/orgs/:orgId/workers/:workerId/approve', summary: 'Approve worker', tag: 'workers', auth: 'org', permission: 'worker.approve' }, ({ actor, params }) =>
    s.workers.approve(actor, params.workerId!),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/workers/:workerId', summary: 'Revoke worker credential', tag: 'workers', auth: 'org', permission: 'worker.manage' }, ({ actor, params }) =>
    s.workers.revoke(actor, params.workerId!),
  );
  route({ method: 'GET', path: '/pairing/:userCode', summary: 'Describe a pending pairing', tag: 'workers', auth: 'user' }, ({ params }) => s.workers.describePairing(params.userCode!));
  route({ method: 'POST', path: '/pairing/approve', summary: 'Approve a worker pairing code', tag: 'workers', auth: 'user', body: approvePairingRequest }, async ({ req, body, userId }) => {
    const actor = await s.orgs.resolveActor(userId, body.organizationId, req.correlationId, req.ip);
    return s.workers.approvePairing(actor, body.userCode, body.name);
  });
  route({ method: 'POST', path: '/pairing/deny', summary: 'Deny a worker pairing code', tag: 'workers', auth: 'user', body: approvePairingRequest.pick({ userCode: true, organizationId: true }) }, async ({ req, body, userId }) => {
    const actor = await s.orgs.resolveActor(userId, body.organizationId, req.correlationId, req.ip);
    await s.workers.denyPairing(actor, body.userCode);
  });

  // ── Capabilities ───────────────────────────────────────────────────────────
  route({ method: 'GET', path: '/orgs/:orgId/capabilities', summary: 'Registry (org + platform)', tag: 'capabilities', auth: 'org' }, ({ actor }) => s.capabilities.list(actor));
  route({ method: 'POST', path: '/orgs/:orgId/capabilities', summary: 'Register a capability version (organization package, or personal with owner: "user")', tag: 'capabilities', auth: 'org', permission: 'capability.personal', body: registerCapabilityRequest.extend({ platform: z.boolean().default(false) }), bodyLimit: 2 * 1024 * 1024 }, ({ actor, body }) =>
    s.capabilities.register(actor, body.manifest, body.private, body.platform, body),
  );
  route({ method: 'GET', path: '/orgs/:orgId/capability-installations', summary: 'Installed capabilities', tag: 'capabilities', auth: 'org', query: z.object({ projectId: z.string().optional() }) }, ({ actor, query }) =>
    s.capabilities.installations(actor, query.projectId),
  );
  route({ method: 'POST', path: '/orgs/:orgId/capability-installations', summary: 'Install capability at a scope (USER: for yourself)', tag: 'capabilities', auth: 'org', permission: 'capability.personal', body: installCapabilityRequest }, ({ actor, body }) =>
    s.capabilities.install(actor, body),
  );
  route({ method: 'POST', path: '/orgs/:orgId/capability-installations/:id/upgrade', summary: 'Upgrade to the latest version in the installation’s range', tag: 'capabilities', auth: 'org' }, ({ actor, params }) =>
    s.capabilities.upgrade(actor, params.id!),
  );
  // Marketplace (packages) for signed-in members: public packages plus their own and their organization's.
  route({ method: 'GET', path: '/orgs/:orgId/registry/packages', summary: 'Search the marketplace (curated first)', tag: 'registry', auth: 'org', query: catalogQuery, response: catalogPageDto }, ({ actor, query }) =>
    s.registry.search(actor, query),
  );
  route({ method: 'GET', path: '/orgs/:orgId/registry/facets', summary: 'Categories and technologies with package counts', tag: 'registry', auth: 'org', query: facetsQuery, response: facetsDto }, ({ query }) =>
    s.registry.facets(query.type),
  );
  route({ method: 'POST', path: '/orgs/:orgId/registry/suggest', summary: 'Suggest capabilities for a prompt, task or project (curated first)', tag: 'registry', auth: 'org', body: suggestRequest, response: suggestionsDto }, ({ actor, body }) =>
    s.registry.suggest(actor, body),
  );
  route({ method: 'GET', path: '/orgs/:orgId/registry/packages/:namespace/:name/related', summary: 'Packages similar to one package', tag: 'registry', auth: 'org' }, ({ actor, params }) =>
    s.registry.related(actor, params.namespace!, params.name!),
  );
  route({ method: 'GET', path: '/orgs/:orgId/registry/packages/:namespace/:name', summary: 'One package with its versions', tag: 'registry', auth: 'org' }, async ({ actor, params }) => {
    const p = await s.registry.findVisible(actor, `@${params.namespace}/${params.name}`);
    return s.registry.get(actor, params.namespace!, params.name!, Boolean(p && s.registry.canManage(actor, p)));
  });
  route({ method: 'PATCH', path: '/orgs/:orgId/registry/packages/:namespace/:name', summary: 'Edit a package’s listing (readme, categories, tags, repository)', tag: 'registry', auth: 'org', body: packageListingInput }, ({ actor, params, body }) =>
    s.registry.updateListing(actor, `@${params.namespace}/${params.name}`, body),
  );
  route({ method: 'POST', path: '/orgs/:orgId/registry/packages/:namespace/:name/publish', summary: 'Ask for a package to be published to the marketplace (reviewed)', tag: 'registry', auth: 'org', body: publishPackageRequest }, ({ actor, params, body }) =>
    s.registry.requestPublish(actor, `@${params.namespace}/${params.name}`, body.listed),
  );
  route({ method: 'POST', path: '/orgs/:orgId/registry/packages/:namespace/:name/unpublish', summary: 'Stop sharing a package outside its owner', tag: 'registry', auth: 'org' }, ({ actor, params }) =>
    s.registry.unpublish(actor, `@${params.namespace}/${params.name}`),
  );
  route({ method: 'POST', path: '/orgs/:orgId/registry/packages/:namespace/:name/versions/:version/status', summary: 'Deprecate, yank or restore a version', tag: 'registry', auth: 'org', body: versionStatusRequest }, ({ actor, params, body }) =>
    s.registry.setVersionStatus(actor, `@${params.namespace}/${params.name}`, params.version!, body.status, body.message),
  );
  route({ method: 'POST', path: '/orgs/:orgId/capability-installations/:id/approve', summary: 'Approve pending installation', tag: 'capabilities', auth: 'org', permission: 'capability.manage' }, ({ actor, params }) =>
    s.capabilities.approve(actor, params.id!),
  );
  route({ method: 'PATCH', path: '/orgs/:orgId/capability-installations/:id', summary: 'Enable/disable installation', tag: 'capabilities', auth: 'org', body: z.object({ enabled: z.boolean() }) }, ({ actor, params, body }) =>
    s.capabilities.setEnabled(actor, params.id!, body.enabled),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/capability-installations/:id', summary: 'Uninstall', tag: 'capabilities', auth: 'org' }, ({ actor, params }) => s.capabilities.uninstall(actor, params.id!));

  // ── Dashboard, audit, notifications, providers, secrets, usage ─────────────
  route({ method: 'GET', path: '/orgs/:orgId/overview', summary: 'Operational overview', tag: 'dashboard', auth: 'org', response: overviewDto }, ({ actor }) => s.queries.overview(actor));
  route({ method: 'GET', path: '/orgs/:orgId/audit', summary: 'Audit log', tag: 'audit', auth: 'org', permission: 'audit.read', query: cursorQuery.extend({ action: z.string().optional() }) }, ({ actor, query }) =>
    s.queries.audit(actor, query),
  );
  route({ method: 'GET', path: '/orgs/:orgId/notifications', summary: 'My notifications', tag: 'notifications', auth: 'org', query: cursorQuery.extend({ unreadOnly: z.coerce.boolean().optional() }) }, ({ actor, query }) =>
    s.queries.notifications(actor, query),
  );
  route({ method: 'POST', path: '/orgs/:orgId/notifications/read', summary: 'Mark notifications read', tag: 'notifications', auth: 'org', body: z.object({ ids: z.union([z.array(z.string()), z.literal('all')]) }) }, ({ actor, body }) =>
    s.queries.markNotificationsRead(actor, body.ids),
  );
  route({ method: 'GET', path: '/orgs/:orgId/usage', summary: 'AI usage aggregates', tag: 'usage', auth: 'org', query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) }, ({ actor, query }) =>
    s.queries.usage(actor, query.days),
  );
  route({ method: 'GET', path: '/orgs/:orgId/providers', summary: 'Organization provider configs', tag: 'providers', auth: 'org' }, ({ actor }) => s.queries.listProviders(actor));
  route(
    {
      method: 'PUT',
      path: '/orgs/:orgId/providers/:providerId',
      summary: 'Create/update provider config',
      tag: 'providers',
      auth: 'org',
      permission: 'provider.manage',
      body: z.object({ kind: z.string().max(40), name: z.string().max(120), baseUrl: z.string().url().nullable().optional(), enabled: z.boolean().optional(), models: z.array(z.record(z.unknown())).optional() }),
    },
    ({ actor, params, body }) => s.queries.upsertProvider(actor, { ...body, providerId: params.providerId! }),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/providers/:providerId', summary: 'Delete provider config', tag: 'providers', auth: 'org', permission: 'provider.manage' }, ({ actor, params }) =>
    s.queries.deleteProvider(actor, params.providerId!),
  );
  route({ method: 'GET', path: '/orgs/:orgId/secrets', summary: 'List secrets (masked)', tag: 'settings', auth: 'org', permission: 'settings.manage' }, ({ actor }) => s.queries.listSecrets(actor));
  route({ method: 'PUT', path: '/orgs/:orgId/secrets/:name', summary: 'Set secret', tag: 'settings', auth: 'org', permission: 'settings.manage', body: z.object({ value: z.string().min(1).max(20_000) }) }, ({ actor, params, body }) =>
    s.queries.putSecret(actor, params.name!, body.value),
  );
  route({ method: 'DELETE', path: '/orgs/:orgId/secrets/:name', summary: 'Delete secret', tag: 'settings', auth: 'org', permission: 'settings.manage' }, ({ actor, params }) =>
    s.queries.deleteSecret(actor, params.name!),
  );
}
