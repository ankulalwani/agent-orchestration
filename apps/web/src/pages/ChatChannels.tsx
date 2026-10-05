import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHAT_EVENTS, DEFAULT_CHAT_EVENTS, type ChatChannelDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Field, Input, Select } from '@ao/ui';
import { ApiError, del, get, patch, post, put } from '../lib/api';
import { useOrgId } from '../lib/session';
import { humanize } from '../lib/format';

type Kind = ChatChannelDto['kind'];
const EVENT_LABELS: Record<(typeof CHAT_EVENTS)[number], string> = {
  'task.approval_required': 'Approval required',
  'task.input_required': 'An agent asks a question',
  'task.recovery_required': 'Recovery required',
  'task.failed': 'Task failed',
  'task.completed': 'Task completed',
  'task.provider_limit': 'Provider limit reached',
  'worker.offline': 'Worker offline',
  'budget.warning': 'Budget warning',
  'budget.exceeded': 'Budget reached',
};
const SETUP: Record<Kind, string> = {
  slack:
    'In Slack: create an app (api.slack.com/apps), turn on Incoming Webhooks and add one for the channel; paste its URL here. For Approve/Deny buttons and the slash command, also paste the app\'s Signing Secret, then set the request URL shown after saving as the app\'s Interactivity request URL and as the request URL of a slash command (for example /agent).',
  teams: 'In Teams: channel → Workflows → "Post to a channel when a webhook request is received" (or an Incoming Webhook connector); paste its URL here. Teams channels get notifications with a link to the task.',
};

