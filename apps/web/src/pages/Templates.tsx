import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LayoutTemplate } from 'lucide-react';
import type { ProjectDto, TaskTemplateDto } from '@ao/contracts';
import { PRIORITIES, fillTaskTemplate, templateVariables } from '@ao/core/shared';
import { Alert, Button, Card, EmptyState, Field, Input, Select, Skeleton, Textarea } from '@ao/ui';
import { ApiError, del, get, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { humanize } from '../lib/format';
import { PageHeader } from '../Layout';

export function useTaskTemplates(projectId?: string, enabled = true) {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['task-templates', orgId, projectId ?? ''], queryFn: () => get<TaskTemplateDto[]>(`/orgs/${orgId}/task-templates${projectId ? `?projectId=${projectId}` : ''}`), enabled });
}

/**
 * Chooses a template and asks for its variables; `onApply` gets the filled title, prompt and background,
 * which the person can still change before creating the task.
 */
export function TemplatePicker({ projectId, enabled, onApply }: { projectId?: string; enabled: boolean; onApply: (t: { title: string; prompt: string; knowledge: string; priority: string; kind: 'code' | 'review' | 'plan' }) => void }) {
  const templates = useTaskTemplates(projectId, enabled);
  const [id, setId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const chosen = templates.data?.find((t) => t.id === id);
  if (!templates.data?.length) return null;
  const value = (name: string) => values[name]?.trim() || chosen?.variables.find((v) => v.name === name)?.default || '';
  const missing = chosen?.variables.filter((v) => v.required && !value(v.name)) ?? [];
  const apply = () => {
    if (!chosen) return;
    const filled = Object.fromEntries(chosen.variables.map((v) => [v.name, value(v.name)]));
    onApply({ title: fillTaskTemplate(chosen.task.title, filled), prompt: fillTaskTemplate(chosen.task.prompt, filled), knowledge: fillTaskTemplate(chosen.task.knowledge ?? '', filled), priority: chosen.task.priority ?? 'NORMAL', kind: chosen.task.kind ?? 'code' });
    setId('');
    setValues({});
  };
  return (
    <div className="stack rounded-md border border-line bg-surface-2 p-3">
      <Field label="Start from a template" hint={chosen?.description || undefined}>
        {(fid) => (
          <Select id={fid} value={id} onChange={(e) => (setId(e.target.value), setValues({}))}>
            <option value="">No template</option>
            {templates.data!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        )}
      </Field>
      {chosen && (
        <>
          {chosen.variables.length > 0 && (
            <div className="grid grid-2">
              {chosen.variables.map((v) => (
                <Field key={v.name} label={v.label || humanize(v.name)} hint={v.required ? undefined : 'Optional'}>
                  {(fid) => <Input id={fid} value={values[v.name] ?? ''} placeholder={v.default} onChange={(e) => setValues({ ...values, [v.name]: e.target.value })} />}
                </Field>
              ))}
            </div>
          )}
          <div><Button disabled={missing.length > 0} onClick={apply}>Fill in the task</Button></div>
        </>
      )}
    </div>
  );
}

const EMPTY = { name: '', description: '', projectId: '', title: '', prompt: '', knowledge: '', priority: 'NORMAL', kind: 'code' as 'code' | 'plan' };

/** Task templates: reusable task text with {{variables}}, offered in the New task dialog. */
export function TemplatesPage() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const list = useTaskTemplates();
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const [form, setForm] = useState(EMPTY);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['task-templates', orgId] });
  const create = useMutation({
    mutationFn: () =>
      post<TaskTemplateDto>(`/orgs/${orgId}/task-templates`, {
        name: form.name,
        description: form.description,
        projectId: form.projectId || null,
        task: { title: form.title, prompt: form.prompt, ...(form.knowledge.trim() ? { knowledge: form.knowledge } : {}), priority: form.priority, kind: form.kind },
      }),
    onSuccess: () => {
      setForm(EMPTY);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (t: TaskTemplateDto) => del(`/orgs/${orgId}/task-templates/${t.id}`), onSuccess: refresh });
  const error = create.error ?? remove.error;
  const variables = useMemo(() => templateVariables(form.title, form.prompt, form.knowledge), [form.title, form.prompt, form.knowledge]);
  const manage = can('project.update');
  const projectName = (id: string | null) => (id ? projects.data?.find((p) => p.id === id)?.name ?? id : 'All projects');

  return (
    <div className="stack">
      <PageHeader title="Templates" description="Task text you use again and again. Write {{variable}} where a task differs; the New task dialog asks for those." />
      {error && <Alert tone="danger">{(error as ApiError).message}</Alert>}
      <Card title="Task templates" padded={false}>
        {list.isLoading ? (
          <div className="p-4"><Skeleton className="h-8" /></div>
        ) : list.data?.length ? (
          <div className="table-wrap">
            <table className="table" aria-label="Task templates">
              <thead>
                <tr><th>Name</th><th>Task</th><th className="hide-mobile">Project</th><th className="hide-mobile">Used</th><th /></tr>
              </thead>
              <tbody>
                {list.data.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {t.name}
                      {t.description && <div className="text-xs text-fg-3">{t.description}</div>}
                    </td>
                    <td className="max-w-[420px]">
                      <span className="block truncate">{t.task.title}</span>
                      {t.variables.length > 0 && <span className="block truncate text-xs text-fg-3">Asks for: {t.variables.map((v) => v.label || v.name).join(', ')}</span>}
                    </td>
                    <td className="hide-mobile text-fg-2">{projectName(t.projectId)}</td>
                    <td className="hide-mobile num text-fg-3">{t.useCount}</td>
                    <td className="text-right">{manage && <Button size="sm" variant="danger" onClick={() => confirm(`Delete the template "${t.name}"? Tasks made from it stay.`) && remove.mutate(t)}>Delete</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={LayoutTemplate} title="No templates yet">{manage ? 'Add one below.' : 'A manager or administrator can add one.'}</EmptyState>
        )}
      </Card>
      {manage && (
        <Card title="Add a template">
          <div className="stack max-w-[720px]">
            <div className="grid grid-2">
              <Field label="Name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="Upgrade a dependency" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
              <Field label="Offered for">
                {(id) => (
                  <Select id={id} value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                    <option value="">All projects</option>
                    {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="Type">
                {(id) => (
                  <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'code' | 'plan' })}>
                    <option value="code">Change code</option>
                    <option value="plan">Plan</option>
                  </Select>
                )}
              </Field>
              <Field label="Priority">
                {(id) => (
                  <Select id={id} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Description" hint="Shown when someone chooses the template">{(id) => <Input id={id} value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Field label="Task title">{(id) => <Input id={id} value={form.title} maxLength={200} placeholder="Upgrade {{package}} to {{version}}" onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
            <Field label="Task prompt" hint={variables.length ? `Asks for: ${variables.join(', ')}` : 'Write {{name}} where each task differs'}>
              {(id) => <Textarea id={id} rows={6} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />}
            </Field>
            <Field label="Background for the agent (optional)">{(id) => <Textarea id={id} rows={3} value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} />}</Field>
            <div><Button variant="primary" disabled={!form.name.trim() || !form.title.trim() || !form.prompt.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create template</Button></div>
          </div>
        </Card>
      )}
    </div>
  );
}
