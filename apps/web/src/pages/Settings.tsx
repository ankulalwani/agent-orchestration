import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AddMemberResponse, InvitationDto, MemberDto } from '@ao/contracts';
import { ROLES, canAssignRole, type Role } from '@ao/core/shared';
import { KeyRound } from 'lucide-react';
import { Alert, Badge, Button, Card, Check, CopyButton, EmptyState, Field, Input, Select, Spinner, Tabs, Textarea } from '@ao/ui';
import QRCode from 'qrcode';
import { useSearchParams } from 'react-router-dom';
import { OAUTH_ERRORS, useOAuthProviders } from './Auth';
import { ApiError, del, get, patch, post, put, refreshSession } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { humanize } from '../lib/format';
import { PageHeader } from '../Layout';
import { Integrations } from './Integrations';
import { GitHubSettings } from './GitHubSettings';
import { ResetMfaDialog } from '../components/ResetMfaDialog';

type Tab = 'general' | 'members' | 'policy' | 'secrets' | 'github' | 'integrations' | 'account';

interface Org {
  id: string;
  name: string;
  slug: string;
  policy: Record<string, unknown>;
  knowledge: string;
  settings: { requireWorkerApproval: boolean; retentionDays: { events: number; agentOutput: number; audit: number } };
}

export function SettingsPage() {
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (['account', 'github'].includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'general'));
  const { can } = useSession();
  return (
    <div className="stack max-w-[1080px]">
      <PageHeader title="Settings" description="Your organization, its people and policy, and your own account." />
      <Tabs
        label="Settings sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'general', label: 'Organization' },
          { id: 'members', label: 'Members' },
          ...(can('policy.manage') ? [{ id: 'policy' as const, label: 'Execution policy' }] : []),
          { id: 'github' as const, label: 'GitHub' },
          ...(can('settings.manage') ? [{ id: 'secrets' as const, label: 'Secrets' }, { id: 'integrations' as const, label: 'Integrations' }] : []),
          { id: 'account', label: 'Your account' },
        ]}
      />
      {tab === 'general' && <General />}
      {tab === 'members' && <Members />}
      {tab === 'policy' && <Policy />}
      {tab === 'secrets' && <Secrets />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'github' && <GitHubSettings />}
      {tab === 'account' && (
        <>
          <ConnectedAccounts />
          <TwoFactor />
          <ApiTokens />
        </>
      )}
    </div>
  );
}

