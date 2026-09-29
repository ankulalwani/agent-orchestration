import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto } from '@ao/contracts';
import { Badge, Button, Card, EmptyState, Spinner, timeAgo } from '@ao/ui';
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
    <div>
      <PageHeader title="Notifications" actions={q.data?.unread ? <Button onClick={() => read.mutate('all')}>Mark all read</Button> : null} />
      <Card padded={false}>
        {q.isLoading ? (
          <div className="card-body"><Spinner /></div>
        ) : q.data?.items.length ? (
          <table className="table">
            <tbody>
              {q.data.items.map((n) => (
                <tr key={n.id} style={{ fontWeight: n.read ? 400 : 600 }}>
                  <td>
                    {n.taskId ? <Link to={`/tasks/${n.taskId}`} onClick={() => !n.read && read.mutate([n.id])}>{n.title}</Link> : n.workerId ? <Link to={`/workers/${n.workerId}`}>{n.title}</Link> : n.title}
                    {n.body && <div className="small muted" style={{ fontWeight: 400 }}>{n.body}</div>}
                  </td>
                  <td><Badge>{n.type.replace('.', ' ')}</Badge></td>
                  <td className="small muted">{timeAgo(n.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState title="You're all caught up" />
        )}
      </Card>
    </div>
  );
}
