import { AuditLog, oid } from '@ao/database';
import { redact } from '@ao/core';
import type { Actor, PlatformActor, WorkerActor } from './context.js';

/** Append-only audit log (spec §60). Entries cannot be edited or deleted through the model. */
export async function audit(
  actor: Actor | PlatformActor | WorkerActor | { system: true; organizationId?: string | null },
  action: string,
  target?: { type: string; id: string } | null,
  metadata: Record<string, unknown> = {},
) {
  const base =
    'system' in actor
      ? { actorType: 'system' as const, actorId: null, organizationId: actor.organizationId ? oid(actor.organizationId) : null }
      : 'workerId' in actor
        ? { actorType: 'worker' as const, actorId: actor.workerId, organizationId: oid(actor.organizationId) }
        : { actorType: 'user' as const, actorId: actor.userId, organizationId: actor.organizationId ? oid(actor.organizationId) : null };
  await AuditLog.create({
    ...base,
    action,
    targetType: target?.type ?? null,
    targetId: target?.id ?? null,
    metadata: redact(metadata),
    ip: 'ip' in actor ? (actor.ip ?? null) : null,
    correlationId: 'correlationId' in actor ? actor.correlationId : null,
  });
}
