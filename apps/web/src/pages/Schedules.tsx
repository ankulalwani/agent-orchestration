import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, ScheduleDto, TaskDto } from '@ao/contracts';
import { PRIORITIES, nextCronRun } from '@ao/core/shared';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea } from '@ao/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { PageHeader } from '../Layout';

const PRESETS = [
  { label: 'Every night at 02:00', cron: '0 2 * * *' },
  { label: 'Weekdays at 09:00', cron: '0 9 * * mon-fri' },
  { label: 'Every Monday at 08:00', cron: '0 8 * * mon' },
  { label: 'First day of the month at 06:00', cron: '0 6 1 * *' },
  { label: 'Every hour', cron: '@hourly' },
];
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const EMPTY = { name: '', projectId: '', cron: PRESETS[0]!.cron, timeZone: LOCAL_ZONE, overlap: 'skip' as ScheduleDto['overlap'], kind: 'code' as 'code' | 'plan', title: '', prompt: '', priority: 'NORMAL' };

/** When an expression runs next, or why it cannot. */
function preview(cron: string, timeZone: string): { next: string | null; error: string | null } {
  try {
    return { next: nextCronRun(cron, new Date(), timeZone).toLocaleString(), error: null };
  } catch (e) {
    return { next: null, error: (e as Error).message };
  }
}

