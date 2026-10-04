import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText, Search } from 'lucide-react';
import { Button, Card, EmptyState, Input, Skeleton } from '@ao/ui';
import { get } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';

interface AuditEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

/** Audit log (spec §60). Read-only; entries are immutable. */
export function AuditPage() {
  const orgId = useOrgId();
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', orgId, action],
    initialPageParam: '',
    queryFn: ({ pageParam }) => get<{ items: AuditEntry[]; nextCursor: string | null }>(`/orgs/${orgId}/audit?limit=100${pageParam ? `&cursor=${pageParam}` : ''}${action ? `&action=${encodeURIComponent(action)}` : ''}`),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div>
      <PageHeader title="Audit log" description="Who did what, when. Entries cannot be edited or deleted." />
      <div className="filters">
        <label className="sr-only" htmlFor="audit-action">Action</label>
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" aria-hidden="true" />
          <Input id="audit-action" className="!w-full pl-8 font-mono !text-xs" placeholder="Filter by exact action, e.g. task.cancel" value={action} onChange={(e) => setAction(e.target.value)} />
        </div>
      </div>
      <Card padded={false}>
        {q.isLoading ? (
          <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading audit log…">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7" />)}
          </div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th className="hide-mobile">Details</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id}>
                    <td className="num text-xs text-fg-2">{new Date(a.createdAt).toLocaleString()}</td>
                    <td className="text-xs">{a.actorType}{a.actorId ? <div className="mono muted">{a.actorId}</div> : null}</td>
                    <td><code>{a.action}</code></td>
                    <td className="text-xs">{a.targetType ? <>{a.targetType} <span className="mono muted">{a.targetId ?? ''}</span></> : '—'}</td>
                    <td className="hide-mobile max-w-[360px]"><span className="mono muted block truncate" title={Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : undefined}>{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : ''}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={ScrollText} title="No audit entries">{action ? 'Nothing recorded for that action. The filter matches the exact action name.' : 'Actions people and workers take in this organization are recorded here.'}</EmptyState>
        )}
        {q.hasNextPage && <div className="border-t border-line p-3 text-center"><Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button></div>}
      </Card>
    </div>
  );
}
