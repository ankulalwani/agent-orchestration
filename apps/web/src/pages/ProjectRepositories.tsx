import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiscoveredSuggestionDto, ProjectDto, RepositoryDto, WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select, Tabs } from '@ao/ui';
import { ApiError, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';

/** A repository's web page, when its key is a hosted repository (host/owner/name). */
export function repositoryHref(r: Pick<RepositoryDto, 'key'>): string | null {
  return r.key && !r.key.startsWith('local:') ? `https://${r.key}` : null;
}

function SourceBadge({ r }: { r: RepositoryDto }) {
  if (r.source === 'github') return <Badge tone={r.github?.accessible === false ? 'warn' : 'neutral'}>{r.github?.accessible === false ? 'GitHub (no access)' : r.github?.private ? 'GitHub · private' : 'GitHub'}</Badge>;
  if (r.source === 'discovered') return <Badge>Found on a worker</Badge>;
  return null;
}

/** The project's repositories: agents see all of them side by side; the primary one holds task state. */
export function RepositoriesCard({ project }: { project: ProjectDto }) {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const canEdit = can('project.update');
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<RepositoryDto | null>(null);
  const [newName, setNewName] = useState('');
  const setProject = (p: ProjectDto) => {
    qc.setQueryData(['project', orgId, project.id], p);
    void qc.invalidateQueries({ queryKey: ['projects', orgId] });
  };
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patch<ProjectDto>(`/orgs/${orgId}/projects/${project.id}/repositories/${id}`, body),
    onSuccess: (p) => {
      setProject(p);
      setRenaming(null);
    },
  });
  const split = useMutation({
    mutationFn: (id: string) => post<ProjectDto>(`/orgs/${orgId}/projects/${project.id}/repositories/${id}/split`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project', orgId, project.id] });
      void qc.invalidateQueries({ queryKey: ['projects', orgId] });
    },
  });
  const workersWith = (r: RepositoryDto) => project.workerPaths.filter((w) => w.repositoryId === r.id).length;
  const error = (update.error ?? split.error) as ApiError | null;

  return (
    <Card title={`Repositories (${project.repositories.length})`} actions={canEdit && <Button size="sm" onClick={() => setAdding(true)}>Add repository</Button>} padded={false}>
      {error && <div className="card-body"><Alert tone="danger">{error.message}</Alert></div>}
      {project.repositories.length > 1 && (
        <p className="card-body muted small" style={{ margin: 0 }}>
          Agents work in all of these repositories at once. A worker runs this project's tasks only when it has every repository checked out.
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th className="hide-mobile">Repository</th>
            <th className="hide-mobile">Branch</th>
            <th>Workers</th>
            {canEdit && <th />}
          </tr>
        </thead>
        <tbody>
          {project.repositories.map((r) => {
            const href = repositoryHref(r);
            return (
              <tr key={r.id}>
                <td>
                  <strong>{r.name}</strong> {r.primary && <Badge tone="ok">primary</Badge>} <SourceBadge r={r} />
                  {project.repositories.length > 1 && <div className="muted small mono" title="Repository ID (for mapping it in a worker's local UI)">{r.id}</div>}
                </td>
                <td className="hide-mobile small mono">{href ? <a href={href} target="_blank" rel="noreferrer">{r.key}</a> : (r.url ?? r.key ?? <span className="muted">No remote</span>)}</td>
                <td className="hide-mobile small mono">{r.defaultBranch}</td>
                <td>{workersWith(r) || <span className="muted">none</span>}</td>
                {canEdit && (
                  <td className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                    {!r.primary && <Button size="sm" variant="ghost" loading={update.isPending && update.variables?.id === r.id && Boolean(update.variables.body.primary)} onClick={() => update.mutate({ id: r.id, body: { primary: true } })}>Make primary</Button>}
                    <Button size="sm" variant="ghost" onClick={() => (setRenaming(r), setNewName(r.name))}>Rename</Button>
                    {project.repositories.length > 1 && can('project.create') && (
                      <Button size="sm" variant="ghost" loading={split.isPending && split.variables === r.id} onClick={() => confirm(`Move ${r.name} into a new project of its own?`) && split.mutate(r.id)}>Own project</Button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <AddRepositoryDialog open={adding} project={project} onClose={() => setAdding(false)} onAdded={setProject} />
      <Dialog
        open={Boolean(renaming)}
        title={`Rename ${renaming?.name ?? ''}`}
        onClose={() => setRenaming(null)}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>Cancel</Button>
            <Button variant="primary" loading={update.isPending} disabled={!newName.trim()} onClick={() => renaming && update.mutate({ id: renaming.id, body: { name: newName.trim() } })}>Save</Button>
          </>
        }
      >
        <Field label="Name" hint="Shown to agents and used as the folder name for new clones. Letters, digits, '.', '_' and '-'.">
          {(id) => <Input id={id} value={newName} onChange={(e) => setNewName(e.target.value)} />}
        </Field>
      </Dialog>
    </Card>
  );
}

function AddRepositoryDialog({ open, project, onClose, onAdded }: { open: boolean; project: ProjectDto; onClose: () => void; onAdded: (p: ProjectDto) => void }) {
  const orgId = useOrgId();
  const [mode, setMode] = useState<'url' | 'move'>('url');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [from, setFrom] = useState('');
  const [repoId, setRepoId] = useState('');
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`), enabled: open });
  const others = (projects.data ?? []).filter((p) => p.id !== project.id);
  const source = others.find((p) => p.id === from);
  const add = useMutation({
    mutationFn: () => post<ProjectDto>(`/orgs/${orgId}/projects/${project.id}/repositories`, mode === 'url' ? { url: url.trim(), defaultBranch: branch.trim() || 'main' } : { fromProjectId: from, repositoryId: repoId }),
    onSuccess: (p) => {
      onAdded(p);
      setUrl('');
      setFrom('');
      setRepoId('');
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      title="Add a repository"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={add.isPending} disabled={mode === 'url' ? !url.trim() : !repoId} onClick={() => add.mutate()}>{mode === 'url' ? 'Add' : 'Move here'}</Button>
        </>
      }
    >
      <div className="stack">
        <Tabs label="How to add" value={mode} onChange={setMode} tabs={[{ id: 'url', label: 'By URL' }, { id: 'move', label: 'From another project' }]} />
        {add.error && <Alert tone="danger">{(add.error as ApiError).message}</Alert>}
        {mode === 'url' ? (
          <>
            <Field label="Repository URL" hint="https, ssh or git@host:owner/repo">{(id) => <Input id={id} value={url} placeholder="https://github.com/acme/web" onChange={(e) => setUrl(e.target.value)} />}</Field>
            <Field label="Default branch">{(id) => <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} />}</Field>
          </>
        ) : (
          <>
            <Field label="Project">
              {(id) => (
                <Select id={id} value={from} onChange={(e) => (setFrom(e.target.value), setRepoId(''))}>
                  <option value="">Choose a project…</option>
                  {others.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              )}
            </Field>
            {source && (
              <Field label="Repository" hint={source.repositories.length === 1 ? `${source.name} has no other repository, so it will be archived (its tasks and history are kept).` : undefined}>
                {(id) => (
                  <Select id={id} value={repoId} onChange={(e) => setRepoId(e.target.value)}>
                    <option value="">Choose a repository…</option>
                    {source.repositories.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}{r.key ? ` (${r.key})` : ''}</option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <p className="muted small" style={{ margin: 0 }}>Workers keep their checkouts of the repository; nothing is moved on disk.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Which workers have which of the project's repositories, and what each is missing. */
export function WorkerCheckoutsCard({ project }: { project: ProjectDto }) {
  const orgId = useOrgId();
  const { can } = useSession();
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`) });
  const [cloneTo, setCloneTo] = useState('');
  // Workers with a projects folder can clone what they are missing.
  const cloneable = (workers.data ?? []).filter((w) => w.status === 'ONLINE' && w.tools.includes('clone'));
  const missingOn = (workerId: string) => project.repositories.filter((r) => r.url && !project.workerPaths.some((p) => p.workerId === workerId && p.repositoryId === r.id));
  const clone = useMutation({
    mutationFn: async (workerId: string) => {
      const results = [];
      for (const r of missingOn(workerId)) results.push(await post<{ requested: string[]; skipped: Array<{ reason: string }> }>(`/orgs/${orgId}/projects/${project.id}/repositories/${r.id}/clone`, { workerIds: [workerId] }));
      return results;
    },
  });
  const byWorker = new Map<string, ProjectDto['workerPaths']>();
  for (const w of project.workerPaths) byWorker.set(w.workerId, [...(byWorker.get(w.workerId) ?? []), w]);
  const multi = project.repositories.length > 1;
  return (
    <Card title="Workers with this project">
      {byWorker.size ? (
        <ul className="check-list">
          {[...byWorker].map(([workerId, paths]) => {
            const missing = project.repositories.filter((r) => !paths.some((p) => p.repositoryId === r.id));
            return (
              <li key={workerId} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
                <span className="row" style={{ gap: 8 }}>
                  <Link to={`/workers/${workerId}`}>{workers.data?.find((x) => x.id === workerId)?.name ?? workerId}</Link>
                  {missing.length ? <Badge tone="warn">missing {missing.map((r) => r.name).join(', ')}</Badge> : multi && <Badge tone="ok">all repositories</Badge>}
                </span>
                {paths.map((p) => (
                  <code key={p.repositoryId ?? p.localPath} className="small">
                    {multi ? `${project.repositories.find((r) => r.id === p.repositoryId)?.name ?? '?'}: ` : ''}
                    {p.localPath}
                  </code>
                ))}
              </li>
            );
          })}
        </ul>
      ) : (
        <Alert tone="warn">
          No worker has this project checked out yet. Workers that scan for repositories map it automatically when they find a clone; otherwise add it in the worker's local UI → Projects with project ID <code>{project.id}</code>.
        </Alert>
      )}
      {can('project.update') && cloneable.some((w) => missingOn(w.id).length) && (
        <div className="row" style={{ gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <Select aria-label="Worker to clone to" value={cloneTo} onChange={(e) => setCloneTo(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Clone to a worker…</option>
            {cloneable
              .filter((w) => missingOn(w.id).length)
              .map((w) => (
                <option key={w.id} value={w.id}>{w.name} ({missingOn(w.id).map((r) => r.name).join(', ')})</option>
              ))}
          </Select>
          <Button size="sm" disabled={!cloneTo} loading={clone.isPending} onClick={() => clone.mutate(cloneTo)}>Clone</Button>
        </div>
      )}
      {clone.data && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          {clone.data.some((r) => r.requested.length) ? 'Cloning into the worker’s projects folder; it appears here when done.' : clone.data.flatMap((r) => r.skipped.map((x) => x.reason)).join('; ')}
        </p>
      )}
      {clone.error && <Alert tone="danger">{(clone.error as ApiError).message}</Alert>}
    </Card>
  );
}

/** Repositories workers found on their disks that are in no project yet. */
export function DiscoveredCard() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const found = useQuery({ queryKey: ['discovered', orgId], queryFn: () => get<DiscoveredSuggestionDto[]>(`/orgs/${orgId}/discovered`), refetchInterval: 30_000 });
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const [target, setTarget] = useState<Record<string, string>>({});
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['discovered', orgId] });
    void qc.invalidateQueries({ queryKey: ['projects', orgId] });
  };
  const accept = useMutation({ mutationFn: (body: { ids: string[]; projectId?: string }) => post<ProjectDto>(`/orgs/${orgId}/discovered/accept`, body), onSuccess: done });
  const dismiss = useMutation({ mutationFn: (ids: string[]) => post(`/orgs/${orgId}/discovered/dismiss`, { ids }), onSuccess: done });
  const list = found.data ?? [];
  if (!list.length) return null;
  const groupId = (g: DiscoveredSuggestionDto) => g.key ?? g.locations[0]!.id;
  const error = (accept.error ?? dismiss.error) as ApiError | null;
  return (
    <Card title={`Found on your workers (${list.length})`} padded={false}>
      <p className="card-body muted small" style={{ margin: 0 }}>
        Git repositories your workers found that are in no project yet. Clones of repositories that are already in a project are mapped automatically.
      </p>
      {error && <div className="card-body"><Alert tone="danger">{error.message}</Alert></div>}
      <table className="table">
        <thead>
          <tr>
            <th>Repository</th>
            <th className="hide-mobile">Where</th>
            {can('project.create') && <th />}
          </tr>
        </thead>
        <tbody>
          {list.map((g) => {
            const id = groupId(g);
            const ids = g.locations.map((l) => l.id);
            const into = target[id] ?? '';
            return (
              <tr key={id}>
                <td>
                  <strong>{g.name}</strong>
                  <div className="muted small mono">{g.key && !g.key.startsWith('local:') ? g.key : g.key ? 'no remote' : 'no remote, no commits'}</div>
                </td>
                <td className="hide-mobile small">
                  {g.locations.map((l) => (
                    <div key={l.id}>
                      {l.workerName}: <code>{l.localPath}</code>
                    </div>
                  ))}
                </td>
                {can('project.create') && (
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <Select aria-label="Project" value={into} onChange={(e) => setTarget({ ...target, [id]: e.target.value })} style={{ maxWidth: 180 }}>
                        <option value="">New project</option>
                        {(projects.data ?? []).map((p) => (
                          <option key={p.id} value={p.id}>Add to {p.name}</option>
                        ))}
                      </Select>
                      <Button size="sm" variant="primary" loading={accept.isPending && accept.variables?.ids[0] === ids[0]} onClick={() => accept.mutate({ ids, ...(into ? { projectId: into } : {}) })}>
                        {into ? 'Add' : 'Create project'}
                      </Button>
                      <Button size="sm" variant="ghost" loading={dismiss.isPending && dismiss.variables?.[0] === ids[0]} onClick={() => dismiss.mutate(ids)}>Dismiss</Button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
