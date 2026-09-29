import { useQuery } from '@tanstack/react-query';
import type { WorkerDto } from '@ao/contracts';
import { get } from '../../lib/api';
import { useOrgId } from '../../lib/session';
import { Badge, Card, Empty, Loading, Row, Screen, T, humanize } from '../../components/ui';

function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

export default function Workers() {
  const orgId = useOrgId();
  const q = useQuery({ queryKey: ['workers', orgId], queryFn: () => get<WorkerDto[]>(`/orgs/${orgId}/workers`), enabled: Boolean(orgId), refetchInterval: 30_000 });
  if (!q.data) return <Loading />;
  return (
    <Screen refreshing={q.isFetching} onRefresh={() => void q.refetch()}>
      {!q.data.length && <Empty text="No workers connected. Install and pair a worker from a computer." />}
      {q.data.map((w) => (
        <Card key={w.id} title={w.name} right={<Badge label={humanize(w.status)} tone={w.status === 'ONLINE' ? 'ok' : w.status === 'OFFLINE' ? 'neutral' : 'warn'} />}>
          <T muted small>{w.os} · {w.hostname} · heartbeat {ago(w.lastHeartbeatAt)}</T>
          <T small>Tasks {w.activeTaskIds.length}/{w.maxConcurrentTasks}{w.metrics ? ` · CPU ${w.metrics.cpuLoadPercent ?? '?'}% · RAM free ${w.metrics.freeMemoryMb ?? '?'} MB` : ''}</T>
          <Row>
            {w.agents.filter((a) => a.installed).map((a) => <Badge key={a.id} label={a.id} tone="accent" />)}
            {w.providers.map((p) => <Badge key={p.id} label={`${p.id}${p.limited ? ' (limited)' : ''}`} tone={p.limited ? 'warn' : p.healthy ? 'ok' : 'danger'} />)}
          </Row>
        </Card>
      ))}
    </Screen>
  );
}
