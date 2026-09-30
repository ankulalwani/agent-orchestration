import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PackageDto, ProjectDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Dialog, EmptyState, Field, Input, Select, Spinner, Tabs, Textarea, type Tone } from '@ao/ui';
import { ApiError, del, get, patch, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';
import { PageHeader } from '../Layout';
import { CATEGORIES } from '@ao/core/shared';
import { ClassificationChips, SignalsLine, useSuggestions, type SuggestInput } from '../components/CapabilitySuggestions';

interface Installation {
  id: string;
  capabilityId: string;
  version: string;
  versionRange: string;
  scope: string;
  projectId: string | null;
  userId: string | null;
  enabled: boolean;
  status: string;
  approvalReasons: string[];
}
interface CatalogPage {
  items: PackageDto[];
  page: number;
  hasMore: boolean;
  curatedCount: number;
}
type Scope = 'USER' | 'ORGANIZATION' | 'PROJECT';

export const TRUST_TONE: Record<string, Tone> = { OFFICIAL: 'ok', VERIFIED: 'ok', LOCAL: 'info', COMMUNITY: 'warn', UNVERIFIED: 'danger' };
const REVIEW_TONE: Record<string, Tone> = { NONE: 'neutral', PENDING: 'warn', APPROVED: 'ok', REJECTED: 'danger' };
const HIGH_RISK = ['shell', 'secrets.read', 'process.execute', 'browser.control', 'filesystem.write'];
const TYPE_LABEL: Record<string, string> = { skill: 'Skill', mcp: 'MCP server', plugin: 'Plugin', integration: 'Integration' };
const EXAMPLE = `{
  "id": "company-react-standards",
  "name": "Company React Standards",
  "version": "1.0.0",
  "type": "skill",
  "description": "Our React conventions: function components, hooks, design tokens and testing rules.",
  "compatibleAgents": [],
  "permissions": ["filesystem.project.read"],
  "triggers": { "keywords": ["react", "component"] },
  "skill": { "instructions": "Use function components, hooks, and our design tokens." }
}`;
const errorText = (err: unknown) =>
  err instanceof ApiError ? `${err.message}${err.context?.reasons ? `: ${(err.context.reasons as string[]).join('; ')}` : ''}` : err instanceof SyntaxError ? 'Invalid manifest JSON' : 'Something went wrong';

/**
 * Skills, MCP servers, plugins and integrations: what is installed, the marketplace (curated first), and
 * the packages this organization and person publish.
 */
export function CapabilitiesPage() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'installed' | 'suggested' | 'marketplace' | 'mine'>('installed');
  const [installing, setInstalling] = useState<PackageDto | null>(null);

  const installs = useQuery({ queryKey: ['installations', orgId], queryFn: () => get<Installation[]>(`/orgs/${orgId}/capability-installations`) });
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['installations', orgId] });
    void qc.invalidateQueries({ queryKey: ['packages', orgId] });
  };
  const approve = useMutation({ mutationFn: (id: string) => post(`/orgs/${orgId}/capability-installations/${id}/approve`), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (i: Installation) => patch(`/orgs/${orgId}/capability-installations/${i.id}`, { enabled: !i.enabled }), onSuccess: refresh });
  const upgrade = useMutation({ mutationFn: (id: string) => post(`/orgs/${orgId}/capability-installations/${id}/upgrade`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => del(`/orgs/${orgId}/capability-installations/${id}`), onSuccess: refresh });
  const err = approve.error ?? toggle.error ?? upgrade.error ?? remove.error;
  const projectName = (id: string | null) => (id ? (projects.data?.find((p) => p.id === id)?.name ?? id) : '');
  const scopeLabel = (i: Installation) => (i.scope === 'PROJECT' ? `Project: ${projectName(i.projectId)}` : i.scope === 'USER' ? 'Just me' : i.scope === 'TASK' ? 'One task' : 'Organization');
  const canChange = (i: Installation) => (i.scope === 'USER' ? can('capability.personal') : can('capability.install'));

  return (
    <div className="stack">
      <PageHeader title="Capabilities" description="Install skills, MCP servers and plugins for your organization, a project, or just yourself. Curated packages are shown first." />
      {err && <Alert tone="danger">{errorText(err)}</Alert>}
      <Tabs label="Capability views" value={tab} onChange={setTab} tabs={[{ id: 'installed', label: 'Installed' }, { id: 'suggested', label: 'Suggested' }, { id: 'marketplace', label: 'Marketplace' }, { id: 'mine', label: 'My packages' }]} />
      {tab === 'installed' && (
        <Card padded={false}>
          {installs.isLoading ? (
            <div className="card-body"><Spinner /></div>
          ) : installs.data?.length ? (
            <table className="table">
              <thead>
                <tr><th>Capability</th><th>Scope</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {installs.data.map((i) => (
                  <tr key={i.id}>
                    <td><code>{i.capabilityId}</code> <span className="muted small">v{i.version} ({i.versionRange})</span></td>
                    <td className="small">{scopeLabel(i)}</td>
                    <td>
                      <Badge tone={i.status === 'ACTIVE' ? (i.enabled ? 'ok' : 'neutral') : 'warn'}>{i.status === 'ACTIVE' ? (i.enabled ? 'Active' : 'Disabled') : 'Pending approval'}</Badge>
                      {i.approvalReasons.length > 0 && <div className="small muted">{i.approvalReasons.join(' · ')}</div>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {i.status === 'PENDING_APPROVAL' && can('capability.manage') && <Button size="sm" variant="primary" onClick={() => approve.mutate(i.id)}>Approve</Button>}
                        {canChange(i) && <Button size="sm" onClick={() => upgrade.mutate(i.id)} loading={upgrade.isPending && upgrade.variables === i.id}>Upgrade</Button>}
                        {i.status === 'ACTIVE' && canChange(i) && <Button size="sm" onClick={() => toggle.mutate(i)}>{i.enabled ? 'Disable' : 'Enable'}</Button>}
                        {canChange(i) && <Button size="sm" variant="danger" onClick={() => remove.mutate(i.id)}>Uninstall</Button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="Nothing installed" action={<Button onClick={() => setTab('marketplace')}>Browse the marketplace</Button>} />
          )}
        </Card>
      )}
      {tab === 'suggested' && <Suggested projects={projects.data ?? []} onInstall={setInstalling} />}
      {tab === 'marketplace' && <Marketplace onInstall={setInstalling} />}
      {tab === 'mine' && <MyPackages onInstall={setInstalling} />}
      {installing && <InstallDialog pkg={installing} projects={projects.data ?? []} onClose={() => setInstalling(null)} onDone={() => { setInstalling(null); setTab('installed'); refresh(); }} />}
    </div>
  );
}

/**
 * Suggestions for a piece of work: a description typed here, a project (its description and detected
 * stack), or both. Curated packages first; each says why it was suggested.
 */
function Suggested({ projects, onInstall }: { projects: ProjectDto[]; onInstall: (p: PackageDto) => void }) {
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [type, setType] = useState('');
  const [input, setInput] = useState<SuggestInput | null>(null);
  const q = useSuggestions(input ?? {}, input !== null);
  const ask = () => setInput({ text, projectId: projectId || undefined, type: type || undefined, limit: 20 });
  return (
    <div className="stack">
      <Card>
        <div className="stack">
          <Field label="What are you working on?" hint="A task, a feature, or a description of the project. Technologies and kinds of work are picked out of the text.">
            {(id) => <Textarea id={id} rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add OAuth sign-in to our Next.js app, with Playwright tests for the login flow…" />}
          </Field>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ maxWidth: 260 }}>
              <option value="">No project</option>
              {projects.map((p) => <option key={p.id} value={p.id}>Project: {p.name}</option>)}
            </Select>
            <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="">All types</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <Button variant="primary" disabled={!text.trim() && !projectId} loading={q.isFetching} onClick={ask}>Suggest</Button>
          </div>
          {projectId && <span className="small muted">Uses the project’s description and knowledge, and the stack found by its last readiness check.</span>}
        </div>
      </Card>
      {q.error && <Alert tone="danger">{errorText(q.error)}</Alert>}
      {q.data && <SignalsLine signals={q.data.signals} />}
      {q.data && !q.data.items.length && <EmptyState title="No suggestions">Nothing in the marketplace matches closely enough. Name the tools or languages involved, or browse the marketplace.</EmptyState>}
      {q.data && q.data.items.length > 0 && (
        <div className="grid grid-2">
          {q.data.items.map((s) => (
            <PackageCard key={s.package.id} pkg={s.package} onInstall={s.installed ? undefined : onInstall}>
              {s.installed && <Badge tone="ok">installed</Badge>}
              <span className="small muted">{s.reasons.join(' · ')}</span>
            </PackageCard>
          ))}
        </div>
      )}
    </div>
  );
}

interface Facets {
  categories: Array<{ slug: string; label: string; count: number }>;
  technologies: Array<{ slug: string; label: string; count: number }>;
}

/** Curated first. When nothing curated matches, all packages are shown with a note, so people can still find one. */
function Marketplace({ onInstall }: { onInstall: (p: PackageDto) => void }) {
  const orgId = useOrgId();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [category, setCategory] = useState('');
  const [technology, setTechnology] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [page, setPage] = useState(1);
  const facets = useQuery({ queryKey: ['facets', orgId, type], queryFn: () => get<Facets>(`/orgs/${orgId}/registry/facets${type ? `?type=${type}` : ''}`), staleTime: 300_000 });
  const filters = { ...(q ? { q } : {}), ...(type ? { type } : {}), ...(category ? { category } : {}), ...(technology ? { technology } : {}) };
  const params = (tier: 'curated' | 'all') => new URLSearchParams({ tier, page: String(page), limit: '24', ...filters }).toString();
  const curated = useQuery({ queryKey: ['packages', orgId, 'curated', filters, page], queryFn: () => get<CatalogPage>(`/orgs/${orgId}/registry/packages?${params('curated')}`) });
  const noCurated = curated.data !== undefined && curated.data.curatedCount === 0;
  const all = useQuery({ queryKey: ['packages', orgId, 'all', filters, page], queryFn: () => get<CatalogPage>(`/orgs/${orgId}/registry/packages?${params('all')}`), enabled: showAll || noCurated });
  const view = showAll || noCurated ? all : curated;
  const reset = (fn: () => void) => {
    fn();
    setPage(1);
  };

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Input aria-label="Search the marketplace" placeholder="Search skills, MCP servers, plugins…" value={q} onChange={(e) => reset(() => setQ(e.target.value))} style={{ maxWidth: 360 }} />
        <Select aria-label="Type" value={type} onChange={(e) => reset(() => setType(e.target.value))} style={{ maxWidth: 180 }}>
          <option value="">All types</option>
          {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        <Select aria-label="Category" value={category} onChange={(e) => reset(() => setCategory(e.target.value))} style={{ maxWidth: 220 }}>
          <option value="">All categories</option>
          {(facets.data?.categories ?? []).filter((c) => c.count > 0).map((c) => <option key={c.slug} value={c.slug}>{c.label} ({c.count})</option>)}
        </Select>
        <Select aria-label="Technology" value={technology} onChange={(e) => reset(() => setTechnology(e.target.value))} style={{ maxWidth: 200 }}>
          <option value="">All technologies</option>
          {(facets.data?.technologies ?? []).map((t) => <option key={t.slug} value={t.slug}>{t.label} ({t.count})</option>)}
        </Select>
        {!noCurated && (
          <Button size="sm" variant="ghost" onClick={() => reset(() => setShowAll((v) => !v))}>{showAll ? 'Curated only' : 'Show all results'}</Button>
        )}
      </div>
      {noCurated && <Alert tone="info">No curated package matches{q ? ` “${q}”` : ''}. Showing community packages: check their trust level and permissions before installing.</Alert>}
      {view.error && <Alert tone="danger">{errorText(view.error)}</Alert>}
      {view.isLoading ? (
        <Spinner />
      ) : view.data?.items.length ? (
        <div className="grid grid-2">
          {view.data.items.map((p) => <PackageCard key={p.id} pkg={p} onInstall={onInstall} />)}
        </div>
      ) : (
        <EmptyState title="Nothing found">Try other words, or register your own package under My packages.</EmptyState>
      )}
      {(page > 1 || view.data?.hasMore) && (
        <div className="row">
          <Button size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="small muted">Page {page}</span>
          <Button size="sm" disabled={!view.data?.hasMore} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}

function PackageCard({ pkg: p, onInstall, children }: { pkg: PackageDto; onInstall?: (p: PackageDto) => void; children?: ReactNode }) {
  const { can } = useSession();
  return (
    <Card title={p.displayName} actions={<div className="row">{p.curated && <Badge tone="accent">curated</Badge>}<Badge tone={TRUST_TONE[p.trust] ?? 'neutral'}>{p.trust.toLowerCase()}</Badge></div>}>
      <div className="stack">
        <div className="row small" style={{ flexWrap: 'wrap' }}>
          <Badge tone="info">{TYPE_LABEL[p.type] ?? p.type}</Badge>
          <code>{p.ref}</code>
          <span className="muted">v{p.latestVersion} · {p.publisherName}{p.publisherVerified ? ' ✓' : ''} · {p.installs} installs</span>
        </div>
        {p.deprecated && <Alert tone="warn">Deprecated: {p.deprecated}</Alert>}
        {p.description && <p style={{ margin: 0 }}>{p.description}</p>}
        <ClassificationChips pkg={p} />
        <div className="small">
          <strong>Permissions:</strong> {p.permissions.length ? p.permissions.map((x) => <code key={x} style={{ marginRight: 6 }}>{x}</code>) : 'none'}
        </div>
        <div className="row">
          {onInstall && (can('capability.install') || can('capability.personal')) && <Button size="sm" onClick={() => onInstall(p)}>Install…</Button>}
          {children}
        </div>
      </div>
    </Card>
  );
}

function InstallDialog({ pkg, projects, onClose, onDone }: { pkg: PackageDto; projects: ProjectDto[]; onClose: () => void; onDone: () => void }) {
  const orgId = useOrgId();
  const { can } = useSession();
  const personalOnly = pkg.ownerKind === 'user' && pkg.visibility === 'PRIVATE';
  const [scope, setScope] = useState<Scope>(personalOnly || !can('capability.install') ? 'USER' : 'ORGANIZATION');
  const [projectId, setProjectId] = useState('');
  const install = useMutation({
    mutationFn: () => post(`/orgs/${orgId}/capability-installations`, { capabilityId: pkg.ref, scope, projectId: scope === 'PROJECT' ? projectId : undefined }),
    onSuccess: onDone,
  });
  const risky = pkg.permissions.some((p) => HIGH_RISK.includes(p)) || ['UNVERIFIED', 'COMMUNITY'].includes(pkg.trust);
  return (
    <Dialog open title={`Install ${pkg.displayName}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={install.isPending} disabled={scope === 'PROJECT' && !projectId} onClick={() => install.mutate()}>Install</Button></>}>
      <div className="stack">
        {install.error && <Alert tone="danger">{errorText(install.error)}</Alert>}
        <Alert tone={risky ? 'warn' : 'info'}>
          Publisher <strong>{pkg.publisherName}</strong>, trust <strong>{pkg.trust}</strong>{pkg.curated ? ', curated' : ''}. Requests: {pkg.permissions.join(', ') || 'no permissions'}. Organization policy may require approval.
        </Alert>
        <Field label="Install for">
          {(id) => (
            <Select id={id} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
              {can('capability.personal') && <option value="USER">Just me (my tasks in this organization)</option>}
              {!personalOnly && can('capability.install') && <option value="ORGANIZATION">Whole organization</option>}
              {!personalOnly && can('capability.install') && <option value="PROJECT">One project</option>}
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
      </div>
    </Dialog>
  );
}

/** Packages owned by this organization or by me: register versions, and publish them to the marketplace. */
function MyPackages({ onInstall }: { onInstall: (p: PackageDto) => void }) {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [owner, setOwner] = useState<'user' | 'organization'>(can('capability.manage') ? 'organization' : 'user');
  const [manifest, setManifest] = useState(EXAMPLE);
  const [readme, setReadme] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  const mine = useQuery({ queryKey: ['packages', orgId, 'mine'], queryFn: () => get<CatalogPage>(`/orgs/${orgId}/registry/packages?mine=true&limit=100`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['packages', orgId] });
  const register = useMutation({
    mutationFn: () =>
      post(`/orgs/${orgId}/capabilities`, {
        manifest: JSON.parse(manifest),
        owner,
        listing: readme.trim() || categories.length ? { ...(readme.trim() ? { readme } : {}), ...(categories.length ? { categories } : {}) } : undefined,
      }),
    onSuccess: () => {
      setOpen(false);
      refresh();
    },
  });
  const path = (p: PackageDto) => `/orgs/${orgId}/registry/packages/${p.namespace}/${p.name}`;
  const publish = useMutation({ mutationFn: ({ p, listed }: { p: PackageDto; listed: boolean }) => post(`${path(p)}/publish`, { listed }), onSuccess: refresh });
  const unpublish = useMutation({ mutationFn: (p: PackageDto) => post(`${path(p)}/unpublish`), onSuccess: refresh });
  const err = register.error ?? publish.error ?? unpublish.error;
  const findings = (err instanceof ApiError ? (err.context?.findings as Array<{ level: string; message: string }> | undefined) : undefined) ?? [];

  return (
    <div className="stack">
      <div className="row">
        {(can('capability.personal') || can('capability.manage')) && <Button variant="primary" onClick={() => setOpen(true)}>Register package or version</Button>}
        <span className="small muted">New packages are private to you or your organization. Publishing sends them for review before others can install them.</span>
      </div>
      {err && (
        <Alert tone="danger">
          {errorText(err)}
          {findings.length > 0 && <ul>{findings.map((f, i) => <li key={i}>{f.level}: {f.message}</li>)}</ul>}
        </Alert>
      )}
      {mine.isLoading ? (
        <Spinner />
      ) : mine.data?.items.length ? (
        <div className="grid grid-2">
          {mine.data.items.map((p) => (
            <PackageCard key={p.id} pkg={p} onInstall={onInstall}>
              <Badge tone="neutral">{p.visibility.toLowerCase()}</Badge>
              {p.review && <Badge tone={REVIEW_TONE[p.review.status] ?? 'neutral'}>review: {p.review.status.toLowerCase()}</Badge>}
              {p.source === 'native' && p.visibility !== 'PUBLIC' && p.review?.status !== 'PENDING' && (
                <Button size="sm" loading={publish.isPending} onClick={() => publish.mutate({ p, listed: true })}>Publish to marketplace</Button>
              )}
              {['PUBLIC', 'UNLISTED'].includes(p.visibility) && <Button size="sm" variant="ghost" onClick={() => unpublish.mutate(p)}>Unpublish</Button>}
              {p.review?.status === 'REJECTED' && p.review.notes && <div className="small muted">Reviewer: {p.review.notes}</div>}
            </PackageCard>
          ))}
        </div>
      ) : (
        <EmptyState title="No packages yet">Register a skill, MCP server or plugin manifest to use it yourself or across the organization.</EmptyState>
      )}

      <Dialog open={open} title="Register package or version" onClose={() => setOpen(false)} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={register.isPending} onClick={() => register.mutate()}>Register</Button></>}>
        <div className="stack">
          <Field label="Owner" hint="Personal packages are yours in every organization; organization packages belong to this organization.">
            {(id) => (
              <Select id={id} value={owner} onChange={(e) => setOwner(e.target.value as 'user' | 'organization')}>
                {can('capability.personal') && <option value="user">Me (personal)</option>}
                {can('capability.manage') && <option value="organization">This organization</option>}
              </Select>
            )}
          </Field>
          <Field label="Manifest (JSON)" hint="Same id with a higher version adds a version. Secret settings must be references like secret:NAME.">
            {(id) => <Textarea id={id} rows={14} className="mono" value={manifest} onChange={(e) => setManifest(e.target.value)} />}
          </Field>
          <Field label="Readme (Markdown, optional)" hint="Shown on the package page in the marketplace.">
            {(id) => <Textarea id={id} rows={6} value={readme} onChange={(e) => setReadme(e.target.value)} />}
          </Field>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
            <legend className="small"><strong>Categories (optional, up to 3)</strong> <span className="muted">Packages are categorized automatically; your choice is a strong hint.</span></legend>
            <div className="row small" style={{ flexWrap: 'wrap' }}>
              {CATEGORIES.filter((c) => c.slug !== 'other').map((c) => (
                <label key={c.slug} className="row small">
                  <input
                    type="checkbox"
                    checked={categories.includes(c.slug)}
                    disabled={!categories.includes(c.slug) && categories.length >= 3}
                    onChange={() => setCategories((cs) => (cs.includes(c.slug) ? cs.filter((x) => x !== c.slug) : [...cs, c.slug]))}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Dialog>
    </div>
  );
}
