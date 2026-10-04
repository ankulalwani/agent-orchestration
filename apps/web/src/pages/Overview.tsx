import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, Cpu, Play, Server } from 'lucide-react';
import type { OverviewDto, TaskDto, WorkerDto } from '@ao/contracts';
import { Badge, Button, Card, EmptyState, Skeleton, SlotMeter, Stat, StatStrip, cn, timeAgo } from '@ao/ui';
import { get } from '../lib/api';
import { useOrgId } from '../lib/session';
import { RunsOn, TaskStatusBadge, humanize } from '../lib/format';
import { PageHeader } from '../Layout';

/** Main dashboard (spec §80): what is running, where, on which AI, what waits and why, what needs a human. */
export function OverviewPage() {
  const orgId = useOrgId();
  const nav = useNavigate();
  const overview = useQuery({ queryKey: ['overview', orgId], queryFn: () => get<OverviewDto>(`/orgs/${orgId}/overview`), refetchInterval: 15_000 });
  const running = useQuery({
    queryKey: ['tasks', orgId, 'active'],
    queryFn: () => get<{ items: TaskDto[] }>(`/orgs/${orgId}/tasks?status=CLAIMING,PREPARING,RUNNING,VERIFYING,WAITING_FOR_LIMIT,PAUSED&limit=20`),
    refetchInterval: 15_000,
  });
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), refetchInterval: 30_000 });

  if (overview.isLoading) {
    return (
      <div className="flex flex-col gap-4" role="status" aria-label="Loading overview…">
        <PageHeader title="Overview" description="Everything running across your workers, and what needs a human." />
        <Skeleton className="h-[146px]" />
        <Skeleton className="h-56" />
      </div>
    );
  }
  const o = overview.data;
  if (!o) return <EmptyState title="Could not load the overview">The server did not answer. This page retries on its own.</EmptyState>;
  const firstRun = workers.isSuccess && !workers.data.length;
  const slots = (workers.data ?? []).filter((w) => w.status === 'ONLINE').reduce((a, w) => ({ used: a.used + w.activeTaskIds.length, max: a.max + w.maxConcurrentTasks }), { used: 0, max: 0 });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Overview" description="Everything running across your workers, and what needs a human." />
      {firstRun && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-brand/40 bg-brand-soft px-4 py-3.5">
          <div className="min-w-0">
            <h2>Connect your first worker</h2>
            <p className="max-w-[70ch] text-fg-2">Workers run coding agents on your machines. The setup guide walks you through pairing, projects and a first test task.</p>
          </div>
          <Button asChild variant="primary">
            <Link to="/welcome">Get started</Link>
          </Button>
        </div>
      )}

      <StatStrip>
        <Stat label="Active tasks" value={o.activeTasks}>
          {slots.max > 0 && <span className="tabular-nums">{slots.used} of {slots.max} slots in use</span>}
        </Stat>
        <Stat label="Waiting" value={o.waitingTasks} />
        <Stat label="Completed today" value={o.completedToday} />
        <Stat label="Failed" value={o.failedTasks} attention={o.failedTasks > 0} />
        <Stat label="Recovery required" value={o.recoveryRequired} attention={o.recoveryRequired > 0} />
        <Stat label="Verification failures" value={o.verificationFailures} attention={o.verificationFailures > 0} />
        <Stat label="Workers online" value={o.workersOnline} />
        <Stat label="Workers offline" value={o.workersOffline} attention={o.workersOffline > 0} />
      </StatStrip>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Needs attention" actions={<Badge tone={o.needsAttention.length ? 'warn' : 'ok'} plain>{o.needsAttention.length}</Badge>} padded={false}>
            {o.needsAttention.length ? (
              <ul className="divide-y divide-line">
                {o.needsAttention.map((t) => (
                  <li key={t.taskId}>
                    <Link to={`/tasks/${t.taskId}`} className="relative flex items-center gap-3 px-4 py-2.5 text-fg hover:bg-surface-2 hover:no-underline">
                      <span className={cn('absolute inset-y-0 left-0 w-0.5', ['RECOVERY_REQUIRED', 'FAILED', 'CRASHED'].includes(t.status) ? 'bg-danger' : 'bg-warn')} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{t.title}</span>
                        {t.reason && <span className="block truncate text-xs text-fg-3">{t.reason}</span>}
                      </span>
                      <TaskStatusBadge status={t.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={CircleCheck} title="Nothing needs you right now">Tasks waiting for input, approval or recovery show up here.</EmptyState>
            )}
          </Card>

          <Card title="Running now" actions={<Link to="/tasks" className="text-xs">All tasks</Link>} padded={false}>
            {running.data?.items.length ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Status</th>
                      <th>Worker</th>
                      <th className="hide-mobile">Agent / provider / model</th>
                    </tr>
                  </thead>
                  <tbody>
                    {running.data.items.map((t) => (
                      <tr key={t.id} className="clickable" onClick={() => nav(`/tasks/${t.id}`)}>
                        <td className="max-w-[420px]">
                          <Link to={`/tasks/${t.id}`} className="block truncate">{t.title}</Link>
                          <span className="block truncate text-xs text-fg-3">{t.progress.currentStep ?? t.statusReason ?? '—'}</span>
                        </td>
                        <td>
                          <TaskStatusBadge status={t.status} />
                          {t.status === 'WAITING_FOR_LIMIT' && <div className="mt-0.5 text-xs text-fg-3">{t.waitingUntil ? `until ${new Date(t.waitingUntil).toLocaleTimeString()}` : 'reset time unknown'}</div>}
                        </td>
                        <td className="whitespace-nowrap">{workers.data?.find((w) => w.id === t.workerId)?.name ?? '—'}</td>
                        <td className="hide-mobile"><RunsOn agent={t.agentId} provider={t.providerId} model={t.modelId} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState icon={Play} title="No tasks running">New tasks start as soon as a worker with the project has a free slot.</EmptyState>
            )}
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Workers" padded={false} actions={<Link to="/workers" className="text-xs">All workers</Link>}>
            {workers.data?.length ? (
              <ul className="divide-y divide-line">
                {workers.data.map((w) => {
                  const online = w.status === 'ONLINE';
                  return (
                    <li key={w.id}>
                      <Link to={`/workers/${w.id}`} className="flex items-center gap-3 px-4 py-2.5 text-fg hover:bg-surface-2 hover:no-underline">
                        <span className={cn('size-2 flex-none rounded-full', online ? 'bg-ok' : w.status === 'PENDING_APPROVAL' ? 'bg-warn' : 'bg-line-strong')} aria-hidden="true" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{w.name}</span>
                          <span className="block truncate text-xs text-fg-3">{online ? `heartbeat ${timeAgo(w.lastHeartbeatAt)}` : `${humanize(w.status)}, last seen ${timeAgo(w.lastHeartbeatAt)}`}</span>
                        </span>
                        <SlotMeter used={w.activeTaskIds.length} max={w.maxConcurrentTasks} offline={!online} />
                        <span className="w-8 flex-none text-right font-mono text-xs text-fg-2">{w.activeTaskIds.length}/{w.maxConcurrentTasks}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState icon={Server} title="No workers connected" action={<Link to="/welcome">Connect a worker</Link>} />
            )}
          </Card>

          <Card title="AI provider health" padded={false}>
            {o.providerHealth.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th className="text-right">Healthy</th>
                    <th className="text-right">Limited</th>
                    <th className="text-right">Unhealthy</th>
                  </tr>
                </thead>
                <tbody>
                  {o.providerHealth.map((p) => (
                    <tr key={p.providerId}>
                      <td className="font-mono text-xs">{p.providerId}</td>
                      <td className={cn('num text-right', p.healthy ? 'text-ok' : 'text-fg-3')}>{p.healthy}</td>
                      <td className={cn('num text-right', p.limited ? 'font-semibold text-warn' : 'text-fg-3')}>{p.limited}</td>
                      <td className={cn('num text-right', p.unhealthy ? 'font-semibold text-danger' : 'text-fg-3')}>{p.unhealthy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState icon={Cpu} title="No providers reported yet">Providers are configured on each worker.</EmptyState>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
