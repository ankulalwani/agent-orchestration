import { createHmac, createPrivateKey, sign as cryptoSign, timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { AppError, createLogger, newSecretToken, repositoryKey, sanitizeRepositoryName, sha256 } from '@ao/core';
import { GitHubApp, GitHubInstallation, GitHubState, GitHubUserToken, Organization, Project, isDuplicateKeyError, oid } from '@ao/database';
import { API_PREFIX, type GithubStatusDto, type createGithubRepositoryRequest, type githubManifestRequest } from '@ao/contracts';
import type { ServerConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';
import type { ProjectService, RepositoryOrigin } from './project.service.js';

const log = createLogger('github');
const STATE_TTL_MS = 30 * 60_000;
const HTTP_TIMEOUT_MS = 20_000;
/** Polling interval: webhooks can't reach a control plane on a private address, and deliveries can be lost. */
export const GITHUB_SYNC_INTERVAL_MS = 10 * 60_000;
const SYNC_LOCK_MS = 5 * 60_000;

type Installation = { organizationId: unknown; installationId: number; accountLogin: string; accountType: string; repositorySelection?: string | null; suspended?: boolean | null };
interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  clone_url: string;
  default_branch?: string;
  private: boolean;
  archived?: boolean;
  description?: string | null;
  owner?: { login: string };
}
export interface GithubSyncResult {
  installations: number;
  repositories: number;
  projectsCreated: number;
  errors: string[];
}

/** Why a GitHub redirect could not finish; the dashboard shows a message for each. */
export type GithubRedirectError = 'state' | 'github' | 'not_installed' | 'app_mismatch';

/** Private addresses GitHub cannot deliver webhooks to. */
export function isLocalUrl(url: string) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return (
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h.endsWith('.local') ||
      h.endsWith('.internal') ||
      h === '::1' ||
      h === '0.0.0.0' ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      !h.includes('.')
    );
  } catch {
    return true;
  }
}

/**
 * GitHub App integration: the organization creates its app from the dashboard (app-manifest flow),
 * installs it on GitHub accounts, and every repository the installations can see is synced into
 * projects (one project per new repository). Webhooks keep projects current when the control plane is
 * reachable from GitHub; a periodic sync covers everything else.
 */
