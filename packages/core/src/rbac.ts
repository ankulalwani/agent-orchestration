/** Role-based access control (spec §18, §57). Enforced server-side only. */

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'DEVELOPER', 'VIEWER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'org.read',
  'org.update',
  'org.delete',
  'member.read',
  'member.invite',
  'member.update_role',
  'member.remove',
  'team.manage',
  'project.read',
  'project.create',
  'project.update',
  'project.delete',
  'worker.read',
  'worker.approve',
  'worker.manage',
  'task.read',
  'task.create',
  'task.control', // pause/resume/cancel/retry/restart/input
  'task.approve',
  'task.delete',
  'provider.read',
  'provider.manage',
  'capability.read',
  'capability.install',
  'capability.manage',
  'policy.manage',
  'audit.read',
  'settings.manage',
  'billing.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const VIEWER: Permission[] = [
  'org.read',
  'member.read',
  'project.read',
  'worker.read',
  'task.read',
  'provider.read',
  'capability.read',
];
const DEVELOPER: Permission[] = [...VIEWER, 'task.create', 'task.control'];
const MANAGER: Permission[] = [
  ...DEVELOPER,
  'project.create',
  'project.update',
  'task.approve',
  'task.delete',
  'team.manage',
  'member.invite',
  'capability.install',
  'audit.read',
];
const ADMIN: Permission[] = [
  ...MANAGER,
  'org.update',
  'member.update_role',
  'member.remove',
  'project.delete',
  'worker.approve',
  'worker.manage',
  'provider.manage',
  'capability.manage',
  'policy.manage',
  'settings.manage',
];
const OWNER: Permission[] = [...ADMIN, 'org.delete', 'billing.manage'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, ReadonlySet<Permission>>> = {
  VIEWER: new Set(VIEWER),
  DEVELOPER: new Set(DEVELOPER),
  MANAGER: new Set(MANAGER),
  ADMIN: new Set(ADMIN),
  OWNER: new Set(OWNER),
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

const RANK: Record<Role, number> = { VIEWER: 0, DEVELOPER: 1, MANAGER: 2, ADMIN: 3, OWNER: 4 };
export const roleRank = (r: Role) => RANK[r];

/** An actor may only assign roles at or below their own rank, and only OWNER may create OWNERs. */
export function canAssignRole(actor: Role, target: Role): boolean {
  if (!can(actor, 'member.update_role') && !can(actor, 'member.invite')) return false;
  if (target === 'OWNER') return actor === 'OWNER';
  return RANK[actor] >= RANK[target];
}
