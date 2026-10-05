import { AppError, fillTaskTemplate, templateVariables } from '@ao/core';
import { Project, TaskTemplate, isDuplicateKeyError, oid } from '@ao/database';
import { createTaskRequest, type TaskTemplateDto, type createTaskTemplateRequest, type updateTaskTemplateRequest, type useTaskTemplateRequest } from '@ao/contracts';
import type { z } from 'zod';
import { requirePermission, type Actor } from './context.js';
import { audit } from './audit.js';
import type { TaskService } from './task.service.js';

const MAX_PER_ORGANIZATION = 500;

type TemplateLean = Record<string, any> & { _id: any };
type Variable = TaskTemplateDto['variables'][number];

/**
 * Task templates: a task request whose title, prompt and background hold `{{variable}}` placeholders.
 * Using one fills the placeholders and creates an ordinary task as the caller. Managers keep the
 * templates; everyone who may create tasks may use them.
 */
export class TaskTemplateService {
  constructor(private tasks: TaskService) {}

  /** Every variable the text uses, with what is stored about it; stored ones the text no longer uses are dropped. */
  private variables(t: { task: { title?: string; prompt?: string; knowledge?: string }; variables?: Variable[] }): Variable[] {
    const stored = new Map((t.variables ?? []).map((v) => [v.name, v]));
    return templateVariables(t.task.title, t.task.prompt, t.task.knowledge).map((name) => stored.get(name) ?? { name, label: '', default: '', required: true });
  }

  private dto(t: TemplateLean): TaskTemplateDto {
    return {
      id: String(t._id),
      organizationId: String(t.organizationId),
      name: t.name,
      description: t.description ?? '',
      projectId: t.projectId ? String(t.projectId) : null,
      task: t.task,
      variables: this.variables(t as never),
      createdBy: String(t.createdBy),
      useCount: t.useCount ?? 0,
      createdAt: new Date(t.createdAt).toISOString(),
    };
  }

  private async checkProject(actor: Actor, projectId: string | null | undefined) {
    if (!projectId) return;
    if (!(await Project.exists({ _id: oid(projectId, 'Project'), organizationId: oid(actor.organizationId), archived: { $ne: true } }))) throw new AppError('NOT_FOUND', 'Project not found');
  }

  private async find(actor: Actor, id: string): Promise<TemplateLean> {
    const t = (await TaskTemplate.findOne({ _id: oid(id, 'Template'), organizationId: oid(actor.organizationId) }).lean()) as TemplateLean | null;
    if (!t) throw new AppError('NOT_FOUND', 'Template not found');
    return t;
  }

  async list(actor: Actor, projectId?: string) {
    requirePermission(actor, 'task.read');
    const filter: Record<string, unknown> = { organizationId: oid(actor.organizationId) };
    if (projectId) filter.$or = [{ projectId: null }, { projectId: oid(projectId, 'Project') }];
    return ((await TaskTemplate.find(filter).sort({ name: 1 }).lean()) as TemplateLean[]).map((t) => this.dto(t));
  }

  async create(actor: Actor, input: z.output<typeof createTaskTemplateRequest>) {
    requirePermission(actor, 'project.update');
    await this.checkProject(actor, input.projectId);
    if ((await TaskTemplate.countDocuments({ organizationId: oid(actor.organizationId) })) >= MAX_PER_ORGANIZATION) throw new AppError('VALIDATION_FAILED', `An organization can have ${MAX_PER_ORGANIZATION} templates`);
    try {
      const doc = await TaskTemplate.create({
        organizationId: oid(actor.organizationId),
        name: input.name,
        description: input.description,
        projectId: input.projectId ? oid(input.projectId) : null,
        task: input.task,
        variables: this.variables(input),
        createdBy: oid(actor.userId),
      });
      await audit(actor, 'task_template.create', { type: 'task_template', id: String(doc._id) }, { name: input.name });
      return this.dto(doc.toObject() as TemplateLean);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A template with this name exists');
      throw e;
    }
  }

  async update(actor: Actor, id: string, input: z.output<typeof updateTaskTemplateRequest>) {
    requirePermission(actor, 'project.update');
    const cur = await this.find(actor, id);
    await this.checkProject(actor, input.projectId);
    const set: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'task'] as const) if (input[k] !== undefined) set[k] = input[k];
    if (input.projectId !== undefined) set.projectId = input.projectId ? oid(input.projectId) : null;
    if (input.task || input.variables) set.variables = this.variables({ task: input.task ?? cur.task, variables: input.variables ?? cur.variables });
    try {
      const doc = (await TaskTemplate.findOneAndUpdate({ _id: cur._id }, { $set: set }, { new: true }).lean()) as TemplateLean;
      await audit(actor, 'task_template.update', { type: 'task_template', id }, { fields: Object.keys(input) });
      return this.dto(doc);
    } catch (e) {
      if (isDuplicateKeyError(e)) throw new AppError('CONFLICT', 'A template with this name exists');
      throw e;
    }
  }

  async remove(actor: Actor, id: string) {
    requirePermission(actor, 'project.update');
    const cur = await this.find(actor, id);
    await TaskTemplate.deleteOne({ _id: cur._id });
    await audit(actor, 'task_template.delete', { type: 'task_template', id }, { name: cur.name });
  }

  /** Fills the template and creates the task, as the caller. */
  async use(actor: Actor, id: string, input: z.output<typeof useTaskTemplateRequest>) {
    requirePermission(actor, 'task.create');
    const t = await this.find(actor, id);
    if (t.projectId && String(t.projectId) !== input.projectId) throw new AppError('VALIDATION_FAILED', 'This template belongs to another project');
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const v of this.variables(t as never)) {
      const value = (input.values[v.name] ?? '').trim() || v.default;
      if (!value && v.required) missing.push(v.label || v.name);
      values[v.name] = value;
    }
    if (missing.length) throw new AppError('VALIDATION_FAILED', `Give a value for: ${missing.join(', ')}`, { context: { missing } });
    const fill = (text: string | undefined) => (text === undefined ? undefined : fillTaskTemplate(text, values));
    const request = createTaskRequest.parse({
      ...t.task,
      title: fill(t.task.title)!.trim().slice(0, 200),
      prompt: fill(t.task.prompt),
      ...(t.task.knowledge ? { knowledge: fill(t.task.knowledge) } : {}),
      projectId: input.projectId,
      dependencies: input.dependencies,
      idempotencyKey: input.idempotencyKey,
    });
    const task = await this.tasks.create(actor, request);
    await TaskTemplate.updateOne({ _id: t._id }, { $inc: { useCount: 1 } });
    return task;
  }
}
