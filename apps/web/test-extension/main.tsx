// Fixture for tests/e2e/web-extension.test.ts: the dashboard rendered with a WebExtension, as a distribution does.
import { useQuery } from '@tanstack/react-query';
import type { OverviewDto } from '@ao/contracts';
import { Card } from '@ao/ui';
import { renderWebApp } from '../src/app';
import { PageHeader } from '../src/Layout';
import { get } from '../src/lib/api';
import { useOrgId } from '../src/lib/session';

function ExtraPage() {
  const orgId = useOrgId();
  const overview = useQuery({ queryKey: ['fixture-overview', orgId], queryFn: () => get<OverviewDto>(`/orgs/${orgId}/overview`) });
  return (
    <>
      <PageHeader title="Extension page" description="Added by a WebExtension" />
      <Card title="Uses the core API client">{overview.isSuccess ? `active tasks: ${overview.data.activeTasks}` : 'loading'}</Card>
    </>
  );
}

renderWebApp({
  routes: [{ path: '/extension-page', element: <ExtraPage /> }],
  nav: [
    { section: 'organization', to: '/extension-page', label: 'Extension page' },
    { section: 'organization', to: '/owners-only', label: 'Owners only', visible: (c) => c.can('billing.manage') },
    { section: 'server', to: '/extension-admin', label: 'Extension admin' },
  ],
  Banner: () => <div role="status">Extension banner</div>,
});
