import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ProjectDto } from '@ao/contracts';
import { Select, Tabs } from '@ao/ui';
import { get } from '../lib/api';
import { useOrgId } from '../lib/session';
import { PageHeader } from '../Layout';
import { CostView, FlowView, OverviewView, ReliabilityView, WorkersView } from './insights/views';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'cost', label: 'Cost' },
  { id: 'workers', label: 'Workers' },
  { id: 'reliability', label: 'Reliability' },
  { id: 'flow', label: 'Flow' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/** What finished, what it cost, which workers did it, what went wrong and how long it took. */
export function InsightsPage() {
  const orgId = useOrgId();
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((t) => t.id === params.get('view'))?.id ?? 'overview';
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({ queryKey: ['projects', orgId], queryFn: () => get<ProjectDto[]>(`/orgs/${orgId}/projects`) });
  const filter = { days, projectId };

  return (
    <div className="stack">
      <PageHeader
        title="Insights"
        description="What finished, how often it passed your checks, what it cost and where it got stuck."
        actions={
          <>
            <Select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
            <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last 365 days</option>
            </Select>
          </>
        }
      />
      <Tabs tabs={[...TABS]} value={tab} onChange={(t) => setParams(t === 'overview' ? {} : { view: t }, { replace: true })} label="Insights views" />
      {tab === 'overview' && <OverviewView filter={filter} />}
      {tab === 'cost' && <CostView filter={filter} />}
      {tab === 'workers' && <WorkersView filter={filter} />}
      {tab === 'reliability' && <ReliabilityView filter={filter} />}
      {tab === 'flow' && <FlowView filter={filter} />}
    </div>
  );
}
