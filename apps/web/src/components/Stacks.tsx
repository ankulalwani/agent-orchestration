import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import type { InstallStackResponse, ProjectDto, StackDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, Textarea } from '@ao/ui';
import { ApiError, del, get, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';

type Scope = 'USER' | 'ORGANIZATION' | 'PROJECT';
const TYPE_LABEL: Record<string, string> = { skill: 'Skill', mcp: 'MCP server', plugin: 'Plugin', integration: 'Integration' };
const RESULT: Record<InstallStackResponse['results'][number]['status'], { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  installed: { label: 'installed', tone: 'ok' },
  pending_approval: { label: 'waits for approval', tone: 'warn' },
  failed: { label: 'not installed', tone: 'danger' },
};

/** Stacks: packages that belong together, installed in one step. The organization's own first, then the platform's. */
export function Stacks({ projects, onInstalled }: { projects: ProjectDto[]; onInstalled: () => void }) {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const stacks = useQuery({ queryKey: ['stacks', orgId], queryFn: () => get<StackDto[]>(`/orgs/${orgId}/registry/stacks`) });
  const [installing, setInstalling] = useState<StackDto | null>(null);
  const [form, setForm] = useState({ slug: '', name: '', description: '', refs: '' });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['stacks', orgId] });
  const create = useMutation({
    mutationFn: () => post<StackDto>(`/orgs/${orgId}/registry/stacks`, { slug: form.slug, name: form.name, description: form.description, items: form.refs.split(/[\s,]+/).filter(Boolean).map((ref) => ({ ref })) }),
    onSuccess: () => {
      setForm({ slug: '', name: '', description: '', refs: '' });
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (s: StackDto) => del(`/orgs/${orgId}/registry/stacks/${s.slug}`), onSuccess: refresh });
  const err = create.error ?? remove.error;
  const mayInstall = can('capability.install') || can('capability.personal');

  if (stacks.isLoading) return <Spinner label="Loading stacks…" />;
  return (
    <div className="stack">
      {err && <Alert tone="danger">{(err as ApiError).message}</Alert>}
      {stacks.data?.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {stacks.data.map((s) => (
            <article key={`${s.ownerKind}:${s.slug}`} className="card flex flex-col" aria-label={`${s.name} stack`}>
              <div className="flex flex-1 flex-col gap-2.5 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm">{s.name}</h2>
                    <div className="text-xs text-fg-3">{s.items.length} packages · {s.installs} installs</div>
                  </div>
                  <Badge tone={s.ownerKind === 'organization' ? 'info' : 'accent'} plain>{s.ownerKind === 'organization' ? 'ours' : 'platform'}</Badge>
                </div>
                {s.description && <p className="text-fg-2">{s.description}</p>}
                <ul className="flex flex-col gap-1 text-xs">
                  {s.items.map((i) => (
                    <li key={i.ref} className="flex items-baseline gap-2">
                      <Badge plain>{i.package ? (TYPE_LABEL[i.package.type] ?? i.package.type) : 'unavailable'}</Badge>
                      <span className="min-w-0 truncate">
                        <span className={i.package ? '' : 'text-fg-3 line-through'}>{i.package?.displayName ?? i.ref}</span>
                        {i.note && <span className="text-fg-3"> · {i.note}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex min-h-[42px] flex-wrap items-center gap-2 border-t border-line px-4 py-2">
                {mayInstall && <Button size="sm" onClick={() => setInstalling(s)}>Install all…</Button>}
                {s.ownerKind === 'organization' && can('capability.manage') && <Button size="sm" variant="danger" onClick={() => confirm(`Delete the stack "${s.name}"? What it installed stays installed.`) && remove.mutate(s)}>Delete</Button>}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <Card><EmptyState icon={Layers} title="No stacks yet">A stack is a set of packages that belong together, such as a framework's skills and MCP servers.</EmptyState></Card>
      )}
      {can('capability.manage') && (
        <Card title="Add a stack of this organization" description="For example the packages every new project of yours should get.">
          <div className="stack max-w-[680px]">
            <div className="grid grid-2">
              <Field label="Name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="Our web stack" onChange={(e) => setForm({ ...form, name: e.target.value, slug: form.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') })} />}</Field>
              <Field label="Address" hint="Lower-case letters, digits and dashes">{(id) => <Input id={id} className="mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />}</Field>
            </div>
            <Field label="Description">{(id) => <Input id={id} value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
            <Field label="Packages" hint="References like @namespace/name, one per line">{(id) => <Textarea id={id} rows={4} className="mono" value={form.refs} onChange={(e) => setForm({ ...form, refs: e.target.value })} />}</Field>
            <div><Button variant="primary" disabled={!form.name.trim() || !form.slug.trim() || !form.refs.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create stack</Button></div>
          </div>
        </Card>
      )}
      {installing && <InstallStackDialog stack={installing} projects={projects} onClose={() => setInstalling(null)} onInstalled={() => (refresh(), onInstalled())} />}
    </div>
  );
}

/** The platform's stacks, for server administrators: offered to every organization, public packages only. */
export function PlatformStacks() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const stacks = useQuery({ queryKey: ['stacks', orgId], queryFn: () => get<StackDto[]>(`/orgs/${orgId}/registry/stacks`) });
  const [form, setForm] = useState({ slug: '', name: '', description: '', refs: '' });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['stacks', orgId] });
  const create = useMutation({
    mutationFn: () => post<StackDto>('/admin/registry/stacks', { slug: form.slug, name: form.name, description: form.description, items: form.refs.split(/[\s,]+/).filter(Boolean).map((ref) => ({ ref })) }),
    onSuccess: () => {
      setForm({ slug: '', name: '', description: '', refs: '' });
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (s: StackDto) => del(`/admin/registry/stacks/${s.slug}`), onSuccess: refresh });
  const err = create.error ?? remove.error;
  const platform = (stacks.data ?? []).filter((s) => s.ownerKind === 'platform');
  return (
    <Card title="Stacks" description="Sets of public packages that every organization can install in one step.">
      <div className="stack max-w-[720px]">
        {err && <Alert tone="danger">{(err as ApiError).message}</Alert>}
        {platform.length > 0 && (
          <ul className="flex flex-col divide-y divide-line" aria-label="Platform stacks">
            {platform.map((s) => (
              <li key={s.slug} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{s.name} <code className="small">{s.slug}</code></span>
                  <span className="block truncate text-xs text-fg-3">{s.items.map((i) => i.ref).join(', ')} · {s.installs} installs</span>
                </span>
                <Button size="sm" variant="danger" onClick={() => confirm(`Delete the stack "${s.name}"?`) && remove.mutate(s)}>Delete</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid grid-2">
          <Field label="Stack name">{(id) => <Input id={id} value={form.name} maxLength={100} placeholder="Next.js starter" onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
          <Field label="Stack address" hint="Used in links: lower-case letters, digits and dashes">{(id) => <Input id={id} className="mono" value={form.slug} placeholder="nextjs-starter" onChange={(e) => setForm({ ...form, slug: e.target.value })} />}</Field>
        </div>
        <Field label="Stack description">{(id) => <Input id={id} value={form.description} maxLength={500} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        <Field label="Public packages" hint="References like @namespace/name, one per line">{(id) => <Textarea id={id} rows={3} className="mono" value={form.refs} onChange={(e) => setForm({ ...form, refs: e.target.value })} />}</Field>
        <div><Button variant="primary" disabled={!form.name.trim() || !form.slug.trim() || !form.refs.trim()} loading={create.isPending} onClick={() => create.mutate()}>Create platform stack</Button></div>
      </div>
    </Card>
  );
}

function InstallStackDialog({ stack, projects, onClose, onInstalled }: { stack: StackDto; projects: ProjectDto[]; onClose: () => void; onInstalled: () => void }) {
  const orgId = useOrgId();
  const { can } = useSession();
  const [scope, setScope] = useState<Scope>(can('capability.install') ? 'ORGANIZATION' : 'USER');
  const [projectId, setProjectId] = useState('');
  const install = useMutation({
    mutationFn: () => post<InstallStackResponse>(`/orgs/${orgId}/registry/stacks/${stack.slug}/install`, { scope, projectId: scope === 'PROJECT' ? projectId : undefined }),
    onSuccess: onInstalled,
  });
  const done = install.data;
  const names = new Map(stack.items.map((i) => [i.ref, i.package?.displayName ?? i.ref]));
  return (
    <Dialog
      open
      title={`Install ${stack.name}`}
      onClose={onClose}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={install.isPending} disabled={scope === 'PROJECT' && !projectId} onClick={() => install.mutate()}>Install {stack.items.length} packages</Button></>}
    >
      <div className="stack">
        {install.error && <Alert tone="danger">{(install.error as ApiError).message}</Alert>}
        {done ? (
          <ul className="flex flex-col divide-y divide-line" aria-label="Result">
            {done.results.map((r) => (
              <li key={r.ref} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate">{names.get(r.ref)}</span>
                  {r.reason && <span className="block text-xs text-fg-3">{r.reason}</span>}
                </span>
                <Badge tone={RESULT[r.status].tone}>{RESULT[r.status].label}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <Alert>Each package is installed the usual way: your organization's policy may hold some for approval or refuse them.</Alert>
            <Field label="Install for">
              {(id) => (
                <Select id={id} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
                  {can('capability.personal') && <option value="USER">Just me (my tasks in this organization)</option>}
                  {can('capability.install') && <option value="ORGANIZATION">Whole organization</option>}
                  {can('capability.install') && <option value="PROJECT">One project</option>}
                </Select>
              )}
            </Field>
            {scope === 'PROJECT' && (
              <Field label="Project">
                {(id) => (
                  <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">Choose…</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
