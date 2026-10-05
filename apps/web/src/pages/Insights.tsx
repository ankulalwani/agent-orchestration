import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsDto, ProjectDto } from '@ao/contracts';
import { Card, EmptyState, Select, Spinner, Stat, formatDuration } from '@ao/ui';
import { get } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';
import { BudgetBadge, useBudget } from '../components/BudgetCard';

type Figures = AnalyticsDto['totals'];
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const usd = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);
const dur = (v: number | null) => (v == null ? '—' : formatDuration(v));
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A round number at or above `n` for the top of the axis. */
function niceMax(n: number) {
  if (n <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 4, 5, 10].map((m) => m * step).find((m) => m >= n)!;
}

/** Tasks finished per day: completed and failed, stacked. The tables below hold the same figures. */
function DailyChart({ daily }: { daily: AnalyticsDto['daily'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(...daily.map((d) => d.completed + d.failed)));
  // Few enough date labels that they fit a phone-width chart.
  const labelEvery = Math.ceil(daily.length / 5);
  return (
    <figure className="chart" aria-label="Tasks finished per day">
      <div className="chart-legend small">
        <span><i className="chart-key" style={{ background: 'var(--chart-done)' }} />Completed</span>
        <span><i className="chart-key" style={{ background: 'var(--chart-failed)' }} />Failed</span>
      </div>
      <div className="chart-plot">
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="chart-grid" style={{ bottom: `${f * 100}%` }}>
            <span className="chart-tick small muted">{Math.round(top * f)}</span>
          </div>
        ))}
        <div className="chart-columns">
          {daily.map((d, i) => (
            <div key={d.date} className="chart-slot" tabIndex={0} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${day(d.date)}: ${d.completed} completed, ${d.failed} failed, ${usd(d.costUsd)}`}>
              <div className="chart-stack">
                {d.failed > 0 && <div className="chart-bar" style={{ height: `${(d.failed / top) * 100}%`, background: 'var(--chart-failed)' }} />}
                {d.completed > 0 && <div className="chart-bar" style={{ height: `${(d.completed / top) * 100}%`, background: 'var(--chart-done)' }} />}
              </div>
              {hover === i && (
                <div className="chart-tooltip small" role="tooltip" style={i > daily.length / 2 ? { right: 0 } : { left: 0 }}>
                  <strong>{day(d.date)}</strong>
                  <span>{d.completed} completed</span>
                  <span>{d.failed} failed</span>
                  <span className="muted">{usd(d.costUsd)} spent</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="chart-axis small muted">
        {daily.map((d, i) => (
          <span key={d.date} className="chart-slot">{i % labelEvery === 0 ? day(d.date) : ''}</span>
        ))}
      </div>
    </figure>
  );
}

function FiguresTable<T extends Omit<Figures, 'created'>>({ rows, label, name }: { rows: T[]; label: string; name: (r: T) => string }) {
  if (!rows.length) return <EmptyState title="No finished tasks in this period" />;
  return (
    <div className="table-wrap">
      <table className="table" aria-label={`Outcomes by ${label.toLowerCase()}`}>
        <thead>
          <tr><th>{label}</th><th>Finished</th><th>Success</th><th>First pass</th><th>Fixes per task</th><th>Cost per completed</th><th>Agent time</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={name(r)}>
              <td>{name(r)}</td>
              <td>{r.finished}<span className="muted small"> ({r.failed} failed)</span></td>
              <td>{pct(r.successRate)}</td>
              <td>{pct(r.firstPassRate)}</td>
              <td>{r.avgRemediations.toFixed(1)}</td>
              <td>{usd(r.costPerCompletedUsd)}</td>
              <td>{dur(r.avgActiveMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Outcomes of finished tasks: how often agents succeed, what it costs, and how the agents and models compare. */
export function InsightsPage() {
  const orgId = useOrgId();
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const analytics = useQuery({ queryKey: ['analytics', orgId, days, projectId], queryFn: () => get<AnalyticsDto>(`/orgs/${orgId}/analytics?days=${days}${projectId ? `&projectId=${projectId}` : ''}`), refetchInterval: 60_000 });
  const budget = useBudget();
  const a = analytics.data;

  return (
    <div className="stack">
      <PageHeader
        title="Insights"
        description="What finished, how often it passed your checks, and what it cost."
        actions={
          <>
            <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </Select>
          </>
        }
      />
      {analytics.isLoading || !a ? (
        <Spinner label="Loading insights…" />
      ) : (
        <>
          <div className="grid grid-stats">
            <Stat label="Finished tasks" value={a.totals.finished} hint={`${a.totals.created} created`} />
            <Stat label="Success rate" value={pct(a.totals.successRate)} hint="Completed, of completed and failed" />
            <Stat label="First-pass rate" value={pct(a.totals.firstPassRate)} hint="Passed verification without a fix" />
            <Stat label="Cost" value={usd(a.totals.costUsd)} hint="As agents report it" />
            <Stat label="Cost per completed task" value={usd(a.totals.costPerCompletedUsd)} />
            <Stat label="Agent time per task" value={dur(a.totals.avgActiveMs)} />
            <Stat label="Created to completed" value={dur(a.totals.avgLeadMs)} />
            {budget.data && <Stat label="Spent this month" value={usd(budget.data.organization.spentUsd)} hint={budget.data.organization.limitUsd == null ? 'No budget set' : `of ${usd(budget.data.organization.limitUsd)}`} attention={budget.data.organization.state === 'exceeded'} />}
          </div>
          <Card title="Tasks finished per day">{a.totals.finished ? <DailyChart daily={a.daily} /> : <EmptyState title="No finished tasks in this period" />}</Card>
          <Card title="By agent" padded={false}><FiguresTable rows={a.byAgent} label="Agent" name={(r) => r.agentId} /></Card>
          <Card title="By model" padded={false}><FiguresTable rows={a.byModel} label="Model" name={(r) => `${r.providerId} · ${r.modelId}`} /></Card>
          {!projectId && <Card title="By project" padded={false}><FiguresTable rows={a.byProject} label="Project" name={(r) => r.name} /></Card>}
          {budget.data && budget.data.projects.some((p) => p.limitUsd != null) && (
            <Card title="Project budgets this month" padded={false}>
              <table className="table">
                <tbody>
                  {budget.data.projects.filter((p) => p.limitUsd != null).map((p) => (
                    <tr key={p.projectId}><td>{p.name}</td><td>{usd(p.spentUsd)} of {usd(p.limitUsd)}</td><td style={{ textAlign: 'right' }}><BudgetBadge line={p} /></td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
