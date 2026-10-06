import { randomBytes } from 'node:crypto';
import { AppError, FAILURE_CATEGORY_LABELS, captureError, createLogger, type FailureCategory } from '@ao/core';
import { ChatChannel, Organization, User, oid } from '@ao/database';
import { digestSettingsRequest, type DigestSettingsDto } from '@ao/contracts';
import type { z } from 'zod';
import type { AnalyticsService } from './analytics.service.js';
import { audit } from './audit.js';
import type { ChatService } from './chat.service.js';
import type { ServerConfig } from './config.js';
import { requirePermission, type Actor } from './context.js';
import type { Mailer } from './notifications.js';

const log = createLogger('digest');
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A digest is sent up to this long after its time; after that, the week is skipped. */
const SEND_WINDOW_MS = DAY_MS;

type DigestSettings = { enabled?: boolean; weekday?: number; hourUtc?: number; emails?: string[]; chatChannelIds?: unknown[]; lastPeriod?: string | null; lastSentAt?: Date | null };

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number | null) => (n == null ? 'n/a' : `${Math.round(n * 100)}%`);
const date = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** "(▲ 12% on the week before)", or nothing without an earlier figure. */
function change(value: number, previous: number) {
  if (!previous) return '';
  const p = Math.round(((value - previous) / previous) * 100);
  return p === 0 ? ' (same as the week before)' : ` (${p > 0 ? 'up' : 'down'} ${Math.abs(p)}% on the week before)`;
}

/** The most recent moment the digest was due: `weekday` at `hourUtc`, at or before `now`. */
export function digestDueAt(weekday: number, hourUtc: number, now: Date) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + hourUtc * HOUR_MS;
  let due = today - ((now.getUTCDay() - weekday + 7) % 7) * DAY_MS;
  if (due > now.getTime()) due -= 7 * DAY_MS;
  return new Date(due);
}

/**
 * The weekly digest: the analytics of the last seven full days (UTC) as a short text, sent by email and
 * to chat channels on the weekday and hour an organization chose.
 */
export class DigestService {
  constructor(
    private config: ServerConfig,
    private analytics: AnalyticsService,
    private mailer: Mailer,
    private chat: ChatService,
  ) {}

  private dto(d: DigestSettings | undefined): DigestSettingsDto {
    return {
      enabled: Boolean(d?.enabled),
      weekday: d?.weekday ?? 1,
      hourUtc: d?.hourUtc ?? 8,
      emails: d?.emails ?? [],
      chatChannelIds: (d?.chatChannelIds ?? []).map(String),
      lastSentAt: d?.lastSentAt ? new Date(d.lastSentAt).toISOString() : null,
    };
  }

  async get(actor: Actor) {
    requirePermission(actor, 'settings.manage');
    const org = await Organization.findById(oid(actor.organizationId), { 'settings.digest': 1 }).lean();
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    return this.dto(org.settings?.digest as DigestSettings | undefined);
  }

  async update(actor: Actor, raw: z.input<typeof digestSettingsRequest>) {
    requirePermission(actor, 'settings.manage');
    const input = digestSettingsRequest.parse(raw);
    const channelIds = [...new Set(input.chatChannelIds)];
    const known = await ChatChannel.countDocuments({ _id: { $in: channelIds.map((c) => oid(c, 'Chat channel')) }, organizationId: oid(actor.organizationId) });
    if (known !== channelIds.length) throw new AppError('NOT_FOUND', 'Chat channel not found');
    if (input.enabled && !input.emails.length && !channelIds.length) throw new AppError('VALIDATION_FAILED', 'Add an email address or a chat channel to send the digest to');
    await Organization.updateOne(
      { _id: oid(actor.organizationId) },
      { $set: { 'settings.digest.enabled': input.enabled, 'settings.digest.weekday': input.weekday, 'settings.digest.hourUtc': input.hourUtc, 'settings.digest.emails': [...new Set(input.emails)], 'settings.digest.chatChannelIds': channelIds.map((c) => oid(c)) } },
    );
    await audit(actor, 'digest.update', { type: 'organization', id: actor.organizationId }, { enabled: input.enabled, emails: input.emails.length, chatChannels: channelIds.length });
    return this.get(actor);
  }

  /** The digest as it would be sent now, emailed to the caller only. */
  async sendToMe(actor: Actor, now = new Date()) {
    requirePermission(actor, 'settings.manage');
    const digest = await this.build(actor.organizationId, now);
    const user = await User.findById(oid(actor.userId), { email: 1 }).lean();
    if (user?.email) await this.mailer.send(user.email, digest.subject, digest.text);
    return { ...digest, sentTo: user?.email ?? null };
  }

