/** Stacks: packages that belong together, installed in one step; the platform's and an organization's own. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearDatabase, startTestDatabase, stopTestDatabase } from '@ao/database/testing';
import { AuditLog, CapabilityInstallation, CapabilityStack } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;
let publisher: Actor;
let refs: { skill: string; mcp: string; shell: string; privateSkill: string };
const admin = (a: Actor) => ({ userId: a.userId, correlationId: 't', platformAdmin: true });

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, version: '1.0.0', type: 'skill', description: `Conventions for ${id} in Next.js applications, for reviews and new code.`, skill: { instructions: `Follow ${id}.` }, triggers: { keywords: ['nextjs'] }, ...extra });

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
  await clearDatabase();
  publisher = (await makeOwner(s, 'vendor')).actor;
  const reg = async (m: Record<string, unknown>, publish = true) => {
    const r = await s.capabilities.register(publisher, m);
    if (publish) {
      await s.registry.requestPublish(publisher, r.capabilityId, true);
      await s.registry.review(admin(publisher), r.capabilityId, { decision: 'approve', notes: '', trust: 'VERIFIED' });
    }
    return r.capabilityId;
  };
  refs = {
    skill: await reg(manifest('next-conventions')),
    mcp: await reg(manifest('next-docs', { type: 'mcp', skill: undefined, mcp: { transport: 'http', url: 'https://docs.example.test/mcp', env: {} }, permissions: ['network.outbound'] })),
    shell: await reg(manifest('next-shell-tools', { permissions: ['shell'] })),
    privateSkill: await reg(manifest('vendor-internal'), false),
  };
});
afterAll(stopTestDatabase);

const stack = (extra: Record<string, unknown> = {}) => ({ slug: 'nextjs-starter', name: 'Next.js starter', description: 'Conventions, docs and tools for a Next.js project.', items: [{ ref: refs.skill, note: 'House conventions' }, { ref: refs.mcp, versionRange: '^1.0.0', note: '' }, { ref: refs.shell, note: '' }], ...extra });

describe('platform stacks', () => {
  it('are made by server administrators from public packages only, and seen by everyone', async () => {
    await expect(s.stacks.createPlatform({ userId: publisher.userId, correlationId: 't', platformAdmin: false }, stack())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.stacks.createPlatform(admin(publisher), stack({ items: [{ ref: refs.skill, note: '' }, { ref: refs.privateSkill, note: '' }] }))).rejects.toThrow(/Not a public package: .*vendor-internal/);
    await expect(s.stacks.createPlatform(admin(publisher), stack({ items: [{ ref: refs.skill, note: '' }, { ref: refs.skill, note: '' }] }))).rejects.toThrow(/once/);
    const created = await s.stacks.createPlatform(admin(publisher), stack());
    expect(created).toMatchObject({ slug: 'nextjs-starter', ownerKind: 'platform', installs: 0 });
    expect(created.items.map((i) => [i.ref, i.package?.type, i.versionRange])).toEqual([[refs.skill, 'skill', null], [refs.mcp, 'mcp', '^1.0.0'], [refs.shell, 'skill', null]]);
    expect(created.technologies).toContain('nextjs');
    await expect(s.stacks.createPlatform(admin(publisher), stack())).rejects.toMatchObject({ code: 'CONFLICT' });

    // The public catalog and any organization see it.
    expect((await s.stacks.list(null)).map((x) => x.slug)).toEqual(['nextjs-starter']);
    const customer = (await makeOwner(s, 'customer')).actor;
    expect((await s.stacks.get(customer, 'nextjs-starter')).items).toHaveLength(3);
    await expect(s.stacks.get(null, 'no-such-stack')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('install each package the usual way: allowed ones install, others wait for approval or are refused', async () => {
    const owner = (await makeOwner(s, 'installer')).actor;
    const project = await s.projects.create(owner, { name: 'web', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const manager: Actor = { ...owner, role: 'MANAGER' };
    // (By default every installation by a non-administrator waits for approval; here only risky ones do.)
    await s.orgs.update(owner, { policy: { capabilities: { installPolicy: 'AUTO' } } });
    await expect(s.stacks.install({ ...owner, role: 'DEVELOPER' }, 'nextjs-starter', { scope: 'ORGANIZATION' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(s.stacks.install(manager, 'nextjs-starter', { scope: 'PROJECT' })).rejects.toThrow(/projectId is required/);

    // A manager: the package that asks for shell access needs an administrator's approval.
    const first = await s.stacks.install(manager, 'nextjs-starter', { scope: 'PROJECT', projectId: project.id });
    expect(first.results).toEqual([
      { ref: refs.skill, status: 'installed', version: '1.0.0', reason: null },
      { ref: refs.mcp, status: 'installed', version: '1.0.0', reason: null },
      { ref: refs.shell, status: 'pending_approval', version: '1.0.0', reason: expect.stringMatching(/shell/) },
    ]);
    const installs = await CapabilityInstallation.find({ organizationId: owner.organizationId }).lean();
    expect(installs.map((i) => [i.scope, String(i.projectId), i.status]).sort()).toEqual([['PROJECT', project.id, 'ACTIVE'], ['PROJECT', project.id, 'ACTIVE'], ['PROJECT', project.id, 'PENDING_APPROVAL']]);
    expect((await s.stacks.get(owner, 'nextjs-starter')).installs).toBe(1);

    // Policy that blocks a permission: that package is refused, the others still install.
    await s.orgs.update(owner, { policy: { capabilities: { installPolicy: 'AUTO', blockedPermissions: ['shell'] } } });
    const second = await s.stacks.install(owner, 'nextjs-starter', { scope: 'ORGANIZATION' });
    expect(second.results.map((r) => r.status)).toEqual(['installed', 'installed', 'failed']);
    expect(second.results[2]!.reason).toMatch(/Blocked by organization policy/);
    expect(await AuditLog.countDocuments({ action: 'stack.install', organizationId: owner.organizationId })).toBe(2);
  });

  it('can be changed and deleted by server administrators', async () => {
    const changed = await s.stacks.updatePlatform(admin(publisher), 'nextjs-starter', { name: 'Next.js essentials', items: [{ ref: refs.skill, note: 'Only this' }] });
    expect(changed).toMatchObject({ name: 'Next.js essentials', items: [{ ref: refs.skill, note: 'Only this' }] });
    await expect(s.stacks.updatePlatform(admin(publisher), 'nextjs-starter', { items: [{ ref: '@nobody/nothing', note: '' }] })).rejects.toThrow(/Not a public package/);
    await expect(s.stacks.updatePlatform(admin(publisher), 'missing', { name: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await s.stacks.removePlatform(admin(publisher), 'nextjs-starter');
    expect(await s.stacks.list(null)).toEqual([]);
  });
});

describe('an organization’s own stacks', () => {
  it('may hold its private packages, are seen by that organization only, and come first', async () => {
    await s.stacks.createPlatform(admin(publisher), stack({ slug: 'public-one', name: 'Public one', items: [{ ref: refs.skill, note: '' }] }));
    await expect(s.stacks.create({ ...publisher, role: 'MANAGER' }, stack())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const own = await s.stacks.create(publisher, stack({ slug: 'house-stack', name: 'House stack', items: [{ ref: refs.privateSkill, note: 'Ours' }, { ref: refs.skill, note: '' }] }));
    expect(own).toMatchObject({ ownerKind: 'organization', items: [{ ref: refs.privateSkill, package: { visibility: 'ORGANIZATION' } }, { ref: refs.skill }] });
    expect((await s.stacks.list(publisher)).map((x) => x.slug)).toEqual(['house-stack', 'public-one']);

    const other = (await makeOwner(s, 'stranger')).actor;
    expect((await s.stacks.list(other)).map((x) => x.slug)).toEqual(['public-one']);
    await expect(s.stacks.get(other, 'house-stack')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.stacks.install(other, 'house-stack', { scope: 'ORGANIZATION' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.stacks.remove(other, 'house-stack')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Another organization cannot put someone's private package into a stack of its own.
    await expect(s.stacks.create(other, stack({ slug: 'theirs', items: [{ ref: refs.privateSkill, note: '' }] }))).rejects.toThrow(/Not found in the registry/);
    expect((await s.stacks.list(null)).map((x) => x.slug)).toEqual(['public-one']);

    // An organization's stack with the platform's address wins for its members.
    await s.stacks.create(publisher, stack({ slug: 'public-one', name: 'Our take on it', items: [{ ref: refs.mcp, note: '' }] }));
    expect((await s.stacks.get(publisher, 'public-one')).name).toBe('Our take on it');
    expect((await s.stacks.get(other, 'public-one')).name).toBe('Public one');

    expect((await s.stacks.update(publisher, 'house-stack', { description: 'Changed' })).description).toBe('Changed');
    await s.stacks.remove(publisher, 'house-stack');
    expect(await CapabilityStack.countDocuments({ slug: 'house-stack' })).toBe(0);
  });
});
