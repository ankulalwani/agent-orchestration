import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OverviewDto, TaskDto, WorkerDto } from '@ao/contracts';
import { Badge, Card, EmptyState, Spinner, Stat, timeAgo } from '@ao/ui';
import { get } from '../lib/api';
import { useOrgId } from '../lib/session';
import { TaskStatusBadge, WorkerStatusBadge } from '../lib/format';
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

  if (overview.isLoading) return <Spinner label="Loading overview…" />;
  const o = overview.data;
  if (!o) return <EmptyState title="Could not load the overview" />;
  const firstRun = !workers.data?.length;

  return (
    <div className="stack">
      <PageHeader title="Overview" description="Everything running across your workers, and what needs a human." />
      {firstRun && (
        <Card>
          <div className="spread">
            <div>
              <h2>Connect your first worker</h2>
              <p className="muted">Workers run coding agents on your machines. The setup guide walks you through pairing, projects and a first test task.</p>
            </div>
            <Link className="btn btn-primary" to="/welcome">Get started</Link>
          </div>
        </Card>
      )}
      <div className="grid grid-stats">
        <Stat label="Active tasks" value={o.activeTasks} />
        <Stat label="Waiting" value={o.waitingTasks} />
        <Stat label="Completed today" value={o.completedToday} />
        <Stat label="Failed" value={o.failedTasks} attention={o.failedTasks > 0} />
        <Stat label="Recovery required" value={o.recoveryRequired} attention={o.recoveryRequired > 0} />
        <Stat label="Verification failures" value={o.verificationFailures} attention={o.verificationFailures > 0} />
        <Stat label="Workers online" value={o.workersOnline} />
        <Stat label="Workers offline" value={o.workersOffline} attention={o.workersOffline > 0} />
      </div>

      <div className="grid grid-2">
        <Card title="Needs attention" actions={<Badge tone={o.needsAttention.length ? 'warn' : 'ok'}>{o.needsAttention.length}</Badge>} padded={false}>
          {o.needsAttention.length ? (
            <div className="table-wrap">
              <table className="table">
                <tbody>
                  {o.needsAttention.map((t) => (
                    <tr key={t.taskId} className="clickable" onClick={() => nav(`/tasks/${t.taskId}`)}>
                      <td>
                        <Link to={`/tasks/${t.taskId}`}>{t.title}</Link>
                        {t.reason && <div className="muted small truncate">{t.reason}</div>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <TaskStatusBadge status={t.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="Nothing needs you right now" />
          )}
        </Card>

        <Card title="AI provider health" padded={false}>
          {o.providerHealth.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Healthy</th>
                  <th>Limited</th>
                  <th>Unhealthy</th>
                </tr>
              </thead>
              <tbody>
                {o.providerHealth.map((p) => (
                  <tr key={p.providerId}>
                    <td>{p.providerId}</td>
                    <td>{p.healthy ? <Badge tone="ok">{p.healthy}</Badge> : 0}</td>
                    <td>{p.limited ? <Badge tone="warn">{p.limited}</Badge> : 0}</td>
                    <td>{p.unhealthy ? <Badge tone="danger">{p.unhealthy}</Badge> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No providers reported yet">Providers are configured on each worker.</EmptyState>
          )}
        </Card>
      </div>

      <Card title="Running now" padded={false}>
        {running.data?.items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Where</th>
                  <th>Agent · Provider · Model</th>
                  <th>Current step</th>
                </tr>
              </thead>
              <tbody>
                {running.data.items.map((t) => (
                  <tr key={t.id} className="clickable" onClick={() => nav(`/tasks/${t.id}`)}>
                    <td>
                      <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                    </td>
                    <td>
                      <TaskStatusBadge status={t.status} />
                      {t.status === 'WAITING_FOR_LIMIT' && <div className="muted small">{t.waitingUntil ? `until ${new Date(t.waitingUntil).toLocaleTimeString()}` : 'reset time unknown'}</div>}
                    </td>
                    <td>{workers.data?.find((w) => w.id === t.workerId)?.name ?? '—'}</td>
                    <td className="small">{[t.agentId, t.providerId, t.modelId].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="small muted"><span className="truncate">{t.progress.currentStep ?? t.statusReason ?? '—'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No tasks running" />
        )}
      </Card>

      <Card title="Workers" padded={false} actions={<Link to="/workers">All workers</Link>}>
        {workers.data?.length ? (
          <table className="table">
            <tbody>
              {workers.data.map((w) => (
                <tr key={w.id} className="clickable" onClick={() => nav(`/workers/${w.id}`)}>
                  <td>{w.name}</td>
                  <td><WorkerStatusBadge status={w.status} /></td>
                  <td className="small muted">{w.activeTaskIds.length}/{w.maxConcurrentTasks} tasks</td>
                  <td className="small muted hide-mobile">heartbeat {timeAgo(w.lastHeartbeatAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="No workers connected" action={<Link to="/welcome">Connect a worker</Link>} />
        )}
      </Card>
    </div>
  );
}
