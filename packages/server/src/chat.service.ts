import { createHmac, randomBytes } from 'node:crypto';
import { AppError, createLogger, safeEqual, type Role } from '@ao/core';
import { ChatChannel, Membership, Project, Task, isDuplicateKeyError, oid } from '@ao/database';
import { API_PREFIX, CHAT_EVENTS, type ChatChannelDto, type TaskActionRequest, type createChatChannelRequest, type updateChatChannelRequest } from '@ao/contracts';
import type { z } from 'zod';
import { requirePublicCallbackUrls, type ServerConfig } from './config.js';
import type { SecretBox } from './crypto.js';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';
import type { OutboundNotification } from './notifications.js';
import type { TaskService } from './task.service.js';

const log = createLogger('chat');
/** Slack: a request older than this is refused (replay protection). */
const MAX_SIGNATURE_AGE_S = 300;
const ATTENTION = ['WAITING_FOR_APPROVAL', 'WAITING_FOR_INPUT', 'RECOVERY_REQUIRED'];
const HELP = [
  'Commands:',
  '• `status`: tasks that wait for a person',
  '• `approve <task>` · `deny <task> [reason]`',
  '• `answer <task> <text>`: answer an agent\'s question',
  '• `retry <task>` · `cancel <task>`',
  '`<task>` is a task ID, or its last 6 characters.',
].join('\n');

type ChannelLean = Record<string, any> & { _id: any };

/** Slack's mrkdwn control characters. */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Chat channels: notifications go to Slack or Microsoft Teams through an incoming webhook. A Slack
 * channel with the app's signing secret also takes actions back (Approve/Deny buttons and a slash
 * command); each is checked against Slack's signature and runs as the organization member whose Slack
 * member ID sent it, with that member's role. Teams channels are notifications with a link to the task.
 */