  /**
   * Sends the digests that are due. An organization's digest is claimed by writing its date first, so
   * several server instances send it once. Called by the scheduler's sweep.
   */
  async runDue(now = new Date()) {
    const orgs = await Organization.find({ 'settings.digest.enabled': true }, { 'settings.digest': 1 }).lean();
    let sent = 0;
    for (const org of orgs) {
      const d = (org.settings?.digest ?? {}) as DigestSettings;
      const dueAt = digestDueAt(d.weekday ?? 1, d.hourUtc ?? 8, now);
      const period = dueAt.toISOString().slice(0, 10);
      if (d.lastPeriod === period || now.getTime() - dueAt.getTime() > SEND_WINDOW_MS) continue;
      const claimed = await Organization.updateOne({ _id: org._id, 'settings.digest.enabled': true, 'settings.digest.lastPeriod': { $ne: period } }, { $set: { 'settings.digest.lastPeriod': period, 'settings.digest.lastSentAt': now } });
      if (!claimed.modifiedCount) continue; // another instance has this one
      try {
        const organizationId = String(org._id);
        const digest = await this.build(organizationId, now);
        for (const to of d.emails ?? []) await this.mailer.send(to, digest.subject, digest.text);
        await this.chat.sendTo(organizationId, (d.chatChannelIds ?? []).map(String), { organizationId, type: 'organization.notice', title: digest.subject, body: digest.text, taskId: null });
        sent++;
      } catch (e) {
        captureError(e, { tags: { component: 'digest' } });
        log.warn({ organizationId: String(org._id), err: String(e) }, 'digest was not sent');
      }
    }
    return sent;
  }

  /** The seven full UTC days before `now`, against the seven before those. */
  async build(organizationId: string, now = new Date()) {
    const org = await Organization.findById(oid(organizationId), { name: 1 }).lean();
    if (!org) throw new AppError('NOT_FOUND', 'Organization not found');
    // The analytics count whole days up to "now": the last instant of yesterday makes that seven full days.
    const asOf = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1);
    const actor: Actor = { userId: '000000000000000000000000', organizationId, role: 'OWNER', correlationId: `digest_${randomBytes(6).toString('hex')}` };
    const q = { days: 7 };
    const [overview, cost, workers, reliability, today] = await Promise.all([
      this.analytics.overview(actor, q, asOf),
      this.analytics.cost(actor, q, asOf),
      this.analytics.workers(actor, q, asOf),
      this.analytics.reliability(actor, q, asOf),
      this.analytics.cost(actor, { days: 1 }, now), // the budgets as they are now, also on the first of a month
    ]);
    const t = overview.totals;
    const p = overview.previous;
    const lines = [`${date(new Date(overview.since))} to ${date(asOf)} (UTC)`, ''];
    lines.push(`Tasks: ${t.finished} finished${change(t.finished, p.finished)}: ${t.completed} completed, ${t.failed} failed.`);
    if (t.finished) lines.push(`Success rate: ${pct(t.successRate)}${p.successRate == null ? '' : ` (${pct(p.successRate)} the week before)`}. Passed the checks first time: ${pct(t.firstPassRate)}.`);
    lines.push(`Spend: ${usd(cost.totals.costUsd)}${change(cost.totals.costUsd, cost.previous.costUsd)}${t.costPerCompletedUsd == null ? '' : `, ${usd(t.costPerCompletedUsd)} per completed task`}.`);
    const budget = today.budgets.find((b) => b.scope === 'organization');
    if (budget?.limitUsd != null) {
      lines.push(`Budget this month: ${usd(budget.spentUsd)} of ${usd(budget.limitUsd)}, forecast ${usd(budget.forecastUsd)}${budget.state === 'exceeded' ? ' (limit reached)' : budget.forecastExceeds ? ' (over the limit at this rate)' : ''}.`);
    }
    const r = reliability.totals;
    const top = reliability.byCategory[0];
    lines.push(`Stopped tasks: ${r.stops}${change(r.stops, r.previousStops)}${top ? `. Most common reason: ${(FAILURE_CATEGORY_LABELS[top.category as FailureCategory] ?? top.category).toLowerCase()} (${top.stops})` : ''}${r.stillStopped ? `. ${r.stillStopped} still wait for someone` : ''}.`);
    const step = reliability.verificationSteps.find((s) => s.failed > 0);
    if (step) lines.push(`Check that fails most: ${step.name} (${pct(step.failureRate)} of ${step.runs} runs).`);
    const busiest = workers.workers.find((w) => w.finished > 0);
    if (busiest) lines.push(`Busiest worker: ${busiest.name} (${busiest.finished} finished tasks).`);
    lines.push('', `Details: ${this.config.WEB_URL.replace(/\/+$/, '')}/insights`);
    return { subject: `Weekly digest for ${org.name}`, text: lines.join('\n') };
  }
}
