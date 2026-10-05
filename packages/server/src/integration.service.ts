import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppError, createLogger, safeEqual, type Role } from '@ao/core';
import { Integration, Membership, Project, Secret, Task, oid } from '@ao/database';
import { integrationSettings, type IntegrationSettings, type TaskDto, type createIntegrationRequest, type updateIntegrationRequest } from '@ao/contracts';
import type { z } from 'zod';
import { requirePublicCallbackUrls, type ServerConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';
import type { TaskService } from './task.service.js';
import { API_PREFIX } from '@ao/contracts';

const log = createLogger('integrations');

/** What a delivery asks for, once parsed. */
export interface Trigger {
  title: string;
  prompt: string;
  /** Same external item → same task (deliveries are retried; an issue can be opened and labeled). */
  idempotencyKey: string;
  url: string | null;
  /** github: owner/repo#number; gitlab: projectId#iid. Used for replies. */
  ref: string | null;
  /** What `ref` points at: an issue, or a pull/merge request. */
  refType?: 'issue' | 'pr';
  /** Pull/merge request reviews (FUT-003). */
  review?: { base: string; head: string; fetchHead: string; pullRequest: { url: string; number: number } };
  /**
   * Feedback on a pull request: when a task of the project opened it, the new task follows up on that
   * task's branch. `required`: without such a task there is nothing to do (a review); otherwise an
   * ordinary task is created (a comment command). `reviewId`: its line comments are fetched for the prompt.
   */
  followUp?: { pullRequestUrl: string; number: number; required: boolean; reviewId?: number };
  /** The item's id in the other system, when replies need it instead of `ref` (Linear). */
  externalId?: string;
}
export type DeliveryResult = { status: 'created' | 'duplicate'; taskId: string } | { status: 'ignored'; reason: string } | { status: 'pong' };

type IntegrationLean = { _id: unknown; organizationId: unknown; projectId: unknown; name: string; kind: 'github' | 'gitlab' | 'jira' | 'linear' | 'generic'; enabled: boolean; settings: unknown; createdBy: unknown; secretEnc?: string; lastDeliveryAt?: Date | null; lastDeliveryResult?: string | null; deliveries?: number; createdAt: Date };

const hmacHex = (secret: string, body: Buffer) => createHmac('sha256', secret).update(body).digest('hex');
function sameHex(a: string, b: string) {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
/** `{{a.b}}` → payload.a.b ('' when missing; objects as JSON). */
export function fillTemplate(template: string, payload: unknown): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, p: string) => {
    let v: unknown = payload;
    for (const k of p.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * Integration-driven task creation (FUT-002, spec §74). An integration is a webhook endpoint of an
 * organization that turns deliveries into tasks in one project:
 * - GitHub: issues opened (or labeled with the configured label) and `/agent …` issue comments;
 *   signed with X-Hub-Signature-256.
 * - GitLab: issue hooks (opened, or the label added) and `/agent …` notes; X-Gitlab-Token.
 * - Jira: issues created with the label (or the label added) and `/agent …` comments; X-Hub-Signature
 *   (the webhook's secret).
 * - Linear: the same for Linear issues and comments; Linear-Signature (Linear's own signing secret,
 *   which is stored with `setSecret`).
 * - Generic: any JSON, title and prompt from templates; X-AO-Signature (HMAC-SHA256 of the body).
 * Deliveries are idempotent per external item. Optionally the result is reported back: a comment on the
 * issue (GitHub/GitLab, with a token from the organization's secrets) or a signed callback (generic).
 */
export class IntegrationService {
  constructor(
    private readonly config: ServerConfig,
    private readonly box: SecretBox,
    private readonly tasks: TaskService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    tasks.onFinished((t) => this.reportFinished(t));
  }

  webhookUrl(id: string) {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}${API_PREFIX}/hooks/${id}`;
  }

  private dto(i: IntegrationLean) {
    return {
      id: String(i._id),
      name: i.name,
      kind: i.kind,
      projectId: String(i.projectId),
      enabled: i.enabled,
      settings: integrationSettings.parse(i.settings ?? {}),
      webhookUrl: this.webhookUrl(String(i._id)),
      lastDeliveryAt: i.lastDeliveryAt?.toISOString() ?? null,
      lastDeliveryResult: i.lastDeliveryResult ?? null,
      deliveries: i.deliveries ?? 0,
      createdAt: i.createdAt.toISOString(),
    };
  }

  // ── Management (settings.manage) ───────────────────────────────────────────
  async list(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    return ((await Integration.find({ organizationId: oid(actor.organizationId) }).sort({ name: 1 }).lean()) as IntegrationLean[]).map((i) => this.dto(i));
  }

  async create(actor: Actor, input: z.output<typeof createIntegrationRequest>) {
    requirePermission(actor, 'settings.manage');
    await this.checkProject(actor, input.projectId);
    this.checkCallback(input.settings.callbackUrl);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    try {
      const doc = await Integration.create({ organizationId: oid(actor.organizationId), projectId: oid(input.projectId), name: input.name, kind: input.kind, enabled: input.enabled, settings: input.settings, secretEnc: this.box.encrypt(secret), createdBy: oid(actor.userId) });
      await audit(actor, 'integration.create', { type: 'integration', id: String(doc._id) }, { kind: input.kind, name: input.name });
      return { ...this.dto(doc.toObject() as IntegrationLean), secret };
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new AppError('CONFLICT', 'An integration with this name exists');
      throw e;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateIntegrationRequest>) {
    requirePermission(actor, 'settings.manage');
    if (input.projectId) await this.checkProject(actor, input.projectId);
    const cur = (await Integration.findOne({ _id: oid(id, 'Integration'), organizationId: oid(actor.organizationId) }).lean()) as IntegrationLean | null;
    if (!cur) throw new AppError('NOT_FOUND', 'Integration not found');
    const settings = input.settings ? integrationSettings.parse({ ...(cur.settings as object), ...input.settings }) : undefined;
    if (settings) this.checkCallback(settings.callbackUrl);
    const doc = (await Integration.findOneAndUpdate(
      { _id: cur._id },
      { $set: { ...(input.name ? { name: input.name } : {}), ...(input.projectId ? { projectId: oid(input.projectId) } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(settings ? { settings } : {}) } },
      { new: true },
    ).lean()) as IntegrationLean;
    await audit(actor, 'integration.update', { type: 'integration', id }, { fields: Object.keys(input) });
    return this.dto(doc);
  }

  async rotateSecret(actor: Actor, id: string) {
    requirePermission(actor, 'settings.manage');
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const r = await Integration.updateOne({ _id: oid(id, 'Integration'), organizationId: oid(actor.organizationId) }, { $set: { secretEnc: this.box.encrypt(secret) } });
    if (!r.matchedCount) throw new AppError('NOT_FOUND', 'Integration not found');
    await audit(actor, 'integration.rotate_secret', { type: 'integration', id });
    return { secret };
  }

  /** Stores a secret the other system chose (Linear shows its webhook's signing secret; it cannot be given one). */
  async setSecret(actor: Actor, id: string, secret: string) {
    requirePermission(actor, 'settings.manage');
    const r = await Integration.updateOne({ _id: oid(id, 'Integration'), organizationId: oid(actor.organizationId) }, { $set: { secretEnc: this.box.encrypt(secret) } });
    if (!r.matchedCount) throw new AppError('NOT_FOUND', 'Integration not found');
    await audit(actor, 'integration.set_secret', { type: 'integration', id });
  }

  async remove(actor: Actor, id: string) {
    requirePermission(actor, 'settings.manage');
    const r = await Integration.deleteOne({ _id: oid(id, 'Integration'), organizationId: oid(actor.organizationId) });
    if (!r.deletedCount) throw new AppError('NOT_FOUND', 'Integration not found');
    await audit(actor, 'integration.delete', { type: 'integration', id });
  }

  private async checkProject(actor: Actor, projectId: string) {
    if (!(await Project.exists({ _id: oid(projectId, 'Project'), organizationId: oid(actor.organizationId) }))) throw new AppError('NOT_FOUND', 'Project not found');
  }

  /** A shared installation must not call into its own network on behalf of tenants. */
  private checkCallback(url: string) {
    if (!url || !requirePublicCallbackUrls(this.config)) return;
    const host = new URL(url).hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.)/.test(host) || !url.startsWith('https://')) {
      throw new AppError('VALIDATION_FAILED', 'Callback URLs must be public https URLs');
    }
  }

  // ── Deliveries ─────────────────────────────────────────────────────────────
  /** Handles one webhook delivery. Throws UNAUTHENTICATED for a bad signature (nothing is recorded). */
  async deliver(id: string, headers: Record<string, string | string[] | undefined>, body: Buffer): Promise<DeliveryResult> {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new AppError('NOT_FOUND', 'Unknown webhook');
    const i = (await Integration.findById(id).select('+secretEnc').lean()) as IntegrationLean | null;
    if (!i) throw new AppError('NOT_FOUND', 'Unknown webhook');
    const secret = this.box.decrypt(i.secretEnc!);
    const h = (k: string) => {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    };
    if (i.kind === 'github') {
      const sig = h('x-hub-signature-256') ?? '';
      if (!sig.startsWith('sha256=') || !sameHex(sig.slice(7), hmacHex(secret, body))) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    } else if (i.kind === 'gitlab') {
      if (!safeEqual(h('x-gitlab-token') ?? '', secret)) throw new AppError('UNAUTHENTICATED', 'Invalid token');
    } else if (i.kind === 'jira') {
      const sig = h('x-hub-signature') ?? '';
      if (!sig.startsWith('sha256=') || !sameHex(sig.slice(7), hmacHex(secret, body))) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    } else if (i.kind === 'linear') {
      if (!sameHex(h('linear-signature') ?? '', hmacHex(secret, body))) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    } else {
      const sig = h('x-ao-signature') ?? '';
      if (!sig.startsWith('sha256=') || !sameHex(sig.slice(7), hmacHex(secret, body))) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new AppError('VALIDATION_FAILED', 'The body must be JSON (for GitHub, choose content type application/json)');
    }
    const record = async (result: string) => {
      await Integration.updateOne({ _id: i._id }, { $set: { lastDeliveryAt: new Date(), lastDeliveryResult: result }, $inc: { deliveries: 1 } });
    };
    if (!i.enabled) {
      await record('ignored: integration is turned off');
      return { status: 'ignored', reason: 'The integration is turned off' };
    }
    const settings = integrationSettings.parse(i.settings ?? {});
    const parsed = i.kind === 'github' ? parseGitHub(h('x-github-event') ?? '', payload, settings) : i.kind === 'gitlab' ? parseGitLab(h('x-gitlab-event') ?? '', payload, settings) : i.kind === 'jira' ? parseJira(payload, settings) : i.kind === 'linear' ? parseLinear(payload, settings) : parseGeneric(payload, settings, h('x-ao-delivery') ?? createHash('sha256').update(body).digest('hex'));
    if ('pong' in parsed) {
      await record('ping');
      return { status: 'pong' };
    }
    if ('ignore' in parsed) {
      await record(`ignored: ${parsed.ignore}`);
      return { status: 'ignored', reason: parsed.ignore };
    }
    // Feedback on a pull request that one of this project's tasks opened: follow up on that task's branch.
    let continuesTaskId: string | undefined;
    if (parsed.followUp) {
      const opened = await Task.findOne({ organizationId: i.organizationId, projectId: i.projectId, 'gitResult.pullRequestUrl': parsed.followUp.pullRequestUrl, kind: { $in: ['code', null] } }, { _id: 1 }).sort({ createdAt: -1 }).lean();
      if (opened) continuesTaskId = String(opened._id);
      else if (parsed.followUp.required) {
        await record('ignored: the pull request was not opened by a task of this project');
        return { status: 'ignored', reason: 'The pull request was not opened by a task of this project' };
      }
    }
    const actor = await this.actorFor(i);
    const key = `int:${String(i._id)}:${createHash('sha256').update(parsed.idempotencyKey).digest('hex').slice(0, 40)}`;
    const before = await this.tasks.findByIdempotencyKey(String(i.organizationId), key);
    const lineComments = continuesTaskId && parsed.followUp?.reviewId && !before ? await this.reviewComments(i, settings, parsed.ref, parsed.followUp.reviewId) : '';
    const task = await this.tasks.create(
      actor,
      {
        projectId: String(i.projectId),
        title: clip(parsed.title.trim() || `${i.name} delivery`, 200),
        prompt: clip(`${parsed.prompt.trim() || parsed.title}${lineComments}`, 100_000),
        // The earlier task opened a pull request, so this one pushes to it.
        ...(continuesTaskId ? { continuesTaskId, policy: { git: { policy: 'PULL_REQUEST' as const } } } : {}),
        priority: settings.priority,
        dependencies: [],
        requirements: {},
        capabilityIds: [],
        requirePlanApproval: settings.requirePlanApproval || undefined,
        idempotencyKey: key,
        ...(parsed.review ? { kind: 'review' as const, review: parsed.review } : {}),
      },
      { source: { integrationId: String(i._id), kind: i.kind, name: i.name, url: parsed.url, ref: parsed.ref, refType: parsed.refType ?? 'issue', ...(parsed.externalId ? { externalId: parsed.externalId } : {}) } },
    );
    const duplicate = Boolean(before);
    await record(duplicate ? `duplicate of task ${task.id}` : `created task ${task.id}`);
    if (!duplicate) {
      await audit(actor, 'integration.task_created', { type: 'task', id: task.id }, { integrationId: String(i._id), ref: parsed.ref });
      void this.reply(i, settings, parsed.externalId ?? parsed.ref, parsed.refType ?? 'issue', parsed.review ? `An agent is reviewing this: ${this.taskUrl(String(i.organizationId), task.id)}` : `Task created in Agent Orchestration: ${this.taskUrl(String(i.organizationId), task.id)}`).catch((e) => log.warn({ err: String(e) }, 'could not reply to the issue'));
    }
    return { status: duplicate ? 'duplicate' : 'created', taskId: task.id };
  }

  /** The line comments of a GitHub review, as text for the prompt ('' without a reply token, or when GitHub refuses). */
  private async reviewComments(i: IntegrationLean, settings: IntegrationSettings, ref: string | null, reviewId: number): Promise<string> {
    const token = ref && i.kind === 'github' ? await this.token(i, settings) : null;
    if (!token || !ref) return '';
    const [repo, number] = ref.split('#') as [string, string];
    const api = (settings.apiBaseUrl || this.config.GITHUB_API_URL).replace(/\/+$/, '');
    try {
      const res = await this.fetchImpl(`${api}/repos/${repo}/pulls/${number}/reviews/${reviewId}/comments?per_page=100`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-orchestration' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return '';
      const comments = (await res.json()) as Array<{ path?: string; line?: number | null; original_line?: number | null; body?: string }>;
      if (!Array.isArray(comments) || !comments.length) return '';
      return `\n\nComments on lines:\n${comments.map((c) => `- ${c.path}${c.line ?? c.original_line ? `:${c.line ?? c.original_line}` : ''}: ${c.body ?? ''}`).join('\n')}`;
    } catch (e) {
      log.warn({ err: String(e), integration: String(i._id) }, 'could not read the review comments');
      return '';
    }
  }

  private taskUrl(_orgId: string, taskId: string) {
    return `${this.config.WEB_URL.replace(/\/+$/, '')}/tasks/${taskId}`;
  }

  private async actorFor(i: IntegrationLean): Promise<Actor> {
    const m = await Membership.findOne({ userId: i.createdBy, organizationId: i.organizationId, suspended: { $ne: true } }).lean();
    if (!m) throw new AppError('CONFLICT', 'The member who set up this integration is no longer in the organization. Recreate the integration.');
    return { userId: String(i.createdBy), organizationId: String(i.organizationId), role: m.role as Role, correlationId: `int_${randomBytes(6).toString('hex')}` };
  }

  // ── Replies ────────────────────────────────────────────────────────────────
  private async reportFinished(t: TaskDto) {
    const src = t.source;
    if (!src?.integrationId) return;
    const i = (await Integration.findById(src.integrationId).lean()) as IntegrationLean | null;
    if (!i) return;
    const settings = integrationSettings.parse(i.settings ?? {});
    const summary = t.completionReport?.summary ?? t.statusReason ?? '';
    const words = { COMPLETED: 'completed', FAILED: 'failed', RECOVERY_REQUIRED: 'needs attention' } as Record<string, string>;
    if (i.kind === 'generic') {
      if (!settings.callbackUrl) return;
      const body = Buffer.from(JSON.stringify({ taskId: t.id, status: t.status, title: t.title, summary, url: this.taskUrl(t.organizationId, t.id), ref: src.ref }));
      const secret = this.box.decrypt(((await Integration.findById(i._id).select('+secretEnc').lean()) as IntegrationLean).secretEnc!);
      const res = await this.fetchImpl(settings.callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ao-signature': `sha256=${hmacHex(secret, body)}` }, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) log.warn({ status: res.status, integration: String(i._id) }, 'callback failed');
      return;
    }
    if (t.kind === 'review' && t.status === 'COMPLETED' && t.completionReport?.review) return this.postReview(i, settings, src.ref, t);
    await this.reply(i, settings, src.externalId ?? src.ref, src.refType ?? 'issue', `Task ${words[t.status] ?? t.status.toLowerCase()}: ${t.title}\n\n${summary}\n\n${this.taskUrl(t.organizationId, t.id)}`.trim());
  }

  private async token(i: IntegrationLean, settings: IntegrationSettings) {
    if (!settings.replyTokenSecret) return null;
    const s = await Secret.findOne({ organizationId: i.organizationId, name: settings.replyTokenSecret }).select('+valueEnc').lean();
    if (!s) log.warn({ integration: String(i._id), secret: settings.replyTokenSecret }, 'reply token secret not found');
    return s ? this.box.decrypt(s.valueEnc) : null;
  }

  /**
   * Posts a finished review (FUT-003). GitHub: a pull request review with line comments (always as a
   * comment, never an approval or a merge block: the verdict is stated in the text). If GitHub refuses
   * the line comments (lines outside the diff), the review is posted with all comments in its body.
   * GitLab: one merge request note.
   */
  private async postReview(i: IntegrationLean, settings: IntegrationSettings, ref: string | null, t: TaskDto) {
    const token = ref ? await this.token(i, settings) : null;
    if (!token || !ref) return;
    const review = t.completionReport!.review!;
    const verdict = { approve: 'Looks good', comment: 'Comments', request_changes: 'Changes requested' }[review.verdict];
    const line = (c: (typeof review.comments)[number]) => `- **${c.severity}** \`${c.path}${c.line ? `:${c.line}` : ''}\`: ${c.body}`;
    const header = `**Agent review — ${verdict}**\n\n${review.summary}`;
    const footer = `\n\n[Task](${this.taskUrl(t.organizationId, t.id)})`;
    const [repo, number] = ref.split('#') as [string, string];
    if (i.kind === 'github') {
      const api = (settings.apiBaseUrl || this.config.GITHUB_API_URL).replace(/\/+$/, '');
      const headers = { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'agent-orchestration' };
      const inline = review.comments.filter((c) => c.line);
      const general = review.comments.filter((c) => !c.line);
      const post = (body: object) => this.fetchImpl(`${api}/repos/${repo}/pulls/${number}/reviews`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      let res = await post({
        event: 'COMMENT',
        body: header + (general.length ? `\n\n${general.map(line).join('\n')}` : '') + footer,
        comments: inline.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: `**${c.severity}**: ${c.body}` })),
      });
      if (res.status === 422 && inline.length) res = await post({ event: 'COMMENT', body: header + `\n\n${review.comments.map(line).join('\n')}` + footer });
      if (!res.ok) log.warn({ status: res.status, integration: String(i._id) }, 'posting the review failed');
      return;
    }
    const api = (settings.apiBaseUrl || 'https://gitlab.com').replace(/\/+$/, '');
    const res = await this.fetchImpl(`${api}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests/${number}/notes`, {
      method: 'POST',
      headers: { 'private-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ body: header + (review.comments.length ? `\n\n${review.comments.map(line).join('\n')}` : '') + footer }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) log.warn({ status: res.status, integration: String(i._id) }, 'posting the review failed');
  }

  /** Comments on the GitHub issue / GitLab issue, when a reply token is configured. */
  private async reply(i: IntegrationLean, settings: IntegrationSettings, ref: string | null, refType: 'issue' | 'pr', text: string) {
    if (!ref || i.kind === 'generic') return;
    const token = await this.token(i, settings);
    if (!token) return;
    const [repo, number] = ref.split('#') as [string, string];
    let res: Response;
    if (i.kind === 'linear') {
      // `ref` is the issue's id. A personal API key goes in the header as it is; an OAuth token as a bearer.
      res = await this.fetchImpl(`${(settings.apiBaseUrl || 'https://api.linear.app').replace(/\/+$/, '')}/graphql`, {
        method: 'POST',
        headers: { authorization: token.startsWith('lin_api_') ? token : `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }', variables: { issueId: ref, body: text } }),
        signal: AbortSignal.timeout(15_000),
      });
    } else if (i.kind === 'jira') {
      // `ref` is the issue key; the site comes from the settings. "email:token" (Jira Cloud) or a personal access token.
      if (!settings.apiBaseUrl) return void log.warn({ integration: String(i._id) }, 'no Jira site URL configured; reply not sent');
      res = await this.fetchImpl(`${settings.apiBaseUrl.replace(/\/+$/, '')}/rest/api/2/issue/${encodeURIComponent(ref)}/comment`, {
        method: 'POST',
        headers: { authorization: token.includes(':') ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
        signal: AbortSignal.timeout(15_000),
      });
    } else if (i.kind === 'github') {
      const api = (settings.apiBaseUrl || this.config.GITHUB_API_URL).replace(/\/+$/, '');
      res = await this.fetchImpl(`${api}/repos/${repo}/issues/${number}/comments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'agent-orchestration' },
        body: JSON.stringify({ body: text }),
        signal: AbortSignal.timeout(15_000),
      });
    } else {
      const api = (settings.apiBaseUrl || 'https://gitlab.com').replace(/\/+$/, '');
      res = await this.fetchImpl(`${api}/api/v4/projects/${encodeURIComponent(repo)}/${refType === 'pr' ? 'merge_requests' : 'issues'}/${number}/notes`, {
        method: 'POST',
        headers: { 'private-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ body: text }),
        signal: AbortSignal.timeout(15_000),
      });
    }
    if (!res.ok) log.warn({ status: res.status, integration: String(i._id) }, 'reply comment failed');
  }
}

// ── Payload parsing ──────────────────────────────────────────────────────────
type Parsed = Trigger | { ignore: string } | { pong: true };
const commandText = (body: string, command: string) => {
  if (!command) return null;
  const trimmed = body.trimStart();
  return trimmed.toLowerCase().startsWith(command.toLowerCase()) ? trimmed.slice(command.length).trim() : null;
};

export function parseGitHub(event: string, p: any, s: IntegrationSettings): Parsed {
  if (event === 'ping') return { pong: true };
  const repo = p?.repository?.full_name as string | undefined;
  if (event === 'issues') {
    const issue = p.issue;
    const labels: string[] = (issue?.labels ?? []).map((l: { name: string }) => l.name);
    if (p.action === 'opened') {
      if (s.label && !labels.includes(s.label)) return { ignore: `issue does not have the "${s.label}" label` };
    } else if (p.action === 'labeled') {
      if (!s.label || p.label?.name !== s.label) return { ignore: 'a different label was added' };
    } else return { ignore: `issues.${p.action} is not handled` };
    return { title: issue.title ?? '', prompt: `${issue.body ?? ''}\n\nGitHub issue: ${issue.html_url}`, idempotencyKey: `gh:issue:${repo}#${issue.number}`, url: issue.html_url ?? null, ref: `${repo}#${issue.number}` };
  }
  if (event === 'issue_comment') {
    if (p.action !== 'created') return { ignore: `issue_comment.${p.action} is not handled` };
    if (p.sender?.type === 'Bot') return { ignore: 'comment by a bot' };
    const text = commandText(p.comment?.body ?? '', s.command);
    if (text === null) return { ignore: s.command ? `comment does not start with ${s.command}` : 'comment commands are off' };
    const issue = p.issue;
    return {
      title: clip(text.split('\n')[0] || issue.title, 200),
      prompt: `${text}\n\nContext — GitHub ${issue.pull_request ? 'pull request' : 'issue'} "${issue.title}" (${issue.html_url}):\n${issue.body ?? ''}`,
      idempotencyKey: `gh:comment:${p.comment.id}`,
      url: p.comment.html_url ?? issue.html_url ?? null,
      ref: `${repo}#${issue.number}`,
      // A command on a pull request that a task opened continues that task's branch.
      ...(issue.pull_request && s.followUps !== 'off' ? { refType: 'pr' as const, followUp: { pullRequestUrl: issue.pull_request.html_url ?? issue.html_url, number: issue.number, required: false } } : {}),
    };
  }
  if (event === 'pull_request_review') {
    if (s.followUps === 'off') return { ignore: 'follow-ups on review feedback are off' };
    if (p.action !== 'submitted') return { ignore: `pull_request_review.${p.action} is not handled` };
    if (p.sender?.type === 'Bot') return { ignore: 'review by a bot' };
    const review = p.review ?? {};
    const pr = p.pull_request ?? {};
    const state = String(review.state ?? '').toLowerCase();
    const body = String(review.body ?? '').trim();
    if (state === 'approved') return { ignore: 'the review approves the pull request' };
    if (state !== 'changes_requested' && !(s.followUps === 'all_reviews' && body)) return { ignore: state === 'commented' ? 'the review does not request changes' : `review state "${state}" is not handled` };
    return {
      title: clip(`Address review: ${pr.title ?? `#${pr.number}`}`, 200),
      prompt: `A reviewer ${state === 'changes_requested' ? 'requested changes on' : 'commented on'} pull request #${pr.number} "${pr.title}" (${pr.html_url}). Address the feedback on the pull request's branch.\n\nReview by ${review.user?.login ?? 'a reviewer'}:\n${body || '(no summary; see the comments on lines)'}\n\nReview: ${review.html_url ?? pr.html_url}`,
      idempotencyKey: `gh:review:${review.id}`,
      url: review.html_url ?? pr.html_url ?? null,
      ref: `${repo}#${pr.number}`,
      refType: 'pr',
      followUp: { pullRequestUrl: pr.html_url, number: pr.number, required: true, reviewId: review.id },
    };
  }
  if (event === 'pull_request') {
    if (s.reviews === 'off') return { ignore: 'pull request reviews are off' };
    const pr = p.pull_request ?? {};
    const actions = ['opened', 'reopened', 'ready_for_review', ...(s.reviews === 'every_push' ? ['synchronize'] : [])];
    if (!actions.includes(p.action)) return { ignore: `pull_request.${p.action} is not reviewed` };
    if (pr.draft) return { ignore: 'draft pull request' };
    return {
      title: clip(`Review: ${pr.title ?? `#${pr.number}`}`, 200),
      prompt: `Review pull request #${pr.number} "${pr.title}" (${pr.html_url}).\n\n${pr.body ?? ''}`,
      idempotencyKey: `gh:pr:${repo}#${pr.number}@${pr.head?.sha}`,
      url: pr.html_url ?? null,
      ref: `${repo}#${pr.number}`,
      refType: 'pr',
      review: { base: pr.base?.ref, head: pr.head?.ref, fetchHead: `pull/${pr.number}/head`, pullRequest: { url: pr.html_url, number: pr.number } },
    };
  }
  return { ignore: `GitHub event "${event}" is not handled` };
}

export function parseGitLab(event: string, p: any, s: IntegrationSettings): Parsed {
  const project = p?.project?.id;
  if (event === 'Issue Hook') {
    const a = p.object_attributes ?? {};
    const labels: string[] = (p.labels ?? []).map((l: { title: string }) => l.title);
    if (a.action === 'open') {
      if (s.label && !labels.includes(s.label)) return { ignore: `issue does not have the "${s.label}" label` };
    } else if (a.action === 'update') {
      const prev: string[] = (p.changes?.labels?.previous ?? []).map((l: { title: string }) => l.title);
      const cur: string[] = (p.changes?.labels?.current ?? []).map((l: { title: string }) => l.title);
      if (!s.label || !cur.includes(s.label) || prev.includes(s.label)) return { ignore: 'the configured label was not added' };
    } else return { ignore: `issue action "${a.action}" is not handled` };
    return { title: a.title ?? '', prompt: `${a.description ?? ''}\n\nGitLab issue: ${a.url}`, idempotencyKey: `gl:issue:${project}#${a.iid}`, url: a.url ?? null, ref: `${project}#${a.iid}` };
  }
  if (event === 'Note Hook') {
    const a = p.object_attributes ?? {};
    if (a.noteable_type !== 'Issue') return { ignore: 'only issue comments are handled' };
    const text = commandText(a.note ?? '', s.command);
    if (text === null) return { ignore: s.command ? `comment does not start with ${s.command}` : 'comment commands are off' };
    const issue = p.issue ?? {};
    return { title: clip(text.split('\n')[0] || issue.title, 200), prompt: `${text}\n\nContext — GitLab issue "${issue.title}" (${issue.url ?? a.url}):\n${issue.description ?? ''}`, idempotencyKey: `gl:note:${a.id}`, url: a.url ?? null, ref: `${project}#${issue.iid}` };
  }
  if (event === 'Merge Request Hook') {
    if (s.reviews === 'off') return { ignore: 'merge request reviews are off' };
    const a = p.object_attributes ?? {};
    const pushed = a.action === 'update' && Boolean(a.oldrev);
    if (!(['open', 'reopen'].includes(a.action) || (pushed && s.reviews === 'every_push'))) return { ignore: `merge request action "${a.action}" is not reviewed` };
    if (a.draft || a.work_in_progress) return { ignore: 'draft merge request' };
    return {
      title: clip(`Review: ${a.title ?? `!${a.iid}`}`, 200),
      prompt: `Review merge request !${a.iid} "${a.title}" (${a.url}).\n\n${a.description ?? ''}`,
      idempotencyKey: `gl:mr:${project}!${a.iid}@${a.last_commit?.id}`,
      url: a.url ?? null,
      ref: `${project}#${a.iid}`,
      refType: 'pr',
      review: { base: a.target_branch, head: a.source_branch, fetchHead: `refs/merge-requests/${a.iid}/head`, pullRequest: { url: a.url, number: a.iid } },
    };
  }
  return { ignore: `GitLab event "${event}" is not handled` };
}

/** Jira descriptions and comments are text, or Atlassian Document Format: the text of its nodes, a line per block. */
function jiraText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const node = v as { type?: string; text?: string; content?: unknown[] };
  if (typeof node.text === 'string') return node.text;
  const inner = (node.content ?? []).map(jiraText).join('');
  return ['paragraph', 'heading', 'listItem', 'codeBlock', 'blockquote'].includes(node.type ?? '') ? `${inner}\n` : inner;
}

/** Jira webhooks (jira:issue_created, jira:issue_updated, comment_created). */
export function parseJira(p: any, s: IntegrationSettings): Parsed {
  const event = String(p?.webhookEvent ?? '');
  const issue = p?.issue ?? {};
  const key = issue.key as string | undefined;
  if (!key) return { ignore: `Jira event "${event || 'unknown'}" has no issue` };
  const fields = issue.fields ?? {};
  let site = '';
  try {
    site = new URL(String(issue.self)).origin;
  } catch {
    /* no link without the site */
  }
  const url = site ? `${site}/browse/${key}` : null;
  const labels: string[] = fields.labels ?? [];
  if (event === 'jira:issue_created' || event === 'jira:issue_updated') {
    if (event === 'jira:issue_created') {
      if (s.label && !labels.includes(s.label)) return { ignore: `issue does not have the "${s.label}" label` };
    } else {
      const change = ((p.changelog?.items ?? []) as Array<{ field?: string; fromString?: string | null; toString?: string | null }>).find((c) => c.field === 'labels');
      const had = (change?.fromString ?? '').split(' ');
      const has = (typeof change?.toString === 'string' ? change.toString : '').split(' ');
      if (!s.label || !change || !has.includes(s.label) || had.includes(s.label)) return { ignore: 'the configured label was not added' };
    }
    return { title: `${key}: ${fields.summary ?? ''}`.trim(), prompt: `${jiraText(fields.description).trim()}\n\nJira issue: ${url ?? key}`, idempotencyKey: `jira:issue:${key}`, url, ref: key };
  }
  if (event === 'comment_created') {
    if (p.comment?.author?.accountType === 'app') return { ignore: 'comment by an app' };
    const text = commandText(jiraText(p.comment?.body).trim(), s.command);
    if (text === null) return { ignore: s.command ? `comment does not start with ${s.command}` : 'comment commands are off' };
    return { title: clip(text.split('\n')[0] || `${key}: ${fields.summary ?? ''}`, 200), prompt: `${text}\n\nContext — Jira issue ${key} "${fields.summary ?? ''}" (${url ?? key}):\n${jiraText(fields.description).trim()}`, idempotencyKey: `jira:comment:${p.comment?.id}`, url, ref: key };
  }
  return { ignore: `Jira event "${event}" is not handled` };
}

/** Linear webhooks (Issue and Comment data change events). */
export function parseLinear(p: any, s: IntegrationSettings): Parsed {
  const d = p?.data ?? {};
  if (p?.type === 'Issue') {
    const labels: Array<{ id: string; name: string }> = d.labels ?? [];
    const wanted = labels.find((l) => l.name === s.label);
    if (p.action === 'create') {
      if (s.label && !wanted) return { ignore: `issue does not have the "${s.label}" label` };
    } else if (p.action === 'update') {
      const before: string[] | undefined = p.updatedFrom?.labelIds;
      if (!s.label || !wanted || !before || before.includes(wanted.id)) return { ignore: 'the configured label was not added' };
    } else return { ignore: `issue action "${p.action}" is not handled` };
    return { title: `${d.identifier ?? ''}: ${d.title ?? ''}`.replace(/^: /, ''), prompt: `${d.description ?? ''}\n\nLinear issue: ${d.url ?? p.url ?? d.identifier}`, idempotencyKey: `linear:issue:${d.id}`, url: d.url ?? p.url ?? null, ref: d.identifier ?? null, externalId: d.id };
  }
  if (p?.type === 'Comment') {
    if (p.action !== 'create') return { ignore: `comment action "${p.action}" is not handled` };
    if (d.botActor || !d.userId) return { ignore: 'comment by an integration' };
    const text = commandText(String(d.body ?? ''), s.command);
    if (text === null) return { ignore: s.command ? `comment does not start with ${s.command}` : 'comment commands are off' };
    const issue = d.issue ?? {};
    return { title: clip(text.split('\n')[0] || issue.title || 'Linear comment', 200), prompt: `${text}\n\nContext — Linear issue ${issue.identifier ?? ''} "${issue.title ?? ''}" (${p.url ?? ''})`, idempotencyKey: `linear:comment:${d.id}`, url: p.url ?? null, ref: issue.identifier ?? null, externalId: issue.id ?? d.issueId };
  }
  return { ignore: `Linear event "${p?.type ?? 'unknown'}" is not handled` };
}

export function parseGeneric(p: unknown, s: IntegrationSettings, deliveryId: string): Parsed {
  const title = fillTemplate(s.titleTemplate, p).trim();
  const prompt = fillTemplate(s.promptTemplate, p).trim();
  if (!title && !prompt) return { ignore: 'the templates produced an empty title and prompt' };
  return { title: title || prompt.split('\n')[0]!, prompt: prompt || title, idempotencyKey: `gen:${deliveryId}`, url: null, ref: null };
}
