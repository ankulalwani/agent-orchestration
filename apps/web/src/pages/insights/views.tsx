import { Link } from 'react-router-dom';
import type { AnalyticsCostDto, AnalyticsDto, AnalyticsFlowDto, AnalyticsReliabilityDto, AnalyticsWorkersDto } from '@ao/contracts';
import { FAILURE_CATEGORY_LABELS, type FailureCategory, type TaskStatus } from '@ao/core/shared';
import { Alert, Badge, Card, EmptyState, Spinner, Stat } from '@ao/ui';
import { BudgetBadge, useBudget } from '../../components/BudgetCard';
import { TaskStatusBadge, WorkerStatusBadge, humanize } from '../../lib/format';
import { DayChart, Delta, FiguresTable, NOTHING_FINISHED, TableCard, compact, count, dur, pct, usd, useInsight, type Filter } from './shared';

const DONE = 'var(--chart-done)';
const FAILED = 'var(--chart-failed)';
const loading = (label: string) => <Spinner label={`Loading ${label}…`} />;

/** Outcomes of finished tasks: how often agents succeed, what it costs, and how the agents and models compare. */
export function OverviewView({ filter }: { filter: Filter }) {
  const { data: a } = useInsight<AnalyticsDto>('', filter);
  const budget = useBudget();
  if (!a) return loading('insights');
  const none = !a.totals.finished && NOTHING_FINISHED;
  const p = a.previous;
  return (
    <>
      <div className="grid grid-stats">
        <Stat label="Finished tasks" value={a.totals.finished} hint={`${a.totals.created} created`}>
          <Delta value={a.totals.finished} previous={p.finished} good="up" />
        </Stat>
        <Stat label="Success rate" value={pct(a.totals.successRate)} hint="Completed, of completed and failed">
          <Delta value={a.totals.successRate} previous={p.successRate} good="up" points />
        </Stat>
        <Stat label="First-pass rate" value={pct(a.totals.firstPassRate)} hint="Passed verification without a fix">
          <Delta value={a.totals.firstPassRate} previous={p.firstPassRate} good="up" points />
        </Stat>
        <Stat label="Cost" value={usd(a.totals.costUsd)} hint="As agents report it">
          <Delta value={a.totals.costUsd} previous={p.costUsd} good="down" />
        </Stat>
        <Stat label="Cost per completed task" value={usd(a.totals.costPerCompletedUsd)}>
          <Delta value={a.totals.costPerCompletedUsd} previous={p.costPerCompletedUsd} good="down" />
        </Stat>
        <Stat label="Agent time per task" value={dur(a.totals.avgActiveMs)}>
          <Delta value={a.totals.avgActiveMs} previous={p.avgActiveMs} good="down" />
        </Stat>
        <Stat label="Created to completed" value={dur(a.totals.avgLeadMs)}>
          <Delta value={a.totals.avgLeadMs} previous={p.avgLeadMs} good="down" />
        </Stat>
        {budget.data && <Stat label="Spent this month" value={usd(budget.data.organization.spentUsd)} hint={budget.data.organization.limitUsd == null ? 'No budget set' : `of ${usd(budget.data.organization.limitUsd)}`} attention={budget.data.organization.state === 'exceeded'} />}
      </div>
      <Card title="Tasks finished per day">
        {none ? (
          <EmptyState title={none} />
        ) : (
          <DayChart
            label="Tasks finished per day"
            days={a.daily}
            series={[
              { key: 'completed', label: 'Completed', color: DONE },
              { key: 'failed', label: 'Failed', color: FAILED },
            ]}
            note={(d) => `${usd(d.costUsd)} spent`}
          />
        )}
      </Card>
      <TableCard title="By agent" view="" table="byAgent" filter={filter} empty={none}>
        <FiguresTable rows={a.byAgent} label="Agent" name={(r) => r.agentId} />
      </TableCard>
      <TableCard title="By model" view="" table="byModel" filter={filter} empty={none}>
        <FiguresTable rows={a.byModel} label="Model" name={(r) => `${r.providerId} · ${r.modelId}`} />
      </TableCard>
      {!filter.projectId && (
        <TableCard title="By project" view="" table="byProject" filter={filter} empty={none}>
          <FiguresTable rows={a.byProject} label="Project" name={(r) => r.name} />
        </TableCard>
      )}
    </>
  );
}