/** Scheduled tasks: tasks created again and again on a cron expression. */
export function SchedulesPage() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['schedules', orgId], queryFn: () => get<ScheduleDto[]>(`/orgs/${orgId}/schedules`), refetchInterval: 60_000 });
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const [form, setForm] = useState(EMPTY);
  const [ran, setRan] = useState<TaskDto | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['schedules', orgId] });
  const projectId = form.projectId || projects.data?.[0]?.id || '';
  const create = useMutation({
    mutationFn: () =>
      post<ScheduleDto>(`/orgs/${orgId}/schedules`, {
        name: form.name,
        projectId,
        cron: form.cron,
        timeZone: form.timeZone,
        overlap: form.overlap,
        task: { title: form.title || form.name, prompt: form.prompt, priority: form.priority, kind: form.kind },
      }),
    onSuccess: () => {
      setForm({ ...EMPTY, projectId: form.projectId, timeZone: form.timeZone });
      refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (s: ScheduleDto) => patch(`/orgs/${orgId}/schedules/${s.id}`, { enabled: !s.enabled }), onSuccess: refresh });
  const run = useMutation({
    mutationFn: (s: ScheduleDto) => post<TaskDto>(`/orgs/${orgId}/schedules/${s.id}/run`),
    onSuccess: (t) => {
      setRan(t);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (s: ScheduleDto) => del(`/orgs/${orgId}/schedules/${s.id}`), onSuccess: refresh });
  const error = create.error ?? toggle.error ?? run.error ?? remove.error;
  const when = useMemo(() => preview(form.cron, form.timeZone), [form.cron, form.timeZone]);
  const manage = can('project.update');
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;

  if (list.isLoading) return <Spinner label="Loading schedules…" />;
  return (
    <div className="stack">
      <PageHeader title="Schedules" description="Tasks that are created again on a schedule: nightly dependency updates, weekly reviews, a flaky-test sweep." />
      {error && <Alert tone="danger">{(error as ApiError).message}</Alert>}
      {ran && (
        <Alert>
          Task created: <Link to={`/tasks/${ran.id}`}>{ran.title}</Link>
        </Alert>
      )}
      <Card title="Scheduled tasks" padded={false}>
        {list.data?.length ? (
          <div className="table-wrap">
            <table className="table" aria-label="Scheduled tasks">
              <thead>
                <tr><th>Name</th><th>Project</th><th>Next run</th><th>Last run</th><th /></tr>
              </thead>
              <tbody>
                {list.data.map((s) => (
                  <tr key={s.id}>
                    <td>
                      {s.name} <Badge tone={s.enabled ? 'ok' : 'neutral'}>{s.enabled ? 'on' : 'off'}</Badge>
                      <div className="small muted"><code>{s.cron}</code> · {s.timeZone}{s.overlap === 'allow' ? ' · runs may overlap' : ''}</div>
                    </td>
                    <td>{projectName(s.projectId)}</td>
                    <td className="small">{s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : '—'}</td>
                    <td className="small">
                      {s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : 'never'}
                      {s.lastResult && (
                        <div className={s.lastResult.startsWith('failed') ? 'small' : 'small muted'}>
                          {s.lastResult === 'created' && s.lastTaskId ? <Link to={`/tasks/${s.lastTaskId}`}>task created</Link> : s.lastResult}
                        </div>
                      )}
                      <div className="muted">{s.runCount} runs</div>
                    </td>
                    <td className="row" style={{ justifyContent: 'flex-end' }}>
                      {can('task.create') && <Button size="sm" loading={run.isPending && run.variables?.id === s.id} onClick={() => run.mutate(s)}>Run now</Button>}
                      {manage && <Button size="sm" onClick={() => toggle.mutate(s)}>{s.enabled ? 'Turn off' : 'Turn on'}</Button>}
                      {manage && <Button size="sm" variant="danger" onClick={() => confirm(`Delete the schedule "${s.name}"? Tasks it created stay.`) && remove.mutate(s)}>Delete</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No scheduled tasks yet">{manage ? 'Add one below.' : 'A manager or administrator can add one.'}</EmptyState>
        )}
      </Card>
      {manage && (
        <Card title="Add a scheduled task">
          <div className="stack" style={{ maxWidth: 720 }}>
            <div className="grid grid-2">
              <Field label="Name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="Nightly dependency update" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
              <Field label="Project">
                {(id) => (
                  <Select id={id} value={projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                    {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                )}
              </Field>
              <Field label="When">
                {(id) => (
                  <Select id={id} value={PRESETS.some((p) => p.cron === form.cron) ? form.cron : ''} onChange={(e) => e.target.value && setForm({ ...form, cron: e.target.value })}>
                    {PRESETS.map((p) => <option key={p.cron} value={p.cron}>{p.label}</option>)}
                    <option value="">Custom</option>
                  </Select>
                )}
              </Field>
              <Field label="Cron expression" hint={when.next ? `Next run: ${when.next} (your time)` : 'minute hour day-of-month month day-of-week'} error={when.error}>
                {(id) => <Input id={id} className="mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />}
              </Field>
              <Field label="Time zone" hint='A name like "Europe/Berlin" or "UTC"'>{(id) => <Input id={id} value={form.timeZone} onChange={(e) => setForm({ ...form, timeZone: e.target.value })} />}</Field>
              <Field label="If the previous run is not finished">
                {(id) => (
                  <Select id={id} value={form.overlap} onChange={(e) => setForm({ ...form, overlap: e.target.value as ScheduleDto['overlap'] })}>
                    <option value="skip">Skip this run</option>
                    <option value="allow">Create another task anyway</option>
                  </Select>
                )}
              </Field>
              <Field label="Kind">
                {(id) => (
                  <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'code' | 'plan' })}>
                    <option value="code">Change code</option>
                    <option value="plan">Plan (propose tasks, change nothing)</option>
                  </Select>
                )}
              </Field>
              <Field label="Priority">
                {(id) => (
                  <Select id={id} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Task title" hint="Empty: the schedule's name. {date} becomes the day of the run.">{(id) => <Input id={id} value={form.title} maxLength={200} placeholder="Update dependencies {date}" onChange={(e) => setForm({ ...form, title: e.target.value })} />}</Field>
            <Field label="Task prompt" hint="What the agent is asked to do on every run">{(id) => <Textarea id={id} rows={6} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />}</Field>
            <div><Button variant="primary" disabled={!form.name.trim() || !form.prompt.trim() || !projectId || Boolean(when.error)} loading={create.isPending} onClick={() => create.mutate()}>Create schedule</Button></div>
          </div>
        </Card>
      )}
    </div>
  );
}
