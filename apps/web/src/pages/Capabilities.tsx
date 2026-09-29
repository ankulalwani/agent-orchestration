import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Select, Spinner, Tabs, Textarea, type Tone } from '@ao/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { PageHeader } from '../Layout';

interface Capability {
  id: string;
  capabilityId: string;
  organizationId: string | null;
  version: string;
  type: string;
  name: string;
  description: string;
  publisher: string;
  trust: string;
  permissions: string[];
  private: boolean;
}
interface Installation {
  id: string;
  capabilityId: string;
  version: string;
  scope: string;
  projectId: string | null;
  enabled: boolean;
  status: string;
  approvalReasons: string[];
}

const TRUST_TONE: Record<string, Tone> = { OFFICIAL: 'ok', VERIFIED: 'ok', LOCAL: 'info', COMMUNITY: 'warn', UNVERIFIED: 'danger' };
const EXAMPLE = `{
  "id": "company-react-standards",
  "name": "Company React Standards",
  "version": "1.0.0",
  "type": "skill",
  "description": "Our React conventions.",
  "compatibleAgents": [],
  "permissions": ["filesystem.project.read"],
  "skill": { "instructions": "Use function components, hooks, and our design tokens." }
}`;

/** Capability registry for this installation (spec §32–§40). No external marketplace is involved. */
export function CapabilitiesPage() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'installed' | 'registry'>('installed');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [manifest, setManifest] = useState(EXAMPLE);
  const [installing, setInstalling] = useState<Capability | null>(null);
  const [scope, setScope] = useState<'ORGANIZATION' | 'PROJECT'>('ORGANIZATION');
  const [projectId, setProjectId] = useState('');

  const caps = useQuery({ queryKey: ['capabilities', orgId], queryFn: () => get<Capability[]>(`/orgs/${orgId}/capabilities`) });
  const installs = useQuery({ queryKey: ['installations', orgId], queryFn: () => get<Installation[]>(`/orgs/${orgId}/capability-installations`) });
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['capabilities', orgId] });
    void qc.invalidateQueries({ queryKey: ['installations', orgId] });
  };
  const register = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/capabilities`, { manifest: JSON.parse(manifest), private: true }),
    onSuccess: () => {
      setRegisterOpen(false);
      refresh();
    },
  });
  const install = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/capability-installations`, { capabilityId: installing!.capabilityId, version: installing!.version, scope, projectId: scope === 'PROJECT' ? projectId : undefined }),
    onSuccess: () => {
      setInstalling(null);
      setTab('installed');
      refresh();
    },
  });
  const approve = useMutation({ mutationFn: (id: string) => post(`/orgs/${orgId}/capability-installations/${id}/approve`), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (i: Installation) => patch(`/orgs/${orgId}/capability-installations/${i.id}`, { enabled: !i.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => del(`/orgs/${orgId}/capability-installations/${id}`), onSuccess: refresh });
  const err = register.error ?? install.error ?? approve.error ?? toggle.error ?? remove.error;
  const projectName = (id: string | null) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : '');

  return (
    <div className="stack">
      <PageHeader
        title="Capabilities"
        description="Skills, MCP servers, plugins and integrations owned by this installation. Private capabilities never leave your server."
        actions={can('capability.manage') && <Button variant="primary" onClick={() => setRegisterOpen(true)}>Register capability</Button>}
      />
      {err && <Alert tone="danger">{err instanceof ApiError ? `${err.message}${err.context?.reasons ? `: ${(err.context.reasons as string[]).join('; ')}` : ''}` : 'Invalid manifest JSON'}</Alert>}
      <Tabs label="Capability views" value={tab} onChange={setTab} tabs={[{ id: 'installed', label: 'Installed' }, { id: 'registry', label: 'Registry' }]} />
      {tab === 'installed' && (
        <Card padded={false}>
          {installs.isLoading ? (
            <div className="card-body"><Spinner /></div>
          ) : installs.data?.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th>Scope</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {installs.data.map((i) => (
                  <tr key={i.id}>
                    <td>{i.capabilityId} <span className="muted small">v{i.version}</span></td>
                    <td className="small">{i.scope === 'PROJECT' ? `Project: ${projectName(i.projectId)}` : 'Organization'}</td>
                    <td>
                      <Badge tone={i.status === 'ACTIVE' ? (i.enabled ? 'ok' : 'neutral') : 'warn'}>{i.status === 'ACTIVE' ? (i.enabled ? 'Active' : 'Disabled') : 'Pending approval'}</Badge>
                      {i.approvalReasons.length > 0 && <div className="small muted">{i.approvalReasons.join(' · ')}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {i.status === 'PENDING_APPROVAL' && can('capability.manage') && <Button size="sm" variant="primary" onClick={() => approve.mutate(i.id)}>Approve</Button>}
                        {i.status === 'ACTIVE' && can('capability.install') && <Button size="sm" onClick={() => toggle.mutate(i)}>{i.enabled ? 'Disable' : 'Enable'}</Button>}
                        {can('capability.install') && <Button size="sm" variant="danger" onClick={() => remove.mutate(i.id)}>Uninstall</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="Nothing installed" action={<Button onClick={() => setTab('registry')}>Browse registry</Button>} />
          )}
        </Card>
      )}
      {tab === 'registry' && (
        <div className="grid grid-2">
          {caps.data?.length ? (
            caps.data.map((c) => (
              <Card key={c.id} title={c.name} actions={<Badge tone={TRUST_TONE[c.trust] ?? 'neutral'}>{c.trust.toLowerCase()}</Badge>}>
                <div className="stack">
                  <div className="row small">
                    <Badge tone="accent">{c.type}</Badge>
                    <span className="muted">v{c.version} · {c.publisher}{c.organizationId === null ? ' · platform' : c.private ? ' · private' : ''}</span>
                  </div>
                  {c.description && <p style={{ margin: 0 }}>{c.description}</p>}
                  <div className="small">
                    <strong>Permissions:</strong> {c.permissions.length ? c.permissions.map((p) => <code key={p} style={{ marginRight: 6 }}>{p}</code>) : 'none'}
                  </div>
                  {can('capability.install') && <div><Button size="sm" onClick={() => setInstalling(c)}>Install…</Button></div>}
                </div>
              </Card>
            ))
          ) : (
            <EmptyState title="The registry is empty">Register your own skills, MCP servers, plugins and integrations. Nothing is fetched from external marketplaces.</EmptyState>
          )}
        </div>
      )}

      <Dialog open={registerOpen} title="Register capability" onClose={() => setRegisterOpen(false)} footer={<><Button onClick={() => setRegisterOpen(false)}>Cancel</Button><Button variant="primary" loading={register.isPending} onClick={() => register.mutate()}>Register</Button></>}>
        <Field label="Manifest (JSON)" hint="Declares type, version, compatibility, permissions and configuration. Secret settings must be references like secret:NAME.">
          {(id) => <Textarea id={id} rows={16} className="mono" value={manifest} onChange={(e) => setManifest(e.target.value)} />}
        </Field>
      </Dialog>

      <Dialog open={!!installing} title={`Install ${installing?.name ?? ''}`} onClose={() => setInstalling(null)} footer={<><Button onClick={() => setInstalling(null)}>Cancel</Button><Button variant="primary" loading={install.isPending} disabled={scope === 'PROJECT' && !projectId} onClick={() => install.mutate()}>Install</Button></>}>
        <div className="stack">
          {installing && (
            <Alert tone={installing.permissions.some((p) => ['shell', 'secrets.read', 'process.execute', 'browser.control'].includes(p)) ? 'warn' : 'info'}>
              Publisher <strong>{installing.publisher}</strong>, trust <strong>{installing.trust}</strong>. Requests: {installing.permissions.join(', ') || 'no permissions'}. Organization policy may require approval.
            </Alert>
          )}
          <Field label="Scope">
            {(id) => (
              <Select id={id} value={scope} onChange={(e) => setScope(e.target.value as 'ORGANIZATION' | 'PROJECT')}>
                <option value="ORGANIZATION">Whole organization</option>
                <option value="PROJECT">One project</option>
              </Select>
            )}
          </Field>
          {scope === 'PROJECT' && (
            <Field label="Project">
              {(id) => (
                <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Choose…</option>
                  {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
            </Field>
          )}
        </div>
      </Dialog>
    </div>
  );
}