/** Sign-in providers (OAuth / OpenID Connect) connected to the signed-in user's account. */
function ConnectedAccounts() {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const providers = useOAuthProviders();
  const user = session!.user;
  const linked = user.identities ?? [];
  const connect = useMutation({
    mutationFn: (provider: string) => post<{ url: string }>(`/me/oauth/${provider}/link`),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const disconnect = useMutation({
    mutationFn: (provider: string) => del(`/me/identities/${provider}`),
    onSuccess: () => void refreshSession(),
  });
  // Result of returning from the provider: show it once, then clean the URL.
  const [notice] = useState(() => {
    const ok = params.get('linked');
    const bad = params.get('oauthError');
    return ok ? { tone: 'info' as const, text: `Connected ${providers.find((p) => p.id === ok)?.name ?? ok}.` } : bad ? { tone: 'danger' as const, text: OAUTH_ERRORS[bad] ?? OAUTH_ERRORS.provider_error } : null;
  });
  useEffect(() => {
    if (params.has('linked') || params.has('oauthError')) {
      setParams({ tab: 'account' }, { replace: true });
      void refreshSession();
    }
    // Once, for the parameters we arrived with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!providers.length && !linked.length) return null;
  const nameOf = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
  const err = connect.error ?? disconnect.error;

  return (
    <Card title="Connected accounts" padded={false}>
      <div className="card-body stack">
        {notice && <Alert tone={notice.tone === 'danger' ? 'danger' : undefined}>{notice.text}</Alert>}
        {err && <Alert tone="danger">{(err as ApiError).message}</Alert>}
        <p className="small muted">
          Sign in with these instead of your password.{user.hasPassword === false && ' You have no password yet; to set one, use "Forgot password" on the sign-in page.'}
        </p>
      </div>
      <table className="table">
        <tbody>
          {[...new Set([...providers.map((p) => p.id), ...linked.map((l) => l.provider)])].map((id) => {
            const link = linked.find((l) => l.provider === id);
            return (
              <tr key={id}>
                <td>
                  <span className="font-medium">{nameOf(id)}</span> {link ? <Badge tone="ok">connected</Badge> : <Badge>not connected</Badge>}
                  {link?.email && <div className="small muted">{link.email}</div>}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {link ? (
                    <Button size="sm" variant="danger" loading={disconnect.isPending && disconnect.variables === id} onClick={() => confirm(`Disconnect ${nameOf(id)}?`) && disconnect.mutate(id)}>
                      Disconnect
                    </Button>
                  ) : providers.some((p) => p.id === id) ? (
                    <Button size="sm" loading={connect.isPending && connect.variables === id} onClick={() => connect.mutate(id)}>
                      Connect
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

/** Two-factor authentication for the signed-in user (TOTP authenticator app + recovery codes). */
function TwoFactor() {
  const { session } = useSession();
  const enabled = Boolean(session!.user.mfaEnabled);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const start = useMutation({
    mutationFn: async () => {
      const r = await post<{ secret: string; otpauthUrl: string }>('/me/mfa/setup');
      return { ...r, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 200 }) };
    },
    onSuccess: (r) => {
      setSetup(r);
      setCode('');
    },
  });
  const enable = useMutation({
    mutationFn: () => post<{ recoveryCodes: string[] }>('/me/mfa/enable', { code }),
    onSuccess: async (r) => {
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await refreshSession();
    },
  });
  const disable = useMutation({
    mutationFn: () => post('/me/mfa/disable', { password, code }),
    onSuccess: async () => {
      setPassword('');
      setCode('');
      setRecoveryCodes(null);
      await refreshSession();
    },
  });
  const err = start.error ?? enable.error ?? disable.error;

  return (
    <Card title="Two-factor authentication">
      <div className="stack" style={{ maxWidth: 560 }}>
        {err && <Alert tone="danger">{(err as ApiError).message}</Alert>}
        {recoveryCodes && (
          <Alert>
            <div className="stack">
              <strong>Save these recovery codes now. They are shown only once.</strong>
              <span>Each one signs you in once if you lose your authenticator.</span>
              <pre aria-label="Recovery codes" className="log w-fit columns-2 gap-8 !text-[13px] !text-fg">{recoveryCodes.join('\n')}</pre>
            </div>
          </Alert>
        )}
        {enabled ? (
          <>
            <p className="flex items-center gap-2"><Badge tone="ok">on</Badge> <span>On. Signing in asks for a code from your authenticator app.</span></p>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                disable.mutate();
              }}
            >
              <div className="grid grid-2">
                <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
                <Field label="Authentication or recovery code">{(id) => <Input id={id} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
              </div>
              <div>
                <Button variant="danger" type="submit" loading={disable.isPending}>Turn off two-factor authentication</Button>
              </div>
            </form>
          </>
        ) : setup ? (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              enable.mutate();
            }}
          >
            <p>Scan this code with an authenticator app (for example 1Password, Google Authenticator or Microsoft Authenticator), then enter the 6-digit code it shows.</p>
            <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} className="rounded-md border border-line bg-white p-1" />
            <div className="small muted">
              Can't scan? Enter this key: <code aria-label="Setup key">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            </div>
            <Field label="6-digit code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <div className="row">
              <Button variant="primary" type="submit" loading={enable.isPending}>Turn on</Button>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <>
            <p>Off. Add a second step to signing in: a code from an authenticator app on your phone.</p>
            <div>
              <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()}>Set up two-factor authentication</Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function useOrg() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['org', orgId], queryFn: () => get<Org>(`/orgs/${orgId}`) });
}

function General() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const org = useOrg();
  const [name, setName] = useState('');
  const [knowledge, setKnowledge] = useState('');
  const [approval, setApproval] = useState(false);
  const [retention, setRetention] = useState({ events: 180, agentOutput: 30, audit: 730 });
  useEffect(() => {
    if (!org.data) return;
    setName(org.data.name);
    setKnowledge(org.data.knowledge ?? '');
    setApproval(org.data.settings.requireWorkerApproval);
    setRetention(org.data.settings.retentionDays);
  }, [org.data]);
  const save = useMutation({
    mutationFn: () => patch(`/orgs/${orgId}`, { name, knowledge, ...(can('settings.manage') ? { settings: { requireWorkerApproval: approval, retentionDays: retention } } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId] }),
  });
  if (org.isLoading) return <Spinner />;
  const editable = can('org.update');
  return (
    <Card title="Organization" actions={editable && <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <div className="stack" style={{ maxWidth: 560 }}>
        {save.error && <Alert tone="danger">{(save.error as ApiError).message}</Alert>}
        {save.isSuccess && <Alert>Saved.</Alert>}
        <Field label="Name">{(id) => <Input id={id} value={name} disabled={!editable} onChange={(e) => setName(e.target.value)} />}</Field>
        <Check checked={approval} disabled={!can('settings.manage')} onChange={(e) => setApproval(e.target.checked)}>
          Newly paired workers need admin approval before they receive tasks
        </Check>
        <div className="grid grid-2">
          <Field label="Keep task events (days)">{(id) => <Input id={id} type="number" min={1} value={retention.events} disabled={!can('settings.manage')} onChange={(e) => setRetention({ ...retention, events: Number(e.target.value) })} />}</Field>
          <Field label="Keep agent output (days)">{(id) => <Input id={id} type="number" min={1} value={retention.agentOutput} disabled={!can('settings.manage')} onChange={(e) => setRetention({ ...retention, agentOutput: Number(e.target.value) })} />}</Field>
          <Field label="Keep audit log (days)" hint="Minimum 30">{(id) => <Input id={id} type="number" min={30} value={retention.audit} disabled={!can('settings.manage')} onChange={(e) => setRetention({ ...retention, audit: Number(e.target.value) })} />}</Field>
        </div>
        <p className="small muted">Data older than these periods is purged hourly. Active task data is never deleted.</p>
        <Field label="Organization knowledge" hint="Given to agents in every task of this organization, before project and task knowledge: conventions, coding standards, how to reach internal services. No secrets: use Secrets for those.">
          {(id) => <Textarea id={id} rows={8} maxLength={50_000} value={knowledge} disabled={!editable} onChange={(e) => setKnowledge(e.target.value)} />}
        </Field>
      </div>
    </Card>
  );
}

function Members() {
  const orgId = useOrgId();
  const { can, org, session } = useSession();
  const qc = useQueryClient();
  const members = useQuery({ queryKey: ['members', orgId], queryFn: () => get<MemberDto[]>(`/orgs/${orgId}/members`) });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('DEVELOPER');
  const invitations = useQuery({ queryKey: ['invitations', orgId], queryFn: () => get<InvitationDto[]>(`/orgs/${orgId}/invitations`) });
  const [invited, setInvited] = useState<{ email: string; url: string } | null>(null);
  const [resetting, setResetting] = useState<MemberDto | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['members', orgId] });
    void qc.invalidateQueries({ queryKey: ['invitations', orgId] });
  };
  const add = useMutation({
    mutationFn: () => post<AddMemberResponse>(`/orgs/${orgId}/members`, { email, role }),
    onSuccess: (r) => {
      setInvited(r.status === 'invited' && r.inviteUrl ? { email: r.invitation!.email, url: r.inviteUrl } : null);
      setEmail('');
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/orgs/${orgId}/invitations/${id}`), onSuccess: refresh });
  const change = useMutation({ mutationFn: (v: { userId: string; role: Role }) => patch(`/orgs/${orgId}/members/${v.userId}`, { role: v.role }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (userId: string) => del(`/orgs/${orgId}/members/${userId}`), onSuccess: refresh });
  const err = add.error ?? change.error ?? remove.error ?? revoke.error;
  const myRole = org!.role;
  const assignable = ROLES.filter((r) => canAssignRole(myRole, r));

  return (
    <div className="stack">
      {err && <Alert tone="danger">{(err as ApiError).message}</Alert>}
      {can('member.invite') && (
        <Card title="Add or invite a member">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-[220px] flex-1">
              <Field label="Email" hint="People without an account receive an invitation link by email">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            </div>
            <Field label="Role" className="w-40">
              {(id) => (
                <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  {assignable.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
                </Select>
              )}
            </Field>
            <Button variant="primary" className="mt-[23px]" loading={add.isPending} disabled={!email} onClick={() => add.mutate()}>Add</Button>
          </div>
          {invited && (
            <div className="mt-3 flex flex-col gap-3">
              <Alert>
                Invitation sent to {invited.email}. If this server doesn't send email, share this link with them. It works once and expires in 7 days.
              </Alert>
              <div className="row">
                <Input aria-label="Invitation link" readOnly className="mono flex-1" value={invited.url} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton value={invited.url} label="Copy link" />
              </div>
            </div>
          )}
        </Card>
      )}
      {(invitations.data?.length ?? 0) > 0 && (
        <Card title="Pending invitations" padded={false}>
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Expires</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {invitations.data!.map((i) => (
                <tr key={i.id}>
                  <td>{i.email}<div className="small muted">Invited by {i.invitedByName}</div></td>
                  <td>{humanize(i.role)}</td>
                  <td className="small">{new Date(i.expiresAt).toLocaleDateString()}</td>
                  <td style={{ textAlign: 'right' }}>
                    {can('member.invite') && <Button size="sm" variant="danger" onClick={() => confirm(`Revoke the invitation for ${i.email}?`) && revoke.mutate(i.id)}>Revoke</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {resetting && (
        <ResetMfaDialog
          person={resetting}
          path={`/orgs/${orgId}/members/${resetting.userId}/reset-mfa`}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            refresh();
          }}
        />
      )}
      <Card title="Members" padded={false}>
        {members.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <tr key={m.userId}>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <span className="grid size-7 flex-none place-items-center rounded-sm bg-surface-3 text-xs font-semibold text-fg-2" aria-hidden="true">{(m.name || m.email).charAt(0).toUpperCase()}</span>
                      <div className="min-w-0">
                        <span className="font-medium">{m.name}</span>{m.userId === session!.user.id && <span className="muted"> (you)</span>}
                        <div className="small muted">{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {can('member.update_role') && m.userId !== session!.user.id && canAssignRole(myRole, m.role) ? (
                      <Select className="!w-40" aria-label={`Role for ${m.name}`} value={m.role} onChange={(e) => change.mutate({ userId: m.userId, role: e.target.value as Role })}>
                        {assignable.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
                      </Select>
                    ) : (
                      humanize(m.role)
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {can('member.remove') && m.userId !== session!.user.id && m.mfaEnabled && !m.inOtherOrganizations && canAssignRole(myRole, m.role) && (
                      <Button size="sm" onClick={() => setResetting(m)}>Reset two-factor</Button>
                    )}{' '}
                    {can('member.remove') && m.userId !== session!.user.id && <Button size="sm" variant="danger" onClick={() => confirm(`Remove ${m.name}?`) && remove.mutate(m.userId)}>Remove</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Policy() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const org = useOrg();
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  useEffect(() => {
    if (org.data) setText(JSON.stringify(org.data.policy ?? {}, null, 2));
  }, [org.data]);
  const save = useMutation({ mutationFn: (policy: unknown) => patch(`/orgs/${orgId}`, { policy }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['org', orgId] }) });
  return (
    <Card
      title="Organization execution policy"
      actions={
        <Button
          variant="primary"
          loading={save.isPending}
          onClick={() => {
            try {
              setParseError(null);
              save.mutate(JSON.parse(text));
            } catch {
              setParseError('Invalid JSON');
            }
          }}
        >
          Save
        </Button>
      }
    >
      <div className="stack">
        <p className="muted max-w-[90ch]">
          Defaults for every project and task. Projects, workers and tasks can override these. Examples: <code>{'{"fallback":{"chain":[{"kind":"FALLBACK_AGENT","agentId":"codex"},{"kind":"WAIT"}]}}'}</code>,{' '}
          <code>{'{"concurrency":{"perProject":2}}'}</code>, <code>{'{"git":{"policy":"PULL_REQUEST"}}'}</code>.
        </p>
        {save.error && <Alert tone="danger">{(save.error as ApiError).message}</Alert>}
        {save.isSuccess && <Alert>Policy saved.</Alert>}
        <Field label="Policy (JSON)" error={parseError}>{(id) => <Textarea id={id} rows={18} className="mono" value={text} onChange={(e) => setText(e.target.value)} />}</Field>
      </div>
    </Card>
  );
}

function Secrets() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const secrets = useQuery({ queryKey: ['secrets', orgId], queryFn: () => get<Array<{ name: string; masked: string; updatedAt: string }>>(`/orgs/${orgId}/secrets`) });
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['secrets', orgId] });
  const save = useMutation({ mutationFn: () => put(`/orgs/${orgId}/secrets/${name}`, { value }), onSuccess: () => { setName(''); setValue(''); refresh(); } });
  const remove = useMutation({ mutationFn: (n: string) => del(`/orgs/${orgId}/secrets/${n}`), onSuccess: refresh });
  return (
    <div className="stack">
      <Alert>Secrets are encrypted at rest and only ever shown masked. Reference them from capability configuration as <code>secret:NAME</code>. AI provider keys belong on workers, not here.</Alert>
      {(save.error || remove.error) && <Alert tone="danger">{((save.error ?? remove.error) as ApiError).message}</Alert>}
      <Card title="Add or replace a secret">
        <div className="flex flex-wrap items-start gap-2">
          <Field label="Name" hint="UPPER_SNAKE_CASE" className="w-56">{(id) => <Input id={id} className="mono" value={name} onChange={(e) => setName(e.target.value.toUpperCase())} />}</Field>
          <div className="min-w-[220px] flex-1">
            <Field label="Value">{(id) => <Input id={id} type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
          </div>
          <Button variant="primary" className="mt-[23px]" disabled={!name || !value} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </Card>
      <Card title="Secrets" padded={false}>
        {secrets.data?.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Value</th><th>Updated</th><th /></tr>
              </thead>
              <tbody>
                {secrets.data.map((s) => (
                  <tr key={s.name}>
                    <td><code>{s.name}</code></td>
                    <td className="mono">{s.masked}</td>
                    <td className="small muted">{new Date(s.updatedAt).toLocaleString()}</td>
                    <td className="text-right"><Button size="sm" variant="danger" onClick={() => confirm(`Delete ${s.name}?`) && remove.mutate(s.name)}>Delete</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={KeyRound} title="No secrets">Add one above, then reference it from a capability as <code>secret:NAME</code>.</EmptyState>
        )}
      </Card>
    </div>
  );
}

interface ApiTokenRow {
  id: string;
  name: string;
  organizationId: string;
  role: Role;
  prefix: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** Personal API tokens for the CLI in CI, scripts and IDE extensions. */
function ApiTokens() {
  const { session, org } = useSession();
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => get<ApiTokenRow[]>('/me/tokens') });
  const [form, setForm] = useState({ name: '', organizationId: org?.organizationId ?? '', role: (org?.role ?? 'DEVELOPER') as Role, expiresInDays: '90' });
  const [created, setCreated] = useState<string | null>(null);
  const memberships = session?.memberships ?? [];
  const current = memberships.find((m) => m.organizationId === form.organizationId);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['api-tokens'] });
  const create = useMutation({
    mutationFn: () => post<{ token: string }>('/me/tokens', { name: form.name, organizationId: form.organizationId, role: form.role, expiresInDays: form.expiresInDays ? Number(form.expiresInDays) : null }),
    onSuccess: (r) => {
      setCreated(r.token);
      setForm({ ...form, name: '' });
      refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => del(`/me/tokens/${id}`), onSuccess: refresh });
  const orgName = (id: string) => memberships.find((m) => m.organizationId === id)?.organizationName ?? id;
  return (
    <Card title="API tokens">
      <div className="stack">
        <p className="small muted max-w-[90ch]">
          For scripts, CI and IDE extensions: <code>AO_SERVER</code>, <code>AO_TOKEN</code> and <code>AO_ORG</code> with <code>agentctl</code>, or <code>Authorization: Bearer …</code> with the API. A token works in one organization with the role you choose (never more than your own), and can't manage tokens, sign-in or the server.
        </p>
        {(create.error || revoke.error) && <Alert tone="danger">{((create.error ?? revoke.error) as ApiError).message}</Alert>}
        {created && (
          <Alert>
            Copy this token now; it won't be shown again: <code className="break-all">{created}</code> <CopyButton value={created} label="Copy token" className="!size-5 align-middle" />
          </Alert>
        )}
        <div className="grid grid-2">
          <Field label="Name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="CI pipeline" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Organization">
            {(id) => (
              <Select id={id} value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value, role: (memberships.find((m) => m.organizationId === e.target.value)?.role ?? 'VIEWER') as Role })}>
                {memberships.map((m) => <option key={m.organizationId} value={m.organizationId}>{m.organizationName}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Role" hint="At most your role in that organization">
            {(id) => (
              <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
                {ROLES.filter((r) => current && ROLES.indexOf(r) >= ROLES.indexOf(current.role as Role)).map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Expires after (days)" hint="Empty: never">{(id) => <Input id={id} type="number" min={1} max={3650} value={form.expiresInDays} onChange={(e) => setForm({ ...form, expiresInDays: e.target.value })} />}</Field>
        </div>
        <div><Button variant="primary" disabled={!form.name.trim() || !form.organizationId} loading={create.isPending} onClick={() => create.mutate()}>Create token</Button></div>
        {tokens.data && tokens.data.length > 0 && (
          <div className="table-wrap -mx-4 -mb-4 border-t border-line"><table className="table" aria-label="API tokens">
            <thead>
              <tr><th>Name</th><th>Organization</th><th>Role</th><th>Last used</th><th>Expires</th><th /></tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}<div className="mono small muted">{t.prefix}…</div></td>
                  <td>{orgName(t.organizationId)}</td>
                  <td>{humanize(t.role)}</td>
                  <td className="small">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : 'never'}</td>
                  <td className="small">{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : 'never'}</td>
                  <td style={{ textAlign: 'right' }}><Button size="sm" variant="danger" onClick={() => confirm(`Revoke "${t.name}"? Anything using it stops working.`) && revoke.mutate(t.id)}>Revoke</Button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </Card>
  );
}
