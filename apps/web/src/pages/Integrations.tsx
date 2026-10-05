import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from '@ao/ui';
import { ApiError, del, get, patch, post, put } from '../lib/api';
import { useOrgId } from '../lib/session';

interface IntegrationSettings {
  label: string;
  command: string;
  titleTemplate: string;
  promptTemplate: string;
  priority: string;
  requirePlanApproval: boolean;
  replyTokenSecret: string;
  apiBaseUrl: string;
  callbackUrl: string;
  reviews: 'off' | 'opened' | 'every_push';
  followUps: 'off' | 'changes_requested' | 'all_reviews';
}
interface Integration {
  id: string;
  name: string;
  kind: 'github' | 'gitlab' | 'jira' | 'linear' | 'generic';
  projectId: string;
  enabled: boolean;
  settings: IntegrationSettings;
  webhookUrl: string;
  lastDeliveryAt: string | null;
  lastDeliveryResult: string | null;
  deliveries: number;
}

const SETUP: Record<Integration['kind'], string> = {
  github: 'In the repository: Settings → Webhooks → Add webhook. Payload URL: the URL below; content type application/json; secret: the secret; events: Issues, Issue comments, and Pull requests for reviews.',
  gitlab: 'In the project: Settings → Webhooks. URL: the URL below; secret token: the secret; triggers: Issues events, Comments, and Merge request events for reviews.',
  jira: 'In Jira: Settings → System → WebHooks → Create a WebHook. URL: the URL below; secret: the secret; events: Issue created, Issue updated, and Comment created.',
  linear: 'In Linear: Settings → API → Webhooks → New webhook. URL: the URL below; data change events: Issues and Comments. Linear then shows a signing secret: paste it here and save. Deliveries are refused until you do.',
  generic: 'POST JSON to the URL below with header X-AO-Signature: sha256=<HMAC-SHA256 of the body with the secret>, and optionally X-AO-Delivery: <unique id> so retries do not create duplicates.',
};

