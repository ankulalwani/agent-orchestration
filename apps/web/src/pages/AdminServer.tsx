import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Dialog, Field, Input, Select, Spinner } from '@ao/ui';
import { ApiError, get, patch } from '../lib/api';
import { PageHeader } from '../Layout';

interface Setting {
  key: string;
  group: string;
  value: string | number | boolean | null;
  secret: boolean;
  source: 'environment' | 'admin' | 'default';
  editable: boolean;
}
interface Overview {
  version: string;
  node: string;
  deploymentMode: string;
  status: Record<string, { ok: boolean; detail: string }>;
  settings: Setting[];
  settingsUpdatedAt: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  database: 'Database',
  queue: 'Dispatch queue',
  email: 'Email',
  artifacts: 'Artifacts',
  signIn: 'Sign-in',
  errorTracking: 'Error tracking',
  keyRotation: 'Encryption keys',
};
const GROUP_ORDER = ['General', 'Security', 'Database & queue', 'Email', 'Storage', 'Sign-in', 'Observability', 'Limits & scheduling', 'Other'];
const SOURCE_LABELS: Record<Setting['source'], string> = { environment: 'environment', admin: 'set here', default: 'default' };
const BOOLEAN_KEYS = /^(ALLOW_REGISTRATION|REQUIRE_EMAIL_VERIFICATION|EXPO_PUSH_ENABLED|TELEMETRY_ENABLED)$/;
/** URLs that may carry a password: shown masked, so a change needs the full value again. */
const URL_WITH_CREDENTIALS = /^(SMTP_URL|ERROR_TRACKING_DSN|ERROR_TRACKING_WEBHOOK_URL)$/;

function show(s: Setting) {
  if (s.value === null) return <span className="muted">not set</span>;
  if (s.secret) return <Badge tone="neutral">{String(s.value)}</Badge>;
  if (typeof s.value === 'boolean') return s.value ? 'true' : 'false';
  return <code>{String(s.value)}</code>;
}

function EditSetting({ setting, onClose }: { setting: Setting; onClose: () => void }) {
  const qc = useQueryClient();
  const hidden = setting.secret || URL_WITH_CREDENTIALS.test(setting.key);
  const [value, setValue] = useState(hidden || setting.value === null ? '' : String(setting.value));
  const save = useMutation({
    mutationFn: (v: string | null) => patch<Overview>('/admin/server/settings', { values: { [setting.key]: v } }),
    onSuccess: (o) => {
      qc.setQueryData(['admin-server'], o);
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={`Change ${setting.key}`}
      onClose={onClose}
      footer={
        <>
          {setting.source === 'admin' && (
            <Button variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending}>
              Reset to default
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={hidden && !value} onClick={() => save.mutate(value)}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        {save.error && <Alert tone="danger">{(save.error as ApiError).message}</Alert>}
        <Field label="Value" hint={hidden ? 'The current value is not shown. Enter the complete new value.' : 'Leave empty to use the default.'}>
          {(id) =>
            BOOLEAN_KEYS.test(setting.key) ? (
              <Select id={id} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="true">true</option>
                <option value="false">false</option>
              </Select>
            ) : (
              <Input id={id} type={setting.secret ? 'password' : 'text'} autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder={hidden && setting.value !== null ? 'Enter a new value' : ''} />
            )
          }
        </Field>
        <p className="small muted">The change applies at once, on every instance of the control plane within a few seconds. It is recorded in the audit log (without the value).</p>
      </div>
    </Dialog>
  );
}

/** Server configuration for platform administrators (SELFHOST-002): status, every setting, and editing where allowed. */
export function AdminServerPage() {
  const q = useQuery({ queryKey: ['admin-server'], queryFn: () => get<Overview>('/admin/server') });
  const [editing, setEditing] = useState<Setting | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert tone="danger">{(q.error as ApiError).message}</Alert>;
  const o = q.data!;
  const groups = GROUP_ORDER.map((g) => [g, o.settings.filter((s) => s.group === g)] as const).filter(([, list]) => list.length);
  return (
    <div className="stack">
      <PageHeader title="Server settings" description={`Agent Orchestration ${o.version}, ${o.deploymentMode}.`} />
      <Alert>
        Settings with a <strong>Change</strong> button can be managed here and apply without a restart. An environment variable always takes precedence: to manage such a setting here, remove it from the server's environment. All other settings come from environment variables only and need a restart (see the self-hosting guide). Secrets are shown only as set or not set.
      </Alert>
      <Card title="Status" padded={false}>
        <div className="table-wrap"><table className="table" aria-label="Server status">
          <tbody>
            {Object.entries(o.status).map(([k, s]) => (
              <tr key={k}>
                <td style={{ width: 180 }}>{STATUS_LABELS[k] ?? k}</td>
                <td style={{ width: 110 }}><Badge tone={s.ok ? 'ok' : 'warn'}>{s.ok ? 'ok' : 'attention'}</Badge></td>
                <td className="small">{s.detail}</td>
              </tr>
            ))}
            <tr>
              <td>Version</td>
              <td />
              <td className="small">Agent Orchestration {o.version} · Node.js {o.node} · {o.deploymentMode}</td>
            </tr>
          </tbody>
        </table></div>
      </Card>
      {groups.map(([group, list]) => (
        <Card key={group} title={group} padded={false}>
          <div className="table-wrap"><table className="table min-w-[640px] table-fixed">
            <thead>
              <tr>
                <th className="w-[34%]">Variable</th>
                <th>Value</th>
                <th className="w-[120px]">Source</th>
                <th className="w-[100px]" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.key}>
                  <td><code>{s.key}</code></td>
                  <td className="break-all">{show(s)}</td>
                  <td className="small muted">{SOURCE_LABELS[s.source]}</td>
                  <td className="text-right">
                    {s.editable && s.source !== 'environment' && (
                      <Button size="sm" onClick={() => setEditing(s)} aria-label={`Change ${s.key}`}>
                        Change
                      </Button>
                    )}
                    {s.editable && s.source === 'environment' && <span className="small muted" title="Set by an environment variable, which takes precedence">locked</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      ))}
      {editing && <EditSetting setting={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
