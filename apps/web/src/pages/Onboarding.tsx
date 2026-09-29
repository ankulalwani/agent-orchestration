import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto, TaskDto, WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';

/**
 * First-run wizard (spec §79): connect worker → detect agents → detect providers → connect project →
 * readiness → run a test task. Each step reads live state, so it can be resumed at any time.
 */
export function OnboardingPage() {
  const orgId = useOrgId();
  const nav = useNavigate();
  const qc = useQueryClient();
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), refetchInterval: 5000 });
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`), refetchInterval: 5000 });
  const [projectName, setProjectName] = useState('');
  const createProject = useMutation({ mutationFn: () => post<ProjectDto>(`/orgs/${orgId}/projects`, { name: projectName }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects', orgId] }) });
  const createTask = useMutation({
    mutationFn: (projectId: string) =>
      post<TaskDto>(`/orgs/${orgId}/tasks`, {
        projectId,
        title: 'Readiness check',
        prompt: 'Inspect this repository and write a short summary of its structure, how to build it and how to run its tests to .agent-orchestration/plans/readiness.md. Do not modify any other files.',
        policy: { git: { policy: 'NONE' } },
      }),
    onSuccess: (t) => nav(`/tasks/${t.id}`),
  });

  if (workers.isLoading || projects.isLoading) return <Spinner />;
  const ws = workers.data ?? [];
  const online = ws.filter((w) => w.status === 'ONLINE');
  const agents = online.flatMap((w) => w.agents.filter((a) => a.installed && a.id !== 'mock'));
  const providers = online.flatMap((w) => w.providers);
  const project = projects.data?.[0];
  const mapped = projects.data?.find((p) => p.workerPaths.length > 0);

  const steps = [
    { label: 'Connect a worker', done: online.length > 0 },
    { label: 'Agents detected', done: agents.length > 0 },
    { label: 'Providers configured', done: providers.length > 0 },
    { label: 'Create a project', done: Boolean(project) },
    { label: 'Map the project on a worker', done: Boolean(mapped) },
    { label: 'Run a test task', done: false },
  ];
  const current = steps.findIndex((s) => !s.done);

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <PageHeader title="Getting started" description="Set up a worker, a project and a first task. This page updates as you complete each step." />
      <ol className="steps" aria-label="Setup progress">
        {steps.map((s, i) => (
          <li key={s.label} className={`step ${s.done ? 'done' : i === current ? 'current' : ''}`} aria-current={i === current ? 'step' : undefined}>
            {s.done ? '✓ ' : `${i + 1}. `}
            {s.label}
          </li>
        ))}
      </ol>

      <Card title="1. Connect a worker" actions={online.length ? <Badge tone="ok">{online.length} online</Badge> : null}>
        {online.length ? (
          <p style={{ margin: 0 }}>Connected: {online.map((w) => w.name).join(', ')}.</p>
        ) : (
          <div className="stack">
            <p style={{ margin: 0 }}>Install the worker on the machine that has your code and AI agents. It opens a local page where you choose <strong>My self-hosted server</strong> and enter this server's address: <code>{location.origin}</code>. It then shows a pairing code.</p>
            <div><Link className="btn btn-primary" to="/pair">Enter pairing code</Link></div>
          </div>
        )}
      </Card>

      <Card title="2. Agents and providers">
        {online.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Waiting for a worker.</p>
        ) : (
          <div className="stack">
            <div>
              <strong>Agents:</strong> {agents.length ? [...new Set(agents.map((a) => `${a.name} ${a.version ?? ''}`))].join(', ') : <span className="muted">none detected — install Claude Code, Codex, Gemini CLI, OpenCode or Aider on the worker</span>}
            </div>
            <div>
              <strong>Models:</strong> each agent runs on its own login (for example your Claude subscription); nothing to set up.
              {' '}
              {providers.some((p) => p.kind !== 'native') ? (
                <>Add-on models: {[...new Set(providers.filter((p) => p.kind !== 'native').map((p) => p.name))].join(', ')}.</>
              ) : (
                <span className="muted">Optional: add-on models (worker's local UI → AI models) keep tasks going when an agent reaches its usage limit.</span>
              )}
            </div>
          </div>
        )}
      </Card>

      <Card title="3. Project">
        {project ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              Project <Link to={`/projects/${project.id}`}>{project.name}</Link> (ID <code>{project.id}</code>).
            </p>
            {mapped ? (
              <Alert>Mapped on {mapped.workerPaths.length} worker(s).</Alert>
            ) : (
              <Alert tone="warn">In the worker's local UI → Projects, add project ID <code>{project.id}</code> and the absolute path of its checkout. The worker only works inside mapped paths.</Alert>
            )}
          </div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="Project name">{(id) => <Input id={id} value={projectName} onChange={(e) => setProjectName(e.target.value)} />}</Field>
            <Button variant="primary" disabled={!projectName} loading={createProject.isPending} onClick={() => createProject.mutate()}>Create project</Button>
          </div>
        )}
        {createProject.error && <Alert tone="danger">{(createProject.error as ApiError).message}</Alert>}
      </Card>

      <Card title="4. Run a test task">
        <div className="stack">
          <p style={{ margin: 0 }}>A read-only readiness check: the agent inspects the repository and writes a summary into the orchestration state folder. Git policy is set to “don't commit”.</p>
          {createTask.error && <Alert tone="danger">{(createTask.error as ApiError).message}</Alert>}
          <div>
            <Button variant="primary" disabled={!mapped} loading={createTask.isPending} onClick={() => mapped && createTask.mutate(mapped.id)}>Run readiness check</Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