export class ChatService {
  constructor(
    private readonly config: ServerConfig,
    private readonly box: SecretBox,
    private readonly tasks: TaskService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  requestUrl(id: string) {
    return `${this.config.PUBLIC_URL.replace(/\/+$/, '')}${API_PREFIX}/chat/slack/${id}`;
  }

  private taskUrl(taskId: string) {
    return `${this.config.WEB_URL.replace(/\/+$/, '')}/tasks/${taskId}`;
  }

  private dto(c: ChannelLean): ChatChannelDto {
    return {
      id: String(c._id),
      name: c.name,
      kind: c.kind,
      enabled: Boolean(c.enabled),
      events: c.events ?? [],
      projectIds: (c.projectIds ?? []).map(String),
      webhookHost: c.webhookHost,
      interactive: Boolean(c.interactive),
      requestUrl: c.kind === 'slack' && c.interactive ? this.requestUrl(String(c._id)) : null,
      lastDeliveryAt: c.lastDeliveryAt ? new Date(c.lastDeliveryAt).toISOString() : null,
      lastDeliveryResult: c.lastDeliveryResult ?? null,
      createdAt: new Date(c.createdAt).toISOString(),
    };
  }

  /** A shared installation must not call into its own network on behalf of tenants. */
  private checkWebhook(url: string) {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) throw new AppError('VALIDATION_FAILED', 'The webhook URL must start with https://');
    if (!requirePublicCallbackUrls(this.config)) return u.host;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|0\.)/.test(u.hostname) || u.protocol !== 'https:') {
      throw new AppError('VALIDATION_FAILED', 'Webhook URLs must be public https URLs');
    }
    return u.host;
  }

  private async checkProjects(actor: Actor, projectIds: string[]) {
    if (!projectIds.length) return;
    const n = await Project.countDocuments({ _id: { $in: projectIds.map((p) => oid(p, 'Project')) }, organizationId: oid(actor.organizationId) });
    if (n !== new Set(projectIds).size) throw new AppError('NOT_FOUND', 'Project not found');
  }

  // ── Management (settings.manage) ───────────────────────────────────────────
  async list(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    return ((await ChatChannel.find({ organizationId: oid(actor.organizationId) }).sort({ name: 1 }).lean()) as ChannelLean[]).map((c) => this.dto(c));
  }

  async create(actor: Actor, input: z.output<typeof createChatChannelRequest>) {
    requirePermission(actor, 'settings.manage');
    const webhookHost = this.checkWebhook(input.webhookUrl);
    await this.checkProjects(actor, input.projectIds);
    const interactive = input.kind === 'slack' && Boolean(input.signingSecret);
    try {
      const doc = await ChatChannel.create({
        organizationId: oid(actor.organizationId),
        name: input.name,
        kind: input.kind,
        enabled: input.enabled,
        webhookUrlEnc: this.box.encrypt(input.webhookUrl),
        webhookHost,
        signingSecretEnc: interactive ? this.box.encrypt(input.signingSecret!) : null,
        interactive,
        events: input.events,
        projectIds: input.projectIds.map((p) => oid(p)),
        createdBy: oid(actor.userId),
      });
      await audit(actor, 'chat_channel.create', { type: 'chat_channel', id: String(doc._id) }, { kind: input.kind, name: input.name, host: webhookHost, interactive });
      return this.dto(doc.toObject() as ChannelLean);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A chat channel with this name exists');
      throw e;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateChatChannelRequest>) {
    requirePermission(actor, 'settings.manage');
    const cur = (await ChatChannel.findOne({ _id: oid(id, 'Chat channel'), organizationId: oid(actor.organizationId) }).lean()) as ChannelLean | null;
    if (!cur) throw new AppError('NOT_FOUND', 'Chat channel not found');
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'enabled', 'events'] as const) if (input[k] !== undefined) set[k] = input[k];
    if (input.webhookUrl) Object.assign(set, { webhookHost: this.checkWebhook(input.webhookUrl), webhookUrlEnc: this.box.encrypt(input.webhookUrl) });
    if (input.projectIds) {
      await this.checkProjects(actor, input.projectIds);
      set.projectIds = input.projectIds.map((p) => oid(p));
    }
    // An empty signing secret turns buttons and commands off.
    if (input.signingSecret !== undefined && cur.kind === 'slack') Object.assign(set, { interactive: Boolean(input.signingSecret), signingSecretEnc: input.signingSecret ? this.box.encrypt(input.signingSecret) : null });
    try {
      const doc = (await ChatChannel.findOneAndUpdate({ _id: cur._id }, { $set: set }, { new: true }).lean()) as ChannelLean;
      await audit(actor, 'chat_channel.update', { type: 'chat_channel', id }, { fields: Object.keys(input) });
      return this.dto(doc);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A chat channel with this name exists');
      throw e;
    }
  }

  async remove(actor: Actor, id: string) {
    requirePermission(actor, 'settings.manage');
    const r = await ChatChannel.deleteOne({ _id: oid(id, 'Chat channel'), organizationId: oid(actor.organizationId) });
    if (!r.deletedCount) throw new AppError('NOT_FOUND', 'Chat channel not found');
    await audit(actor, 'chat_channel.delete', { type: 'chat_channel', id });
  }

  /** Sends a test message; the result is what the chat service answered. */
  async test(actor: Actor, id: string) {
    requirePermission(actor, 'settings.manage');
    const c = (await ChatChannel.findOne({ _id: oid(id, 'Chat channel'), organizationId: oid(actor.organizationId) }).select('+webhookUrlEnc').lean()) as ChannelLean | null;
    if (!c) throw new AppError('NOT_FOUND', 'Chat channel not found');
    const result = await this.post(c, { organizationId: actor.organizationId, type: 'organization.notice', title: 'Agent Orchestration is connected', body: `Notifications for "${c.name}" arrive here.`, taskId: null }, null);
    return { result };
  }

  // ── Identity ───────────────────────────────────────────────────────────────
  async identity(actor: Actor) {
    const m = await Membership.findOne({ organizationId: oid(actor.organizationId), userId: oid(actor.userId) }, { slackUserId: 1 }).lean();
    return { slackUserId: m?.slackUserId ?? null };
  }

  async setIdentity(actor: Actor, slackUserId: string | null) {
    try {
      await Membership.updateOne({ organizationId: oid(actor.organizationId), userId: oid(actor.userId) }, slackUserId ? { $set: { slackUserId } } : { $unset: { slackUserId: 1 } });
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'Another member of this organization uses this Slack member ID');
      throw e;
    }
    await audit(actor, 'member.chat_identity', { type: 'user', id: actor.userId }, { slack: Boolean(slackUserId) });
    return { slackUserId };
  }

  // ── Outgoing ───────────────────────────────────────────────────────────────
  /** Sends a notification to the organization's channels that take its type (and its task's project). */
  async deliver(n: OutboundNotification) {
    if (!(CHAT_EVENTS as readonly string[]).includes(n.type)) return;
    const channels = (await ChatChannel.find({ organizationId: oid(n.organizationId), enabled: true, events: n.type }).select('+webhookUrlEnc').lean()) as ChannelLean[];
    if (!channels.length) return;
    const task = n.taskId ? await Task.findById(n.taskId, { projectId: 1 }).lean() : null;
    for (const c of channels) {
      const projects: string[] = (c.projectIds ?? []).map(String);
      if (projects.length && n.taskId && !(task && projects.includes(String(task.projectId)))) continue;
      await this.post(c, n, n.taskId);
    }
  }

  private async post(c: ChannelLean, n: OutboundNotification, taskId: string | null) {
    const message = c.kind === 'slack' ? this.slackMessage(n, taskId, Boolean(c.interactive)) : this.teamsMessage(n, taskId);
    let result: string;
    try {
      const res = await this.fetchImpl(this.box.decrypt(c.webhookUrlEnc), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal: AbortSignal.timeout(10_000) });
      result = res.ok ? 'ok' : `failed: HTTP ${res.status}`;
    } catch (e) {
      result = `failed: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'could not connect'}`;
    }
    if (result !== 'ok') log.warn({ channel: String(c._id), result }, 'chat delivery failed');
    await ChatChannel.updateOne({ _id: c._id }, { $set: { lastDeliveryAt: new Date(), lastDeliveryResult: result } });
    return result;
  }

  private slackMessage(n: OutboundNotification, taskId: string | null, interactive: boolean) {
    const title = clip(n.title, 300);
    const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: `*${esc(title)}*${n.body ? `\n${esc(clip(n.body, 2500))}` : ''}` } }];
    if (taskId) {
      const button = (text: string, action: string, style?: 'primary' | 'danger') => ({ type: 'button', text: { type: 'plain_text', text }, action_id: action, value: taskId, ...(style ? { style } : {}) });
      const hint = n.type === 'task.input_required' && interactive ? ` · answer with the command: \`answer ${taskId.slice(-6)} <text>\`` : '';
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Task \`${taskId.slice(-6)}\`${hint}` }] });
      blocks.push({
        type: 'actions',
        elements: [
          ...(interactive && n.type === 'task.approval_required' ? [button('Approve', 'ao_approve', 'primary'), button('Deny', 'ao_deny', 'danger')] : []),
          ...(interactive && n.type === 'task.recovery_required' ? [button('Retry', 'ao_retry')] : []),
          { type: 'button', text: { type: 'plain_text', text: 'Open task' }, url: this.taskUrl(taskId), action_id: 'ao_open' },
        ],
      });
    }
    return { text: title, blocks };
  }

  private teamsMessage(n: OutboundNotification, taskId: string | null) {
    return {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [{ type: 'TextBlock', text: clip(n.title, 300), weight: 'Bolder', wrap: true }, ...(n.body ? [{ type: 'TextBlock', text: clip(n.body, 2500), wrap: true }] : [])],
            actions: taskId ? [{ type: 'Action.OpenUrl', title: 'Open task', url: this.taskUrl(taskId) }] : [],
          },
        },
      ],
    };
  }

  // ── Incoming (Slack buttons and slash command) ─────────────────────────────
  /**
   * One request from Slack to a channel's request URL. Throws UNAUTHENTICATED unless Slack's signature
   * over the raw body is valid and recent. Returns what to answer Slack with.
   */
  async handleSlack(id: string, headers: Record<string, string | string[] | undefined>, body: Buffer, now = Date.now()): Promise<unknown> {
    if (!/^[a-f0-9]{24}$/i.test(id)) throw new AppError('NOT_FOUND', 'Unknown chat channel');
    const c = (await ChatChannel.findById(id).select('+signingSecretEnc').lean()) as ChannelLean | null;
    if (!c || c.kind !== 'slack' || !c.interactive || !c.signingSecretEnc) throw new AppError('NOT_FOUND', 'Unknown chat channel');
    const h = (k: string) => {
      const v = headers[k];
      return (Array.isArray(v) ? v[0] : v) ?? '';
    };
    const timestamp = h('x-slack-request-timestamp');
    const age = Math.abs(now / 1000 - Number(timestamp));
    const expected = `v0=${createHmac('sha256', this.box.decrypt(c.signingSecretEnc)).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
    if (!/^\d+$/.test(timestamp) || !(age <= MAX_SIGNATURE_AGE_S) || !safeEqual(h('x-slack-signature'), expected)) throw new AppError('UNAUTHENTICATED', 'Invalid signature');
    if (!c.enabled) return { response_type: 'ephemeral', text: 'This channel is turned off in Agent Orchestration.' };

    const form = new URLSearchParams(body.toString('utf8'));
    if (form.has('payload')) {
      let payload: any;
      try {
        payload = JSON.parse(form.get('payload')!);
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Invalid payload');
      }
      const action = payload?.actions?.[0];
      const verb = { ao_approve: 'approve', ao_deny: 'deny', ao_retry: 'retry' }[String(action?.action_id)] as 'approve' | 'deny' | 'retry' | undefined;
      // Link buttons ("Open task") are reported too; there is nothing to do for them.
      if (payload?.type !== 'block_actions' || !verb) return undefined;
      const user = String(payload.user?.id ?? '');
      const r = await this.act(c, user, verb, String(action.value ?? ''), '');
      await this.respond(c, String(payload.response_url ?? ''), r.ok ? { response_type: 'in_channel', replace_original: false, text: `${r.text} (<@${user}>)` } : { response_type: 'ephemeral', replace_original: false, text: r.text });
      return undefined;
    }
    const [verb = '', ...rest] = (form.get('text') ?? '').trim().split(/\s+/);
    const user = form.get('user_id') ?? '';
    const text = await this.command(c, user, verb.toLowerCase(), rest);
    return { response_type: 'ephemeral', text };
  }

  /** Slack's response URL for a message; only ever Slack's own host for this channel. */
  private async respond(c: ChannelLean, url: string, message: unknown) {
    try {
      if (new URL(url).host !== c.webhookHost) return;
      await this.fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message), signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      log.warn({ channel: String(c._id), err: String(e) }, 'could not answer in Slack');
    }
  }

  private async command(c: ChannelLean, slackUserId: string, verb: string, args: string[]): Promise<string> {
    if (verb === '' || verb === 'help') return HELP;
    if (verb === 'status') {
      const actor = await this.actorFor(c, slackUserId);
      if (!actor) return UNLINKED;
      const waiting = await Task.find({ organizationId: c.organizationId, status: { $in: ATTENTION } }, { title: 1, status: 1 }).sort({ updatedAt: -1 }).limit(10).lean();
      if (!waiting.length) return 'Nothing waits for a person.';
      return waiting.map((t) => `• \`${String(t._id).slice(-6)}\` ${t.status.toLowerCase().replace(/_/g, ' ')}: <${this.taskUrl(String(t._id))}|${esc(clip(t.title, 120))}>`).join('\n');
    }
    if (!['approve', 'deny', 'answer', 'retry', 'cancel'].includes(verb)) return `Unknown command "${clip(verb, 30)}".\n${HELP}`;
    const [ref, ...words] = args;
    if (!ref) return `Which task? Example: \`${verb} 1a2b3c\``;
    return (await this.act(c, slackUserId, verb as 'approve', ref, words.join(' '))).text;
  }

  private async actorFor(c: ChannelLean, slackUserId: string): Promise<Actor | null> {
    if (!slackUserId) return null;
    const m = await Membership.findOne({ organizationId: c.organizationId, slackUserId, suspended: { $ne: true } }).lean();
    return m ? { userId: String(m.userId), organizationId: String(c.organizationId), role: m.role as Role, correlationId: `chat_${randomBytes(6).toString('hex')}` } : null;
  }

  /** A task by ID, or by the last characters of its ID among the tasks that wait for a person. */
  private async resolveTask(c: ChannelLean, ref: string): Promise<string | null> {
    if (/^[a-f0-9]{24}$/i.test(ref)) return ref.toLowerCase();
    if (!/^[a-f0-9]{6,23}$/i.test(ref)) return null;
    const waiting = await Task.find({ organizationId: c.organizationId, status: { $in: [...ATTENTION, 'FAILED'] } }, { _id: 1 }).sort({ updatedAt: -1 }).limit(500).lean();
    const matches = waiting.map((t) => String(t._id)).filter((t) => t.endsWith(ref.toLowerCase()));
    return matches.length === 1 ? matches[0]! : null;
  }

  private async act(c: ChannelLean, slackUserId: string, verb: 'approve' | 'deny' | 'answer' | 'retry' | 'cancel', ref: string, text: string): Promise<{ ok: boolean; text: string }> {
    const actor = await this.actorFor(c, slackUserId);
    if (!actor) return { ok: false, text: UNLINKED };
    const taskId = await this.resolveTask(c, ref);
    if (!taskId) return { ok: false, text: `No task "${clip(ref, 30)}" waits for a person. Use the full task ID, or \`status\` to list them.` };
    if (verb === 'answer' && !text.trim()) return { ok: false, text: 'What is the answer? Example: `answer 1a2b3c use the staging database`' };
    const request: TaskActionRequest = verb === 'answer' ? { action: 'input', input: text } : { action: verb, reason: text.trim() || `From Slack (${c.name})` };
    try {
      const t = await this.tasks.action(actor, taskId, request);
      const done = { approve: 'Approved', deny: 'Denied', answer: 'Answer sent', retry: 'Retrying', cancel: 'Cancelled' }[verb];
      return { ok: true, text: `${done}: ${esc(clip(t.title, 150))}` };
    } catch (e) {
      if (e instanceof AppError) return { ok: false, text: esc(e.userMessage) };
      throw e;
    }
  }
}

const UNLINKED = 'Your Slack account is not linked to a member. In Agent Orchestration, open Settings → Your account and enter your Slack member ID (Slack: your profile → ⋮ → Copy member ID).';
