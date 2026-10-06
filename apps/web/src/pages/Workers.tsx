import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Server } from 'lucide-react';
import type { WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, KeyValue, Select, Skeleton, SlotMeter, Spinner, Stat, StatStrip, cn, timeAgo } from '@ao/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { WorkerStatusBadge } from '../lib/format';
import { PageHeader } from '../Layout';
import { InstallWorkerCard } from '../InstallWorker';

const gb = (mb: number | null | undefined) => (mb == null ? '?' : mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${mb} MB`);

/** A horizontal load bar; turns amber, then red, as it fills. */
function Load({ percent }: { percent: number | null | undefined }) {
  if (percent == null) return <span className="text-fg-3">—</span>;
  const v = Math.max(0, Math.min(100, percent));
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
        <span className={cn('block h-full rounded-full', v >= 90 ? 'bg-danger' : v >= 70 ? 'bg-warn' : 'bg-fg-3')} style={{ width: `${v}%` }} />
      </span>
      <span className="w-8 font-mono text-xs text-fg-2">{Math.round(v)}%</span>
    </span>
  );
}

export function WorkersPage() {
  const orgId = useOrgId();
  const nav = useNavigate();
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), refetchInterval: 30_000 });
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Workers"
        description="Machines that execute tasks. Workers connect outbound; no inbound ports are needed."
        actions={
          <Button asChild variant="primary">
            <Link to="/pair"><Link2 aria-hidden="true" />Pair with a code</Link>
          </Button>
        }
      />
      <Card padded={false}>
        {workers.isLoading ? (
          <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading workers…">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}
          </div>
        ) : workers.data?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Tasks</th>
                  <th className="hide-mobile">Agents</th>
                  <th className="hide-mobile">CPU</th>
                  <th className="hide-mobile">RAM free</th>
                  <th className="text-right">Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {workers.data.map((w) => (
                  <tr key={w.id} className="clickable" onClick={() => nav(`/workers/${w.id}`)}>
                    <td>
                      <Link to={`/workers/${w.id}`}>{w.name}</Link>
                      <div className="text-xs text-fg-3">{w.os} · {w.hostname}</div>
                    </td>
                    <td><WorkerStatusBadge status={w.status} /></td>
                    <td className="whitespace-nowrap">
                      <SlotMeter used={w.activeTaskIds.length} max={w.maxConcurrentTasks} offline={w.status !== 'ONLINE'} />
                      <span className="ml-2 font-mono text-xs text-fg-2">{w.activeTaskIds.length}/{w.maxConcurrentTasks}</span>
                    </td>
                    <td className="hide-mobile text-xs text-fg-2">{w.agents.filter((a) => a.installed).map((a) => a.id).join(', ') || '—'}</td>
                    <td className="hide-mobile"><Load percent={w.metrics?.cpuLoadPercent} /></td>
                    <td className="hide-mobile num font-mono text-xs text-fg-2">{w.metrics ? gb(w.metrics.freeMemoryMb) : '—'}</td>
                    <td className="num text-right text-xs text-fg-3">{timeAgo(w.lastHeartbeatAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={Server} title="No workers yet">Install the worker on a machine with your code and AI agents (desktop app or command, below), then approve it here.</EmptyState>
        )}
      </Card>
      {!workers.isLoading && <InstallWorkerCard />}
    </div>
  );
}

export function WorkerDetailPage() {
  const { workerId } = useParams();
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const nav = useNavigate();
  const worker = useQuery({ queryKey: ['worker', orgId, workerId], queryFn: () => get<WorkerDto>(`/orgs/${orgId}/workers/${workerId}`), refetchInterval: 20_000 });
  const [labels, setLabels] = useState<string | null>(null);
  const update = useMutation({ mutationFn: (b: Record<string, unknown>) => patch<WorkerDto>(`/orgs/${orgId}/workers/${workerId}`, b), onSuccess: () => void qc.invalidateQueries({ queryKey: ['worker', orgId, workerId] }) });
  const approve = useMutation({ mutationFn: () => post(`/orgs/${orgId}/workers/${workerId}/approve`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['worker', orgId, workerId] }) });
  const revoke = useMutation({ mutationFn: () => del(`/orgs/${orgId}/workers/${workerId}`), onSuccess: () => nav('/workers') });

  if (worker.isLoading) return <Spinner label="Loading worker…" />;
  const w = worker.data;
  if (!w) return <EmptyState icon={Server} title="Worker not found" action={<Link to="/workers">Back to workers</Link>} />;
  const err = update.error ?? approve.error ?? revoke.error;
  const m = w.metrics;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        crumb={<Link to="/workers">Workers</Link>}
        title={w.name}
        description={`${w.os} · ${w.arch} · ${w.hostname} · worker v${w.version}`}
        actions={
          <>
            {w.status === 'PENDING_APPROVAL' && can('worker.approve') && <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>Approve worker</Button>}
            {can('worker.manage') && <Button variant="danger" onClick={() => confirm('Revoke this worker? Its credential stops working immediately; running tasks are recovered on another worker.') && revoke.mutate()}>Revoke</Button>}
          </>
        }
      />
      {err && <Alert tone="danger">{(err as ApiError).message}</Alert>}

      <StatStrip>
        <Stat label="Status" value={<span className="block leading-7"><WorkerStatusBadge status={w.status} /></span>}>
          heartbeat {timeAgo(w.lastHeartbeatAt)}{w.latencyMs !== null ? `, ${w.latencyMs} ms` : ''}
        </Stat>
        <Stat label="Task slots" value={<span className="text-[15px] leading-7">{w.activeTaskIds.length} of {w.maxConcurrentTasks} in use</span>}>
          <SlotMeter used={w.activeTaskIds.length} max={w.maxConcurrentTasks} offline={w.status !== 'ONLINE'} />
        </Stat>
        <Stat label="CPU" value={<span className="text-[15px] leading-7">{m?.cpuLoadPercent != null ? `${m.cpuLoadPercent}%` : '—'}</span>}>{m ? `${m.cpuCount} cores` : null}</Stat>
        <Stat label="Memory free" value={<span className="text-[15px] leading-7">{m ? gb(m.freeMemoryMb) : '—'}</span>}>
          {m ? `of ${gb(m.totalMemoryMb)}${m.freeDiskMb != null ? `, disk ${gb(m.freeDiskMb)} free` : ''}` : null}
        </Stat>
      </StatStrip>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card title="Running here">
          <KeyValue
            items={[
              ['Active tasks', w.activeTaskIds.length ? w.activeTaskIds.map((t) => <div key={t}><Link to={`/tasks/${t}`} className="font-mono text-xs">{t}</Link></div>) : 'None'],
              ['Tools', w.tools.join(', ') || null],
              ['Labels', w.labels.length ? <span className="row !gap-1">{w.labels.map((l) => <Badge key={l} plain>{l}</Badge>)}</span> : null],
            ]}
          />
        </Card>
        <Card title="Scheduling">
          <div className="stack">
            <Field label="Maximum concurrent tasks">
              {(id) => (
                <Select id={id} className="!w-24" value={w.maxConcurrentTasks} disabled={!can('worker.manage')} onChange={(e) => update.mutate({ maxConcurrentTasks: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Labels" hint="Comma separated. Tasks can require labels to pick this worker.">
              {(id) => (
                <div className="flex gap-2">
                  <Input id={id} value={labels ?? w.labels.join(', ')} disabled={!can('worker.manage')} onChange={(e) => setLabels(e.target.value)} />
                  {can('worker.manage') && <Button onClick={() => update.mutate({ labels: (labels ?? '').split(',').map((s) => s.trim()).filter(Boolean) })}>Save</Button>}
                </div>
              )}
            </Field>
          </div>
        </Card>
      </div>

      <Card title="Agents" padded={false}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Installed</th>
                <th>Providers</th>
                <th className="hide-mobile">Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {w.agents.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="font-medium">{a.name}</span>
                    {a.notes.length > 0 && <div className="text-xs text-fg-3">{a.notes.join(' · ')}</div>}
                  </td>
                  <td>{a.installed ? <Badge tone="ok">{a.version ?? 'yes'}</Badge> : <Badge>not installed</Badge>}</td>
                  <td className="text-xs text-fg-2">{a.supportedProviders.join(', ')}</td>
                  <td className="hide-mobile text-xs text-fg-3">{a.capabilities.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="AI providers" padded={false}>
        {w.providers.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Health</th>
                  <th>Credential</th>
                  <th>Models</th>
                </tr>
              </thead>
              <tbody>
                {w.providers.map((p) => (
                  <tr key={p.id}>
                    <td><span className="font-medium">{p.name}</span><div className="text-xs text-fg-3">{p.kind}</div></td>
                    <td>{p.limited ? <Badge tone="warn">limited{p.limitedUntil ? ` until ${new Date(p.limitedUntil).toLocaleTimeString()}` : ''}</Badge> : p.healthy ? <Badge tone="ok">healthy</Badge> : <Badge tone="danger">unhealthy</Badge>}{p.error && <div className="mt-0.5 text-xs text-fg-3">{p.error}</div>}</td>
                    <td className="mono">{p.credentialMasked ?? '—'}</td>
                    <td className="mono text-fg-2">{p.models.map((m) => m.id).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No models reported by this worker">Agents run on their own login once installed. Add-on models are added in the worker's local UI (AI models); keys stay on the worker.</EmptyState>
        )}
      </Card>
    </div>
  );
}

/** Device-code approval (spec §13): the worker shows a code; the user confirms it here. */
export function PairPage() {
  const [params] = useSearchParams();
  const { session, org } = useSession();
  const nav = useNavigate();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [orgId, setOrgId] = useState(org?.organizationId ?? '');
  const [name, setName] = useState('');
  const valid = /^[A-Za-z]{4}-\d{4}$/.test(code.trim());
  const pending = useQuery({ queryKey: ['pairing', code], queryFn: () => get<{ name: string; hostname: string; os: string; version: string }>(`/pairing/${encodeURIComponent(code.trim().toUpperCase())}`), enabled: valid, retry: false });
  const approve = useMutation({
    mutationFn: () => post<WorkerDto>('/pairing/approve', { userCode: code.trim().toUpperCase(), organizationId: orgId, name: name || undefined }),
    onSuccess: (w) => nav(`/workers/${w.id}`),
  });
  const deny = useMutation({ mutationFn: () => post('/pairing/deny', { userCode: code.trim().toUpperCase(), organizationId: orgId }) });

  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <PageHeader crumb={<Link to="/workers">Workers</Link>} title="Pair a worker" description="The desktop app and the install command open this page with the code filled in. You can also enter a code by hand." />
      <Card>
        <div className="stack">
          <Field label="Pairing code" hint="Shown by the worker, e.g. ABCD-1234">{(id) => <Input id={id} className="code-block" value={code} maxLength={9} autoComplete="off" spellCheck={false} onChange={(e) => setCode(e.target.value.toUpperCase())} />}</Field>
          {valid && pending.isLoading && <Spinner label="Looking up code…" />}
          {valid && pending.error && <Alert tone="danger">That code was not found or has expired. Restart pairing on the worker.</Alert>}
          {pending.data && (
            <Alert>
              You are approving <strong>{pending.data.name}</strong> ({pending.data.hostname}, {pending.data.os}, v{pending.data.version}). Only approve machines you control.
            </Alert>
          )}
          {session!.memberships.length > 1 && (
            <Field label="Organization">
              {(id) => (
                <Select id={id} value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                  {session!.memberships.map((m) => <option key={m.organizationId} value={m.organizationId}>{m.organizationName}</option>)}
                </Select>
              )}
            </Field>
          )}
          <Field label="Worker name" hint="Optional">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={pending.data?.name} />}</Field>
          {(approve.error || deny.error) && <Alert tone="danger">{((approve.error ?? deny.error) as ApiError).message}</Alert>}
          {deny.isSuccess && <Alert>Pairing denied.</Alert>}
          <div className="row">
            <Button variant="primary" disabled={!pending.data} loading={approve.isPending} onClick={() => approve.mutate()}>Approve worker</Button>
            <Button disabled={!pending.data} onClick={() => deny.mutate()}>Deny</Button>
          </div>
        </div>
      </Card>
      <InstallWorkerCard />
    </div>
  );
}
