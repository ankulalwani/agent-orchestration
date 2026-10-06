import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { AnalyticsDto, AnalyticsReliabilityDto, AnalyticsWorkersDto } from '@ao/contracts';
import { FAILURE_CATEGORY_LABELS, type FailureCategory } from '@ao/core/shared';
import { get } from '../../lib/api';
import { useOrgId } from '../../lib/session';
import { Card, Empty, Loading, Row, Screen, T, useTheme } from '../../components/ui';

const PERIODS = [7, 30, 90];
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const usd = (v: number | null) => (v == null ? '—' : `$${v.toFixed(2)}`);
function dur(ms: number | null) {
  if (ms == null) return '—';
  const m = Math.round(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Insights, read-only: outcomes and cost of finished tasks, why tasks stopped, and what each worker did. */
export default function Insights() {
  const orgId = useOrgId();
  const t = useTheme();
  const [days, setDays] = useState(30);
  const view = <D,>(path: string) => ({ queryKey: ['analytics', path, orgId, days], queryFn: () => get<D>(`/orgs/${orgId}/analytics${path}?days=${days}`), enabled: Boolean(orgId), refetchInterval: 60_000 });
  const overview = useQuery(view<AnalyticsDto>(''));
  const reliability = useQuery(view<AnalyticsReliabilityDto>('/reliability'));
  const workers = useQuery(view<AnalyticsWorkersDto>('/workers'));
  if (!overview.data) return <Loading />;
  const a = overview.data.totals;
  const stats: Array<[string, string]> = [
    ['Finished', String(a.finished)],
    ['Success', pct(a.successRate)],
    ['First pass', pct(a.firstPassRate)],
    ['Cost', usd(a.costUsd)],
    ['Per completed', usd(a.costPerCompletedUsd)],
    ['Agent time', dur(a.avgActiveMs)],
  ];
  const refetch = () => void Promise.all([overview.refetch(), reliability.refetch(), workers.refetch()]);
  const line = { paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.border, justifyContent: 'space-between' as const };
  return (
    <Screen refreshing={overview.isFetching} onRefresh={refetch}>
      <Row>
        {PERIODS.map((d) => (
          <Pressable key={d} accessibilityRole="button" accessibilityState={{ selected: days === d }} onPress={() => setDays(d)} style={{ paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: days === d ? t.accent : t.border, backgroundColor: t.surface }}>
            <T small bold={days === d} style={{ color: days === d ? t.accent : t.text }}>{`${d} days`}</T>
          </Pressable>
        ))}
      </Row>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {stats.map(([label, value]) => (
          <View key={label} style={{ width: '31%', flexGrow: 1, backgroundColor: t.surface, borderColor: t.border, borderWidth: 1, borderRadius: 12, padding: 12 }} accessible accessibilityLabel={`${label}: ${value}`}>
            <T muted small>{label}</T>
            <T bold style={{ fontSize: 20 }}>{value}</T>
          </View>
        ))}
      </View>
      <Card title="Why tasks stopped">
        {reliability.data?.byCategory.length ? (
          reliability.data.byCategory.map((c) => (
            <Row key={c.category} style={line}>
              <T style={{ flexShrink: 1 }}>{FAILURE_CATEGORY_LABELS[c.category as FailureCategory] ?? c.category}</T>
              <T muted small>{`${c.stops} stopped · ${c.stillStopped} still`}</T>
            </Row>
          ))
        ) : (
          <Empty text={reliability.data ? 'No task stopped in this period' : 'Loading…'} />
        )}
      </Card>
      <Card title="Workers">
        {workers.data?.workers.length ? (
          workers.data.workers.map((w) => (
            <View key={w.workerId} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: t.border, gap: 2 }}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold style={{ flexShrink: 1 }}>{w.name}</T>
                <T small>{`${w.finished} finished · ${pct(w.successRate)}`}</T>
              </Row>
              <T muted small>{`Agent time ${dur(w.sessionMs)} · online ${pct(w.onlineShare)} · used ${pct(w.utilization)} · ${usd(w.costUsd)}`}</T>
            </View>
          ))
        ) : (
          <Empty text={workers.data ? 'No workers yet' : 'Loading…'} />
        )}
      </Card>
    </Screen>
  );
}
