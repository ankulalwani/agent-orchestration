import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskDto, TaskEventDto, WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, EmptyState, KeyValue, Progress, Spinner, Tabs, Textarea, formatDuration, timeAgo, type Tone } from '@ao/ui';
import { ApiError, get, getAccessToken, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { TaskStatusBadge, humanize } from '../lib/format';

type Tab = 'overview' | 'prompt' | 'timeline' | 'logs' | 'verification' | 'git' | 'recovery' | 'report';

const EVENT_TONE: Partial<Record<string, string>> = {
  TaskCompleted: 'ok',
  VerificationPassed: 'ok',
  GitCommitCreated: 'ok',
  TaskFailed: 'danger',
  PluginHookFailed: 'danger',
  AgentCrashed: 'danger',
  RecoveryRequired: 'danger',
  VerificationFailed: 'danger',
  ProviderLimitDetected: 'warn',
  ContextExhausted: 'warn',
  FallbackStarted: 'warn',
  LeaseExpired: 'warn',
  AgentHangSuspected: 'warn',
  AgentStarted: 'accent',
  SessionResumed: 'accent',
};

/** Task detail (spec §81) with live execution (§82) and controls (§83, §84). */
export function TaskDetailPage() {
  const { taskId } = useParams();
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('overview');

  const task = useQuery({ queryKey: ['task', orgId, taskId], queryFn: () => get<TaskDto>(`/orgs/${orgId}/tasks/${taskId}`), refetchInterval: 20_000 });
  const events = useQuery({ queryKey: ['events', orgId, taskId], queryFn: () => get<{ items: TaskEventDto[] }>(`/orgs/${orgId}/tasks/${taskId}/events?limit=500`), enabled: tab === 'timeline' || tab === 'recovery' || tab === 'overview' });
  const output = useQuery({ queryKey: ['output', orgId, taskId], queryFn: () => get<{ items: TaskEventDto[] }>(`/orgs/${orgId}/tasks/${taskId}/events?limit=500&includeOutput=true`), enabled: tab === 'logs' });
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`) });

  const action = useMutation({
    mutationFn: (body: { action: string; input?: string; reason?: string }) => post<TaskDto>(`/orgs/${orgId}/tasks/${taskId}/actions`, body),
    onSuccess: (t) => qc.setQueryData(['task', orgId, taskId], t),
  });

  if (task.isLoading) return <Spinner label="Loading task…" />;
  if (task.error || !task.data) return <EmptyState title="Task not found" action={<Link to="/tasks">Back to tasks</Link>} />;
  const t = task.data;
  const worker = workers.data?.find((w) => w.id === t.workerId);
  const active = ['CLAIMING', 'PREPARING', 'RUNNING', 'VERIFYING'].includes(t.status);
  const canControl = can('task.control');

  return (
    <div className="stack">
      <div className="page-header">
        <div>
          <div className="small muted"><Link to="/tasks">Tasks</Link> / {t.id}</div>
          <h1>{t.title}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <TaskStatusBadge status={t.status} />
            <Badge>{humanize(t.priority)}</Badge>
            {t.statusReason && <span className="muted small">{t.statusReason}</span>}
            {t.parentTaskId && (
              <span className="small muted">
                part of <Link to={`/tasks/${t.parentTaskId}`}>a plan</Link>
              </span>
            )}
            {t.source && (
              <span className="small muted">
                from {t.source.name}
                {t.source.url && (
                  <>
                    {' '}
                    (<a href={t.source.url} target="_blank" rel="noreferrer noopener">{t.source.ref ?? 'source'}</a>)
                  </>
                )}
              </span>
            )}
          </div>
        </div>
        {canControl && (
          <div className="row">
            {['RUNNING', 'WAITING_FOR_LIMIT'].includes(t.status) && <Button onClick={() => action.mutate({ action: 'pause' })}>Pause</Button>}
            {['PAUSED', 'WAITING_FOR_LIMIT'].includes(t.status) && <Button onClick={() => action.mutate({ action: 'resume' })}>Resume</Button>}
            {['FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(t.status) && (
              <>
                <Button variant="primary" onClick={() => action.mutate({ action: 'retry' })} title="Continue from the last checkpoint">Retry</Button>
                <Button onClick={() => action.mutate({ action: 'restart' })} title="Start again without the checkpoint (Git work is kept)">Restart fresh</Button>
              </>
            )}
            {active && <Button onClick={() => action.mutate({ action: 'restart' })}>Restart agent</Button>}
            {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status) && (
              <Button variant="danger" onClick={() => confirm('Cancel this task? Work done so far is kept in the project directory.') && action.mutate({ action: 'cancel' })}>Cancel</Button>
            )}
          </div>
        )}
      </div>

      {action.error && <Alert tone="danger">{action.error instanceof ApiError ? action.error.message : 'Action failed'}</Alert>}
      {t.pendingInteraction && <InteractionPanel task={t} onSubmit={(body) => action.mutate(body)} canApprove={can('task.approve')} canControl={canControl} busy={action.isPending} />}
      {t.status === 'WAITING_FOR_LIMIT' && (
        <Alert tone="warn">
          The AI provider <strong>{t.providerId}</strong> hit a usage limit. The task is paused, not failed.{' '}
          {t.waitingUntil ? `It will resume after ${new Date(t.waitingUntil).toLocaleString()}.` : 'The reset time is unknown; the worker checks back with increasing intervals.'}
        </Alert>
      )}
      {t.status === 'RECOVERY_REQUIRED' && <Alert tone="danger">Automatic recovery stopped: {t.statusReason}. Review the Recovery tab, then retry or restart.</Alert>}

      <Tabs<Tab>
        label="Task sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'prompt', label: 'Prompt & plan' },
          { id: 'timeline', label: 'Timeline' },
          { id: 'logs', label: 'Logs' },
          { id: 'verification', label: `Verification${t.verificationRuns.length ? ` (${t.verificationRuns.length})` : ''}` },
          { id: 'git', label: 'Git' },
          { id: 'recovery', label: 'Recovery' },
          { id: 'report', label: 'Report' },
        ]}
      />

      {tab === 'overview' && (
        <div className="grid grid-2">
          <Card title={active ? 'Agent is working…' : 'Execution'}>
            <div className="stack">
              {t.progress.percent !== null && <Progress value={t.progress.percent} label="Task progress" />}
              <KeyValue
                items={[
                  ['Current step', t.progress.currentStep ?? t.lastCheckpoint?.nextAction ?? null],
                  ['Worker', worker ? <Link to={`/workers/${worker.id}`}>{worker.name}</Link> : t.workerId],
                  ['Agent', t.agentId],
                  ['Provider', t.providerId],
                  ['Model', t.modelId],
                  ['Session', t.sessionId ? <code>{t.sessionId}</code> : null],
                  ['Active time', formatDuration(t.activeMs)],
                  ['Started', t.startedAt ? `${new Date(t.startedAt).toLocaleString()} (${timeAgo(t.startedAt)})` : null],
                  ['Completed', t.completedAt ? new Date(t.completedAt).toLocaleString() : null],
                ]}
              />
            </div>
          </Card>
          <Card title="Health">
            <KeyValue
              items={[
                ['Verification', <VerificationBadge key="v" status={t.verificationStatus} />],
                ['Git', <Badge key="g" tone={t.gitStatus === 'FAILED' || t.gitStatus === 'BLOCKED' ? 'warn' : t.gitStatus === 'NONE' ? 'neutral' : 'ok'}>{humanize(t.gitStatus)}</Badge>],
                ['Restarts', t.restartCount],
                ['Limit hits', t.limitHitCount],
                ['Context resets', t.contextResetCount],
                ['Remediations', t.remediationCount],
                ['Retries', t.retryCount],
                ['Dependencies', t.dependencies.length ? t.dependencies.map((d) => <div key={d}><Link to={`/tasks/${d}`}>{d}</Link></div>) : 'None'],
                ['Correlation ID', <code key="c">{t.correlationId}</code>],
              ]}
            />
          </Card>
          <Card title="Recent activity" className="span-2">
            <Timeline events={(events.data?.items ?? []).slice(-12)} />
          </Card>
        </div>
      )}

      {tab === 'prompt' && (
        <div className="stack">
          <Card title="Original prompt">
            <pre className="log">{t.originalPrompt}</pre>
          </Card>
          {t.knowledge && (
            <Card title="Background for the agent">
              <pre className="log">{t.knowledge}</pre>
            </Card>
          )}
          {t.normalizedPrompt && (
            <Card title="Normalized prompt">
              <pre className="log">{t.normalizedPrompt}</pre>
            </Card>
          )}
          <Card title="Plan">{t.generatedPlan ? <pre className="log">{t.generatedPlan}</pre> : <p className="muted">No generated plan. The agent plans inside its session; progress is tracked via checkpoints.</p>}</Card>
          {t.lastCheckpoint && (
            <Card title="Latest checkpoint">
              <KeyValue
                items={[
                  ['Phase', t.lastCheckpoint.phase],
                  ['Completed steps', <List key="c" items={t.lastCheckpoint.completedSteps} />],
                  ['Remaining steps', <List key="r" items={t.lastCheckpoint.remainingSteps} />],
                  ['Changed files', <List key="f" items={t.lastCheckpoint.changedFiles} mono />],
                  ['Known issues', <List key="k" items={t.lastCheckpoint.knownIssues} />],
                  ['Next action', t.lastCheckpoint.nextAction || null],
                  ['Saved', new Date(t.lastCheckpoint.createdAt).toLocaleString()],
                ]}
              />
            </Card>
          )}
        </div>
      )}

      {tab === 'timeline' && (
        <Card title="Timeline">{events.isLoading ? <Spinner /> : <Timeline events={events.data?.items ?? []} />}</Card>
      )}
      {tab === 'logs' && <LogView events={output.data?.items ?? []} loading={output.isLoading} />}
      {tab === 'verification' && <VerificationView task={t} />}
      {tab === 'git' && <GitView task={t} />}
      {tab === 'recovery' && (
        <Card title="Recovery events">
          {t.completionReport?.recoveryEvents.length ? (
            <List items={t.completionReport.recoveryEvents} />
          ) : (
            <Timeline events={(events.data?.items ?? []).filter((e) => ['ProviderLimitDetected', 'ContextExhausted', 'FallbackStarted', 'AgentCrashed', 'AgentHangSuspected', 'LeaseExpired', 'SessionResumed', 'CheckpointCreated', 'RemediationStarted', 'RecoveryRequired'].includes(e.type))} />
          )}
        </Card>
      )}
      {tab === 'report' && <ReportView task={t} />}
    </div>
  );
}

function VerificationBadge({ status }: { status: string }) {
  const tone: Tone = status === 'PASSED' ? 'ok' : status === 'FAILED' ? 'danger' : status === 'RUNNING' ? 'info' : 'neutral';
  return <Badge tone={tone}>{humanize(status)}</Badge>;
}

function List({ items, mono }: { items: string[]; mono?: boolean }) {
  if (!items.length) return <span className="muted">None</span>;
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {items.map((x, i) => <li key={i} className={mono ? 'mono' : undefined}>{x}</li>)}
    </ul>
  );
}

function describe(e: TaskEventDto): string {
  const p = e.payload as Record<string, any>;
  switch (e.type) {
    case 'TaskStatusChanged':
      return `${humanize(p.from)} → ${humanize(p.to)}${p.reason ? ` — ${p.reason}` : ''}`;
    case 'AgentStarted':
    case 'SessionResumed':
      return `${p.agentId} · ${p.providerId} · ${p.modelId}${p.agentVersion ? ` (v${p.agentVersion})` : ''}`;
    case 'AgentExited':
      return `${humanize(String(p.state))} after ${formatDuration(p.durationMs ?? 0)}${p.costUsd ? ` · $${Number(p.costUsd).toFixed(4)}` : ''}${p.outputTokens ? ` · ${p.outputTokens} output tokens` : ''}`;
    case 'ProviderLimitDetected':
      return `${p.providerId} limited${p.retryAt ? ` until ${new Date(p.retryAt).toLocaleString()}` : ' (reset time unknown)'}`;
    case 'FallbackStarted':
      return `${p.fromProviderId ?? p.fromAgentId} → ${p.agentId}/${p.providerId}/${p.modelId}`;
    case 'CommandExecuted':
      return `${p.tool}: ${p.summary ?? ''}`;
    case 'CheckpointCreated':
      return `${p.reason}${p.nextAction ? ` — next: ${p.nextAction}` : ''}`;
    case 'VerificationStepCompleted':
      return `${p.name}: ${p.status}`;
    case 'PluginHookCompleted':
    case 'PluginHookFailed':
      return `${p.plugin} ${p.version} · ${p.hook} · ${formatDuration(p.durationMs ?? 0)}${p.error ? ` — ${p.error}` : ''}`;
    case 'GitCommitCreated':
      return `${String(p.commit).slice(0, 10)} on ${p.branch} (${p.files} files)`;
    case 'TaskClaimed':
      return `by ${p.workerName ?? p.workerId}`;
    case 'AgentStateChanged':
      return p.warning ? String(p.warning) : `${humanize(String(p.state ?? ''))}${p.detail ? ` — ${p.detail}` : ''}`;
    case 'VerificationStarted':
      return `attempt ${p.attempt}`;
    case 'VerificationPassed':
    case 'VerificationFailed':
      return `attempt ${p.attempt}${Array.isArray(p.failed) && p.failed.length ? ` — failed: ${p.failed.join(', ')}` : ''}${Array.isArray(p.warnings) && p.warnings.length ? ` — ${p.warnings.join(' ')}` : ''}`;
    default:
      return Object.keys(p).length ? JSON.stringify(p).slice(0, 200) : '';
  }
}

function Timeline({ events }: { events: TaskEventDto[] }) {
  const shown = events.filter((e) => e.type !== 'AgentOutput' && e.type !== 'TaskProgress');
  if (!shown.length) return <p className="muted">No events yet.</p>;
  return (
    <ol className="timeline">
      {shown.map((e) => (
        <li key={e.eventId}>
          <span className="small muted" title={new Date(e.timestamp).toLocaleString()}>{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className={`dot ${EVENT_TONE[e.type] ?? ''}`} aria-hidden="true" />
          <span>
            <strong>{e.type.replace(/([a-z])([A-Z])/g, '$1 $2')}</strong> <span className="muted">{describe(e)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function LogView({ events, loading }: { events: TaskEventDto[]; loading: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const lines = events.filter((e) => e.type === 'AgentOutput').flatMap((e) => ((e.payload.lines as string[] | undefined) ?? []));
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, follow]);
  return (
    <Card title="Agent output" actions={<label className="row small"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>}>
      {loading ? <Spinner /> : lines.length ? <pre className="log" ref={ref} aria-live="off">{lines.join('\n')}</pre> : <p className="muted">No output yet. Output is redacted for secrets before it leaves the worker.</p>}
    </Card>
  );
}

function VerificationView({ task }: { task: TaskDto }) {
  if (!task.verificationRuns.length) return <Card title="Verification"><p className="muted">Verification has not run yet. A task can only complete after its checks pass.</p></Card>;
  return (
    <div className="stack">
      {[...task.verificationRuns].reverse().map((run) => (
        <Card key={run.attempt} title={`Attempt ${run.attempt}`} actions={<Badge tone={run.status === 'passed' ? 'ok' : 'danger'}>{run.status}</Badge>} padded={false}>
          <table className="table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {run.steps.map((s, i) => (
                <tr key={i}>
                  <td>
                    <strong>{s.name}</strong>
                    {s.command && <div className="mono small muted">{s.command}</div>}
                    {s.status !== 'passed' && s.outputTail && <pre className="log" style={{ maxHeight: 220, marginTop: 6 }}>{s.outputTail}</pre>}
                    {s.artifacts.map((a) => <div key={a.key} style={{ marginTop: 6 }}><ArtifactLink taskId={task.id} artifactKey={a.key} name={a.name} contentType={a.contentType} /></div>)}
                  </td>
                  <td><Badge tone={s.status === 'passed' ? 'ok' : s.status === 'skipped' ? 'neutral' : 'danger'}>{s.status}</Badge>{!s.required && <div className="small muted">optional</div>}</td>
                  <td className="small">{formatDuration(s.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

function GitView({ task }: { task: TaskDto }) {
  const g = task.gitResult;
  if (!g) return <Card title="Git"><p className="muted">No Git operations yet. Changes are committed according to the project's Git policy after verification passes.</p></Card>;
  return (
    <Card title="Git">
      <div className="stack">
        <KeyValue
          items={[
            ['Policy', humanize(g.policy)],
            ['Branch', g.branch ? <code>{g.branch}</code> : null],
            ['Base branch', g.baseBranch ?? null],
            ['Commit', g.commit ? <code>{g.commit}</code> : 'No commit'],
            ['Pushed', g.pushed ? 'Yes' : 'No'],
            ['Pull request', g.pullRequestUrl ? <a href={g.pullRequestUrl} target="_blank" rel="noreferrer">{g.pullRequestUrl}</a> : null],
          ]}
        />
        {g.blocked.length > 0 && <Alert tone="warn">{g.blocked.map((b, i) => <div key={i}>{b}</div>)}</Alert>}
        <div>
          <h3>Files changed ({g.filesChanged.length})</h3>
          <List items={g.filesChanged.map((f) => `${f.status.trim() || 'M'}  ${f.path}`)} mono />
        </div>
        {g.diffStat && <pre className="log">{g.diffStat}</pre>}
      </div>
    </Card>
  );
}

/** Proposed tasks of a plan (FUT-001), and creating them. */
function PlanView({ task }: { task: TaskDto }) {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const { can } = useSession();
  const plan = task.completionReport?.plan;
  const apply = useMutation({
    mutationFn: () => post<{ taskIds: string[] }>(`/orgs/${orgId}/tasks/${task.id}/apply-plan`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['task', orgId, task.id] });
      void qc.invalidateQueries({ queryKey: ['tasks', orgId] });
    },
  });
  if (!plan) return null;
  const applied = task.planApplied;
  const idFor = (key: string) => applied?.taskIds[plan.tasks.findIndex((x) => x.key === key)];
  return (
    <Card
      title={`Plan: ${plan.tasks.length} task${plan.tasks.length === 1 ? '' : 's'}`}
      actions={
        !applied && can('task.create') ? (
          <Button variant="primary" loading={apply.isPending} onClick={() => apply.mutate()}>
            Create {plan.tasks.length} tasks
          </Button>
        ) : applied ? (
          <Badge tone="ok">created {new Date(applied.at).toLocaleString()}</Badge>
        ) : undefined
      }
    >
      <div className="stack">
        {apply.error && <Alert tone="danger">{(apply.error as ApiError).message}</Alert>}
        <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{plan.summary}</p>
        <table className="table" aria-label="Planned tasks">
          <thead>
            <tr><th>Task</th><th>After</th><th>Priority</th></tr>
          </thead>
          <tbody>
            {plan.tasks.map((x) => (
              <tr key={x.key}>
                <td>
                  {idFor(x.key) ? <Link to={`/tasks/${idFor(x.key)}`}>{x.title}</Link> : x.title}
                  <details className="small muted"><summary>Prompt</summary><pre className="log">{x.prompt}</pre></details>
                </td>
                <td className="small">{x.dependsOn.map((d) => plan.tasks.find((y) => y.key === d)?.title ?? d).join(', ') || '—'}</td>
                <td className="small">{humanize(x.priority)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!applied && <p className="small muted">Nothing is created until you click Create. The tasks run in the order of their dependencies.</p>}
      </div>
    </Card>
  );
}

function ReportView({ task }: { task: TaskDto }) {
  const r = task.completionReport;
  if (!r) return <Card title="Completion report"><p className="muted">The report is produced when the task completes. It separates verified facts from the agent's own claims.</p></Card>;
  const review = r.review;
  return (
    <div className="stack">
      <PlanView task={task} />
      {review && (
        <Card title={<span className="row">Review <Badge tone={review.verdict === 'approve' ? 'ok' : review.verdict === 'request_changes' ? 'danger' : 'info'}>{humanize(review.verdict)}</Badge></span>}>
          <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{review.summary}</p>
          {review.comments.length > 0 && (
            <table className="table" aria-label="Review comments">
              <tbody>
                {review.comments.map((c, i) => (
                  <tr key={i}>
                    <td style={{ width: 90 }}><Badge tone={c.severity === 'blocker' || c.severity === 'major' ? 'danger' : 'neutral'}>{c.severity}</Badge></td>
                    <td className="mono small" style={{ width: 220, wordBreak: 'break-all' }}>{c.path}{c.line ? `:${c.line}` : ''}</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{c.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      <Card title="Summary">
        <p style={{ marginTop: 0 }}>{r.summary}</p>
        <KeyValue
          items={[
            ['Verification', r.verification],
            ['Agent · Provider · Model', [r.agentId, r.providerId, r.modelId].filter(Boolean).join(' · ')],
            ['Duration', formatDuration(r.durationMs)],
            ['Tests executed', <List key="t" items={r.testsExecuted} />],
            ['Files changed', <List key="f" items={r.filesChanged} mono />],
          ]}
        />
      </Card>
      {r.warnings.length > 0 && <Alert tone="warn">{r.warnings.map((w, i) => <div key={i}>{w}</div>)}</Alert>}
      <div className="grid grid-2">
        <Card title="Remaining work"><List items={r.remainingWork} /></Card>
        <Card title="Known limitations"><List items={r.knownLimitations} /></Card>
      </div>
      {r.agentReport && (
        <Card title="Agent's own report (unverified)">
          <pre className="log">{r.agentReport}</pre>
        </Card>
      )}
    </div>
  );
}

function InteractionPanel({ task, onSubmit, canApprove, canControl, busy }: { task: TaskDto; onSubmit: (b: { action: string; input?: string }) => void; canApprove: boolean; canControl: boolean; busy: boolean }) {
  const [text, setText] = useState('');
  const p = task.pendingInteraction!;
  return (
    <Card title={p.kind === 'approval' ? 'Approval required' : 'Agent needs input'}>
      <div className="stack">
        <p style={{ margin: 0 }}>{p.question}</p>
        <p className="small muted" style={{ margin: 0 }}>Asked {timeAgo(p.requestedAt)}</p>
        {p.kind === 'input' ? (
          canControl ? (
            <>
              <label className="sr-only" htmlFor="agent-input">Your response</label>
              <Textarea id="agent-input" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
              <div><Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => onSubmit({ action: 'input', input: text })}>Send response</Button></div>
            </>
          ) : (
            <p className="muted">You don't have permission to respond.</p>
          )
        ) : canApprove ? (
          <div className="row">
            <Button variant="primary" loading={busy} onClick={() => onSubmit({ action: 'approve' })}>Approve</Button>
            <Button variant="danger" onClick={() => onSubmit({ action: 'deny' })}>Deny</Button>
          </div>
        ) : (
          <p className="muted">A manager or admin must approve.</p>
        )}
      </div>
    </Card>
  );
}

/** Artifacts need the bearer token, so they are fetched and shown via object URLs. */
export function ArtifactLink({ taskId, artifactKey, name, contentType }: { taskId: string; artifactKey: string; name: string; contentType: string }) {
  const orgId = useOrgId();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const file = artifactKey.split('/').pop()!;
  const load = async () => {
    try {
      const token = getAccessToken();
      const res = await fetch(`/api/v1/orgs/${orgId}/tasks/${taskId}/artifacts/${encodeURIComponent(file)}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUrl(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (error) return <span className="small muted">{name}: {error}</span>;
  if (url && contentType.startsWith('image/')) return <img src={url} alt={name} style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 6 }} />;
  if (url) return <a href={url} download={name}>{name}</a>;
  return <Button size="sm" onClick={() => void load()}>View {name}</Button>;
}
