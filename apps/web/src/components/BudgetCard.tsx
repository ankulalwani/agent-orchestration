import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BudgetStatusDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@ao/ui';
import { ApiError, get, patch } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';

const usd = (n: number) => `$${n.toFixed(2)}`;
type Line = BudgetStatusDto['organization'];

export function useBudget() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['budget', orgId], queryFn: () => get<BudgetStatusDto>(`/orgs/${orgId}/budget`), refetchInterval: 60_000 });
}

export function BudgetBadge({ line }: { line: Line }) {
  if (line.limitUsd == null) return <span className="muted small">no limit</span>;
  return <Badge tone={line.state === 'exceeded' ? 'danger' : line.state === 'warning' ? 'warn' : 'ok'}>{Math.round((line.spentUsd / line.limitUsd) * 100)}%</Badge>;
}

const FIELDS = [
  { key: 'organizationMonthlyUsd', label: 'Organization, per month (US$)', hint: 'All projects together, calendar month (UTC)' },
  { key: 'projectMonthlyUsd', label: 'Each project, per month (US$)', hint: 'A project can set its own in its policy' },
  { key: 'taskUsd', label: 'Each task (US$)', hint: 'Over the whole life of a task' },
  { key: 'taskTokens', label: 'Each task (tokens)', hint: 'Input plus output tokens' },
] as const;
type Key = (typeof FIELDS)[number]['key'];

/** Spend limits of the organization's execution policy, with this month's spend. */
export function BudgetCard() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const budget = useBudget();
  const org = useQuery({ queryKey: ['org', orgId], queryFn: () => get<{ policy: { budget?: Partial<Record<Key | 'warnAt', number | null>> } & Record<string, unknown> }>(`/orgs/${orgId}`) });
  const [form, setForm] = useState<Record<Key, string>>({ organizationMonthlyUsd: '', projectMonthlyUsd: '', taskUsd: '', taskTokens: '' });
  const [warnAt, setWarnAt] = useState('80');
  useEffect(() => {
    const b = org.data?.policy?.budget ?? {};
    setForm({ organizationMonthlyUsd: String(b.organizationMonthlyUsd ?? ''), projectMonthlyUsd: String(b.projectMonthlyUsd ?? ''), taskUsd: String(b.taskUsd ?? ''), taskTokens: String(b.taskTokens ?? '') });
    setWarnAt(String(Math.round((b.warnAt ?? 0.8) * 100)));
  }, [org.data]);
  const save = useMutation({
    mutationFn: () => {
      const limit = (k: Key) => (form[k].trim() === '' ? null : Number(form[k]));
      // The whole policy is sent, as the Policy (JSON) card does: the server replaces it.
      return patch(`/orgs/${orgId}`, {
        policy: { ...(org.data?.policy ?? {}), budget: { organizationMonthlyUsd: limit('organizationMonthlyUsd'), projectMonthlyUsd: limit('projectMonthlyUsd'), taskUsd: limit('taskUsd'), taskTokens: limit('taskTokens'), warnAt: Number(warnAt) / 100 } },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['org', orgId] });
      void qc.invalidateQueries({ queryKey: ['budget', orgId] });
    },
  });
  if (budget.isLoading || org.isLoading) return <Spinner />;
  const b = budget.data;
  const editable = can('policy.manage');
  const spending = b?.projects.filter((p) => p.spentUsd > 0 || p.limitUsd != null) ?? [];

  return (
    <Card title="Spend budget" actions={editable && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Limits on what agents and AI providers report as spent. A task that reaches a limit stops before its next agent session and waits for you (Recovery required); queued tasks wait until the limit is raised or the month ends. Empty means no limit.
        </p>
        {save.error && <Alert tone="danger">{(save.error as ApiError).message}</Alert>}
        {save.isSuccess && <Alert>Budget saved.</Alert>}
        {b && (
          <table className="table" aria-label="Spend this month">
            <thead>
              <tr><th>This month</th><th>Spent</th><th>Limit</th><th /></tr>
            </thead>
            <tbody>
              <tr>
                <td>Organization</td>
                <td>{usd(b.organization.spentUsd)}</td>
                <td>{b.organization.limitUsd == null ? '—' : usd(b.organization.limitUsd)}</td>
                <td style={{ textAlign: 'right' }}><BudgetBadge line={b.organization} /></td>
              </tr>
              {spending.map((p) => (
                <tr key={p.projectId}>
                  <td className="small">{p.name}</td>
                  <td className="small">{usd(p.spentUsd)}</td>
                  <td className="small">{p.limitUsd == null ? '—' : usd(p.limitUsd)}</td>
                  <td style={{ textAlign: 'right' }}><BudgetBadge line={p} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="grid grid-2">
          {FIELDS.map((f) => (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {(id) => <Input id={id} type="number" min={0} step={f.key === 'taskTokens' ? 1000 : 0.01} disabled={!editable} value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />}
            </Field>
          ))}
          <Field label="Warn at (% of a monthly limit)" hint="Owners and administrators get one notice per month">
            {(id) => <Input id={id} type="number" min={0} max={100} disabled={!editable} value={warnAt} onChange={(e) => setWarnAt(e.target.value)} />}
          </Field>
        </div>
      </div>
    </Card>
  );
}
