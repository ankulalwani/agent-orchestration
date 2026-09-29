import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, TaskDto } from '@ao/contracts';
import { PRIORITIES, TASK_STATUSES, type TaskStatus } from '@ao/core/shared';
import { Alert, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, Textarea, timeAgo } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { TaskStatusBadge, humanize } from '../lib/format';
import { PageHeader } from '../Layout';

const FILTERS: Array<{ label: string; statuses: TaskStatus[] }> = [
  { label: 'All', statuses: [] },
  { label: 'Active', statuses: ['CLAIMING', 'PREPARING', 'RUNNING', 'VERIFYING'] },
  { label: 'Waiting', statuses: ['QUEUED', 'PAUSED', 'WAITING_FOR_LIMIT', 'WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL'] },
  { label: 'Needs action', statuses: ['WAITING_FOR_INPUT', 'WAITING_FOR_APPROVAL', 'RECOVERY_REQUIRED', 'CRASHED'] },
  { label: 'Completed', statuses: ['COMPLETED'] },
  { label: 'Failed', statuses: ['FAILED', 'CANCELLED'] },
];

export function TasksPage() {
  const orgId = useOrgId();
  const { can } = useSession();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState(0);
  const [projectId, setProjectId] = useState('');
  const [q, setQ] = useState('');
  const statuses = FILTERS[filter]!.statuses;

  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const tasks = useInfiniteQuery({
    queryKey: ['tasks', orgId, { statuses, projectId, q }],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50', ...(pageParam ? { cursor: pageParam } : {}), ...(statuses.length ? { status: statuses.join(',') } : {}), ...(projectId ? { projectId } : {}), ...(q ? { q } : {}) });
      return get<{ items: TaskDto[]; nextCursor: string | null }>(`/orgs/${orgId}/tasks?${qs}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 20_000,
  });
  const items = useMemo(() => tasks.data?.pages.flatMap((p) => p.items) ?? [], [tasks.data]);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? '—';

  return (
    <div>
      <PageHeader title="Tasks" description="Every task, its status, and where it runs." actions={can('task.create') && <Button variant="primary" onClick={() => setParams({ new: '1' })}>New task</Button>} />
      <div className="filters" role="toolbar" aria-label="Task filters">
        {FILTERS.map((f, i) => (
          <button key={f.label} className="chip" aria-pressed={filter === i} onClick={() => setFilter(i)}>
            {f.label}
          </button>
        ))}
        <label className="sr-only" htmlFor="project-filter">Project</label>
        <Select id="project-filter" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <label className="sr-only" htmlFor="task-search">Search</label>
        <Input id="task-search" placeholder="Search title or prompt" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card padded={false}>
        {tasks.isLoading ? (
          <div className="card-body"><Spinner label="Loading tasks…" /></div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th className="hide-mobile">Project</th>
                  <th className="hide-mobile">Priority</th>
                  <th className="hide-mobile">AI</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => nav(`/tasks/${t.id}`)}>
                    <td>
                      <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                      {t.statusReason && !['COMPLETED'].includes(t.status) && <div className="muted small truncate">{t.statusReason}</div>}
                    </td>
                    <td><TaskStatusBadge status={t.status} /></td>
                    <td className="hide-mobile">{projectName(t.projectId)}</td>
                    <td className="hide-mobile small">{humanize(t.priority)}</td>
                    <td className="hide-mobile small muted">{t.agentId ? `${t.agentId} · ${t.modelId}` : '—'}</td>
                    <td className="small muted">{timeAgo(t.completedAt ?? t.startedAt ?? t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tasks match" action={can('task.create') && <Button onClick={() => setParams({ new: '1' })}>Create a task</Button>} />
        )}
        {tasks.hasNextPage && (
          <div className="card-body">
            <Button onClick={() => void tasks.fetchNextPage()} loading={tasks.isFetchingNextPage}>Load more</Button>
          </div>
        )}
      </Card>
      <NewTaskDialog open={params.get('new') === '1'} onClose={() => setParams({})} projects={projects.data ?? []} existing={items} />
    </div>
  );
}

function NewTaskDialog({ open, onClose, projects, existing }: { open: boolean; onClose: () => void; projects: ProjectDto[]; existing: TaskDto[] }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [form, setForm] = useState({ kind: 'code' as 'code' | 'review' | 'plan', base: 'main', head: '', projectId: '', title: '', prompt: '', knowledge: '', priority: 'NORMAL', dependencies: [] as string[], requirePlanApproval: false, gitPolicy: '' });
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const create = useMutation({
    mutationFn: () =>
      post<TaskDto>(`/orgs/${orgId}/tasks`, {
        projectId: form.projectId || projects[0]?.id,
        title: form.title,
        prompt: form.prompt,
        ...(form.knowledge.trim() ? { knowledge: form.knowledge } : {}),
        ...(form.kind === 'review' ? { kind: 'review', review: { base: form.base.trim(), head: form.head.trim() } } : form.kind === 'plan' ? { kind: 'plan' } : {}),
        priority: form.priority,
        dependencies: form.dependencies,
        requirePlanApproval: form.requirePlanApproval,
        idempotencyKey,
        ...(form.gitPolicy ? { policy: { git: { policy: form.gitPolicy } } } : {}),
      }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: ['tasks', orgId] });
      onClose();
      nav(`/tasks/${t.id}`);
    },
  });
  const candidates = existing.filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));

  if (!projects.length && open) {
    return (
      <Dialog open title="New task" onClose={onClose} footer={<Button onClick={onClose}>Close</Button>}>
        <EmptyState title="Create a project first" action={<Link to="/projects">Go to projects</Link>}>Tasks run inside a project that is checked out on a worker.</EmptyState>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      title="New task"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.title.trim() || !form.prompt.trim() || (form.kind === 'review' && (!form.base.trim() || !form.head.trim()))} onClick={() => create.mutate()}>
            Create task
          </Button>
        </>
      }
    >
      <div className="stack">
        {create.error && <Alert tone="danger">{create.error instanceof ApiError ? create.error.message : 'Could not create the task'}</Alert>}
        <Field label="Project">
          {(id) => (
            <Select id={id} value={form.projectId || projects[0]?.id} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'code' | 'review' | 'plan' })}>
              <option value="code">Change code</option>
              <option value="review">Review changes (the agent changes nothing)</option>
              <option value="plan">Plan: break a goal into tasks (you review the plan first)</option>
            </Select>
          )}
        </Field>
        {form.kind === 'review' && (
          <div className="grid grid-2">
            <Field label="Base branch" hint="What the changes are compared against">{(id) => <Input id={id} value={form.base} onChange={(e) => setForm({ ...form, base: e.target.value })} />}</Field>
            <Field label="Branch to review">{(id) => <Input id={id} value={form.head} placeholder="feature/checkout" onChange={(e) => setForm({ ...form, head: e.target.value })} />}</Field>
          </div>
        )}
        <Field label="Title">{(id) => <Input id={id} value={form.title} maxLength={200} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Add Razorpay to checkout" />}</Field>
        <Field label="What should be done?" hint="Be specific about requirements, tests and how to verify. The original text is kept unchanged.">
          {(id) => <Textarea id={id} rows={7} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="Update the checkout flow, add Razorpay support, write tests, verify checkout in the browser…" />}
        </Field>
        <Field label="Background for the agent (optional)" hint="Context that isn't an instruction: links, decisions, constraints. Added after organization and project knowledge.">
          {(id) => <Textarea id={id} rows={3} maxLength={50_000} value={form.knowledge} onChange={(e) => setForm({ ...form, knowledge: e.target.value })} />}
        </Field>
        <div className="grid grid-2">
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Git" hint="Default comes from project policy">
            {(id) => (
              <Select id={id} value={form.gitPolicy} onChange={(e) => setForm({ ...form, gitPolicy: e.target.value })}>
                <option value="">Project default</option>
                <option value="NONE">Don't commit</option>
                <option value="COMMIT">Commit</option>
                <option value="COMMIT_AND_PUSH">Commit and push</option>
                <option value="PULL_REQUEST">Open a pull request</option>
              </Select>
            )}
          </Field>
        </div>
        {candidates.length > 0 && (
          <Field label="Runs after" hint="The task waits until these complete">
            {(id) => (
              <Select id={id} multiple value={form.dependencies} onChange={(e) => setForm({ ...form, dependencies: Array.from(e.target.selectedOptions, (o) => o.value) })} style={{ minHeight: 90 }}>
                {candidates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
              </Select>
            )}
          </Field>
        )}
        <label className="row">
          <input type="checkbox" checked={form.requirePlanApproval} onChange={(e) => setForm({ ...form, requirePlanApproval: e.target.checked })} />
          Require approval before the agent starts
        </label>
      </div>
    </Dialog>
  );
}

export const ALL_STATUSES = TASK_STATUSES;
