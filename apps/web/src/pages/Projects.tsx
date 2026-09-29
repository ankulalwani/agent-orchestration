import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, KeyValue, Select, Spinner, Tabs, Textarea } from '@ao/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { PageHeader } from '../Layout';
import { DiscoveredCard, RepositoriesCard, WorkerCheckoutsCard } from './ProjectRepositories';

/** Workers with a checkout of the project (of any of its repositories). */
const workerCount = (p: ProjectDto) => new Set(p.workerPaths.map((w) => w.workerId)).size;

export function ProjectsPage() {
  const orgId = useOrgId();
  const { can } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', repositoryUrl: '', defaultBranch: 'main' });
  // A new project can also start with a new GitHub repository (through the organization's GitHub App).
  const [source, setSource] = useState<'url' | 'github'>('url');
  const [gh, setGh] = useState({ owner: '', private: true, cloneTo: [] as string[] });
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), enabled: open && source === 'github' });
  const cloneable = (workers.data ?? []).filter((w) => w.status === 'ONLINE' && w.tools.includes('clone'));
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const owners = useQuery({ queryKey: ['github-owners', orgId], queryFn: () => get<Array<{ login: string; type: string; canCreate: boolean }>>(`/orgs/${orgId}/github/owners`), enabled: open });
  const creatable = (owners.data ?? []).filter((o) => o.canCreate);
  const create = useMutation({
    mutationFn: () =>
      source === 'github'
        ? post<ProjectDto>(`/orgs/${orgId}/github/repositories`, { owner: gh.owner || creatable[0]?.login, name: form.name.trim().replace(/[^A-Za-z0-9._-]+/g, '-'), private: gh.private, description: form.description, cloneToWorkerIds: gh.cloneTo })
        : post<ProjectDto>(`/orgs/${orgId}/projects`, { ...form, repositoryUrl: form.repositoryUrl || undefined }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['projects', orgId] });
      setOpen(false);
      nav(`/projects/${p.id}`);
    },
  });

  return (
    <div>
      <PageHeader title="Projects" description="Repositories that tasks run against. Each worker maps a project to a local checkout." actions={can('project.create') && <Button variant="primary" onClick={() => setOpen(true)}>New project</Button>} />
      <Card padded={false}>
        {projects.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : projects.data?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Project</th>
                <th className="hide-mobile">Repository</th>
                <th>Workers</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => nav(`/projects/${p.id}`)}>
                  <td>
                    <Link to={`/projects/${p.id}`}>{p.name}</Link>
                    {p.description && <div className="muted small">{p.description}</div>}
                  </td>
                  <td className="hide-mobile small mono">
                    {p.repositories.find((r) => r.primary)?.key ?? p.repositoryUrl ?? '—'}
                    {p.repositories.length > 1 && <span className="muted"> +{p.repositories.length - 1} more</span>}
                  </td>
                  <td>{workerCount(p) ? `${workerCount(p)} worker${workerCount(p) > 1 ? 's' : ''}` : <span className="muted">Not on any worker</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No projects yet" action={can('project.create') && <Button onClick={() => setOpen(true)}>Create a project</Button>}>
            Connect GitHub (Settings → GitHub) to get a project for each repository, or let your workers find the repositories on their disks.
          </EmptyState>
        )}
      </Card>
      <DiscoveredCard />
      <Dialog
        open={open}
        title="New project"
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form.name.trim()} onClick={() => create.mutate()}>Create</Button>
          </>
        }
      >
        <div className="stack">
          {create.error && <Alert tone="danger">{(create.error as ApiError).message}</Alert>}
          {creatable.length > 0 && (
            <Tabs label="Repository" value={source} onChange={setSource} tabs={[{ id: 'url', label: 'Existing repository' }, { id: 'github', label: 'New GitHub repository' }]} />
          )}
          <Field label="Name" hint={source === 'github' ? 'Also the repository name' : undefined}>{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Description">{(id) => <Input id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
          {source === 'github' ? (
            <>
              <Field label="Create it in">
                {(id) => (
                  <Select id={id} value={gh.owner || creatable[0]?.login || ''} onChange={(e) => setGh({ ...gh, owner: e.target.value })}>
                    {creatable.map((o) => (
                      <option key={o.login} value={o.login}>{o.login}{o.type === 'User' ? ' (personal)' : ''}</option>
                    ))}
                  </Select>
                )}
              </Field>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" checked={gh.private} onChange={(e) => setGh({ ...gh, private: e.target.checked })} />
                <span>Private repository</span>
              </label>
              {cloneable.length > 0 && (
                <Field label="Clone it to" hint="Into each worker's projects folder">
                  {() => (
                    <div className="stack" style={{ gap: 4 }}>
                      {cloneable.map((w) => (
                        <label key={w.id} className="row" style={{ gap: 8 }}>
                          <input type="checkbox" checked={gh.cloneTo.includes(w.id)} onChange={(e) => setGh({ ...gh, cloneTo: e.target.checked ? [...gh.cloneTo, w.id] : gh.cloneTo.filter((x) => x !== w.id) })} />
                          <span>{w.name}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </Field>
              )}
            </>
          ) : (
            <>
              <Field label="Repository URL" hint="Optional; more repositories can be added to the project later">{(id) => <Input id={id} value={form.repositoryUrl} onChange={(e) => setForm({ ...form, repositoryUrl: e.target.value })} />}</Field>
              <Field label="Default branch">{(id) => <Input id={id} value={form.defaultBranch} onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })} />}</Field>
            </>
          )}
        </div>
      </Dialog>
    </div>
  );
}

type ReadinessItem = { id: string; category: 'required' | 'recommended' | 'available' | 'not_required'; title: string; explanation: string; confidence: string; capabilityId?: string };
const READINESS_GROUPS: Array<{ key: ReadinessItem['category']; label: string; tone: 'danger' | 'warn' | 'ok' | 'neutral' }> = [
  { key: 'required', label: 'Required', tone: 'danger' },
  { key: 'recommended', label: 'Recommended', tone: 'warn' },
  { key: 'available', label: 'Already available', tone: 'ok' },
  { key: 'not_required', label: 'Not required', tone: 'neutral' },
];

/** "Prepare project for AI" (spec §41): analysis runs on a worker that has the checkout. */
function ReadinessCard({ project }: { project: ProjectDto }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const r = project.readiness;
  const pending = r?.status === 'PENDING';
  useQuery({
    queryKey: ['project', orgId, project.id, 'poll'],
    queryFn: async () => {
      const fresh = await get<ProjectDto>(`/orgs/${orgId}/projects/${project.id}`);
      qc.setQueryData(['project', orgId, project.id], fresh);
      return fresh.readiness?.status ?? null;
    },
    enabled: pending,
    refetchInterval: 1500,
  });
  const run = useMutation({ mutationFn: () => post<ProjectDto>(`/orgs/${orgId}/projects/${project.id}/readiness`), onSuccess: (p) => qc.setQueryData(['project', orgId, project.id], p) });
  const report = r?.report as { score: number; summary: string; items: ReadinessItem[] } | null | undefined;
  return (
    <Card title="AI readiness" actions={<Button size="sm" loading={run.isPending || pending} onClick={() => run.mutate()}>{report ? 'Analyze again' : 'Prepare project for AI'}</Button>}>
      <div className="stack">
        {run.error && <Alert tone="danger">{(run.error as ApiError).message}</Alert>}
        {r?.status === 'FAILED' && <Alert tone="danger">Analysis failed on the worker: {r.error}</Alert>}
        {pending && <Spinner label="Inspecting the repository on the worker…" />}
        {!report && !pending && <p className="muted" style={{ margin: 0 }}>Checks Git, agents, providers, tests, build, browser verification, tools, documentation and matching capabilities. Only project metadata is read; no source code leaves the worker.</p>}
        {report && (
          <>
            <div className="row">
              <strong style={{ fontSize: 22 }}>{report.score}%</strong>
              <span>{report.summary}</span>
            </div>
            {READINESS_GROUPS.map((g) => {
              const list = report.items.filter((i) => i.category === g.key);
              if (!list.length) return null;
              return (
                <div key={g.key}>
                  <h3 style={{ marginBottom: 6 }}>{g.label} <Badge tone={g.tone}>{list.length}</Badge></h3>
                  <ul className="check-list">
                    {list.map((i) => (
                      <li key={i.id} style={{ flexDirection: 'column', gap: 0, alignItems: 'flex-start' }}>
                        <strong>{i.title}</strong>
                        <span className="small muted">{i.explanation} <span title="confidence">({i.confidence} confidence)</span></span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            {r?.completedAt && <span className="small muted">Analyzed {new Date(r.completedAt).toLocaleString()}</span>}
          </>
        )}
      </div>
    </Card>
  );
}

export function ProjectDetailPage() {
  const { projectId } = useParams();
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const project = useQuery({ queryKey: ['project', orgId, projectId], queryFn: () => get<ProjectDto>(`/orgs/${orgId}/projects/${projectId}`) });
  const [knowledge, setKnowledge] = useState('');
  const [policyText, setPolicyText] = useState('');
  const [gitPolicy, setGitPolicy] = useState('');
  const [policyError, setPolicyError] = useState<string | null>(null);
  useEffect(() => {
    if (!project.data) return;
    setKnowledge(project.data.knowledge);
    setPolicyText(JSON.stringify(project.data.policy ?? {}, null, 2));
    setGitPolicy(((project.data.policy as { git?: { policy?: string } } | undefined)?.git?.policy) ?? '');
  }, [project.data]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch<ProjectDto>(`/orgs/${orgId}/projects/${projectId}`, body),
    onSuccess: (p) => qc.setQueryData(['project', orgId, projectId], p),
  });
  const archive = useMutation({ mutationFn: () => del(`/orgs/${orgId}/projects/${projectId}`), onSuccess: () => nav('/projects') });

  if (project.isLoading) return <Spinner />;
  if (!project.data) return <EmptyState title="Project not found" />;
  const p = project.data;
  const canEdit = can('project.update');

  return (
    <div className="stack">
      <PageHeader title={p.name} description={p.description} actions={can('project.delete') && <Button variant="danger" onClick={() => confirm('Archive this project? Its tasks and history are kept.') && archive.mutate()}>Archive</Button>} />
      {(save.error || archive.error) && <Alert tone="danger">{((save.error ?? archive.error) as ApiError).message}</Alert>}
      <RepositoriesCard project={p} />
      <div className="grid grid-2">
        <Card title="Details">
          <KeyValue items={[['Primary repository', p.repositories.find((r) => r.primary)?.name ?? '—'], ['Default branch', p.defaultBranch], ['Project ID', <code key="id">{p.id}</code>]]} />
        </Card>
        <WorkerCheckoutsCard project={p} />
      </div>
      <ReadinessCard project={p} />
      <Card title="Git policy" actions={canEdit && <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ policy: { ...(p.policy ?? {}), git: { ...((p.policy as any)?.git ?? {}), ...(gitPolicy ? { policy: gitPolicy } : {}) } } })}>Save</Button>}>
        <Field label="After verification passes" hint="Force-push, branch deletion and discarding changes are never automatic.">
          {(id) => (
            <Select id={id} value={gitPolicy} disabled={!canEdit} onChange={(e) => setGitPolicy(e.target.value)}>
              <option value="">Organization default (commit)</option>
              <option value="NONE">Don't commit</option>
              <option value="COMMIT">Commit on a task branch</option>
              <option value="COMMIT_AND_PUSH">Commit and push</option>
              <option value="PULL_REQUEST">Open a pull request</option>
            </Select>
          )}
        </Field>
      </Card>
      <Card title="Project knowledge" actions={canEdit && <Button size="sm" loading={save.isPending} onClick={() => save.mutate({ knowledge })}>Save</Button>}>
        <Field label="Shared with every agent working on this project" hint="Architecture, conventions, business rules, known issues. Never put secrets here.">
          {(id) => <Textarea id={id} rows={8} value={knowledge} disabled={!canEdit} onChange={(e) => setKnowledge(e.target.value)} />}
        </Field>
      </Card>
      {can('policy.manage') && (
        <Card
          title="Advanced policy (JSON)"
          actions={
            <Button
              size="sm"
              loading={save.isPending}
              onClick={() => {
                try {
                  setPolicyError(null);
                  save.mutate({ policy: JSON.parse(policyText) });
                } catch {
                  setPolicyError('Invalid JSON');
                }
              }}
            >
              Save policy
            </Button>
          }
        >
          <Field label="Overrides for this project" hint="Concurrency, agents, models, fallback chain, verification steps, capabilities, approvals. Validated by the server." error={policyError}>
            {(id) => <Textarea id={id} rows={12} className="mono" value={policyText} onChange={(e) => setPolicyText(e.target.value)} />}
          </Field>
        </Card>
      )}
    </div>
  );
}
