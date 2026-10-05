import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ListChecks, Plus, Search } from 'lucide-react';
import type { ProjectDto, TaskDto, WorkerDto } from '@ao/contracts';
import { PRIORITIES, TASK_STATUSES, type TaskStatus } from '@ao/core/shared';
import { Alert, Button, Card, Check, Dialog, EmptyState, Field, Input, Select, Skeleton, Textarea, cn, timeAgo } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { RunsOn, TaskStatusBadge, humanize } from '../lib/format';
import { PageHeader } from '../Layout';
import { TaskCapabilitySuggestions } from '../components/CapabilitySuggestions';
import { TemplatePicker } from './Templates';

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
      <PageHeader
        title="Tasks"
        description="Every task, its status, and where it runs."
        actions={
          can('task.create') && (
            <Button variant="primary" onClick={() => setParams({ new: '1' })}>
              <Plus aria-hidden="true" />
              New task
            </Button>
          )
        }
      />
      <div className="filters" role="toolbar" aria-label="Task filters">
        <div className="chips">
          {FILTERS.map((f, i) => (
            <button key={f.label} type="button" className="chip" aria-pressed={filter === i} onClick={() => setFilter(i)}>
              {f.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <label className="sr-only" htmlFor="project-filter">Project</label>
        <Select id="project-filter" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
        <label className="sr-only" htmlFor="task-search">Search</label>
        <div className="relative max-[560px]:w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden="true" />
          <Input id="task-search" className="!w-full pl-8 min-[561px]:!w-64" placeholder="Search title or prompt" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Card padded={false}>
        {tasks.isLoading ? (
          <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading tasks…">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8" />)}
          </div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th className="hide-mobile">Project</th>
                  <th className="hide-mobile">Priority</th>
                  <th className="hide-mobile">Agent / model</th>
                  <th className="text-right">Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => nav(`/tasks/${t.id}`)}>
                    <td className="max-w-[460px]">
                      <Link to={`/tasks/${t.id}`} className="block truncate">{t.title}</Link>
                      {t.statusReason && !['COMPLETED'].includes(t.status) && <span className="block truncate text-xs text-fg-3">{t.statusReason}</span>}
                    </td>
                    <td><TaskStatusBadge status={t.status} /></td>
                    <td className="hide-mobile whitespace-nowrap text-fg-2">{projectName(t.projectId)}</td>
                    <td className={cn('hide-mobile whitespace-nowrap', t.priority === 'NORMAL' ? 'text-fg-3' : 'text-fg')}>{humanize(t.priority)}</td>
                    <td className="hide-mobile"><RunsOn agent={t.agentId} model={t.agentId ? t.modelId : null} /></td>
                    <td className="num text-right text-xs text-fg-3">{timeAgo(t.completedAt ?? t.startedAt ?? t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={ListChecks} title="No tasks match" action={can('task.create') && <Button onClick={() => setParams({ new: '1' })}>Create a task</Button>}>
            {q || projectId || filter ? 'Try a different filter or search.' : 'A task is a piece of work for a coding agent: a change, a review or a plan.'}
          </EmptyState>
        )}
        {tasks.hasNextPage && (
          <div className="border-t border-line p-3 text-center">
            <Button onClick={() => void tasks.fetchNextPage()} loading={tasks.isFetchingNextPage}>Load more</Button>
          </div>
        )}
      </Card>
      <NewTaskDialog open={params.get('new') === '1'} onClose={() => setParams({})} projects={projects.data ?? []} existing={items} continuesTaskId={params.get('continues')} />
    </div>
  );
}

function NewTaskDialog({ open, onClose, projects, existing, continuesTaskId }: { open: boolean; onClose: () => void; projects: ProjectDto[]; existing: TaskDto[]; /** Follow up on this task: same project, its branch and pull request. */ continuesTaskId?: string | null }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const nav = useNavigate();
  const continued = useQuery({ queryKey: ['task', orgId, continuesTaskId], queryFn: () => get<TaskDto>(`/orgs/${orgId}/tasks/${continuesTaskId}`), enabled: open && Boolean(continuesTaskId) });
  const [form, setForm] = useState({ kind: 'code' as 'code' | 'review' | 'plan', base: 'main', head: '', projectId: '', title: '', prompt: '', knowledge: '', priority: 'NORMAL', dependencies: [] as string[], requirePlanApproval: false, gitPolicy: '', capabilityIds: [] as string[], attemptAgents: [] as string[] });
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), enabled: open });
  // Agents that are installed and signed in on some worker.
  const agents = useMemo(() => {
    const byId = new Map<string, string>();
    for (const w of workers.data ?? []) for (const a of w.agents as Array<{ id: string; name?: string; installed?: boolean; authenticated?: boolean }>) if (a.installed && a.authenticated !== false) byId.set(a.id, a.name ?? a.id);
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [workers.data]);
  const racing = form.kind === 'code' && form.attemptAgents.length >= 2;
  const create = useMutation({
    mutationFn: () =>
      post<TaskDto>(`/orgs/${orgId}/tasks`, {
        ...(continued.data ? { continuesTaskId: continued.data.id } : {}),
        projectId: continued.data?.projectId ?? (form.projectId || projects[0]?.id),
        title: form.title,
        prompt: form.prompt,
        ...(form.knowledge.trim() ? { knowledge: form.knowledge } : {}),
        ...(form.kind === 'review' ? { kind: 'review', review: { base: form.base.trim(), head: form.head.trim() } } : form.kind === 'plan' ? { kind: 'plan' } : {}),
        priority: form.priority,
        dependencies: form.dependencies,
        requirePlanApproval: form.requirePlanApproval,
        ...(form.capabilityIds.length ? { capabilityIds: form.capabilityIds } : {}),
        idempotencyKey,
        ...(form.gitPolicy ? { policy: { git: { policy: form.gitPolicy } } } : {}),
        ...(racing ? { attempts: form.attemptAgents.map((agentId) => ({ agentId })) } : {}),
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
      className="!w-[min(680px,calc(100vw-24px))]"
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
        {continued.data && (
          <Alert>
            Follows up on <strong>{continued.data.title}</strong>: the agent works on branch <code>{continued.data.gitResult?.branch}</code>
            {continued.data.gitResult?.pullRequestUrl ? ' and pushes to its pull request.' : '.'}
          </Alert>
        )}
        <TemplatePicker projectId={continued.data?.projectId ?? (form.projectId || projects[0]?.id)} enabled={open} onApply={(t) => setForm((f) => ({ ...f, ...t }))} />
        <div className="grid grid-2">
          <Field label="Project">
            {(id) => (
              <Select id={id} value={continued.data?.projectId ?? (form.projectId || projects[0]?.id)} disabled={Boolean(continued.data)} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
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
        </div>
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
        {form.kind !== 'review' && (
          <TaskCapabilitySuggestions
            text={`${form.title}\n${form.prompt}`}
            projectId={form.projectId || projects[0]?.id}
            selected={form.capabilityIds}
            onToggle={(ref) => setForm((f) => ({ ...f, capabilityIds: f.capabilityIds.includes(ref) ? f.capabilityIds.filter((x) => x !== ref) : [...f.capabilityIds, ref] }))}
          />
        )}
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
        {form.kind === 'code' && agents.length >= 2 && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="mb-1 text-xs font-medium text-fg-2">Try with several agents (optional)</legend>
            <div className="row">
              {agents.map((a) => (
                <Check
                  key={a.id}
                  checked={form.attemptAgents.includes(a.id)}
                  disabled={!form.attemptAgents.includes(a.id) && form.attemptAgents.length >= 4}
                  onChange={(e) => setForm({ ...form, attemptAgents: e.target.checked ? [...form.attemptAgents, a.id] : form.attemptAgents.filter((x) => x !== a.id) })}
                >
                  {a.name}
                </Check>
              ))}
            </div>
            <span className="hint text-xs text-fg-3">
              {racing
                ? `${form.attemptAgents.length} attempts: the first that passes verification wins, the others are cancelled. Each attempt needs a worker of its own to run at the same time, and each one spends.`
                : 'Choose two or more to run one attempt per agent; the first that passes verification wins.'}
            </span>
          </fieldset>
        )}
        <Check checked={form.requirePlanApproval} onChange={(e) => setForm({ ...form, requirePlanApproval: e.target.checked })}>
          Require approval before the agent starts
        </Check>
      </div>
    </Dialog>
  );
}

export const ALL_STATUSES = TASK_STATUSES;
