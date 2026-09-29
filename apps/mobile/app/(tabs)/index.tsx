import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import type { OverviewDto } from '@ao/contracts';
import { get } from '../../lib/api';
import { useOrgId, useSession } from '../../lib/session';
import { Card, Empty, Loading, Row, Screen, StatusBadge, T, useTheme } from '../../components/ui';

/** Dashboard (spec §53, §80): what runs, what waits, what needs a human. */
export default function Dashboard() {
  const orgId = useOrgId();
  const { org } = useSession();
  const router = useRouter();
  const t = useTheme();
  const q = useQuery({ queryKey: ['overview', orgId], queryFn: () => get<OverviewDto>(`/orgs/${orgId}/overview`), enabled: Boolean(orgId), refetchInterval: 30_000 });
  if (!q.data) return <Loading />;
  const o = q.data;
  const stats: Array<[string, number, boolean?]> = [
    ['Active', o.activeTasks],
    ['Waiting', o.waitingTasks],
    ['Done today', o.completedToday],
    ['Failed', o.failedTasks, o.failedTasks > 0],
    ['Recovery', o.recoveryRequired, o.recoveryRequired > 0],
    ['Workers online', o.workersOnline],
  ];
  return (
    <Screen refreshing={q.isFetching} onRefresh={() => void q.refetch()}>
      <T muted small>{org?.organizationName}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {stats.map(([label, value, bad]) => (
          <View key={label} style={{ width: '31%', flexGrow: 1, backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 12, padding: 12 }} accessible accessibilityLabel={`${label}: ${value}`}>
            <T muted small>{label}</T>
            <T bold style={{ fontSize: 22, color: bad ? t.danger : t.text }}>{value}</T>
          </View>
        ))}
      </View>
      <Card title="Needs attention">
        {o.needsAttention.length ? (
          o.needsAttention.map((n) => (
            <Pressable key={n.taskId} accessibilityRole="link" onPress={() => router.push(`/task/${n.taskId}`)} style={{ paddingVertical: 8, gap: 4, borderTopWidth: 1, borderTopColor: t.border }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold style={{ flexShrink: 1 }}>{n.title}</T>
                <StatusBadge status={n.status} />
              </Row>
              {n.reason ? <T muted small>{n.reason}</T> : null}
            </Pressable>
          ))
        ) : (
          <Empty text="Nothing needs you right now" />
        )}
      </Card>
      {o.workersOffline > 0 && (
        <Card title="Workers offline">
          <T>{o.workersOffline} worker{o.workersOffline > 1 ? 's are' : ' is'} offline. Tasks on them are recovered after their lease expires.</T>
        </Card>
      )}
    </Screen>
  );
}