/** Chat channels: notifications to Slack or Microsoft Teams, and approvals from Slack. */
export function ChatChannels() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['chat-channels', orgId], queryFn: () => get<ChatChannelDto[]>(`/orgs/${orgId}/chat-channels`) });
  const [form, setForm] = useState({ name: '', kind: 'slack' as Kind, webhookUrl: '', signingSecret: '', events: [...DEFAULT_CHAT_EVENTS] as string[] });
  const [tested, setTested] = useState<{ name: string; result: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['chat-channels', orgId] });
  const create = useMutation({
    mutationFn: () => post<ChatChannelDto>(`/orgs/${orgId}/chat-channels`, { name: form.name, kind: form.kind, webhookUrl: form.webhookUrl, events: form.events, ...(form.kind === 'slack' && form.signingSecret ? { signingSecret: form.signingSecret } : {}) }),
    onSuccess: () => {
      setForm({ ...form, name: '', webhookUrl: '', signingSecret: '' });
      refresh();
    },
  });
  const toggle = useMutation({ mutationFn: (c: ChatChannelDto) => patch(`/orgs/${orgId}/chat-channels/${c.id}`, { enabled: !c.enabled }), onSuccess: refresh });
  const test = useMutation({
    mutationFn: (c: ChatChannelDto) => post<{ result: string }>(`/orgs/${orgId}/chat-channels/${c.id}/test`).then((r) => ({ name: c.name, result: r.result })),
    onSuccess: (r) => {
      setTested(r);
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (c: ChatChannelDto) => del(`/orgs/${orgId}/chat-channels/${c.id}`), onSuccess: refresh });
  const error = create.error ?? toggle.error ?? test.error ?? remove.error;

  return (
    <div className="stack">
      <Alert>Send what needs a person to a chat channel. In Slack, members can approve, deny and answer agents from the channel; each action runs with the role of the member who took it.</Alert>
      {error && <Alert tone="danger">{(error as ApiError).message}</Alert>}
      {tested && <Alert tone={tested.result === 'ok' ? 'info' : 'danger'}>{tested.result === 'ok' ? `Test message sent to "${tested.name}".` : `"${tested.name}": ${tested.result}. Check the webhook URL.`}</Alert>}
      <Card title="Chat channels" padded={false}>
        <table className="table" aria-label="Chat channels">
          <thead>
            <tr><th>Name</th><th>Sends</th><th>Last message</th><th /></tr>
          </thead>
          <tbody>
            {list.data?.length ? (
              list.data.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name} <Badge tone={c.enabled ? 'ok' : 'neutral'}>{c.enabled ? humanize(c.kind) : 'off'}</Badge>
                    <div className="small muted">{c.webhookHost}{c.interactive ? ' · buttons and commands on' : ''}</div>
                    {c.requestUrl && <div className="small muted">Request URL: <code style={{ wordBreak: 'break-all' }}>{c.requestUrl}</code></div>}
                  </td>
                  <td className="small">{c.events.map((e) => EVENT_LABELS[e as keyof typeof EVENT_LABELS] ?? e).join(', ') || 'nothing'}</td>
                  <td className="small">{c.lastDeliveryAt ? `${new Date(c.lastDeliveryAt).toLocaleString()} — ${c.lastDeliveryResult}` : 'none yet'}</td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" loading={test.isPending && test.variables?.id === c.id} onClick={() => test.mutate(c)}>Send test</Button>
                    <Button size="sm" onClick={() => toggle.mutate(c)}>{c.enabled ? 'Turn off' : 'Turn on'}</Button>
                    <Button size="sm" variant="danger" onClick={() => confirm(`Delete ${c.name}?`) && remove.mutate(c)}>Delete</Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr><td className="muted">No chat channels yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
      <Card title="Add a chat channel">
        <div className="stack" style={{ maxWidth: 680 }}>
          <p className="small muted" style={{ margin: 0 }}>{SETUP[form.kind]}</p>
          <div className="grid grid-2">
            <Field label="Name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="Slack #agents" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Service">
              {(id) => (
                <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Kind })}>
                  <option value="slack">Slack</option>
                  <option value="teams">Microsoft Teams</option>
                </Select>
              )}
            </Field>
          </div>
          <Field label="Incoming webhook URL" hint="Stored encrypted and never shown again">{(id) => <Input id={id} type="password" autoComplete="off" value={form.webhookUrl} onChange={(e) => setForm({ ...form, webhookUrl: e.target.value })} />}</Field>
          {form.kind === 'slack' && (
            <Field label="Signing secret" hint="Optional. Slack app → Basic Information → Signing Secret. Turns on buttons and the slash command.">
              {(id) => <Input id={id} type="password" autoComplete="off" value={form.signingSecret} onChange={(e) => setForm({ ...form, signingSecret: e.target.value })} />}
            </Field>
          )}
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small">Send</legend>
            {CHAT_EVENTS.map((e) => (
              <label key={e} className="row">
                <input type="checkbox" checked={form.events.includes(e)} onChange={(ev) => setForm({ ...form, events: ev.target.checked ? [...form.events, e] : form.events.filter((x) => x !== e) })} />
                {EVENT_LABELS[e]}
              </label>
            ))}
          </fieldset>
          <div><Button variant="primary" disabled={!form.name.trim() || !form.webhookUrl.trim()} loading={create.isPending} onClick={() => create.mutate()}>Add channel</Button></div>
        </div>
      </Card>
    </div>
  );
}

/** The signed-in member's Slack member ID in this organization. */
export function ChatIdentity() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const identity = useQuery({ queryKey: ['chat-identity', orgId], queryFn: () => get<{ slackUserId: string | null }>(`/orgs/${orgId}/chat-identity`) });
  const [slackUserId, setSlackUserId] = useState('');
  useEffect(() => setSlackUserId(identity.data?.slackUserId ?? ''), [identity.data]);
  const save = useMutation({ mutationFn: () => put(`/orgs/${orgId}/chat-identity`, { slackUserId: slackUserId.trim() || null }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['chat-identity', orgId] }) });
  return (
    <Card title="Slack">
      <div className="stack" style={{ maxWidth: 560 }}>
        <p className="small muted" style={{ margin: 0 }}>Link your Slack account to approve, deny and answer agents from Slack. Your actions there run with your role in this organization.</p>
        {save.error && <Alert tone="danger">{(save.error as ApiError).message}</Alert>}
        {save.isSuccess && <Alert>Saved.</Alert>}
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <Field label="Slack member ID" hint="In Slack: your profile → ⋮ → Copy member ID. Empty: not linked.">{(id) => <Input id={id} className="mono" placeholder="U012AB3CD" disabled={identity.isLoading} value={slackUserId} onChange={(e) => setSlackUserId(e.target.value.toUpperCase())} />}</Field>
          </div>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save member ID</Button>
        </div>
      </div>
    </Card>
  );
}