export class GitHubService {
  private tokens = new Map<number, { token: string; expiresAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private listeners: Array<(organizationId: string) => void> = [];
  /** Set by the composition root (stage: clone new repositories to workers). */
  cloneRequester: ((actor: Actor, projectId: string, repositoryId: string, workerIds: string[]) => Promise<void>) | null = null;

  constructor(
    private config: ServerConfig,
    private box: SecretBox,
    private projects: ProjectService,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  /** Called after a sync changed an organization's repositories (so worker discoveries can be matched again). */
  onRepositoriesChanged(fn: (organizationId: string) => void) {
    this.listeners.push(fn);
  }

  private get api() {
    return this.config.GITHUB_API_URL.replace(/\/+$/, '');
  }
  private get web() {
    return this.config.GITHUB_URL.replace(/\/+$/, '');
  }
  private publicUrl(path: string) {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}${API_PREFIX}${path}`;
  }
  /** Where GitHub redirects end: the dashboard's GitHub settings, with the outcome in the query. */
  settingsUrl(params: Record<string, string>) {
    return `${this.config.WEB_URL.replace(/\/+$/, '')}/settings?${new URLSearchParams({ tab: 'github', ...params })}`;
  }

  // ── HTTP ───────────────────────────────────────────────────────────────────
  private async gh<T>(method: string, path: string, auth: { bearer: string } | null, body?: unknown, base = this.api): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'agent-orchestrator',
          ...(auth?.bearer ? { authorization: `Bearer ${auth.bearer}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch (e) {
      throw new AppError('UPSTREAM_ERROR', `GitHub could not be reached: ${(e as Error).message}`, { retryable: true });
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const d = (data ?? {}) as { message?: string; errors?: Array<{ message?: string } | string> };
      const detail = [d.message, ...(d.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message))].filter(Boolean).join('; ');
      throw new AppError('UPSTREAM_ERROR', `GitHub refused ${method} ${path.split('?')[0]} (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, { context: { status: res.status } });
    }
    return data as T;
  }

  private appJwt(appId: number, pem: string) {
    const now = Math.floor(Date.now() / 1000);
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
    return `${unsigned}.${cryptoSign('RSA-SHA256', Buffer.from(unsigned), createPrivateKey(pem)).toString('base64url')}`;
  }

  private async appWithSecrets(organizationId: string) {
    const app = await GitHubApp.findOne({ organizationId: oid(organizationId) }).select('+clientSecretEnc +privateKeyEnc +webhookSecretEnc').lean();
    if (!app) throw new AppError('VALIDATION_FAILED', 'Create the GitHub App first (Settings → GitHub)');
    return { ...app, privateKey: this.box.decrypt(app.privateKeyEnc), clientSecret: this.box.decrypt(app.clientSecretEnc), webhookSecret: app.webhookSecretEnc ? this.box.decrypt(app.webhookSecretEnc) : null };
  }

  /**
   * An installation access token (about an hour). Scoped tokens (to repositories and permissions) are
   * never cached; they are handed to workers for one clone or push.
   */
  async installationToken(organizationId: string, installationId: number, scope?: { repositoryIds: number[]; permissions: Record<string, 'read' | 'write'> }) {
    const cached = this.tokens.get(installationId);
    if (!scope && cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached;
    const app = await this.appWithSecrets(organizationId);
    const r = await this.gh<{ token: string; expires_at: string }>('POST', `/app/installations/${installationId}/access_tokens`, { bearer: this.appJwt(app.appId, app.privateKey) }, scope ? { repository_ids: scope.repositoryIds, permissions: scope.permissions } : {});
    const t = { token: r.token, expiresAt: Date.parse(r.expires_at) };
    if (!scope) this.tokens.set(installationId, t);
    return t;
  }

  // ── Single-use state for redirects ─────────────────────────────────────────
  private async newState(actor: Actor, purpose: 'manifest' | 'install' | 'user', data: Record<string, unknown> = {}) {
    const state = newSecretToken(24);
    await GitHubState.create({ stateHash: sha256(state), purpose, organizationId: oid(actor.organizationId), userId: oid(actor.userId), data, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
    return state;
  }

  private async consumeState(state: string | undefined, purpose: 'manifest' | 'install' | 'user') {
    if (!state) return null;
    return GitHubState.findOneAndUpdate({ stateHash: sha256(state), purpose, usedAt: null, expiresAt: { $gt: new Date() } }, { usedAt: new Date() }, { new: true }).lean();
  }

  // ── Status ─────────────────────────────────────────────────────────────────
  async status(actor: Actor): Promise<GithubStatusDto> {
    requirePermission(actor, 'project.read');
    const [app, installations, user] = await Promise.all([
      GitHubApp.findOne({ organizationId: oid(actor.organizationId) }).lean(),
      GitHubInstallation.find({ organizationId: oid(actor.organizationId) }).sort({ accountLogin: 1 }).lean(),
      GitHubUserToken.findOne({ organizationId: oid(actor.organizationId), userId: oid(actor.userId) }).lean(),
    ]);
    return {
      app: app
        ? { appId: app.appId, slug: app.slug, name: app.name, htmlUrl: app.htmlUrl, ownerLogin: app.ownerLogin ?? null, public: Boolean(app.public), webhookActive: Boolean(app.webhookActive), createdAt: new Date(app.createdAt as Date).toISOString() }
        : null,
      installations: installations.map((i) => ({
        installationId: i.installationId,
        accountLogin: i.accountLogin,
        accountType: i.accountType as 'User' | 'Organization',
        repositorySelection: i.repositorySelection ?? 'all',
        suspended: Boolean(i.suspended),
        lastSyncAt: i.lastSyncAt ? new Date(i.lastSyncAt).toISOString() : null,
        lastSyncError: i.lastSyncError ?? null,
        repositoryCount: i.repositoryCount ?? 0,
      })),
      user: user ? { login: user.login } : null,
      webhookUrl: this.publicUrl('/github/webhook'),
      publicUrlIsLocal: isLocalUrl(this.config.PUBLIC_URL),
      githubUrl: this.web,
    };
  }

  // ── Creating the app (manifest flow) ───────────────────────────────────────
  async startManifest(actor: Actor, input: z.output<typeof githubManifestRequest>) {
    requirePermission(actor, 'settings.manage');
    const org = await Organization.findById(oid(actor.organizationId)).lean();
    const local = isLocalUrl(this.config.PUBLIC_URL);
    const state = await this.newState(actor, 'manifest');
    // GitHub app names are at most 34 characters and unique on GitHub; the form on GitHub lets the admin change it.
    const name = `Agent Orchestrator ${org?.name ?? ''}`.trim().slice(0, 34).trim();
    const manifest = {
      name,
      url: this.config.PUBLIC_URL,
      // GitHub can't deliver webhooks to a private address: the app then relies on the periodic sync.
      ...(local ? {} : { hook_attributes: { url: this.publicUrl('/github/webhook'), active: true } }),
      redirect_url: this.publicUrl('/github/app/callback'),
      callback_urls: [this.publicUrl('/github/user/callback')],
      setup_url: this.publicUrl('/github/app/setup'),
      setup_on_update: true,
      public: input.public,
      default_permissions: {
        metadata: 'read',
        contents: 'write', // clone and push task branches
        pull_requests: 'write', // open pull requests
        issues: 'write', // reply on issues that created tasks
        administration: 'write', // create repositories in organizations
      },
      default_events: local ? [] : ['repository'],
    };
    const path = input.organization ? `/organizations/${encodeURIComponent(input.organization)}/settings/apps/new` : '/settings/apps/new';
    return { postUrl: `${this.web}${path}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest) };
  }

