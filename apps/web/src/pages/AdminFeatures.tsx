import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '@ao/ui';
import { ApiError, get, put } from '../lib/api';
import { PageHeader } from '../Layout';

interface Flag {
  key: string;
  name: string;
  description: string;
  stage: 'stable' | 'beta' | 'experimental';
  defaultEnabled: boolean;
  enabled: boolean | null;
  forcedByEnvironment: boolean;
  effective: boolean;
  organizations: Array<{ organizationId: string; name: string; enabled: boolean }>;
}
interface FlagList {
  flags: Flag[];
  unknownEnvironmentFlags: string[];
}

const toValue = (v: boolean | null) => (v === null ? 'default' : v ? 'on' : 'off');
const fromValue = (v: string) => (v === 'default' ? null : v === 'on');

function FlagCard({ flag }: { flag: Flag }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [orgId, setOrgId] = useState('');
  const set = useMutation({
    mutationFn: (x: { enabled: boolean | null; organizationId?: string }) =>
      put<FlagList>(x.organizationId ? `/admin/features/${flag.key}/orgs/${x.organizationId}` : `/admin/features/${flag.key}`, { enabled: x.enabled }),
    onSuccess: (list) => qc.setQueryData(['admin-features'], list),
  });
  const orgs = useQuery({
    queryKey: ['admin-orgs', search],
    queryFn: () => get<Array<{ id: string; name: string; slug: string }>>(`/admin/organizations${search ? `?q=${encodeURIComponent(search)}` : ''}`),
  });
  const available = (orgs.data ?? []).filter((o) => !flag.organizations.some((x) => x.organizationId === o.id));
  return (
    <Card
      title={
        <span className="row">
          {flag.name}
          {flag.stage !== 'stable' && <Badge tone="warn">{flag.stage}</Badge>}
          <Badge tone={flag.effective ? 'ok' : 'neutral'}>{flag.effective ? 'on' : 'off'}</Badge>
        </span>
      }
    >
      <div className="stack">
        <p className="small">{flag.description}</p>
        <p className="small muted">
          <code>{flag.key}</code> · default {flag.defaultEnabled ? 'on' : 'off'}
        </p>
        {set.error && <Alert tone="danger">{(set.error as ApiError).message}</Alert>}
        {flag.forcedByEnvironment ? (
          <Alert tone="warn">Turned on for every organization by the FEATURE_FLAGS environment variable. Remove it there to control this flag here.</Alert>
        ) : (
          <>
            <Field label="For all organizations">
              {(id) => (
                <Select id={id} style={{ maxWidth: 280 }} value={toValue(flag.enabled)} onChange={(e) => set.mutate({ enabled: fromValue(e.target.value) })} disabled={set.isPending}>
                  <option value="default">Default ({flag.defaultEnabled ? 'on' : 'off'})</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              )}
            </Field>
            <div>
              <strong className="small">Organization exceptions</strong>
              {flag.organizations.length === 0 && <p className="small muted">None: every organization uses the setting above.</p>}
              {flag.organizations.length > 0 && (
                <table className="table" aria-label={`${flag.name} organization exceptions`}>
                  <tbody>
                    {flag.organizations.map((o) => (
                      <tr key={o.organizationId}>
                        <td>{o.name}</td>
                        <td style={{ width: 90 }}><Badge tone={o.enabled ? 'ok' : 'neutral'}>{o.enabled ? 'on' : 'off'}</Badge></td>
                        <td style={{ width: 200, textAlign: 'right' }}>
                          <Button size="sm" onClick={() => set.mutate({ enabled: !o.enabled, organizationId: o.organizationId })}>Turn {o.enabled ? 'off' : 'on'}</Button>{' '}
                          <Button size="sm" variant="ghost" onClick={() => set.mutate({ enabled: null, organizationId: o.organizationId })}>Remove</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                <Input aria-label="Search organizations" placeholder="Search organizations" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
                <Select aria-label="Organization" value={orgId} onChange={(e) => setOrgId(e.target.value)} style={{ maxWidth: 240 }}>
                  <option value="">Choose an organization…</option>
                  {available.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </Select>
                <Button size="sm" disabled={!orgId} onClick={() => set.mutate({ enabled: true, organizationId: orgId }, { onSuccess: () => setOrgId('') })}>Turn on</Button>
                <Button size="sm" disabled={!orgId} onClick={() => set.mutate({ enabled: false, organizationId: orgId }, { onSuccess: () => setOrgId('') })}>Turn off</Button>
              </div>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

/** Feature flags for platform administrators (CORE-010): for everyone, with per-organization exceptions. */
export function AdminFeaturesPage() {
  const q = useQuery({ queryKey: ['admin-features'], queryFn: () => get<FlagList>('/admin/features') });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert tone="danger">{(q.error as ApiError).message}</Alert>;
  const { flags, unknownEnvironmentFlags } = q.data!;
  return (
    <div className="stack">
      <PageHeader title="Feature flags" description="Turn features on or off for all organizations, with exceptions for single organizations. Changes apply within a few seconds and are audited." />
      {unknownEnvironmentFlags.length > 0 && <Alert tone="warn">FEATURE_FLAGS names flags this version does not know: {unknownEnvironmentFlags.join(', ')}.</Alert>}
      {flags.map((f) => (
        <FlagCard key={f.key} flag={f} />
      ))}
    </div>
  );
}
