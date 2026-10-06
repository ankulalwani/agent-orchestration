import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChatChannelDto, DigestSettingsDto } from '@ao/contracts';
import { Alert, Button, Card, Check, Field, Input, Select, timeAgo } from '@ao/ui';
import { ApiError, get, post, put } from '../lib/api';
import { useOrgId } from '../lib/session';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const message = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong');

/** The weekly analytics digest: when it is sent, and to which addresses and chat channels. */
export function DigestCard() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['digest', orgId], queryFn: () => get<DigestSettingsDto>(`/orgs/${orgId}/analytics/digest`) });
  const channels = useQuery({ queryKey: ['chat-channels', orgId], queryFn: () => get<ChatChannelDto[]>(`/orgs/${orgId}/chat-channels`) });
  const [form, setForm] = useState({ enabled: false, weekday: 1, hourUtc: 8, emails: '', chatChannelIds: [] as string[] });
  useEffect(() => {
    const d = settings.data;
    if (d) setForm({ enabled: d.enabled, weekday: d.weekday, hourUtc: d.hourUtc, emails: d.emails.join(', '), chatChannelIds: d.chatChannelIds });
  }, [settings.data]);

  const emails = form.emails.split(/[\s,;]+/).filter(Boolean);
  const save = useMutation({
    mutationFn: () => put<DigestSettingsDto>(`/orgs/${orgId}/analytics/digest`, { enabled: form.enabled, weekday: form.weekday, hourUtc: form.hourUtc, emails, chatChannelIds: form.chatChannelIds }),
    onSuccess: (d) => qc.setQueryData(['digest', orgId], d),
  });
  const preview = useMutation({ mutationFn: () => post<{ subject: string; text: string; sentTo: string | null }>(`/orgs/${orgId}/analytics/digest/send`) });
  const toggle = (id: string) => setForm((f) => ({ ...f, chatChannelIds: f.chatChannelIds.includes(id) ? f.chatChannelIds.filter((c) => c !== id) : [...f.chatChannelIds, id] }));

  return (
    <Card
      title="Weekly digest"
      description="A summary of Insights for the last seven days: tasks, success rate, spend against the budget, why tasks stopped and which check fails most."
      actions={
        <>
          <Button loading={preview.isPending} onClick={() => preview.mutate()}>
            Email it to me now
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <Check checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} hint={settings.data?.lastSentAt ? `Last sent ${timeAgo(settings.data.lastSentAt)}` : 'Not sent yet'}>
          Send the digest every week
        </Check>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Day">
            {(id) => (
              <Select id={id} value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Hour (UTC)" hint="The digest covers the seven full days before, in UTC">
            {(id) => (
              <Select id={id} value={form.hourUtc} onChange={(e) => setForm({ ...form, hourUtc: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Email addresses" hint="Separated by commas. Up to 20.">
          {(id) => <Input id={id} value={form.emails} placeholder="lead@example.com, finance@example.com" onChange={(e) => setForm({ ...form, emails: e.target.value })} />}
        </Field>
        {channels.data && channels.data.length > 0 && (
          <fieldset className="stack">
            <legend className="small muted">Chat channels</legend>
            {channels.data.map((c) => (
              <Check key={c.id} checked={form.chatChannelIds.includes(c.id)} onChange={() => toggle(c.id)} hint={c.enabled ? undefined : 'Switched off: nothing is sent to it'}>
                {c.name}
              </Check>
            ))}
          </fieldset>
        )}
        {save.isError && <Alert tone="danger">{message(save.error)}</Alert>}
        {save.isSuccess && !save.isPending && <Alert tone="info">Saved.</Alert>}
        {preview.isError && <Alert tone="danger">{message(preview.error)}</Alert>}
        {preview.data && (
          <Alert tone="info">
            {preview.data.sentTo ? `Sent to ${preview.data.sentTo}.` : 'Your account has no email address.'} This is what it says:
            <pre className="mt-2 whitespace-pre-wrap text-xs">{preview.data.text}</pre>
          </Alert>
        )}
      </div>
    </Card>
  );
}