  /** GitHub redirects here after the app was created; the code is exchanged for its credentials. */
  async completeManifest(code: string | undefined, state: string | undefined): Promise<string> {
    const s = await this.consumeState(state, 'manifest');
    if (!s || !code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return this.settingsUrl({ error: 'state' satisfies GithubRedirectError });
    try {
      const r = await this.gh<{ id: number; slug: string; name: string; html_url: string; owner?: { login: string; type: string }; client_id: string; client_secret: string; webhook_secret: string | null; pem: string }>(
        'POST',
        `/app-manifests/${code}/conversions`,
        null,
      );
      const organizationId = String(s.organizationId);
      const previous = await GitHubApp.findOne({ organizationId: s.organizationId }).lean();
      const doc = {
        organizationId: s.organizationId,
        appId: r.id,
        slug: r.slug,
        name: r.name,
        htmlUrl: r.html_url,
        ownerLogin: r.owner?.login ?? null,
        ownerType: r.owner?.type ?? null,
        clientId: r.client_id,
        clientSecretEnc: this.box.encrypt(r.client_secret),
        privateKeyEnc: this.box.encrypt(r.pem),
        webhookSecretEnc: r.webhook_secret ? this.box.encrypt(r.webhook_secret) : null,
        webhookActive: Boolean(r.webhook_secret) && !isLocalUrl(this.config.PUBLIC_URL),
        createdBy: s.userId,
      };
      await GitHubApp.findOneAndUpdate({ organizationId: s.organizationId }, { $set: doc }, { upsert: true });
      // A replaced app: its installations and member authorizations belong to the old app.
      if (previous && previous.appId !== r.id) {
        await GitHubInstallation.deleteMany({ organizationId: s.organizationId, appId: previous.appId });
        await GitHubUserToken.deleteMany({ organizationId: s.organizationId });
      }
      await audit({ system: true, organizationId }, 'github.app_created', { type: 'github-app', id: String(r.id) }, { slug: r.slug, by: String(s.userId) });
      return this.settingsUrl({ created: r.slug });
    } catch (e) {
      log.warn({ err: String(e) }, 'GitHub app manifest conversion failed');
      return this.settingsUrl({ error: 'github' satisfies GithubRedirectError });
    }
  }

  async removeApp(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    const app = await GitHubApp.findOneAndDelete({ organizationId: oid(actor.organizationId) }).lean();
    if (!app) throw new AppError('NOT_FOUND', 'No GitHub App is configured');
    await GitHubInstallation.deleteMany({ organizationId: oid(actor.organizationId) });
    await GitHubUserToken.deleteMany({ organizationId: oid(actor.organizationId) });
    await audit(actor, 'github.app_removed', { type: 'github-app', id: String(app.appId) });
  }

  // ── Installations ──────────────────────────────────────────────────────────
  /**
   * Installation link. Only installations started here (with this single-use state) are accepted, so
   * installing a public app on some other account never brings that account's repositories in.
   */
  async startInstall(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    const app = await GitHubApp.findOne({ organizationId: oid(actor.organizationId) }).lean();
    if (!app) throw new AppError('VALIDATION_FAILED', 'Create the GitHub App first');
    const state = await this.newState(actor, 'install');
    return { url: `${app.htmlUrl.replace(/\/+$/, '')}/installations/new?state=${encodeURIComponent(state)}` };
  }

  /** GitHub's setup URL: after an installation was created (with our state) or changed (known installation). */
  async completeInstall(installationIdRaw: string | undefined, state: string | undefined): Promise<string> {
    const installationId = Number(installationIdRaw);
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return this.settingsUrl({ error: 'state' satisfies GithubRedirectError });
    const known = await GitHubInstallation.findOne({ installationId }).lean();
    const s = await this.consumeState(state, 'install');
    const organizationId = s ? String(s.organizationId) : known ? String(known.organizationId) : null;
    if (!organizationId) return this.settingsUrl({ error: 'state' satisfies GithubRedirectError });
    try {
      const app = await this.appWithSecrets(organizationId);
      const i = await this.gh<{ id: number; app_id: number; account: { login: string; type: string; id: number }; repository_selection: string; suspended_at: string | null }>(
        'GET',
        `/app/installations/${installationId}`,
        { bearer: this.appJwt(app.appId, app.privateKey) },
      );
      if (i.app_id !== app.appId) return this.settingsUrl({ error: 'app_mismatch' satisfies GithubRedirectError });
      const doc = await this.upsertInstallation(organizationId, app.appId, i);
      if (s) await audit({ system: true, organizationId }, 'github.installation_added', { type: 'github-installation', id: String(installationId) }, { account: i.account.login, by: String(s.userId) });
      void this.syncInstallation(doc).catch((e) => log.warn({ err: String(e), installationId }, 'sync after installation failed'));
      return this.settingsUrl({ installed: i.account.login });
    } catch (e) {
      log.warn({ err: String(e), installationId }, 'installation setup failed');
      return this.settingsUrl({ error: 'github' satisfies GithubRedirectError });
    }
  }

  private async upsertInstallation(organizationId: string, appId: number, i: { id: number; account: { login: string; type: string; id: number }; repository_selection: string; suspended_at: string | null }) {
    return (await GitHubInstallation.findOneAndUpdate(
      { installationId: i.id },
      {
        $set: {
          organizationId: oid(organizationId),
          appId,
          accountLogin: i.account.login,
          accountType: i.account.type === 'Organization' ? 'Organization' : 'User',
          accountId: i.account.id,
          repositorySelection: i.repository_selection,
          suspended: Boolean(i.suspended_at),
        },
      },
      { upsert: true, new: true },
    ).lean())!;
  }

  /** Forget an installation here (uninstalling on GitHub is done on GitHub). Its projects stay. */
  async forgetInstallation(actor: Actor, installationId: number) {
    requirePermission(actor, 'settings.manage');
    const r = await GitHubInstallation.deleteOne({ organizationId: oid(actor.organizationId), installationId });
    if (!r.deletedCount) throw new AppError('NOT_FOUND', 'Installation not found');
    this.tokens.delete(installationId);
    await this.markInaccessible(actor.organizationId, installationId, []);
    await audit(actor, 'github.installation_removed', { type: 'github-installation', id: String(installationId) });
  }

  // ── Members' authorization (personal repositories) ─────────────────────────
  async startUserAuthorization(actor: Actor) {
    const app = await GitHubApp.findOne({ organizationId: oid(actor.organizationId) }).lean();
    if (!app) throw new AppError('VALIDATION_FAILED', 'Create the GitHub App first');
    const state = await this.newState(actor, 'user');
    const q = new URLSearchParams({ client_id: app.clientId, state, redirect_uri: this.publicUrl('/github/user/callback') });
    return { url: `${this.web}/login/oauth/authorize?${q}` };
  }

  async completeUserAuthorization(code: string | undefined, state: string | undefined): Promise<string> {
    const s = await this.consumeState(state, 'user');
    if (!s || !code) return this.settingsUrl({ error: 'state' satisfies GithubRedirectError });
    try {
      const app = await this.appWithSecrets(String(s.organizationId));
      const t = await this.exchangeUserCode(app, { code, redirect_uri: this.publicUrl('/github/user/callback') });
      const me = await this.gh<{ login: string; id: number }>('GET', '/user', { bearer: t.access_token });
      await this.saveUserToken(String(s.organizationId), String(s.userId), me, t);
      await audit({ system: true, organizationId: String(s.organizationId) }, 'github.user_connected', { type: 'user', id: String(s.userId) }, { login: me.login });
      return this.settingsUrl({ connected: me.login });
    } catch (e) {
      log.warn({ err: String(e) }, 'GitHub user authorization failed');
      return this.settingsUrl({ error: 'github' satisfies GithubRedirectError });
    }
  }

  private async exchangeUserCode(app: { clientId: string; clientSecret: string }, grant: Record<string, string>) {
    const t = await this.gh<{ access_token?: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number; error?: string; error_description?: string }>(
      'POST',
      '/login/oauth/access_token',
      null,
      { client_id: app.clientId, client_secret: app.clientSecret, ...grant },
      this.web,
    );
    if (!t.access_token) throw new AppError('UPSTREAM_ERROR', `GitHub did not authorize: ${t.error_description ?? t.error ?? 'no token'}`);
    return t as typeof t & { access_token: string };
  }

  private async saveUserToken(organizationId: string, userId: string, me: { login: string; id: number }, t: { access_token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }) {
    await GitHubUserToken.findOneAndUpdate(
      { organizationId: oid(organizationId), userId: oid(userId) },
      {
        $set: {
          login: me.login,
          githubUserId: me.id,
          accessTokenEnc: this.box.encrypt(t.access_token),
          refreshTokenEnc: t.refresh_token ? this.box.encrypt(t.refresh_token) : null,
          expiresAt: t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null,
          refreshExpiresAt: t.refresh_token_expires_in ? new Date(Date.now() + t.refresh_token_expires_in * 1000) : null,
        },
      },
      { upsert: true },
    );
  }

  /** The member's user-to-server token, refreshed when it has expired. */
  private async userToken(actor: Actor) {
    const u = await GitHubUserToken.findOne({ organizationId: oid(actor.organizationId), userId: oid(actor.userId) }).select('+accessTokenEnc +refreshTokenEnc').lean();
    if (!u) return null;
    if (!u.expiresAt || u.expiresAt.getTime() - Date.now() > 60_000) return { login: u.login, token: this.box.decrypt(u.accessTokenEnc) };
    if (!u.refreshTokenEnc || (u.refreshExpiresAt && u.refreshExpiresAt.getTime() < Date.now())) return null;
    const app = await this.appWithSecrets(actor.organizationId);
    const t = await this.exchangeUserCode(app, { grant_type: 'refresh_token', refresh_token: this.box.decrypt(u.refreshTokenEnc) });
    await this.saveUserToken(actor.organizationId, actor.userId, { login: u.login, id: u.githubUserId }, t);
    return { login: u.login, token: t.access_token };
  }

  async disconnectUser(actor: Actor) {
    await GitHubUserToken.deleteOne({ organizationId: oid(actor.organizationId), userId: oid(actor.userId) });
    await audit(actor, 'github.user_disconnected', { type: 'user', id: actor.userId });
  }

  // ── Sync: installations' repositories → projects ───────────────────────────
  async syncOrganization(actor: Actor | null, organizationId: string): Promise<GithubSyncResult> {
    if (actor) requirePermission(actor, 'settings.manage');
    const installations = await GitHubInstallation.find({ organizationId: oid(organizationId), suspended: { $ne: true } }).lean();
    const total: GithubSyncResult = { installations: installations.length, repositories: 0, projectsCreated: 0, errors: [] };
    for (const i of installations) {
      try {
        const r = await this.syncInstallation(i, { force: Boolean(actor) });
        total.repositories += r.repositories;
        total.projectsCreated += r.projectsCreated;
      } catch (e) {
        total.errors.push(`${i.accountLogin}: ${(e as Error).message}`);
      }
    }
    if (actor) await audit(actor, 'github.sync', null, { ...total });
    return total;
  }

  /**
   * Imports every repository the installation can see: a repository already in a project (by GitHub id
   * or by key, in any project, archived ones included) is updated; a new one gets a project of its own.
   * Archived GitHub repositories are not imported. Repositories the installation no longer sees are
   * marked inaccessible, never removed.
   */
  async syncInstallation(inst: Installation, opts: { force?: boolean } = {}): Promise<{ repositories: number; projectsCreated: number }> {
    const organizationId = String(inst.organizationId);
    // One sync per installation at a time (also across API instances): two at once would both create a
    // project for a new repository. A forced sync (webhook, "Sync now") waits for the running one.
    const acquire = () => {
      const now = new Date();
      return GitHubInstallation.findOneAndUpdate({ installationId: inst.installationId, $or: [{ syncLockUntil: null }, { syncLockUntil: { $lt: now } }] }, { syncLockUntil: new Date(now.getTime() + SYNC_LOCK_MS) });
    };
    let lock = await acquire();
    for (const deadline = Date.now() + SYNC_LOCK_MS; !lock && opts.force && Date.now() < deadline; lock = await acquire()) await new Promise((r) => setTimeout(r, 200));
    if (!lock) return { repositories: 0, projectsCreated: 0 };
    let created = 0;
    try {
      const { token } = await this.installationToken(organizationId, inst.installationId);
      const repos: GhRepo[] = [];
      for (let page = 1; page <= 100; page++) {
        const r = await this.gh<{ total_count: number; repositories: GhRepo[] }>('GET', `/installation/repositories?per_page=100&page=${page}`, { bearer: token });
        repos.push(...r.repositories);
        if (r.repositories.length < 100) break;
      }
      for (const repo of repos) if (await this.importRepository(organizationId, inst, repo)) created++;
      await this.markInaccessible(organizationId, inst.installationId, repos.map((r) => r.id));
      await GitHubInstallation.updateOne({ installationId: inst.installationId }, { lastSyncAt: new Date(), lastSyncError: null, repositoryCount: repos.length, syncLockUntil: null });
      if (created) await audit({ system: true, organizationId }, 'github.projects_created', { type: 'github-installation', id: String(inst.installationId) }, { count: created });
      for (const fn of this.listeners) fn(organizationId);
      return { repositories: repos.length, projectsCreated: created };
    } catch (e) {
      await GitHubInstallation.updateOne({ installationId: inst.installationId }, { lastSyncAt: new Date(), lastSyncError: String((e as Error).message).slice(0, 500), syncLockUntil: null });
      throw e;
    }
  }

  private githubInfo(inst: Installation, repo: GhRepo) {
    return { installationId: inst.installationId, repoId: repo.id, fullName: repo.full_name, private: repo.private, archived: Boolean(repo.archived), accessible: true };
  }

  /** Returns true when a project was created for the repository. */
  private async importRepository(organizationId: string, inst: Installation, repo: GhRepo): Promise<boolean> {
    const key = repositoryKey(repo.html_url);
    const github = this.githubInfo(inst, repo);
    const existing = await Project.findOne({ organizationId: oid(organizationId), $or: [{ 'repositories.github.repoId': repo.id }, ...(key ? [{ 'repositories.key': key }] : [])] });
    if (existing) {
      const r = existing.repositories.find((x) => (x.github as { repoId?: number } | null)?.repoId === repo.id) ?? existing.repositories.find((x) => x.key === key);
      if (!r) return false;
      r.github = github;
      r.key = key;
      r.url = repo.clone_url;
      if (r.source === 'github' && repo.default_branch) r.defaultBranch = repo.default_branch;
      if (r.primary) {
        existing.repositoryUrl = repo.clone_url;
        existing.defaultBranch = r.defaultBranch ?? existing.defaultBranch;
      }
      await existing.save();
      return false;
    }
    if (repo.archived) return false;
    const owner = repo.owner?.login ?? repo.full_name.split('/')[0] ?? 'github';
    const origin: RepositoryOrigin = { source: 'github', github, key: key ?? undefined, name: sanitizeRepositoryName(repo.name) };
    for (const name of [repo.name, `${repo.name} (${owner})`, ...Array.from({ length: 20 }, (_, i) => `${repo.name} (${owner} ${i + 2})`)]) {
      try {
        const p = await Project.create({
          organizationId: oid(organizationId),
          name,
          description: (repo.description ?? '').slice(0, 2000),
          repositoryUrl: repo.clone_url,
          defaultBranch: repo.default_branch ?? 'main',
          repositories: [{ name: origin.name, key, url: repo.clone_url, defaultBranch: repo.default_branch ?? 'main', primary: true, source: 'github', github }],
        });
        log.info({ organizationId, projectId: String(p._id), repository: repo.full_name }, 'project created from GitHub');
        return true;
      } catch (e) {
        if (!isDuplicateKeyError(e)) throw e;
      }
    }
    return false;
  }

  private async markInaccessible(organizationId: string, installationId: number, seenRepoIds: number[]) {
    await Project.updateMany(
      { organizationId: oid(organizationId), 'repositories.github.installationId': installationId },
      { $set: { 'repositories.$[r].github.accessible': false } },
      { arrayFilters: [{ 'r.github.installationId': installationId, 'r.github.repoId': { $nin: seenRepoIds } }] },
    );
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────
  async webhook(headers: Record<string, string | string[] | undefined>, raw: Buffer): Promise<{ status: 'ok' | 'ignored' | 'pong'; code: number }> {
    const event = String(headers['x-github-event'] ?? '');
    const signature = String(headers['x-hub-signature-256'] ?? '');
    let body: { action?: string; installation?: { id: number; app_id?: number; account?: { login: string; type: string; id: number }; repository_selection?: string; suspended_at?: string | null }; hook?: { app_id?: number } };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return { status: 'ignored', code: 400 };
    }
    const appId = body.installation?.app_id ?? body.hook?.app_id;
    const known = body.installation?.id ? await GitHubInstallation.findOne({ installationId: body.installation.id }).lean() : null;
    const app = appId ? await GitHubApp.findOne({ appId }).select('+webhookSecretEnc').lean() : known ? await GitHubApp.findOne({ organizationId: known.organizationId }).select('+webhookSecretEnc').lean() : null;
    if (!app?.webhookSecretEnc) return { status: 'ignored', code: 202 };
    const expected = `sha256=${createHmac('sha256', this.box.decrypt(app.webhookSecretEnc)).update(raw).digest('hex')}`;
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return { status: 'ignored', code: 401 };
    if (event === 'ping') return { status: 'pong', code: 200 };
    // Installations are only accepted when started from the dashboard; events for others are ignored.
    if (!known || String(known.organizationId) !== String(app.organizationId)) return { status: 'ignored', code: 202 };
    const organizationId = String(known.organizationId);
    if (event === 'installation') {
      if (body.action === 'deleted') {
        await GitHubInstallation.deleteOne({ installationId: known.installationId });
        this.tokens.delete(known.installationId);
        await this.markInaccessible(organizationId, known.installationId, []);
        await audit({ system: true, organizationId }, 'github.installation_deleted', { type: 'github-installation', id: String(known.installationId) });
        return { status: 'ok', code: 200 };
      }
      if (body.action === 'suspend' || body.action === 'unsuspend') {
        await GitHubInstallation.updateOne({ installationId: known.installationId }, { suspended: body.action === 'suspend' });
        return { status: 'ok', code: 200 };
      }
    }
    if (['installation', 'installation_repositories', 'repository'].includes(event)) {
      if (body.installation?.repository_selection) await GitHubInstallation.updateOne({ installationId: known.installationId }, { repositorySelection: body.installation.repository_selection });
      void this.syncInstallation(known, { force: true }).catch((e) => log.warn({ err: String(e), installationId: known.installationId }, 'sync after webhook failed'));
      return { status: 'ok', code: 200 };
    }
    return { status: 'ignored', code: 202 };
  }

  // ── Creating repositories ──────────────────────────────────────────────────
  /**
   * Creates a GitHub repository (with an initial commit, so it can be cloned) and adds it to a project,
   * a new one unless `projectId` is given. Organizations: through the installation. Personal accounts:
   * with the member's own authorization of the app.
   */
  async createRepository(actor: Actor, input: z.output<typeof createGithubRepositoryRequest>) {
    requirePermission(actor, 'project.create');
    if (input.projectId) requirePermission(actor, 'project.update');
    const inst = await GitHubInstallation.findOne({ organizationId: oid(actor.organizationId), accountLogin: new RegExp(`^${input.owner.replace(/[^A-Za-z0-9-]/g, '')}$`, 'i') }).lean();
    if (!inst) throw new AppError('VALIDATION_FAILED', `The GitHub App is not installed on ${input.owner}. Install it there first (Settings → GitHub).`);
    const body = { name: input.name, private: input.private, description: input.description, auto_init: true };
    let repo: GhRepo;
    if (inst.accountType === 'Organization') {
      const { token } = await this.installationToken(actor.organizationId, inst.installationId);
      repo = await this.gh<GhRepo>('POST', `/orgs/${encodeURIComponent(inst.accountLogin)}/repos`, { bearer: token }, body);
    } else {
      const user = await this.userToken(actor);
      if (!user || user.login.toLowerCase() !== inst.accountLogin.toLowerCase()) {
        throw new AppError('VALIDATION_FAILED', `To create repositories in the personal account ${inst.accountLogin}, connect that GitHub account first (Settings → GitHub → Connect your GitHub account).`);
      }
      repo = await this.gh<GhRepo>('POST', '/user/repos', { bearer: user.token }, body);
      // With "only selected repositories", a new repository is not in the installation until added.
      if (inst.repositorySelection === 'selected') await this.gh('PUT', `/user/installations/${inst.installationId}/repositories/${repo.id}`, { bearer: user.token });
    }
    await audit(actor, 'github.repository_created', { type: 'github-repository', id: String(repo.id) }, { fullName: repo.full_name, private: repo.private });
    const origin: RepositoryOrigin = { source: 'github', github: this.githubInfo(inst, repo), name: sanitizeRepositoryName(repo.name) };
    const url = repo.clone_url;
    const branch = repo.default_branch ?? 'main';
    const project = input.projectId
      ? await this.projects.addRepository(actor, input.projectId, { url, defaultBranch: branch }, origin)
      : await this.projects.create(actor, { name: repo.name, description: input.description, repositoryUrl: url, defaultBranch: branch, environments: [], knowledge: '' }, origin);
    const added = project.repositories.find((r) => r.github?.repoId === repo.id);
    if (added && input.cloneToWorkerIds.length && this.cloneRequester) await this.cloneRequester(actor, project.id, added.id, input.cloneToWorkerIds);
    return project;
  }

  /** Owners the member can create repositories in: organization installations, and their own connected account. */
  async repositoryOwners(actor: Actor) {
    requirePermission(actor, 'project.read');
    const [installations, user] = await Promise.all([
      GitHubInstallation.find({ organizationId: oid(actor.organizationId), suspended: { $ne: true } }).lean(),
      GitHubUserToken.findOne({ organizationId: oid(actor.organizationId), userId: oid(actor.userId) }).lean(),
    ]);
    return installations.map((i) => ({
      login: i.accountLogin,
      type: i.accountType,
      canCreate: i.accountType === 'Organization' || (user?.login ?? '').toLowerCase() === i.accountLogin.toLowerCase(),
    }));
  }

  // ── Credentials for workers (clone, push, pull requests) ───────────────────
  /**
   * Short-lived installation tokens limited to these repositories (contents and pull requests), one per
   * installation. Repositories that are not from the GitHub App, or no longer accessible, get none.
   */
  async repositoryTokens(organizationId: string, repos: Array<{ id: string; name: string; github?: { installationId: number; repoId: number; accessible: boolean } | null }>) {
    const app = await GitHubApp.findOne({ organizationId: oid(organizationId) }).lean();
    const byInstallation = new Map<number, typeof repos>();
    for (const r of repos) if (r.github?.accessible !== false && r.github) byInstallation.set(r.github.installationId, [...(byInstallation.get(r.github.installationId) ?? []), r]);
    const out: Array<{ repositoryId: string; name: string; token: string; expiresAt: string; apiBaseUrl: string; host: string }> = [];
    if (!app) return out;
    const host = new URL(this.web).host.toLowerCase();
    for (const [installationId, list] of byInstallation) {
      const t = await this.installationToken(organizationId, installationId, { repositoryIds: list.map((r) => r.github!.repoId), permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } });
      for (const r of list) out.push({ repositoryId: r.id, name: r.name, token: t.token, expiresAt: new Date(t.expiresAt).toISOString(), apiBaseUrl: this.api, host });
    }
    return out;
  }

  // ── Periodic sync ──────────────────────────────────────────────────────────
  start(intervalMs = GITHUB_SYNC_INTERVAL_MS) {
    if (this.timer) return;
    const tick = async () => {
      const due = await GitHubInstallation.find({ suspended: { $ne: true }, $or: [{ lastSyncAt: null }, { lastSyncAt: { $lt: new Date(Date.now() - intervalMs) } }] }).lean();
      for (const i of due) await this.syncInstallation(i).catch((e) => log.warn({ err: String(e), installationId: i.installationId }, 'periodic GitHub sync failed'));
    };
    this.timer = setInterval(() => void tick(), Math.min(intervalMs, 60_000));
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
