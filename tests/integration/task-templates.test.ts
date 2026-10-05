import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDatabase, stopTestDatabase, clearDatabase } from '@ao/database/testing';
import { fillTaskTemplate, templateVariables } from '@ao/core';
import { AuditLog, Task } from '@ao/database';
import type { Actor, Services } from '@ao/server';
import { makeOwner, makeServices } from '../helpers.js';

let s: Services;

beforeAll(async () => {
  await startTestDatabase();
  s = (await makeServices()).services;
});
afterAll(stopTestDatabase);
beforeEach(clearDatabase);

async function setup() {
  const { actor } = await makeOwner(s);
  const project = await s.projects.create(actor, { name: 'shop', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
  return { actor, project };
}

const template = (extra: Record<string, unknown> = {}) => ({
  name: 'Bump a dependency',
  description: 'Upgrade one package and fix what breaks',
  projectId: null,
  task: { title: 'Upgrade {{package}} to {{version}}', prompt: 'Upgrade {{ package }} to {{version}}. Changelog: {{changelog}}', knowledge: 'Owner: {{owner}}', priority: 'LOW' as const, requirements: {}, capabilityIds: [] },
  variables: [
    { name: 'version', label: 'Target version', default: 'latest', required: true },
    { name: 'changelog', label: 'Changelog URL', default: '', required: false },
    { name: 'gone', label: 'No longer used', default: '', required: true },
  ],
  ...extra,
});
const use = (actor: Actor, id: string, projectId: string, values: Record<string, string>, extra: Record<string, unknown> = {}) => s.taskTemplates.use(actor, id, { projectId, values, dependencies: [], ...extra });

describe('template text', () => {
  it('finds variables in order and fills them', () => {
    expect(templateVariables('Upgrade {{package}} to {{ version }}', 'again {{package}}', null, '{{1bad}} {{ok-name_2}} {single}')).toEqual(['package', 'version', 'ok-name_2']);
    expect(fillTaskTemplate('a {{x}} b {{ y }} c {{z}} {{1bad}}', { x: '1', y: '{{x}}' })).toBe('a 1 b {{x}} c  {{1bad}}');
  });
});

describe('task templates', () => {
  it('list the variables their text uses, with stored labels and defaults', async () => {
    const { actor } = await setup();
    const t = await s.taskTemplates.create(actor, template());
    expect(t.variables).toEqual([
      { name: 'package', label: '', default: '', required: true },
      { name: 'version', label: 'Target version', default: 'latest', required: true },
      { name: 'changelog', label: 'Changelog URL', default: '', required: false },
      { name: 'owner', label: '', default: '', required: true },
    ]);
    const changed = await s.taskTemplates.update(actor, t.id, { task: { ...template().task, knowledge: '' } });
    expect(changed.variables.map((v) => v.name)).toEqual(['package', 'version', 'changelog']);
    expect(changed.variables[1]).toMatchObject({ label: 'Target version' });
  });

  it('create an ordinary task as the caller, with values, defaults and optional variables', async () => {
    const { actor, project } = await setup();
    const t = await s.taskTemplates.create(actor, template());
    await expect(use(actor, t.id, project.id, { package: 'zod' })).rejects.toThrow(/Give a value for: owner/);
    await expect(use(actor, t.id, project.id, { owner: 'pay team' })).rejects.toThrow(/Give a value for: package/);

    const developer: Actor = { ...actor, role: 'DEVELOPER' };
    const task = await use(developer, t.id, project.id, { package: 'zod', owner: 'pay team', version: '  ' });
    expect(task).toMatchObject({ title: 'Upgrade zod to latest', originalPrompt: 'Upgrade zod to latest. Changelog:', knowledge: 'Owner: pay team', priority: 'LOW', status: 'QUEUED', createdBy: actor.userId });
    expect((await s.taskTemplates.list(actor))[0]!.useCount).toBe(1);

    const again = await use(actor, t.id, project.id, { package: 'vite', owner: 'x', version: '7', changelog: 'https://example.com/c' }, { idempotencyKey: 'tmpl-key-1' });
    expect(again.originalPrompt).toBe('Upgrade vite to 7. Changelog: https://example.com/c');
    expect((await use(actor, t.id, project.id, { package: 'vite', owner: 'x' }, { idempotencyKey: 'tmpl-key-1' })).id).toBe(again.id);
    expect(await Task.countDocuments()).toBe(2);
  });

  it('can be limited to a project', async () => {
    const { actor, project } = await setup();
    const other = await s.projects.create(actor, { name: 'blog', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    const everywhere = await s.taskTemplates.create(actor, template({ name: 'Everywhere', task: { ...template().task, title: 'T', prompt: 'P', knowledge: '' } }));
    const onlyShop = await s.taskTemplates.create(actor, template({ name: 'Only shop', projectId: project.id, task: { ...template().task, title: 'T', prompt: 'P', knowledge: '' } }));
    expect((await s.taskTemplates.list(actor, other.id)).map((t) => t.id)).toEqual([everywhere.id]);
    expect((await s.taskTemplates.list(actor, project.id)).map((t) => t.name)).toEqual(['Everywhere', 'Only shop']);
    await expect(use(actor, onlyShop.id, other.id, {})).rejects.toThrow(/another project/);
    expect((await use(actor, onlyShop.id, project.id, {})).projectId).toBe(project.id);
  });

  it('roles, tenants, names and deletion', async () => {
    const { actor, project } = await setup();
    const developer: Actor = { ...actor, role: 'DEVELOPER' };
    const viewer: Actor = { ...actor, role: 'VIEWER' };
    await expect(s.taskTemplates.create(developer, template())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const t = await s.taskTemplates.create(actor, template());
    await expect(s.taskTemplates.create(actor, template())).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await s.taskTemplates.list(viewer)).toHaveLength(1);
    await expect(use(viewer, t.id, project.id, { package: 'a', owner: 'b' })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const { actor: stranger } = await makeOwner(s);
    const theirs = await s.projects.create(stranger, { name: 'x', description: '', defaultBranch: 'main', environments: [], knowledge: '' });
    expect(await s.taskTemplates.list(stranger)).toHaveLength(0);
    await expect(use(stranger, t.id, theirs.id, { package: 'a', owner: 'b' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(use(actor, t.id, theirs.id, { package: 'a', owner: 'b' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(s.taskTemplates.create(actor, template({ name: 'Foreign', projectId: theirs.id }))).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await s.taskTemplates.remove(actor, t.id);
    expect(await s.taskTemplates.list(actor)).toHaveLength(0);
    expect(await AuditLog.distinct('action', { action: /^task_template\./ })).toEqual(['task_template.create', 'task_template.delete']);
  });
});
