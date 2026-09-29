import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkerDto } from '@ao/contracts';
import { Badge, Card, EmptyState, Spinner } from '@ao/ui';
import { get } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';

function useWorkers() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), refetchInterval: 30_000 });
}

/** Agents across all workers (spec §52). Agents are configured on each worker; this is the fleet view. */
export function AgentsPage() {
  const workers = useWorkers();
  if (workers.isLoading) return <Spinner />;
  const ids = [...new Set((workers.data ?? []).flatMap((w) => w.agents.map((a) => a.id)))];
  return (
    <div className="stack">
      <PageHeader title="Agents" description="Coding agents detected on your workers. The platform is agent-neutral: any installed, compatible agent can run a task." />
      {!ids.length && <EmptyState title="No agents reported" action={<Link to="/workers">View workers</Link>}>Agents appear once a worker connects and detects them.</EmptyState>}
      {ids.map((id) => {
        const rows = (workers.data ?? []).map((w) => ({ w, a: w.agents.find((x) => x.id === id) })).filter((r) => r.a);
        const first = rows[0]!.a!;
        return (
          <Card key={id} title={first.name} actions={<Badge tone={rows.some((r) => r.a!.installed) ? 'ok' : 'neutral'}>{rows.filter((r) => r.a!.installed).length} of {rows.length} workers</Badge>} padded={false}>
            <table className="table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Installed</th>
                  <th>Authenticated</th>
                  <th className="hide-mobile">Capabilities</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ w, a }) => (
                  <tr key={w.id}>
                    <td><Link to={`/workers/${w.id}`}>{w.name}</Link></td>
                    <td>{a!.installed ? <Badge tone="ok">{a!.version ?? 'yes'}</Badge> : <Badge>no</Badge>}</td>
                    <td className="small">{a!.authenticated === true ? 'yes' : a!.authenticated === false ? 'no' : 'checked on first run'}</td>
                    <td className="hide-mobile small muted">{a!.capabilities.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-body small muted">Drives providers: {first.supportedProviders.join(', ')}{first.notes.length ? ` · ${first.notes.join(' · ')}` : ''}</div>
          </Card>
        );
      })}
    </div>
  );
}

/** Providers across workers (spec §51). Credentials never leave workers; only masked values are shown. */
export function ProvidersPage() {
  const workers = useWorkers();
  if (workers.isLoading) return <Spinner />;
  const rows = (workers.data ?? []).flatMap((w) => w.providers.map((p) => ({ w, p })));
  return (
    <div className="stack">
      <PageHeader
        title="AI models"
        description="Tasks run on each harness's own login by default (for example a Claude subscription). Add-on models are optional: when a harness reaches its usage limit, tasks can continue on them. Add them in each worker's local UI → AI models; keys never leave the worker."
      />
      <Card padded={false}>
        {rows.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Worker</th>
                  <th>Status</th>
                  <th className="hide-mobile">Credential</th>
                  <th className="hide-mobile">Models</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ w, p }) => (
                  <tr key={`${w.id}-${p.id}`}>
                    <td>
                      {p.name} {p.kind === 'native' ? <Badge>own login</Badge> : <Badge tone="info">add-on</Badge>}
                      {p.kind !== 'native' && <div className="muted small">{p.kind}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</div>}
                    </td>
                    <td><Link to={`/workers/${w.id}`}>{w.name}</Link></td>
                    <td>
                      {p.limited ? <Badge tone="warn">Limited</Badge> : p.healthy ? <Badge tone="ok">Healthy</Badge> : <Badge tone="danger">Unhealthy</Badge>}
                      {p.limited && <div className="small muted">{p.limitedUntil ? `until ${new Date(p.limitedUntil).toLocaleString()}` : 'reset time unknown'}</div>}
                      {p.error && !p.limited && <div className="small muted">{p.error}</div>}
                    </td>
                    <td className="hide-mobile mono small">{p.credentialMasked ?? '—'}</td>
                    <td className="hide-mobile small">{p.kind === 'native' ? "the harness's own choice" : p.models.map((m) => m.id).join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No harnesses reported">Install a harness such as Claude Code on a worker. Add-on models (OpenRouter, NVIDIA NIM, Groq, DeepSeek, OpenAI, Gemini, Ollama, LM Studio or any OpenAI-compatible API) are added in the worker's local UI → AI models.</EmptyState>
        )}
      </Card>
    </div>
  );
}
