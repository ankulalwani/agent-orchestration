import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Card, Spinner } from '@ao/ui';
import { ApiError, get, post } from '../lib/api';
import { PageHeader } from '../Layout';

interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  releaseUrl: string | null;
  repo: string;
  canApply: boolean;
}

/** Updates the server itself: compare with the newest published version, then redeploy through the platform's hook. */
export function AdminUpdatesPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['updates'], queryFn: () => get<UpdateStatus>('/admin/updates') });
  const [requested, setRequested] = useState(false);
  const check = useMutation({ mutationFn: () => post<UpdateStatus>('/admin/updates/check'), onSuccess: (r) => qc.setQueryData(['updates'], r) });
  const apply = useMutation({ mutationFn: () => post('/admin/updates/apply'), onSuccess: () => setRequested(true) });
  if (status.isLoading) return <Spinner />;
  if (status.error) return <Alert tone="danger">{(status.error as ApiError).message}</Alert>;
  const s = status.data!;
  const error = check.error ?? apply.error;
  return (
    <div className="stack">
      <PageHeader title="Updates" description="Keep this server on the newest version. Nothing is checked in the background: this page contacts GitHub only when you press Check." />
      {error && <Alert tone="danger">{(error as ApiError).message}</Alert>}
      {requested && <Alert tone="info">Update requested. The server restarts in a moment; this page reconnects on its own once the new version is up.</Alert>}
      <Card title="Server version">
        <div className="stack">
          <p style={{ margin: 0 }}>
            Installed <code>{s.current}</code>
            {s.latest && <> · newest <code>{s.latest}</code> {s.updateAvailable ? <Badge tone="warn">update available</Badge> : <Badge tone="ok">up to date</Badge>}</>}
          </p>
          {s.checkedAt && <p className="small muted" style={{ margin: 0 }}>Checked {new Date(s.checkedAt).toLocaleString()} against {s.repo}{s.releaseUrl && <> · <a href={s.releaseUrl} target="_blank" rel="noreferrer">what changed</a></>}</p>}
          <div className="row">
            <Button loading={check.isPending} onClick={() => check.mutate()}>Check for updates</Button>
            {s.canApply && (
              <Button variant="primary" loading={apply.isPending} disabled={requested} onClick={() => window.confirm('Redeploy now? The server restarts and is unavailable for a short time. Running tasks continue on their workers.') && apply.mutate()}>
                {s.updateAvailable ? `Update to ${s.latest}` : 'Redeploy the newest image'}
              </Button>
            )}
          </div>
          {!s.canApply && (
            <div className="small muted">
              <p style={{ margin: '0 0 4px' }}>One-click update is off. Set <code>UPDATE_WEBHOOK_URL</code> to your platform's redeploy hook (Easypanel: service → Deploy webhook; Coolify, Portainer: the service webhook) to enable the button. Until then:</p>
              <ul style={{ margin: 0 }}>
                <li>Docker Compose: <code>docker compose pull &amp;&amp; docker compose up -d</code></li>
                <li>Easypanel / Coolify: open the service and press Deploy (use the <code>latest</code> image tag, or change the tag to {s.latest ?? 'the new version'}).</li>
              </ul>
            </div>
          )}
        </div>
      </Card>
      <Card title="Workers">
        <p className="small muted" style={{ margin: 0 }}>
          New worker versions are published to this server automatically by the release workflow and signed with the server's key (see Worker releases). Machines already running a worker update from the worker's own Updates page; new machines install the newest one with the one-line command.
        </p>
      </Card>
    </div>
  );
}
