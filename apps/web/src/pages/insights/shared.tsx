import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import type { AnalyticsDto } from '@ao/contracts';
import { Button, Card, EmptyState, formatDuration } from '@ao/ui';
import { download, get } from '../../lib/api';
import { useOrgId } from '../../lib/session';

/** What every Insights view is asked for: a period, and one project or all of them. */
export interface Filter {
  days: number;
  projectId: string;
}
export type View = '' | '/cost' | '/workers' | '/reliability' | '/flow';

export const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const usd = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);
export const dur = (v: number | null) => (v == null ? '—' : formatDuration(v));
export const count = (v: number) => v.toLocaleString();
/** Token counts, shortened: 1.2M, 34k. */
export const compact = (v: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v);
export const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

const query = (f: Filter) => `days=${f.days}${f.projectId ? `&projectId=${f.projectId}` : ''}`;

export function useInsight<T>(view: View, filter: Filter) {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['analytics', view, orgId, filter.days, filter.projectId], queryFn: () => get<T>(`/orgs/${orgId}/analytics${view}?${query(filter)}`), refetchInterval: 60_000 });
}

/** Downloads one table of a view as a CSV file. */
export function CsvButton({ view, table, filter }: { view: View; table: string; filter: Filter }) {
  const orgId = useOrgId();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await download(`/orgs/${orgId}/analytics${view}?${query(filter)}&format=csv&table=${table}`, `insights${view.replace('/', '-')}-${table}-${filter.days}d.csv`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="ghost" size="sm" loading={busy} onClick={() => void save()} aria-label={`Download ${table} as CSV`}>
      <Download size={14} aria-hidden /> CSV
    </Button>
  );
}

/** A card holding one table of a view, with its CSV download. */
export function TableCard({ title, description, view, table, filter, empty, children }: { title: string; description?: string; view: View; table: string; filter: Filter; /** Shown instead of the table. */ empty?: string | false; children: ReactNode }) {
  return (
    <Card title={title} description={description} padded={false} actions={empty ? undefined : <CsvButton view={view} table={table} filter={filter} />}>
      {empty ? <EmptyState title={empty} /> : <div className="table-wrap">{children}</div>}
    </Card>
  );
}

/**
 * The change against the period before, under a figure. `good` says which direction is an improvement;
 * `points` compares rates as percentage points. Nothing is shown without an earlier value to compare with.
 */
export function Delta({ value, previous, good, points }: { value: number | null; previous: number | null; good: 'up' | 'down'; points?: boolean }) {
  if (value == null || previous == null || (!points && previous === 0)) return null;
  const change = points ? (value - previous) * 100 : ((value - previous) / previous) * 100;
  const rounded = Math.round(change);
  if (rounded === 0) return <span>No change from the period before</span>;
  const better = (rounded > 0) === (good === 'up');
  return (
    <span>
      <span className={better ? 'text-ok' : 'text-danger'}>
        {rounded > 0 ? '▲' : '▼'} {Math.abs(rounded)}
        {points ? ' pts' : '%'}
      </span>{' '}
      from the period before
    </span>
  );
}

/** A round number at or above `n` for the top of the axis. */
function niceMax(n: number, whole: boolean) {
  if (whole && n <= 4) return 4;
  if (n <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(n));
  return [1, 2, 4, 5, 10].map((m) => m * step).find((m) => m >= n)!;
}

export interface Series<K extends string> {
  key: K;
  label: string;
  /** A CSS color; the series colors are in app.css. */
  color: string;
}

/** Values per day as stacked columns, the first series at the bottom. The tables hold the same figures. */
export function DayChart<K extends string, D extends { date: string } & Record<K, number>>({ label, days, series, format = count, tick = format, whole = true, note }: { label: string; days: D[]; series: Array<Series<K>>; format?: (v: number) => string; /** Axis labels, when the full format is too wide for the margin. */ tick?: (v: number) => string; /** Counts: the axis never goes below 4. */ whole?: boolean; /** A last line of the tooltip. */ note?: (d: D) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(...days.map((d) => series.reduce((a, s) => a + d[s.key], 0))), whole);
  // Few enough date labels that they fit a phone-width chart.
  const labelEvery = Math.ceil(days.length / 5);
  const line = (d: D) => series.map((s) => `${format(d[s.key])} ${s.label.toLowerCase()}`);
  return (
    <figure className="chart" aria-label={label}>
      {series.length > 1 && (
        <div className="chart-legend small">
          {series.map((s) => (
            <span key={s.key}>
              <i className="chart-key" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="chart-plot">
        {[1, 0.5, 0].map((f) => (
          <div key={f} className="chart-grid" style={{ bottom: `${f * 100}%` }}>
            <span className="chart-tick small muted">{tick(top * f)}</span>
          </div>
        ))}
        <div className="chart-columns">
          {days.map((d, i) => (
            <div key={d.date} className="chart-slot" tabIndex={0} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${day(d.date)}: ${[...line(d), ...(note ? [note(d)] : [])].join(', ')}`}>
              <div className="chart-stack">
                {[...series].reverse().map((s) => d[s.key] > 0 && <div key={s.key} className="chart-bar" style={{ height: `${(d[s.key] / top) * 100}%`, background: s.color }} />)}
              </div>
              {hover === i && (
                <div className="chart-tooltip small" role="tooltip" style={i > days.length / 2 ? { right: 0 } : { left: 0 }}>
                  <strong>{day(d.date)}</strong>
                  {line(d).map((l) => (
                    <span key={l}>{l}</span>
                  ))}
                  {note && <span className="muted">{note(d)}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="chart-axis small muted">
        {days.map((d, i) => (
          <span key={d.date} className="chart-slot">
            {i % labelEvery === 0 ? day(d.date) : ''}
          </span>
        ))}
      </div>
    </figure>
  );
}

type Figures = Omit<AnalyticsDto['totals'], 'created'>;

/** The outcome figures of finished tasks, one row per agent, project, creator, … */
export function FiguresTable<T extends Figures>({ rows, label, name }: { rows: T[]; label: string; name: (r: T) => ReactNode }) {
  return (
    <table className="table" aria-label={`Outcomes by ${label.toLowerCase()}`}>
      <thead>
        <tr>
          <th>{label}</th>
          <th>Finished</th>
          <th>Success</th>
          <th>First pass</th>
          <th>Fixes per task</th>
          <th>Cost per completed</th>
          <th>Agent time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{name(r)}</td>
            <td>
              {r.finished}
              <span className="muted small"> ({r.failed} failed)</span>
            </td>
            <td>{pct(r.successRate)}</td>
            <td>{pct(r.firstPassRate)}</td>
            <td>{r.avgRemediations.toFixed(1)}</td>
            <td>{usd(r.costPerCompletedUsd)}</td>
            <td>{dur(r.avgActiveMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const NOTHING_FINISHED = 'No finished tasks in this period';
