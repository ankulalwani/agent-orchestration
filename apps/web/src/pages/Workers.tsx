import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkerDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, KeyValue, Select, Spinner, timeAgo } from '@ao/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { WorkerStatusBadge } from '../lib/format';
import { PageHeader } from '../Layout';

export function WorkersPage() {
  const orgId = useOrgId();
  const nav = useNavigate();
  const workers = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), refetchInterval: 30_000 });
  return (
    <div>
      <PageHeader title="Workers" description="Machines that execute tasks. Workers connect outbound; no inbound ports are needed." actions={<Link className="btn btn-primary" to="/pair">Pair a worker</Link>} />
      <Card padded={false}>
        {workers.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : workers.data?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Status</th>
                  <th>Tasks</th>
                  <th className="hide-mobile">Agents</th>
                  <th className="hide-mobile">CPU / RAM free</th>
                  <th>Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {workers.data.map((w) => (
                  <tr key={w.id} className="clickable" onClick={() => nav(`/workers/${w.id}`)}>
                    <td>
                      <Link to={`/workers/${w.id}`}>{w.name}</Link>
                      <div className="muted small">{w.os} · {w.hostname}</div>
                    </td>
                    <td><WorkerStatusBadge status={w.status} /></td>
                    <td>{w.activeTaskIds.length}/{w.maxConcurrentTasks}</td>
                    <td className="hide-mobile small">{w.agents.filter((a) => a.installed).map((a) => a.id).join(', ') || '—'}</td>
                    <td className="hide-mobile small">{w.metrics?.cpuLoadPercent ?? '?'}% · {w.metrics?.freeMemoryMb ?? '?'} MB</td>
                    <td className="small muted">{timeAgo(w.lastHeartbeatAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No workers yet" action={<Link to="/pair">Pair your first worker</Link>}>Install the worker on a machine with your code and AI agents, then pair it here.</EmptyState>
        )}
      </Card>
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

  if (worker.isLoading) return <Spinner />;
  const w = worker.data;
  if (!w) return <EmptyState title="Worker not found" />;
  const err = update.error ?? approve.error ?? revoke.error;

  return (
    <div className="stack">
      <PageHeader
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
      <div className="grid grid-2">
        <Card title="Status">
          <KeyValue
            items={[
              ['Status', <WorkerStatusBadge key="s" status={w.status} />],
              ['Last heartbeat', `${timeAgo(w.lastHeartbeatAt)}${w.latencyMs !== null ? ` · ${w.latencyMs} ms` : ''}`],
              ['CPU', w.metrics ? `${w.metrics.cpuLoadPercent ?? '?'}% of ${w.metrics.cpuCount} cores` : null],
              ['Memory free', w.metrics ? `${w.metrics.freeMemoryMb} / ${w.metrics.totalMemoryMb} MB` : null],
              ['Disk free', w.metrics?.freeDiskMb != null ? `${w.metrics.freeDiskMb} MB` : null],
              ['Active tasks', w.activeTaskIds.length ? w.activeTaskIds.map((t) => <div key={t}><Link to={`/tasks/${t}`}>{t}</Link></div>) : 'None'],
              ['Tools', w.tools.join(', ') || null],
            ]}
          />
        </Card>
        <Card title="Scheduling">
          <div className="stack">
            <Field label="Maximum concurrent tasks">
              {(id) => (
                <Select id={id} value={w.maxConcurrentTasks} disabled={!can('worker.manage')} onChange={(e) => update.mutate({ maxConcurrentTasks: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Labels" hint="Comma separated. Tasks can require labels to pick this worker.">
              {(id) => (
                <div className="row">
                  <Input id={id} value={labels ?? w.labels.join(', ')} disabled={!can('worker.manage')} onChange={(e) => setLabels(e.target.value)} />
                  {can('worker.manage') && <Button size="sm" onClick={() => update.mutate({ labels: (labels ?? '').split(',').map((s) => s.trim()).filter(Boolean) })}>Save</Button>}
                </div>
              )}
            </Field>
          </div>
        </Card>
      </div>
      <Card title="Agents" padded={false}>
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
                  {a.name}
                  {a.notes.length > 0 && <div className="muted small">{a.notes.join(' · ')}</div>}
                </td>
                <td>{a.installed ? <Badge tone="ok">{a.version ?? 'yes'}</Badge> : <Badge>not installed</Badge>}</td>
                <td className="small">{a.supportedProviders.join(', ')}</td>
                <td className="hide-mobile small muted">{a.capabilities.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="AI providers" padded={false}>
        {w.providers.length ? (
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
                  <td>{p.name}<div className="muted small">{p.kind}</div></td>
                  <td>{p.limited ? <Badge tone="warn">limited{p.limitedUntil ? ` until ${new Date(p.limitedUntil).toLocaleTimeString()}` : ''}</Badge> : p.healthy ? <Badge tone="ok">healthy</Badge> : <Badge tone="danger">unhealthy</Badge>}{p.error && <div className="muted small">{p.error}</div>}</td>
                  <td className="mono small">{p.credentialMasked ?? '—'}</td>
                  <td className="small">{p.models.map((m) => m.id).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
    <div className="stack" style={{ maxWidth: 560 }}>
      <PageHeader title="Pair a worker" description="Install the worker, choose this server, and enter the code it shows." />
      <Card>
        <div className="stack">
          <Field label="Pairing code" hint="Shown by the worker, e.g. ABCD-1234">{(id) => <Input id={id} className="code-block" value={code} maxLength={9} onChange={(e) => setCode(e.target.value.toUpperCase())} />}</Field>
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
      <Card title="Install the worker">
        <p className="muted" style={{ marginTop: 0 }}>Run the installer for your OS on the machine that has your code and AI agents. See the self-hosting guide for full instructions.</p>
        <pre className="log">{`# Windows (PowerShell)\n.\\installers\\windows\\install-worker.ps1\n\n# macOS\n./installers/macos/install-worker.sh\n\n# Linux\n./installers/linux/install-worker.sh`}</pre>
      </Card>
    </div>
  );
}
