import { Membership, Notification, PushToken, User, oid } from '@ao/database';
import { captureError, createLogger, redactString } from '@ao/core';
import type { ServerConfig } from './config.js';
import type { LiveHub } from './live.js';
import { toNotificationDto } from './dto.js';

const log = createLogger('notifications');

export const NOTIFICATION_TYPES = [
  'task.completed',
  'task.failed',
  'task.waiting',
  'task.provider_limit',
  'task.approval_required',
  'task.input_required',
  'task.recovery_required',
  'task.verification_failed',
  'worker.offline',
  'worker.pending_approval',
  'deployment.result',
  'budget.warning',
  'budget.exceeded',
  /** Organization-level notices from extensions (for example account or plan changes). */
  'organization.notice',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** A notification as it leaves the server for other systems; the body is already redacted. */
export interface OutboundNotification {
  organizationId: string;
  type: NotificationType;
  title: string;
  body: string;
  taskId: string | null;
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** SMTP mailer; when SMTP is not configured, messages are logged (dev) and not sent. */
export async function createMailer(config: ServerConfig): Promise<Mailer & { configured: boolean }> {
  if (!config.SMTP_URL) {
    return {
      configured: false,
      async send(to, subject) {
        log.info({ to, subject }, 'SMTP not configured; email not sent');
      },
    };
  }
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport(config.SMTP_URL);
  return {
    configured: true,
    /**
     * Never throws: a mail-server outage must not fail registration, invitations or password resets,
     * nor make "reset password" answer differently for existing and unknown emails (enumeration).
     */
    async send(to, subject, text) {
      try {
        await transport.sendMail({ from: config.SMTP_FROM, to, subject, text });
      } catch (e) {
        log.error({ subject, err: String(e) }, 'email could not be sent');
        captureError(e, { tags: { component: 'smtp' } });
      }
    },
  };
}

export class NotificationService {
  constructor(
    private config: ServerConfig,
    private live: LiveHub,
    private mailer: Mailer,
  ) {}

  private sinks: Array<(n: OutboundNotification) => Promise<void>> = [];
  /** Other places a notification goes (chat channels). A sink never delays or fails the notification. */
  onNotify(sink: (n: OutboundNotification) => Promise<void>) {
    this.sinks.push(sink);
  }

  /**
   * Notify organization members. `minRole` filters recipients; the task creator is always included.
   * Delivery: in-app (always), push (if enabled & tokens), email for high-severity types.
   */
  async notify(input: {
    organizationId: string;
    type: NotificationType;
    title: string;
    body?: string;
    taskId?: string | null;
    workerId?: string | null;
    userIds?: string[];
    roles?: string[];
    /** Also send by email (default: only for high-severity task and worker types). */
    email?: boolean;
  }) {
    const orgId = oid(input.organizationId);
    let userIds = input.userIds;
    if (!userIds) {
      const members = await Membership.find({ organizationId: orgId, suspended: { $ne: true }, ...(input.roles ? { role: { $in: input.roles } } : {}) }).lean();
      userIds = members.map((m) => String(m.userId));
    }
    const body = redactString(input.body ?? '');
    const docs = await Notification.insertMany(
      [...new Set(userIds)].map((u) => ({
        organizationId: orgId,
        userId: oid(u),
        type: input.type,
        title: input.title,
        body,
        taskId: input.taskId ? oid(input.taskId) : null,
        workerId: input.workerId ? oid(input.workerId) : null,
      })),
    );
    for (const d of docs) this.live.publishToOrg(input.organizationId, { type: 'notification', notification: toNotificationDto(d.toObject()) });
    const outbound = { organizationId: input.organizationId, type: input.type, title: input.title, body, taskId: input.taskId ?? null };
    for (const sink of this.sinks) void sink(outbound).catch((e) => captureError(e, { tags: { component: 'notifications.sink' } }));

    const emailTypes: NotificationType[] = ['task.failed', 'task.recovery_required', 'worker.offline', 'task.approval_required'];
    if (input.email ?? emailTypes.includes(input.type)) {
      const users = await User.find({ _id: { $in: userIds.map((u) => oid(u)) } }).lean();
      await Promise.allSettled(users.map((u) => this.mailer.send(u.email, input.title, body)));
    }
    if (this.config.EXPO_PUSH_ENABLED) await this.sendPush(userIds, input.title, body, { taskId: input.taskId, type: input.type });
  }

  /** Expo push API (only when EXPO_PUSH_ENABLED=true). */
  private async sendPush(userIds: string[], title: string, body: string, data: Record<string, unknown>) {
    const tokens = await PushToken.find({ userId: { $in: userIds.map((u) => oid(u)) } }).lean();
    if (!tokens.length) return;
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(tokens.map((t) => ({ to: t.token, title, body, data }))),
      });
    } catch (e) {
      log.warn({ err: String(e) }, 'push delivery failed');
    }
  }
}
