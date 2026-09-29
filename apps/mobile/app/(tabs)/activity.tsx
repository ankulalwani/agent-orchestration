import { Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { NotificationDto } from '@ao/contracts';
import { get, post } from '../../lib/api';
import { useOrgId } from '../../lib/session';
import { Button, Empty, Loading, Screen, T, useTheme } from '../../components/ui';

export default function Activity() {
  const orgId = useOrgId();
  const qc = useQueryClient();
  const router = useRouter();
  const t = useTheme();
  const q = useQuery({ queryKey: ['notifications', orgId, 'list'], queryFn: () => get<{ items: NotificationDto[]; unread: number }>(`/orgs/${orgId}/notifications?limit=100`), enabled: Boolean(orgId) });
  const read = useMutation({ mutationFn: (ids: string[] | 'all') => post(`/orgs/${orgId}/notifications/read`, { ids }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifications', orgId] }) });
  if (!q.data) return <Loading />;
  return (
    <Screen refreshing={q.isFetching} onRefresh={() => void q.refetch()}>
      {q.data.unread > 0 && <Button label="Mark all as read" onPress={() => read.mutate('all')} />}
      {!q.data.items.length && <Empty text="You're all caught up" />}
      {q.data.items.map((n) => (
        <Pressable
          key={n.id}
          accessibilityRole={n.taskId ? 'link' : 'text'}
          onPress={() => {
            if (!n.read) read.mutate([n.id]);
            if (n.taskId) router.push(`/task/${n.taskId}`);
          }}
          style={{ backgroundColor: t.surface, borderColor: n.read ? t.border : t.accent, borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 }}
        >
          <T bold={!n.read}>{n.title}</T>
          {n.body ? <T muted small>{n.body}</T> : null}
          <T muted small>{new Date(n.createdAt).toLocaleString()}</T>
        </Pressable>
      ))}
    </Screen>
  );
}
