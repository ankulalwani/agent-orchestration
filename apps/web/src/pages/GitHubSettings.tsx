import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GithubStatusDto } from '@ao/contracts';
import { Alert, Badge, Button, Card, Field, Input, Spinner, timeAgo } from '@ao/ui';
import { ApiError, del, get, post } from '../lib/api';
import { useOrgId, useSession } from '../lib/session';

const REDIRECT_ERRORS: Record<string, string> = {
  state: 'That link expired or was already used. Start again from this page.',
  github: 'GitHub did not complete the request. Try again; if it keeps failing, check the server log.',
  app_mismatch: 'That installation belongs to a different GitHub App.',
  not_installed: 'The app is not installed on that account.',
};

/** Posts the app manifest to GitHub in the browser (GitHub's app-manifest flow is a form POST). */
function postManifest(postUrl: string, manifest: string) {
  const form = document.createElement('form');
  form.method = 'post';
  form.action = postUrl;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
}

export function useGithubStatus() {
  const orgId = useOrgId();
  return useQuery({ queryKey: ['github', orgId], queryFn: () => get<GithubStatusDto>(`/orgs/${orgId}/github`) });
}

/** Settings → GitHub: create the organization's GitHub App, install it, sync repositories into projects. */
export function GitHubSettings() {
  const orgId = useOrgId();
  const { can } = useSession();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const status = useGithubStatus();
  const [organization, setOrganization] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['github', orgId] });
  const manifest = useMutation({
    mutationFn: () => post<{ postUrl: string; manifest: string }>(`/orgs/${orgId}/github/app/manifest`, { organization: organization.trim() || undefined, public: isPublic }),
    onSuccess: (r) => postManifest(r.postUrl, r.manifest),
  });
  const install = useMutation({ mutationFn: () => post<{ url: string }>(`/orgs/${orgId}/github/installations`), onSuccess: (r) => void (window.location.href = r.url) });
  const connect = useMutation({ mutationFn: () => post<{ url: string }>(`/orgs/${orgId}/github/user`), onSuccess: (r) => void (window.location.href = r.url) });
  const disconnect = useMutation({ mutationFn: () => del(`/orgs/${orgId}/github/user`), onSuccess: refresh });
  const sync = useMutation({
    mutationFn: () => post<{ repositories: number; projectsCreated: number; errors: string[] }>(`/orgs/${orgId}/github/sync`),
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ['projects', orgId] });
    },
  });
  const forget = useMutation({ mutationFn: (id: number) => del(`/orgs/${orgId}/github/installations/${id}`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => del(`/orgs/${orgId}/github/app`), onSuccess: refresh });
  const admin = can('settings.manage');
  const error = (manifest.error ?? install.error ?? connect.error ?? disconnect.error ?? sync.error ?? forget.error ?? remove.error) as ApiError | null;

  if (status.isLoading) return <Spinner />;
  const st = status.data;
  if (!st) return <Alert tone="danger">{(status.error as ApiError)?.message ?? 'Could not load the GitHub settings'}</Alert>;
  const redirectError = params.get('error');

  return (
    <div className="stack">
      {redirectError && <Alert tone="danger">{REDIRECT_ERRORS[redirectError] ?? 'The GitHub request did not complete.'}</Alert>}
      {params.get('created') && <Alert>GitHub App <strong>{params.get('created')}</strong> created. Now install it on the accounts whose repositories you want here.</Alert>}
      {params.get('installed') && <Alert>Installed on <strong>{params.get('installed')}</strong>. Its repositories are being added as projects.</Alert>}
      {params.get('connected') && <Alert>Connected to GitHub as <strong>{params.get('connected')}</strong>.</Alert>}
      {error && <Alert tone="danger">{error.message}</Alert>}

      {!st.app ? (
        <Card title="Connect GitHub">
          <div className="stack">
            <p style={{ margin: 0 }}>
              Create a GitHub App for this organization. Once it is installed on your GitHub accounts, every repository it can see becomes a project here automatically, and stays in sync.
              Tasks can push branches and open pull requests through it, and new projects can get a new repository.
            </p>
            {st.publicUrlIsLocal && (
              <Alert tone="warn">
                This server's public URL is a private address, so GitHub can't send it webhooks. Repositories are synced every 10 minutes instead (and whenever you press Sync now). Set PUBLIC_URL to a public address for instant updates.
              </Alert>
            )}
            {admin ? (
              <>
                <Field label="GitHub organization (optional)" hint="Create the app owned by this organization. Leave empty to create it in your personal GitHub account.">
                  {(id) => <Input id={id} value={organization} placeholder="acme" onChange={(e) => setOrganization(e.target.value)} />}
                </Field>
                <label className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />
                  <span>Allow installing it on other accounts too (personal accounts and other organizations). Installations are only accepted when started from this page.</span>
                </label>
                <div>
                  <Button variant="primary" loading={manifest.isPending} onClick={() => manifest.mutate()}>Create GitHub App</Button>
                </div>
                <p className="muted small" style={{ margin: 0 }}>
                  You'll confirm on GitHub. The app asks for: repository contents and pull requests (write), issues (write), metadata (read), and administration (write) so it can create repositories. Its credentials are stored encrypted on this server.
                </p>
              </>
            ) : (
              <Alert>Ask an administrator to connect GitHub.</Alert>
            )}
          </div>
        </Card>
      ) : (
        <>
          <Card
            title="GitHub App"
            actions={
              admin && (
                <Button size="sm" variant="danger" loading={remove.isPending} onClick={() => confirm('Remove the GitHub App from this organization? Projects stay; syncing stops. Delete the app on GitHub separately.') && remove.mutate()}>
                  Remove
                </Button>
              )
            }
          >
            <div className="stack">
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <a href={st.app.htmlUrl} target="_blank" rel="noreferrer"><strong>{st.app.name}</strong></a>
                {st.app.ownerLogin && <span className="muted">owned by {st.app.ownerLogin}</span>}
                <Badge>{st.app.public ? 'installable on any account' : 'owner account only'}</Badge>
                <Badge tone={st.app.webhookActive ? 'ok' : 'neutral'}>{st.app.webhookActive ? 'webhooks' : 'synced every 10 minutes'}</Badge>
              </div>
              {!st.app.webhookActive && <p className="muted small" style={{ margin: 0 }}>GitHub can't reach this server's webhook address ({st.webhookUrl}), so changes on GitHub show up at the next sync.</p>}
            </div>
          </Card>

          <Card
            title="Installations"
            padded={false}
            actions={
              admin && (
                <div className="row" style={{ gap: 6 }}>
                  <Button size="sm" loading={sync.isPending} disabled={!st.installations.length} onClick={() => sync.mutate()}>Sync now</Button>
                  <Button size="sm" variant="primary" loading={install.isPending} onClick={() => install.mutate()}>Install on an account</Button>
                </div>
              )
            }
          >
            {sync.data && (
              <div className="card-body">
                <Alert tone={sync.data.errors.length ? 'warn' : 'info'}>
                  {sync.data.repositories} repositories checked, {sync.data.projectsCreated} new project{sync.data.projectsCreated === 1 ? '' : 's'}.
                  {sync.data.errors.map((e) => <div key={e}>{e}</div>)}
                </Alert>
              </div>
            )}
            {st.installations.length ? (
              <table className="table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Repositories</th>
                    <th className="hide-mobile">Last sync</th>
                    {admin && <th />}
                  </tr>
                </thead>
                <tbody>
                  {st.installations.map((i) => (
                    <tr key={i.installationId}>
                      <td>
                        <a href={`${st.githubUrl}/${i.accountLogin}`} target="_blank" rel="noreferrer">{i.accountLogin}</a> <Badge>{i.accountType === 'Organization' ? 'organization' : 'personal'}</Badge>
                        {i.suspended && <> <Badge tone="warn">suspended</Badge></>}
                      </td>
                      <td>{i.repositoryCount} {i.repositorySelection === 'selected' ? <span className="muted small">(selected)</span> : <span className="muted small">(all)</span>}</td>
                      <td className="hide-mobile small">
                        {i.lastSyncAt ? timeAgo(i.lastSyncAt) : <span className="muted">not yet</span>}
                        {i.lastSyncError && <div><Badge tone="danger">sync failed</Badge> <span className="small">{i.lastSyncError}</span></div>}
                      </td>
                      {admin && (
                        <td style={{ textAlign: 'right' }}>
                          <Button size="sm" variant="ghost" onClick={() => confirm(`Stop syncing ${i.accountLogin}? Projects stay. To uninstall the app, do it on GitHub.`) && forget.mutate(i.installationId)}>Forget</Button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-body muted">Not installed anywhere yet. Install it on the GitHub accounts whose repositories should become projects.</div>
            )}
          </Card>

          <Card title="Your GitHub account">
            {st.user ? (
              <div className="row" style={{ gap: 8 }}>
                <span>Connected as <strong>{st.user.login}</strong>. New repositories can be created in that personal account.</span>
                <Button size="sm" variant="ghost" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button>
              </div>
            ) : (
              <div className="stack">
                <p className="muted" style={{ margin: 0 }}>Needed only to create repositories in your personal GitHub account (organizations work through the installation).</p>
                <div><Button loading={connect.isPending} onClick={() => connect.mutate()}>Connect your GitHub account</Button></div>
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
