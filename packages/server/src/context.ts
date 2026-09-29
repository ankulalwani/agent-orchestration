import { AppError, can, type Permission, type Role } from '@ao/core';

/** Authenticated caller acting within one organization. Built server-side from a verified token + membership. */
export interface Actor {
  userId: string;
  organizationId: string;
  role: Role;
  correlationId: string;
  ip?: string | null;
  platformAdmin?: boolean;
}

/** Platform administrator acting on the server itself, outside any organization. */
export interface PlatformActor {
  userId: string;
  correlationId: string;
  ip?: string | null;
  organizationId?: undefined;
}

/** Authenticated worker. organizationId comes from the worker record, never from the request. */
export interface WorkerActor {
  workerId: string;
  organizationId: string;
  correlationId: string;
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!can(actor.role, permission)) {
    throw new AppError('FORBIDDEN', `Your role (${actor.role}) does not allow ${permission}`, {
      context: { permission },
      correlationId: actor.correlationId,
    });
  }
}
