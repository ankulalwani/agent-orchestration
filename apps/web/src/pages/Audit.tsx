import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, Card, EmptyState, Input, Spinner } from '@ao/ui';
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
        <Input id="audit-action" placeholder="Filter by exact action, e.g. task.cancel" value={action} onChange={(e) => setAction(e.target.value)} />
      </div>
      <Card padded={false}>
        {q.isLoading ? (
          <div className="card-body"><Spinner /></div>
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
                    <td className="small">{new Date(a.createdAt).toLocaleString()}</td>
                    <td className="small">{a.actorType}{a.actorId ? <div className="mono muted">{a.actorId}</div> : null}</td>
                    <td><code>{a.action}</code></td>
                    <td className="small">{a.targetType ? `${a.targetType} ${a.targetId ?? ''}` : '—'}</td>
                    <td className="hide-mobile small mono muted"><span className="truncate">{Object.keys(a.metadata).length ? JSON.stringify(a.metadata) : ''}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No audit entries" />
        )}
        {q.hasNextPage && <div className="card-body"><Button onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>Load more</Button></div>}
      </Card>
    </div>
  );
}
