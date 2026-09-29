import { describe, expect, it } from 'vitest';
import { can, canAssignRole, ROLES, PERMISSIONS } from './rbac.js';

describe('RBAC', () => {
  it('viewer is read-only', () => {
    for (const p of PERMISSIONS) {
      expect(can('VIEWER', p)).toBe(p.endsWith('.read') && !['audit.read'].includes(p));
    }
  });

  it('roles are strictly cumulative', () => {
    for (let i = 1; i < ROLES.length; i++) {
      const higher = ROLES[i - 1]!;
      const lower = ROLES[i]!;
      for (const p of PERMISSIONS) if (can(lower, p)) expect(can(higher, p)).toBe(true);
    }
  });

  it('only owners manage billing and delete orgs', () => {
    expect(can('OWNER', 'billing.manage')).toBe(true);
    expect(can('ADMIN', 'billing.manage')).toBe(false);
    expect(can('ADMIN', 'org.delete')).toBe(false);
  });

  it('developers create and control tasks but cannot approve workers', () => {
    expect(can('DEVELOPER', 'task.create')).toBe(true);
    expect(can('DEVELOPER', 'task.control')).toBe(true);
    expect(can('DEVELOPER', 'worker.approve')).toBe(false);
    expect(can('DEVELOPER', 'provider.manage')).toBe(false);
  });

  it('role assignment cannot escalate', () => {
    expect(canAssignRole('ADMIN', 'OWNER')).toBe(false);
    expect(canAssignRole('ADMIN', 'ADMIN')).toBe(true);
    expect(canAssignRole('MANAGER', 'ADMIN')).toBe(false);
    expect(canAssignRole('MANAGER', 'DEVELOPER')).toBe(true);
    expect(canAssignRole('DEVELOPER', 'VIEWER')).toBe(false);
    expect(canAssignRole('OWNER', 'OWNER')).toBe(true);
  });
});
