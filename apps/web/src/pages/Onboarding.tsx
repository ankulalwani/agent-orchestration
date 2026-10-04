import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import type { ProjectDto, TaskDto, WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Field, Input, Progress, Spinner, cn } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';
import { InstallWorkerCard } from '../InstallWorker';

/** One step of the setup: a marker on a rail (number, or a check when done), a title and its content. */
function Step({ n, title, done, current, last, aside, children }: { n: number; title: string; done: boolean; current: boolean; last?: boolean; aside?: ReactNode; children: ReactNode }) {
  return (
    <li className="relative flex gap-4 pb-6 last:pb-0" aria-current={current ? 'step' : undefined}>
      {!last && <span className={cn('absolute bottom-0 left-[13px] top-8 w-px', done ? 'bg-ok/50' : 'bg-line')} aria-hidden="true" />}
      <span
        className={cn(
          'grid size-7 flex-none place-items-center rounded-full border font-mono text-xs',
          done ? 'border-ok bg-ok-soft text-ok' : current ? 'border-brand bg-brand text-on-brand' : 'border-line-strong bg-surface text-fg-3',
        )}
        aria-hidden="true"
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-2 flex min-h-7 flex-wrap items-center gap-2">
          <h2 className={cn('text-sm', !done && !current && 'text-fg-2')}>{title}</h2>
          {aside}
        </div>
        <div className="flex flex-col gap-3 text-fg-2">{children}</div>
      </div>
    </li>
  );
}

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

  if (workers.isLoading || projects.isLoading) return <Spinner label="Loading…" />;
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
  const doneCount = steps.filter((s) => s.done).length;
  // The four sections below cover the six checks above.
  const sectionDone = [steps[0]!.done, steps[1]!.done && steps[2]!.done, steps[3]!.done && steps[4]!.done, false];
  const currentSection = sectionDone.findIndex((d) => !d);

  return (
    <div className="flex max-w-[860px] flex-col gap-5">
      <PageHeader title="Getting started" description="Set up a worker, a project and a first task. This page updates as you complete each step." />

      <div className="card p-4">
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <strong>{doneCount} of {steps.length} checks passed</strong>
          <span className="text-xs text-fg-3">{steps.find((s) => !s.done)?.label ? `Next: ${steps.find((s) => !s.done)!.label.toLowerCase()}` : ''}</span>
        </div>
        <Progress value={(doneCount / steps.length) * 100} label="Setup progress" />
        <ol className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Setup progress">
          {steps.map((s) => (
            <li key={s.label} className={cn('flex items-center gap-1.5', s.done ? 'text-ok' : 'text-fg-3')}>
              <span className={cn('size-1.5 rounded-full', s.done ? 'bg-ok' : 'bg-line-strong')} aria-hidden="true" />
              {s.label}
              {s.done && <span className="sr-only"> (done)</span>}
            </li>
          ))}
        </ol>
      </div>

      <ol className="card p-5">
        <Step n={1} title="Connect a worker" done={sectionDone[0]!} current={currentSection === 0} aside={online.length ? <Badge tone="ok">{online.length} online</Badge> : null}>
          {online.length ? (
            <p>Connected: {online.map((w) => w.name).join(', ')}.</p>
          ) : (
            <>
              <p>Run the install command below on the machine that has your code and AI agents. It opens a page where you click <strong>Approve</strong>. Already installed it by hand? <Link to="/pair">Enter a pairing code</Link>.</p>
              <InstallWorkerCard />
            </>
          )}
        </Step>

        <Step n={2} title="Agents and providers" done={sectionDone[1]!} current={currentSection === 1}>
          {online.length === 0 ? (
            <p className="muted">Waiting for a worker.</p>
          ) : (
            <>
              <div>
                <strong className="text-fg">Agents:</strong> {agents.length ? [...new Set(agents.map((a) => `${a.name} ${a.version ?? ''}`))].join(', ') : <span className="muted">none detected — install Claude Code, Codex, Gemini CLI, OpenCode or Aider on the worker</span>}
              </div>
              <div>
                <strong className="text-fg">Models:</strong> each agent runs on its own login (for example your Claude subscription); nothing to set up.
                {' '}
                {providers.some((p) => p.kind !== 'native') ? (
                  <>Add-on models: {[...new Set(providers.filter((p) => p.kind !== 'native').map((p) => p.name))].join(', ')}.</>
                ) : (
                  <span className="muted">Optional: add-on models (worker's local UI → AI models) keep tasks going when an agent reaches its usage limit.</span>
                )}
              </div>
            </>
          )}
        </Step>

        <Step n={3} title="Project" done={sectionDone[2]!} current={currentSection === 2}>
          {project ? (
            <>
              <p>
                Project <Link to={`/projects/${project.id}`}>{project.name}</Link> (ID <code>{project.id}</code>).
              </p>
              {mapped ? (
                <Alert>Mapped on {mapped.workerPaths.length} worker(s).</Alert>
              ) : (
                <Alert tone="warn">In the worker's local UI → Projects, add project ID <code>{project.id}</code> and the absolute path of its checkout. The worker only works inside mapped paths.</Alert>
              )}
            </>
          ) : (
            <div className="flex max-w-md items-end gap-2">
              <Field label="Project name" className="flex-1">{(id) => <Input id={id} value={projectName} onChange={(e) => setProjectName(e.target.value)} />}</Field>
              <Button variant="primary" disabled={!projectName} loading={createProject.isPending} onClick={() => createProject.mutate()}>Create project</Button>
            </div>
          )}
          {createProject.error && <Alert tone="danger">{(createProject.error as ApiError).message}</Alert>}
        </Step>

        <Step n={4} title="Run a test task" done={false} current={currentSection === 3} last>
          <p>A read-only readiness check: the agent inspects the repository and writes a summary into the orchestration state folder. Git policy is set to “don't commit”.</p>
          {createTask.error && <Alert tone="danger">{(createTask.error as ApiError).message}</Alert>}
          <div>
            <Button variant="primary" disabled={!mapped} loading={createTask.isPending} onClick={() => mapped && createTask.mutate(mapped.id)}>Run readiness check</Button>
          </div>
        </Step>
      </ol>
    </div>
  );
}
