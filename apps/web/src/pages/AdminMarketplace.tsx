import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PackageDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner, Textarea } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';
import { TRUST_TONE } from './Capabilities';
import { CATEGORIES } from '@ao/core/shared';
import { categoryLabel } from '../components/CapabilitySuggestions';
import { PlatformStacks } from '../components/Stacks';

interface CatalogPage {
  items: PackageDto[];
  hasMore: boolean;
}

/** Marketplace administration for platform administrators: publish reviews, curation, and mirroring the MCP Registry. */
export function AdminMarketplacePage() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [trust, setTrust] = useState<Record<string, string>>({});
  const [ranks, setRanks] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [importUrl, setImportUrl] = useState('https://registry.modelcontextprotocol.io/v0/servers');
  const [pages, setPages] = useState('10');

  const reviews = useQuery({ queryKey: ['admin-reviews'], queryFn: () => get<PackageDto[]>('/admin/registry/reviews') });
  const catalog = useQuery({ queryKey: ['admin-catalog', q], queryFn: () => get<CatalogPage>(`/orgs/${orgId}/registry/packages?tier=all&limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-reviews'] });
    void qc.invalidateQueries({ queryKey: ['admin-catalog'] });
    void qc.invalidateQueries({ queryKey: ['packages'] });
  };
  const path = (p: PackageDto) => `/admin/registry/packages/${p.namespace}/${p.name}`;
  const review = useMutation({
    mutationFn: ({ p, decision }: { p: PackageDto; decision: 'approve' | 'reject' }) => post(`${path(p)}/review`, { decision, notes: notes[p.id] ?? '', trust: trust[p.id] || undefined }),
    onSuccess: refresh,
  });
  const curate = useMutation({ mutationFn: ({ p, curated, rank }: { p: PackageDto; curated: boolean; rank?: number }) => post(`${path(p)}/curate`, { curated, rank }), onSuccess: refresh });
  const importer = useMutation({
    mutationFn: () => post<{ created: number; updated: number; unchanged: number; skipped: number; nextCursor: string | null }>('/admin/registry/import/mcp-registry', { url: importUrl, maxPages: Number(pages) || 1 }),
    onSuccess: refresh,
  });
  const categorize = useMutation({ mutationFn: ({ p, categories }: { p: PackageDto; categories: string[] | null }) => post(`${path(p)}/categories`, { categories }), onSuccess: refresh });
  const reclassify = useMutation({ mutationFn: (all: boolean) => post<{ classified: number; version: number }>('/admin/registry/reclassify', { all }), onSuccess: refresh });
  const err = reviews.error ?? review.error ?? curate.error ?? importer.error ?? categorize.error ?? reclassify.error;

  return (
    <div className="stack">
      <PageHeader title="Marketplace" description="Review publish requests, choose curated packages (shown first to everyone), and mirror public registries." />
      {err && <Alert tone="danger">{err instanceof ApiError ? err.message : 'Something went wrong'}</Alert>}

      <Card title={`Waiting for review (${reviews.data?.length ?? 0})`} padded={false}>
        {reviews.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : reviews.data?.length ? (
          <table className="table" aria-label="Publish requests">
            <tbody>
              {reviews.data.map((p) => (
                <tr key={p.id}>
                  <td style={{ width: '45%' }}>
                    <strong>{p.displayName}</strong> <code className="small">{p.ref}</code> <span className="small muted">v{p.latestVersion} · {p.review?.listed ? 'listed' : 'unlisted'}</span>
                    <div className="small">{p.description}</div>
                    <div className="small">Permissions: {p.permissions.join(', ') || 'none'}</div>
                    {p.review?.findings.map((f, i) => <div key={i} className="small"><Badge tone={f.level === 'block' ? 'danger' : 'warn'}>{f.code}</Badge> {f.message}</div>)}
                  </td>
                  <td>
                    <div className="stack">
                      <Select aria-label="Trust" value={trust[p.id] ?? ''} onChange={(e) => setTrust({ ...trust, [p.id]: e.target.value })}>
                        <option value="">Trust: community (default)</option>
                        <option value="VERIFIED">Verified</option>
                        <option value="OFFICIAL">Official</option>
                      </Select>
                      <Textarea aria-label="Notes for the publisher" rows={2} placeholder="Notes for the publisher" value={notes[p.id] ?? ''} onChange={(e) => setNotes({ ...notes, [p.id]: e.target.value })} />
                      <div className="row">
                        <Button size="sm" variant="primary" onClick={() => review.mutate({ p, decision: 'approve' })}>Approve</Button>
                        <Button size="sm" variant="danger" onClick={() => review.mutate({ p, decision: 'reject' })}>Reject</Button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body"><EmptyState title="No publish requests" /></div>
        )}
      </Card>

      <Card title="Curation" padded={false}>
        <div className="card-body">
          <Input aria-label="Search packages" placeholder="Search public packages to curate" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
        </div>
        {catalog.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : (
          <table className="table" aria-label="Packages">
            <thead>
              <tr><th>Package</th><th>Category</th><th>Trust</th><th>Installs</th><th /></tr>
            </thead>
            <tbody>
              {catalog.data?.items.filter((p) => p.visibility === 'PUBLIC').map((p) => (
                <tr key={p.id}>
                  <td>{p.displayName} <code className="small">{p.ref}</code> {p.curated && <Badge tone="accent">curated #{p.curatedRank ?? '–'}</Badge>}</td>
                  <td>
                    <Select
                      aria-label={`Category for ${p.ref}`}
                      value=""
                      onChange={(e) => e.target.value && categorize.mutate({ p, categories: e.target.value === 'auto' ? null : [e.target.value] })}
                      style={{ maxWidth: 200 }}
                    >
                      <option value="">{p.categories.map(categoryLabel).join(', ') || '–'}</option>
                      <option value="auto">Automatic</option>
                      {CATEGORIES.map((c) => <option key={c.slug} value={c.slug}>Set: {c.label}</option>)}
                    </Select>
                  </td>
                  <td><Badge tone={TRUST_TONE[p.trust] ?? 'neutral'}>{p.trust.toLowerCase()}</Badge></td>
                  <td>{p.installs}</td>
                  <td style={{ textAlign: 'right' }}>
                    {p.curated ? (
                      <Button size="sm" onClick={() => curate.mutate({ p, curated: false })}>Remove from curated</Button>
                    ) : (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <Input aria-label={`Rank for ${p.ref}`} type="number" min={0} placeholder="Rank" title="Lower shows first; empty sorts after ranked ones" value={ranks[p.id] ?? ''} onChange={(e) => setRanks({ ...ranks, [p.id]: e.target.value })} style={{ width: 90 }} />
                        <Button size="sm" variant="primary" onClick={() => curate.mutate({ p, curated: true, rank: ranks[p.id] ? Number(ranks[p.id]) : undefined })}>Curate</Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <PlatformStacks />

      <Card title="Categorization">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>
            Packages are categorized automatically when they are registered, edited or mirrored, and again whenever the rules change (at startup). A category you set on a package above always wins.
          </p>
          <div className="row">
            <Button loading={reclassify.isPending && reclassify.variables === false} onClick={() => reclassify.mutate(false)}>Categorize outdated packages</Button>
            <Button variant="ghost" loading={reclassify.isPending && reclassify.variables === true} onClick={() => reclassify.mutate(true)}>Recategorize everything</Button>
          </div>
          {reclassify.data && <Alert tone="info">Categorized {reclassify.data.classified} packages (rules version {reclassify.data.version}).</Alert>}
        </div>
      </Card>

      <Card title="Mirror the MCP Registry">
        <div className="stack">
          <p className="small muted" style={{ margin: 0 }}>Copies server metadata only. Mirrored servers are unverified until you curate them or raise their trust; names already used here are never overwritten.</p>
          <Field label="Registry URL">{(id) => <Input id={id} value={importUrl} onChange={(e) => setImportUrl(e.target.value)} />}</Field>
          <Field label="Pages (100 servers each)">{(id) => <Input id={id} type="number" min={1} max={1000} value={pages} onChange={(e) => setPages(e.target.value)} style={{ maxWidth: 120 }} />}</Field>
          <div><Button variant="primary" loading={importer.isPending} onClick={() => importer.mutate()}>Import</Button></div>
          {importer.data && (
            <Alert tone="info">
              Created {importer.data.created}, updated {importer.data.updated}, unchanged {importer.data.unchanged}, skipped {importer.data.skipped}.{importer.data.nextCursor ? ' More pages remain; run it again to continue.' : ''}
            </Alert>
          )}
        </div>
      </Card>
    </div>
  );
}
