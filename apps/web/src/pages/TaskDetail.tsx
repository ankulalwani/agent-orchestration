import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, MessageSquareWarning, Pause, Play, RotateCcw, ShieldQuestion } from 'lucide-react';
import type { TaskDto, TaskEventDto, WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Check, CopyButton, EmptyState, KeyValue, Progress, Skeleton, Spinner, Stat, StatStrip, Tabs, Textarea, formatDuration, timeAgo, type Tone } from '@ao/ui';
import { ApiError, get, getAccessToken, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { RunsOn, TaskStatusBadge, humanize } from '../lib/format';

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

/** The attempts of a task that several agents try: who runs which, and which one won. */
function Attempts({ task }: { task: TaskDto }) {
  const orgId = useOrgId();
  const group = task.attempt!;
  const attempts = useQuery({ queryKey: ['tasks', orgId, 'attempts', group.groupId], queryFn: () => get<{ items: TaskDto[] }>(`/orgs/${orgId}/tasks?attemptGroupId=${group.groupId}&limit=10`), refetchInterval: 20_000 });
  const items = [...(attempts.data?.items ?? [])].sort((a, b) => a.attempt!.index - b.attempt!.index);
  return (
    <Card title={`Attempt ${group.index + 1} of ${group.of}`} description="Several agents try this task. The first attempt that passes verification wins; the others are cancelled." padded={false}>
      <ul className="divide-y divide-line" aria-label="Attempts">
        {items.map((a) => (
          <li key={a.id} className="flex items-center gap-3 px-4 py-2">
            <span className="min-w-0 flex-1 truncate">
              {a.id === task.id ? <strong>{a.attempt!.agentId}</strong> : <Link to={`/tasks/${a.id}`}>{a.attempt!.agentId}</Link>}
              {a.id === task.id && <span className="text-xs text-fg-3"> · this attempt</span>}
            </span>
            {a.attempt!.winnerTaskId === a.id && <Badge tone="ok" plain>winner</Badge>}
            <TaskStatusBadge status={a.status} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

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

  if (task.isLoading) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label="Loading task…">
        <Skeleton className="h-6 w-80 max-w-full" />
        <Skeleton className="h-[70px]" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (task.error || !task.data) return <EmptyState title="Task not found" action={<Link to="/tasks">Back to tasks</Link>}>It may have been deleted, or it belongs to another organization.</EmptyState>;
  const t = task.data;
  const worker = workers.data?.find((w) => w.id === t.workerId);
  const active = ['CLAIMING', 'PREPARING', 'RUNNING', 'VERIFYING'].includes(t.status);
  const canControl = can('task.control');

  return (
    <div className="flex flex-col gap-4">
      <div className="page-header !mb-0 !items-start">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1 text-xs text-fg-3">
            <Link to="/tasks">Tasks</Link> / <span className="font-mono">{t.id}</span>
            <CopyButton value={t.id} label="Copy task ID" className="!size-5" />
          </div>
          <h1 className="break-words">{t.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <TaskStatusBadge status={t.status} />
            <Badge plain>{humanize(t.priority)}</Badge>
            {t.statusReason && <span className="text-xs text-fg-3">{t.statusReason}</span>}
            {t.usage && (t.usage.costUsd > 0 || t.usage.inputTokens + t.usage.outputTokens > 0) && (
              <span className="text-xs text-fg-3" title={`${t.usage.inputTokens} input and ${t.usage.outputTokens} output tokens, as reported by the agent`}>
                spent {t.usage.costUsd > 0 ? `$${t.usage.costUsd.toFixed(2)}` : `${t.usage.inputTokens + t.usage.outputTokens} tokens`}
              </span>
            )}
            {t.continues && (
              <span className="text-xs text-fg-3">
                follows up on <Link to={`/tasks/${t.continues.taskId}`}>a task</Link>, on branch <code>{t.continues.branch}</code>
              </span>
            )}
            {t.parentTaskId && !t.continues && (
              <span className="text-xs text-fg-3">
                part of <Link to={`/tasks/${t.parentTaskId}`}>a plan</Link>
              </span>
            )}
            {t.source && (
              <span className="text-xs text-fg-3">
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
            {['RUNNING', 'WAITING_FOR_LIMIT'].includes(t.status) && <Button onClick={() => action.mutate({ action: 'pause' })}><Pause aria-hidden="true" />Pause</Button>}
            {['PAUSED', 'WAITING_FOR_LIMIT'].includes(t.status) && <Button onClick={() => action.mutate({ action: 'resume' })}><Play aria-hidden="true" />Resume</Button>}
            {['FAILED', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(t.status) && (
              <>
                <Button variant="primary" onClick={() => action.mutate({ action: 'retry' })} title="Continue from the last checkpoint"><RotateCcw aria-hidden="true" />Retry</Button>
                <Button onClick={() => action.mutate({ action: 'restart' })} title="Start again without the checkpoint (Git work is kept)">Restart fresh</Button>
              </>
            )}
            {active && <Button onClick={() => action.mutate({ action: 'restart' })}><RotateCcw aria-hidden="true" />Restart agent</Button>}
            {t.status === 'COMPLETED' && (t.kind ?? 'code') === 'code' && t.gitResult?.branch && can('task.create') && (
              <Button asChild title="A new task on this task's branch; it adds to the same pull request">
                <Link to={`/tasks?new=1&continues=${t.id}`}>Follow up</Link>
              </Button>
            )}
            {!['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status) && (
              <Button variant="danger" onClick={() => confirm('Cancel this task? Work done so far is kept in the project directory.') && action.mutate({ action: 'cancel' })}><Ban aria-hidden="true" />Cancel</Button>
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
      {t.attempt && <Attempts task={t} />}

      <StatStrip>
        <Stat label="Worker" value={<span className="block truncate text-[15px] leading-7">{worker ? <Link to={`/workers/${worker.id}`} className="text-fg">{worker.name}</Link> : <span className="text-fg-3">Not claimed</span>}</span>} />
        <Stat label="Agent / provider / model" value={<span className="block truncate leading-7"><RunsOn agent={t.agentId} provider={t.providerId} model={t.modelId} /></span>} />
        <Stat label="Active time" value={<span className="text-[15px] leading-7">{formatDuration(t.activeMs)}</span>} />
        <Stat label={active ? 'Agent is working…' : 'Progress'} value={<span className="block truncate text-[15px] leading-7">{t.progress.percent !== null ? `${Math.round(t.progress.percent)}%` : <span className="text-fg-3">—</span>}</span>}>
          {t.progress.percent !== null && <Progress value={t.progress.percent} label="Task progress" />}
        </Stat>
      </StatStrip>

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
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Card title="Recent activity" className="lg:row-span-2">
            <Timeline events={(events.data?.items ?? []).slice(-12)} />
          </Card>
          <Card title="Execution">
            <KeyValue
              items={[
                ['Current step', t.progress.currentStep ?? t.lastCheckpoint?.nextAction ?? null],
                ['Session', t.sessionId ? <code>{t.sessionId}</code> : null],
                ['Started', t.startedAt ? `${new Date(t.startedAt).toLocaleString()} (${timeAgo(t.startedAt)})` : null],
                ['Completed', t.completedAt ? new Date(t.completedAt).toLocaleString() : null],
                ['Dependencies', t.dependencies.length ? t.dependencies.map((d) => <div key={d}><Link to={`/tasks/${d}`} className="font-mono text-xs">{d}</Link></div>) : 'None'],
                ['Correlation ID', <code key="c">{t.correlationId}</code>],
              ]}
            />
          </Card>
          <Card title="Health">
            <KeyValue
              items={[
                ['Verification', <VerificationBadge key="v" status={t.verificationStatus} />],
                ['Git', <Badge key="g" tone={t.gitStatus === 'FAILED' || t.gitStatus === 'BLOCKED' ? 'warn' : t.gitStatus === 'NONE' ? 'neutral' : 'ok'}>{humanize(t.gitStatus)}</Badge>],
                ['Restarts', <Count key="r" n={t.restartCount} />],
                ['Limit hits', <Count key="l" n={t.limitHitCount} />],
                ['Context resets', <Count key="x" n={t.contextResetCount} />],
                ['Remediations', <Count key="m" n={t.remediationCount} />],
                ['Retries', <Count key="t" n={t.retryCount} />],
              ]}
            />
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

/** A counter that is only worth a look when it is not zero. */
function Count({ n }: { n: number }) {
  return <span className={n ? 'font-mono text-xs text-warn' : 'font-mono text-xs text-fg-3'}>{n}</span>;
}

function VerificationBadge({ status }: { status: string }) {
  const tone: Tone = status === 'PASSED' ? 'ok' : status === 'FAILED' ? 'danger' : status === 'RUNNING' ? 'info' : 'neutral';
  return <Badge tone={tone}>{humanize(status)}</Badge>;
}

function List({ items, mono }: { items: string[]; mono?: boolean }) {
  if (!items.length) return <span className="muted">None</span>;
  return (
    <ul>
      {items.map((x, i) => <li key={i} className={mono ? 'mono whitespace-pre-wrap' : undefined}>{x}</li>)}
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
          <span className="muted" title={new Date(e.timestamp).toLocaleString()}>{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className={`dot ${EVENT_TONE[e.type] ?? ''}`} aria-hidden="true" />
          <span className="min-w-0 break-words">
            <strong>{e.type.replace(/([a-z])([A-Z])/g, '$1 $2')}</strong> <span className="text-fg-2">{describe(e)}</span>
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
    <Card title="Agent output" description={lines.length ? `${lines.length.toLocaleString()} lines` : undefined} actions={<Check className="text-xs" checked={follow} onChange={(e) => setFollow(e.target.checked)}>Follow</Check>} padded={false}>
      {loading ? (
        <div className="p-4"><Spinner /></div>
      ) : lines.length ? (
        <pre className="log !max-h-[62vh] !rounded-t-none !border-0" ref={ref} aria-live="off">{lines.join('\n')}</pre>
      ) : (
        <p className="muted p-4">No output yet. Output is redacted for secrets before it leaves the worker.</p>
      )}
    </Card>
  );
}

function VerificationView({ task }: { task: TaskDto }) {
  if (!task.verificationRuns.length) return <Card title="Verification"><p className="muted">Verification has not run yet. A task can only complete after its checks pass.</p></Card>;
  return (
    <div className="stack">
      {[...task.verificationRuns].reverse().map((run) => (
        <Card key={run.attempt} title={`Attempt ${run.attempt}`} actions={<Badge tone={run.status === 'passed' ? 'ok' : 'danger'}>{run.status}</Badge>} padded={false}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Check</th>
                  <th>Result</th>
                  <th className="text-right">Duration</th>
                </tr>
              </thead>
              <tbody>
                {run.steps.map((s, i) => (
                  <tr key={i}>
                    <td>
                      <strong>{s.name}</strong>
                      {s.command && <div className="mono muted break-all">{s.command}</div>}
                      {s.status !== 'passed' && s.outputTail && <pre className="log mt-1.5 !max-h-56">{s.outputTail}</pre>}
                      {s.artifacts.map((a) => <div key={a.key} className="mt-1.5"><ArtifactLink taskId={task.id} artifactKey={a.key} name={a.name} contentType={a.contentType} /></div>)}
                    </td>
                    <td className="align-top"><Badge tone={s.status === 'passed' ? 'ok' : s.status === 'skipped' ? 'neutral' : 'danger'}>{s.status}</Badge>{!s.required && <div className="small muted">optional</div>}</td>
                    <td className="num text-right align-top text-xs text-fg-2">{formatDuration(s.durationMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
            ['Replaces', g.supersedes ? <a href={g.supersedes} target="_blank" rel="noreferrer">{g.supersedes}</a> : null],
            ['Update from base', g.update ? (g.update.state === 'up_to_date' ? `Already contained ${g.update.base}` : g.update.state === 'merged' ? `${g.update.base} merged, no conflicts` : `${g.update.base} merged, conflicts resolved in ${g.update.conflicts.join(', ')}`) : null],
            ['Merge', g.merge ? (g.merge.state === 'merged' ? `Merged${g.merge.method ? ` (${g.merge.method})` : ''}${g.merge.commit ? ` as ${g.merge.commit.slice(0, 7)}` : ''}` : g.merge.state === 'ready' ? 'Ready to merge' : g.merge.state === 'declined' ? 'Declined' : `Not merged: ${g.merge.reason}`) : task.merge ? (task.merge.mode === 'approval' ? 'After approval, when verified' : 'Automatic, when verified') : null],
          ]}
        />
        {g.blocked.length > 0 && <Alert tone="warn">{g.blocked.map((b, i) => <div key={i}>{b}</div>)}</Alert>}
        <div>
          <h3 className="mb-1.5">Files changed ({g.filesChanged.length})</h3>
          {g.filesChanged.length ? (
            <ul className="divide-y divide-line rounded-sm border border-line font-mono text-xs">
              {g.filesChanged.map((f, i) => {
                const s = f.status.trim() || 'M';
                return (
                  <li key={i} className="flex gap-3 px-3 py-1.5">
                    <span className={s.startsWith('A') || s === '??' ? 'w-5 flex-none text-ok' : s.startsWith('D') ? 'w-5 flex-none text-danger' : 'w-5 flex-none text-warn'}>{s}</span>
                    <span className="min-w-0 break-all">{f.path}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className="muted">None</span>
          )}
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
          <Button variant="primary" size="sm" loading={apply.isPending} onClick={() => apply.mutate()}>
            Create {plan.tasks.length} tasks
          </Button>
        ) : applied ? (
          <Badge tone="ok">created {new Date(applied.at).toLocaleString()}</Badge>
        ) : undefined
      }
      padded={false}
    >
      <div className="flex flex-col gap-3 p-4">
        {apply.error && <Alert tone="danger">{(apply.error as ApiError).message}</Alert>}
        <p className="whitespace-pre-wrap">{plan.summary}</p>
      </div>
      <div className="table-wrap border-t border-line">
        <table className="table" aria-label="Planned tasks">
          <thead>
            <tr><th>Task</th><th>After</th><th>Priority</th></tr>
          </thead>
          <tbody>
            {plan.tasks.map((x) => (
              <tr key={x.key}>
                <td>
                  {idFor(x.key) ? <Link to={`/tasks/${idFor(x.key)}`}>{x.title}</Link> : x.title}
                  <details className="small muted"><summary>Prompt</summary><pre className="log mt-1">{x.prompt}</pre></details>
                </td>
                <td className="small align-top">{x.dependsOn.map((d) => plan.tasks.find((y) => y.key === d)?.title ?? d).join(', ') || '—'}</td>
                <td className="small align-top">{humanize(x.priority)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!applied && <p className="small muted border-t border-line px-4 py-2.5">Nothing is created until you click Create. The tasks run in the order of their dependencies.</p>}
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
        <Card title={<span className="row"><h2>Review</h2> <Badge tone={review.verdict === 'approve' ? 'ok' : review.verdict === 'request_changes' ? 'danger' : 'info'}>{humanize(review.verdict)}</Badge></span>} padded={false}>
          <p className="whitespace-pre-wrap p-4">{review.summary}</p>
          {review.comments.length > 0 && (
            <div className="table-wrap border-t border-line">
              <table className="table" aria-label="Review comments">
                <tbody>
                  {review.comments.map((c, i) => (
                    <tr key={i}>
                      <td className="w-[90px] align-top"><Badge tone={c.severity === 'blocker' || c.severity === 'major' ? 'danger' : 'neutral'}>{c.severity}</Badge></td>
                      <td className="mono w-[220px] break-all align-top">{c.path}{c.line ? `:${c.line}` : ''}</td>
                      <td className="whitespace-pre-wrap">{c.body}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      <Card title="Summary">
        <p className="mb-3 max-w-[80ch]">{r.summary}</p>
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
  const Icon = p.kind === 'approval' ? ShieldQuestion : MessageSquareWarning;
  return (
    <section className="rounded-md border border-warn/50 bg-warn-soft p-4">
      <div className="flex gap-3">
        <Icon className="mt-0.5 size-4 flex-none text-warn" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div>
            <h2>{p.kind === 'approval' ? 'Approval required' : 'Agent needs input'}</h2>
            <p className="text-xs text-fg-3">Asked {timeAgo(p.requestedAt)}</p>
          </div>
          <p className="max-w-[80ch] whitespace-pre-wrap">{p.question}</p>
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
      </div>
    </section>
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
  if (url && contentType.startsWith('image/')) return <img src={url} alt={name} className="max-w-full rounded-sm border border-line" />;
  if (url) return <a href={url} download={name}>{name}</a>;
  return <Button size="sm" onClick={() => void load()}>View {name}</Button>;
}
