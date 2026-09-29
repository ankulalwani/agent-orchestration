import { useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { TaskDto } from '@ao/contracts';
import { get } from '../../lib/api';
import { useOrgId } from '../../lib/session';
import { Empty, Loading, Row, StatusBadge, T, useTheme } from '../../components/ui';

const FILTERS: Array<[string, string]> = [
  ['All', ''],
  ['Active', 'CLAIMING,PREPARING,RUNNING,VERIFYING'],
  ['Needs action', 'WAITING_FOR_INPUT,WAITING_FOR_APPROVAL,RECOVERY_REQUIRED,CRASHED'],
  ['Waiting', 'QUEUED,PAUSED,WAITING_FOR_LIMIT'],
  ['Done', 'COMPLETED'],
  ['Failed', 'FAILED,CANCELLED'],
];

export default function Tasks() {
  const orgId = useOrgId();
  const router = useRouter();
  const t = useTheme();
  const [filter, setFilter] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['tasks', orgId, filter],
    initialPageParam: '',
    enabled: Boolean(orgId),
    queryFn: ({ pageParam }) => get<{ items: TaskDto[]; nextCursor: string | null }>(`/orgs/${orgId}/tasks?limit=30${filter ? `&status=${filter}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (l) => l.nextCursor ?? undefined,
    refetchInterval: 30_000,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 12, gap: 8 }}>
        {FILTERS.map(([label, value]) => (
          <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected: filter === value }} onPress={() => setFilter(value)} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: filter === value ? t.accent : t.border, backgroundColor: filter === value ? t.accentSoft : t.surface }}>
            <Text style={{ color: filter === value ? t.accent : t.text2, fontWeight: '600' }}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {q.isLoading ? (
        <Loading />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(x) => x.id}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} />}
          onEndReached={() => q.hasNextPage && void q.fetchNextPage()}
          ListEmptyComponent={<Empty text="No tasks" />}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 24, gap: 8 }}
          renderItem={({ item }) => (
            <Pressable accessibilityRole="link" onPress={() => router.push(`/task/${item.id}`)} style={{ backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold style={{ flexShrink: 1 }}>{item.title}</T>
                <StatusBadge status={item.status} />
              </Row>
              {item.statusReason && item.status !== 'COMPLETED' ? <T muted small>{item.statusReason}</T> : null}
              {item.kind && item.kind !== 'code' ? <T muted small>{item.kind === 'review' ? 'Review' : 'Plan'}{item.kind === 'plan' && item.status === 'COMPLETED' && !item.planApplied ? ' · ready to create its tasks' : ''}</T> : null}
              {item.source ? <T muted small>From {item.source.name}</T> : null}
              {item.agentId ? <T muted small>{item.agentId} · {item.providerId} · {item.modelId}</T> : null}
            </Pressable>
          )}
        />
      )}
    </View>
  );
}