/** Integrations: webhooks from GitHub, GitLab or any system that create tasks (FUT-002). */
export function Integrations() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['integrations', orgId], queryFn: () => get<Integration[]>(`/orgs/${orgId}/integrations`) });
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const [form, setForm] = useState({ name: '', kind: 'github' as Integration['kind'], projectId: '', label: 'agent', command: '/agent', reviews: 'off' as IntegrationSettings['reviews'], followUps: 'off' as IntegrationSettings['followUps'], replyTokenSecret: '', titleTemplate: '{{title}}', promptTemplate: '{{prompt}}', callbackUrl: '', apiBaseUrl: '' });
  // Code hosts have pull/merge requests to review; issue trackers do not.
  const hosting = form.kind === 'github' || form.kind === 'gitlab';
  const [shown, setShown] = useState<{ id: string; name: string; url: string; secret: string; kind: Integration['kind'] } | null>(null);
  const [linearSecret, setLinearSecret] = useState('');
  const saveSecret = useMutation({ mutationFn: () => put(`/orgs/${orgId}/integrations/${shown!.id}/secret`, { secret: linearSecret.trim() }), onSuccess: () => setLinearSecret('') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['integrations', orgId] });
  const create = useMutation({
    mutationFn: () =>
      post<Integration & { secret: string }>(`/orgs/${orgId}/integrations`, {
        name: form.name,
        kind: form.kind,
        projectId: form.projectId || projects.data?.[0]?.id,
        settings: form.kind === 'generic' ? { titleTemplate: form.titleTemplate, promptTemplate: form.promptTemplate, callbackUrl: form.callbackUrl } : { label: form.label, command: form.command, replyTokenSecret: form.replyTokenSecret, ...(hosting ? { reviews: form.reviews } : {}), ...(form.kind === 'github' ? { followUps: form.followUps } : {}), ...(form.kind === 'jira' && form.apiBaseUrl.trim() ? { apiBaseUrl: form.apiBaseUrl.trim() } : {}) },
      }),
    onSuccess: (r) => {
      setShown({ id: r.id, name: r.name, url: r.webhookUrl, secret: r.secret, kind: r.kind });
      setForm({ ...form, name: '' });
      refresh();
    },
  });
  const rotate = useMutation({ mutationFn: (i: Integration) => post<{ secret: string }>(`/orgs/${orgId}/integrations/${i.id}/rotate-secret`).then((r) => ({ i, secret: r.secret })), onSuccess: ({ i, secret }) => setShown({ id: i.id, name: i.name, url: i.webhookUrl, secret, kind: i.kind }) });
  const toggle = useMutation({ mutationFn: (i: Integration) => patch(`/orgs/${orgId}/integrations/${i.id}`, { enabled: !i.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (i: Integration) => del(`/orgs/${orgId}/integrations/${i.id}`), onSuccess: refresh });
  const error = create.error ?? rotate.error ?? toggle.error ?? remove.error;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="stack">
      <Alert>Issues, comments and other events from outside become tasks. Deliveries are signed and idempotent: an issue creates one task however often it is delivered.</Alert>
      {error && <Alert tone="danger">{(error as ApiError).message}</Alert>}
      {shown && (
        <Card title={`Set up "${shown.name}"`} actions={<Button size="sm" onClick={() => setShown(null)}>Done</Button>}>
          <div className="stack">
            <p className="small">{SETUP[shown.kind]}</p>
            <Field label="Webhook URL">{(id) => <Input id={id} readOnly value={shown.url} onFocus={(e) => e.target.select()} />}</Field>
            {shown.kind === 'linear' ? (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Field label="Signing secret from Linear" hint="Stored encrypted and never shown again">{(id) => <Input id={id} type="password" autoComplete="off" value={linearSecret} onChange={(e) => setLinearSecret(e.target.value)} />}</Field>
                </div>
                <Button variant="primary" disabled={linearSecret.trim().length < 8} loading={saveSecret.isPending} onClick={() => saveSecret.mutate()}>Save secret</Button>
                {saveSecret.isSuccess && <span className="small muted">Saved.</span>}
              </div>
            ) : (
              <Field label="Secret" hint="Shown once. Rotate it to get a new one.">{(id) => <Input id={id} readOnly className="mono" value={shown.secret} onFocus={(e) => e.target.select()} />}</Field>
            )}
          </div>
        </Card>
      )}
      <Card title="Integrations" padded={false}>
        <table className="table" aria-label="Integrations">
          <thead>
            <tr><th>Name</th><th>Project</th><th>Last delivery</th><th /></tr>
          </thead>
          <tbody>
            {list.data?.length ? (
              list.data.map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.name} <Badge tone={i.enabled ? 'ok' : 'neutral'}>{i.enabled ? i.kind : 'off'}</Badge>
                    <div className="small muted">{i.kind === 'generic' ? 'templates' : [i.settings.label && `label "${i.settings.label}"`, i.settings.command && `comments "${i.settings.command} …"`, i.settings.reviews !== 'off' && `reviews (${i.settings.reviews === 'opened' ? 'when opened' : 'every push'})`].filter(Boolean).join(' · ') || 'every new issue'}</div>
                  </td>
                  <td>{projectName(i.projectId)}</td>
                  <td className="small">{i.lastDeliveryAt ? `${new Date(i.lastDeliveryAt).toLocaleString()} — ${i.lastDeliveryResult}` : 'none yet'}<div className="muted">{i.deliveries} deliveries</div></td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setShown({ id: i.id, name: i.name, url: i.webhookUrl, secret: '(hidden — rotate to get a new one)', kind: i.kind })}>Setup</Button>
                    {i.kind !== 'linear' && <Button size="sm" onClick={() => confirm('Replace the secret? Deliveries signed with the old one will be refused.') && rotate.mutate(i)}>Rotate secret</Button>}
                    <Button size="sm" onClick={() => toggle.mutate(i)}>{i.enabled ? 'Turn off' : 'Turn on'}</Button>
                    <Button size="sm" variant="danger" onClick={() => confirm(`Delete ${i.name}?`) && remove.mutate(i)}>Delete</Button>
                  </td>
                </tr>
              ))
            ) : (
              <tr><td className="muted">No integrations yet.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
      <Card title="Add an integration">
        <div className="stack" style={{ maxWidth: 680 }}>
          <div className="grid grid-2">
            <Field label="Name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="GitHub – website" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Source">
              {(id) => (
                <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Integration['kind'] })}>
                  <option value="github">GitHub</option>
                  <option value="gitlab">GitLab</option>
                  <option value="jira">Jira</option>
                  <option value="linear">Linear</option>
                  <option value="generic">Other (JSON webhook)</option>
                </Select>
              )}
            </Field>
            <Field label="Project for new tasks">
              {(id) => (
                <Select id={id} value={form.projectId || projects.data?.[0]?.id || ''} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
                  {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
            </Field>
            {form.kind !== 'generic' ? (
              <>
                <Field label="Label" hint="Issues with this label become tasks. Empty: every new issue.">{(id) => <Input id={id} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />}</Field>
                <Field label="Comment command" hint="A comment starting with this creates a task. Empty: off.">{(id) => <Input id={id} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />}</Field>
                {hosting && (
                  <Field label="Review pull/merge requests" hint="An agent reviews the changes and posts the review">
                    {(id) => (
                      <Select id={id} value={form.reviews} onChange={(e) => setForm({ ...form, reviews: e.target.value as IntegrationSettings['reviews'] })}>
                        <option value="off">Off</option>
                        <option value="opened">When opened</option>
                        <option value="every_push">When opened and on every push</option>
                      </Select>
                    )}
                  </Field>
                )}
                {form.kind === 'jira' && <Field label="Jira site URL" hint="For replies, for example https://acme.atlassian.net">{(id) => <Input id={id} value={form.apiBaseUrl} onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })} />}</Field>}
                {form.kind === 'github' && (
                  <Field label="Follow up on review feedback" hint="For pull requests a task opened: a new task on the same branch. Needs the webhook event “Pull request reviews”.">
                    {(id) => (
                      <Select id={id} value={form.followUps} onChange={(e) => setForm({ ...form, followUps: e.target.value as IntegrationSettings['followUps'] })}>
                        <option value="off">Off</option>
                        <option value="changes_requested">When a review requests changes</option>
                        <option value="all_reviews">On every review with a text</option>
                      </Select>
                    )}
                  </Field>
                )}
                <Field label="Token secret for replies" hint={form.kind === 'jira' ? 'Optional: name of a secret holding "email:API token" (Jira Cloud) or a personal access token, to comment on the issue' : form.kind === 'linear' ? 'Optional: name of a secret with a Linear API key, to comment on the issue' : 'Optional: name of a secret with a GitHub/GitLab token, to comment on the issue'}>{(id) => <Input id={id} value={form.replyTokenSecret} onChange={(e) => setForm({ ...form, replyTokenSecret: e.target.value.toUpperCase() })} />}</Field>
              </>
            ) : (
              <Field label="Callback URL" hint="Optional: the result is POSTed here, signed">{(id) => <Input id={id} value={form.callbackUrl} onChange={(e) => setForm({ ...form, callbackUrl: e.target.value })} />}</Field>
            )}
          </div>
          {form.kind === 'generic' && (
            <>
              <Field label="Title template" hint="{{path.in.payload}} is replaced with values from the delivered JSON">{(id) => <Input id={id} value={form.titleTemplate} onChange={(e) => setForm({ ...form, titleTemplate: e.target.value })} />}</Field>
              <Field label="Prompt template">{(id) => <Textarea id={id} rows={4} value={form.promptTemplate} onChange={(e) => setForm({ ...form, promptTemplate: e.target.value })} />}</Field>
            </>
          )}
          <div><Button variant="primary" disabled={!form.name.trim() || !projects.data?.length} loading={create.isPending} onClick={() => create.mutate()}>Create integration</Button></div>
        </div>
      </Card>
    </div>
  );
}
