import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCheck } from 'lucide-react';
import type { NotificationDto } from '@ao/contracts';
import { Badge, Button, Card, EmptyState, Skeleton, cn, timeAgo } from '@ao/ui';
import { get, post } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';

export function NotificationsPage() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notifications', orgId, 'list'], queryFn: () => get<{ items: NotificationDto[]; unread: number }>(`/orgs/${orgId}/notifications?limit=100`) });
  const read = useMutation({
    mutationFn: (ids: string[] | 'all') => post(`/orgs/${orgId}/notifications/read`, { ids }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications', orgId] }),
  });
  return (
    <div className="max-w-[920px]">
      <PageHeader
        title="Notifications"
        description={q.data ? (q.data.unread ? `${q.data.unread} unread` : 'Nothing unread') : undefined}
        actions={q.data?.unread ? <Button onClick={() => read.mutate('all')}><CheckCheck aria-hidden="true" />Mark all read</Button> : null}
      />
      <Card padded={false}>
        {q.isLoading ? (
          <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading notifications…">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}
          </div>
        ) : q.data?.items.length ? (
          <ul className="divide-y divide-line">
            {q.data.items.map((n) => (
              <li key={n.id} className="relative flex items-start gap-3 px-4 py-2.5">
                {!n.read && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand" aria-hidden="true" />}
                <div className={cn('min-w-0 flex-1', n.read ? 'text-fg-2' : 'font-semibold')}>
                  {n.taskId ? <Link to={`/tasks/${n.taskId}`} className={n.read ? 'text-fg-2' : 'text-fg'} onClick={() => !n.read && read.mutate([n.id])}>{n.title}</Link> : n.workerId ? <Link to={`/workers/${n.workerId}`} className={n.read ? 'text-fg-2' : 'text-fg'}>{n.title}</Link> : n.title}
                  {!n.read && <span className="sr-only"> (unread)</span>}
                  {n.body && <div className="text-xs font-normal text-fg-3">{n.body}</div>}
                </div>
                <Badge plain>{n.type.replace('.', ' ')}</Badge>
                <span className="w-16 flex-none text-right text-xs text-fg-3 tabular-nums">{timeAgo(n.createdAt)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={BellOff} title="You're all caught up">Tasks that finish, fail or wait for you are announced here.</EmptyState>
        )}
      </Card>
    </div>
  );
}