type SpendRow = { costUsd: number; inputTokens: number; outputTokens: number; sessions: number };
function SpendTable<T extends SpendRow>({ rows, label, name, total }: { rows: T[]; label: string; name: (r: T) => string; total: number }) {
  return (
    <table className="table" aria-label={`Spend by ${label.toLowerCase()}`}>
      <thead>
        <tr>
          <th>{label}</th>
          <th>Cost</th>
          <th>Share</th>
          <th>Sessions</th>
          <th>Input tokens</th>
          <th>Output tokens</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={name(r)}>
            <td>{name(r)}</td>
            <td>{usd(r.costUsd)}</td>
            <td>{total > 0 ? pct(r.costUsd / total) : '—'}</td>
            <td>{count(r.sessions)}</td>
            <td>{compact(r.inputTokens)}</td>
            <td>{compact(r.outputTokens)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const USAGE_KIND: Record<string, string> = { execution: 'Agent sessions', limit: 'Provider limits hit', fallback: 'Switches to another agent or model' };

/** Where the money went, and whether this month's budgets will hold. */
export function CostView({ filter }: { filter: Filter }) {
  const { data: c } = useInsight<AnalyticsCostDto>('/cost', filter);
  if (!c) return loading('spend');
  const none = !c.totals.sessions && !c.totals.costUsd && 'No agent sessions in this period';
  return (
    <>
      <div className="grid grid-stats">
        <Stat label="Spend" value={usd(c.totals.costUsd)} hint="As agents and providers report it">
          <Delta value={c.totals.costUsd} previous={c.previous.costUsd} good="down" />
        </Stat>
        <Stat label="Agent sessions" value={count(c.totals.sessions)}>
          <Delta value={c.totals.sessions} previous={c.previous.sessions} good="up" />
        </Stat>
        <Stat label="Cost per session" value={usd(c.totals.sessions ? c.totals.costUsd / c.totals.sessions : null)} />
        <Stat label="Input tokens" value={compact(c.totals.inputTokens)} />
        <Stat label="Output tokens" value={compact(c.totals.outputTokens)} />
      </div>
      <Card title="Spend per day">{none ? <EmptyState title={none} /> : <DayChart label="Spend per day" days={c.daily} series={[{ key: 'costUsd', label: 'Spent', color: DONE }]} format={usd} tick={(v) => `$${+v.toFixed(2)}`} whole={false} note={(d) => `${compact(d.inputTokens + d.outputTokens)} tokens`} />}</Card>
      <TableCard title="Budgets this month" description="The forecast continues the month's spend so far at the same rate." view="/cost" table="budgets" filter={filter} empty={!c.budgets.length && 'No spend and no budget this month'}>
        <table className="table" aria-label="Budgets this month">
          <thead>
            <tr>
              <th>Budget</th>
              <th>Spent</th>
              <th>Limit</th>
              <th>Forecast for the month</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {c.budgets.map((b) => (
              <tr key={b.projectId ?? 'organization'}>
                <td>{b.name}</td>
                <td>{usd(b.spentUsd)}</td>
                <td>{b.limitUsd == null ? <span className="muted">No limit</span> : usd(b.limitUsd)}</td>
                <td>
                  {usd(b.forecastUsd)} {b.forecastExceeds && b.state !== 'exceeded' && <Badge tone="warn">Over the limit at this rate</Badge>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  <BudgetBadge line={{ ...b, inputTokens: 0, outputTokens: 0 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      {!filter.projectId && (
        <TableCard title="By project" view="/cost" table="byProject" filter={filter} empty={none}>
          <SpendTable rows={c.byProject} label="Project" name={(r) => r.name} total={c.totals.costUsd} />
        </TableCard>
      )}
      <TableCard title="By model" view="/cost" table="byModel" filter={filter} empty={none}>
        <SpendTable rows={c.byModel} label="Model" name={(r) => `${r.providerId} · ${r.modelId}`} total={c.totals.costUsd} />
      </TableCard>
      <TableCard title="By agent" view="/cost" table="byAgent" filter={filter} empty={none}>
        <SpendTable rows={c.byAgent} label="Agent" name={(r) => r.agentId} total={c.totals.costUsd} />
      </TableCard>
      <TableCard title="Most expensive tasks" view="/cost" table="topTasks" filter={filter} empty={!c.topTasks.length && 'No task reported a cost in this period'}>
        <table className="table" aria-label="Most expensive tasks">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Cost</th>
              <th>Input tokens</th>
              <th>Output tokens</th>
            </tr>
          </thead>
          <tbody>
            {c.topTasks.map((t) => (
              <tr key={t.taskId}>
                <td>
                  <Link to={`/tasks/${t.taskId}`}>{t.title}</Link>
                </td>
                <td>
                  <TaskStatusBadge status={t.status as TaskStatus} />
                </td>
                <td>{usd(t.costUsd)}</td>
                <td>{compact(t.inputTokens)}</td>
                <td>{compact(t.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      <TableCard title="By kind of usage" view="/cost" table="byKind" filter={filter} empty={none}>
        <table className="table" aria-label="Spend by kind of usage">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Count</th>
              <th>Cost</th>
              <th>Agent time</th>
            </tr>
          </thead>
          <tbody>
            {c.byKind.map((k) => (
              <tr key={k.kind}>
                <td>{USAGE_KIND[k.kind] ?? k.kind}</td>
                <td>{count(k.count)}</td>
                <td>{usd(k.costUsd)}</td>
                <td>{k.durationMs ? dur(k.durationMs) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}

/** What each worker did, and how much of its time online it was working. */
export function WorkersView({ filter }: { filter: Filter }) {
  const { data: w } = useInsight<AnalyticsWorkersDto>('/workers', filter);
  if (!w) return loading('workers');
  const online = w.workers.filter((x) => x.onlineMs != null);
  const sum = (k: 'finished' | 'sessionMs' | 'costUsd' | 'stops') => w.workers.reduce((a, x) => a + x[k], 0);
  return (
    <>
      <div className="grid grid-stats">
        <Stat label="Workers" value={w.workers.filter((x) => x.status !== 'REMOVED').length} hint="Paired with this organization" />
        <Stat label="Finished tasks" value={count(sum('finished'))} />
        <Stat label="Agent time" value={dur(sum('sessionMs'))} hint="Time agents ran, all workers" />
        <Stat label="Cost" value={usd(sum('costUsd'))} />
        <Stat label="Stopped tasks" value={count(sum('stops'))} hint="Failed or waiting for recovery" attention={sum('stops') > 0} />
      </div>
      {w.workers.length > 0 && !online.length && <Alert tone="info">Time online is counted from the heartbeats of workers since this server was updated. It appears here once workers have been online in this period.</Alert>}
      <TableCard title="By worker" description="Utilization is agent time against the time online, for as many tasks as the worker runs at once." view="/workers" table="workers" filter={filter} empty={!w.workers.length && 'No workers yet'}>
        <table className="table" aria-label="Work by worker">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Finished</th>
              <th>Success</th>
              <th>First pass</th>
              <th>Agent time</th>
              <th>Online</th>
              <th>Utilization</th>
              <th>Cost</th>
              <th>Stopped</th>
            </tr>
          </thead>
          <tbody>
            {w.workers.map((x) => (
              <tr key={x.workerId}>
                <td>
                  {x.status === 'REMOVED' ? x.name : <Link to={`/workers/${x.workerId}`}>{x.name}</Link>} <WorkerStatusBadge status={x.status} />
                </td>
                <td>
                  {x.finished}
                  <span className="muted small"> ({x.failed} failed)</span>
                </td>
                <td>{pct(x.successRate)}</td>
                <td>{pct(x.firstPassRate)}</td>
                <td>{x.sessionMs ? dur(x.sessionMs) : '—'}</td>
                <td>{x.onlineMs == null ? '—' : `${dur(x.onlineMs)} (${pct(x.onlineShare)})`}</td>
                <td>{pct(x.utilization)}</td>
                <td>{usd(x.costUsd)}</td>
                <td>
                  {x.stops}
                  {x.workerLost > 0 && <span className="muted small"> ({x.workerLost} worker lost)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}

/** Why tasks stopped, how often agents needed rescuing, and which checks fail. */
export function ReliabilityView({ filter }: { filter: Filter }) {
  const { data: r } = useInsight<AnalyticsReliabilityDto>('/reliability', filter);
  if (!r) return loading('reliability');
  const t = r.totals;
  const none = !t.finished && NOTHING_FINISHED;
  return (
    <>
      <div className="grid grid-stats">
        <Stat label="Stopped tasks" value={count(t.stops)} hint="Failed or needed recovery in this period">
          <Delta value={t.stops} previous={t.previousStops} good="down" />
        </Stat>
        <Stat label="Still stopped" value={count(t.stillStopped)} hint="Failed or waiting for recovery now" attention={t.stillStopped > 0} />
        <Stat label="Recovered" value={count(t.recovered)} hint="Retried and completed since" />
        <Stat label="Provider limits hit" value={count(t.limitHits)} hint="In the tasks that finished" />
        <Stat label="Tasks that fell back" value={count(t.fallbacks)} hint="Finished on another agent or model than they started on" />
        <Stat label="Context resets" value={count(t.contextResets)} />
        <Stat label="Agent restarts" value={count(t.restarts)} />
        <Stat label="Fix rounds" value={count(t.remediations)} hint="Times an agent was sent back to fix failed checks" />
      </div>
      <Card title="Stopped tasks per day" description="Counted since this server was updated to record why a task stops.">
        {t.stops ? <DayChart label="Stopped tasks per day" days={r.daily} series={[{ key: 'stops', label: 'Stopped', color: FAILED }]} /> : <EmptyState title="No task stopped in this period" />}
      </Card>
      <TableCard title="Why tasks stopped" view="/reliability" table="byCategory" filter={filter} empty={!t.stops && 'No task stopped in this period'}>
        <table className="table" aria-label="Stopped tasks by reason">
          <thead>
            <tr>
              <th>Reason</th>
              <th>Stopped</th>
              <th>Share</th>
              <th>Still stopped</th>
              <th>Recovered</th>
            </tr>
          </thead>
          <tbody>
            {r.byCategory.map((c) => (
              <tr key={c.category}>
                <td>{FAILURE_CATEGORY_LABELS[c.category as FailureCategory] ?? c.category}</td>
                <td>{c.stops}</td>
                <td>{pct(c.stops / t.stops)}</td>
                <td>{c.stillStopped}</td>
                <td>{c.recovered}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      <TableCard title="Verification steps" description="Every run of a step in the tasks that finished or stopped in this period." view="/reliability" table="verificationSteps" filter={filter} empty={!r.verificationSteps.length && 'No verification ran in this period'}>
        <table className="table" aria-label="Verification steps">
          <thead>
            <tr>
              <th>Step</th>
              <th>Runs</th>
              <th>Failed</th>
              <th>Failure rate</th>
              <th>Average time</th>
            </tr>
          </thead>
          <tbody>
            {r.verificationSteps.map((s) => (
              <tr key={`${s.kind}:${s.name}`}>
                <td>
                  {s.name} <span className="muted small">{s.kind}</span>
                </td>
                <td>{s.runs}</td>
                <td>{s.failed}</td>
                <td>{pct(s.failureRate)}</td>
                <td>{dur(s.avgDurationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
      <TableCard title="Recoveries by agent" description="In the tasks that finished on each agent." view="/reliability" table="byAgent" filter={filter} empty={none}>
        <table className="table" aria-label="Recoveries by agent">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Finished</th>
              <th>Limits hit</th>
              <th>Fell back</th>
              <th>Context resets</th>
              <th>Restarts</th>
              <th>Fix rounds</th>
            </tr>
          </thead>
          <tbody>
            {r.byAgent.map((g) => (
              <tr key={g.agentId}>
                <td>{g.agentId}</td>
                <td>{g.finished}</td>
                <td>{g.limitHits}</td>
                <td>{g.fallbacks}</td>
                <td>{g.contextResets}</td>
                <td>{g.restarts}</td>
                <td>{g.remediations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableCard>
    </>
  );
}

const SOURCE: Record<string, string> = { manual: 'Created by a person', schedule: 'Schedule', github: 'GitHub', gitlab: 'GitLab', jira: 'Jira', linear: 'Linear', slack: 'Slack', webhook: 'Webhook' };

/** How long tasks wait and take, and who and what they come from. */
export function FlowView({ filter }: { filter: Filter }) {
  const { data: f } = useInsight<AnalyticsFlowDto>('/flow', filter);
  if (!f) return loading('flow');
  const none = !f.byKind.length && NOTHING_FINISHED;
  const times: Array<[string, string, AnalyticsFlowDto['times']['lead']]> = [
    ['Waiting to start', 'From creating the task to the first agent start', f.times.startWait],
    ['Agent and verification time', 'Time the task was being worked on', f.times.active],
    ['Created to completed', 'Everything, waiting for people included', f.times.lead],
  ];
  return (
    <>
      <Card title="Times of completed tasks" description={`${count(f.samples)} completed ${f.samples === 1 ? 'task' : 'tasks'}${f.capped ? ' (the most recent ones)' : ''}. Half of them took the median or less; nine in ten took the 90th percentile or less.`} padded={false}>
        {f.samples ? (
          <div className="table-wrap">
            <table className="table" aria-label="Times of completed tasks">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Median</th>
                  <th>90th percentile</th>
                  <th>Average</th>
                </tr>
              </thead>
              <tbody>
                {times.map(([label, hint, s]) => (
                  <tr key={label}>
                    <td>
                      {label}
                      <div className="muted small">{hint}</div>
                    </td>
                    <td>{dur(s.p50Ms)}</td>
                    <td>{dur(s.p90Ms)}</td>
                    <td>{dur(s.avgMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No completed tasks in this period" />
        )}
      </Card>
      <TableCard title="By creator" view="/flow" table="byCreator" filter={filter} empty={none}>
        <FiguresTable rows={f.byCreator} label="Creator" name={(r) => r.name} />
      </TableCard>
      <TableCard title="By source" view="/flow" table="bySource" filter={filter} empty={none}>
        <FiguresTable rows={f.bySource} label="Source" name={(r) => SOURCE[r.source] ?? r.source} />
      </TableCard>
      <TableCard title="By kind of task" view="/flow" table="byKind" filter={filter} empty={none}>
        <FiguresTable rows={f.byKind} label="Kind" name={(r) => humanize(r.kind.toUpperCase())} />
      </TableCard>
      <TableCard title="By priority" view="/flow" table="byPriority" filter={filter} empty={none}>
        <FiguresTable rows={f.byPriority} label="Priority" name={(r) => humanize(r.priority)} />
      </TableCard>
    </>
  );
}
