import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_PREFIX } from '@ao/contracts';
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner } from '@ao/ui';
import { ApiError, del, get, getAccessToken, post, put } from '../lib/api';
import { PageHeader } from '../Layout';

interface Channel {
  channel: 'stable' | 'beta';
  latest: string | null;
  manifestUrl: string;
  releases: Array<{ version: string; sha256: string; size: number; uploadedAt: string; publishedAt: string | null; keyId: string | null; source?: 'upstream' | 'upload' }>;
}
interface SigningKey {
  keyId: string;
  publicKey: string;
  createdAt: string;
  active: boolean;
}
interface Upstream {
  repo: string;
  channel: string;
  latest: string | null;
  releaseUrl: string | null;
  imported: string | null;
  available: boolean;
}
interface Uploaded {
  channel: string;
  version: string;
  sha256: string;
  packageUrl: string;
  sign: string;
  published?: unknown;
}

/** Signed worker releases hosted by this server (WORKER-012), for platform administrators. */
export function AdminReleasesPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['worker-releases'], queryFn: () => get<Channel[]>('/admin/worker-releases') });
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable');
  const [version, setVersion] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const upstream = useQuery({ queryKey: ['worker-releases-upstream', channel], queryFn: () => get<Upstream>(`/admin/worker-releases/${channel}/upstream`), retry: false });
  const sync = useMutation({
    mutationFn: () => post<{ status: 'imported' | 'up-to-date'; version: string; releases: Channel[] }>(`/admin/worker-releases/${channel}/sync`, {}),
    onSuccess: (r) => {
      qc.setQueryData(['worker-releases'], r.releases);
      void qc.invalidateQueries({ queryKey: ['worker-releases-upstream'] });
      void qc.invalidateQueries({ queryKey: ['install-settings'] });
    },
  });
  const upload = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_PREFIX}/admin/worker-releases/${channel}/${encodeURIComponent(version.trim())}/package${keys.data?.some((k) => k.active) ? '?sign=true' : ''}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip', authorization: `Bearer ${getAccessToken()}`, 'x-client': 'web' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'INTERNAL', data?.error?.message ?? `Upload failed (${res.status})`);
      return data as Uploaded;
    },
    onSuccess: (r) => {
      // Signed and published in the same call when this server holds a signing key.
      setUploaded(r.published ? null : r);
      void qc.invalidateQueries({ queryKey: ['worker-releases'] });
    },
  });
  const publish = useMutation({
    mutationFn: async (manifestFile: File) => put<Channel[]>(`/admin/worker-releases/${uploaded?.channel ?? channel}/manifest`, JSON.parse(await manifestFile.text())),
    onSuccess: (r) => {
      qc.setQueryData(['worker-releases'], r);
      setUploaded(null);
    },
  });
  const keys = useQuery({ queryKey: ['worker-release-keys'], queryFn: () => get<SigningKey[]>('/admin/worker-release-keys') });
  const setKeys = (r: SigningKey[]) => qc.setQueryData(['worker-release-keys'], r);
  const generate = useMutation({ mutationFn: () => post<SigningKey[]>('/admin/worker-release-keys'), onSuccess: setKeys });
  const activate = useMutation({ mutationFn: (id: string) => post<SigningKey[]>(`/admin/worker-release-keys/${encodeURIComponent(id)}/activate`), onSuccess: setKeys });
  const remove = useMutation({ mutationFn: (id: string) => del<SigningKey[]>(`/admin/worker-release-keys/${encodeURIComponent(id)}`), onSuccess: setKeys });
  const signHere = useMutation({
    mutationFn: () => post<Channel[]>(`/admin/worker-releases/${uploaded!.channel}/${encodeURIComponent(uploaded!.version)}/sign`, {}),
    onSuccess: (r) => {
      qc.setQueryData(['worker-releases'], r);
      setUploaded(null);
    },
  });
  if (list.isLoading) return <Spinner />;
  if (list.error) return <Alert tone="danger">{(list.error as ApiError).message}</Alert>;
  const error = sync.error ?? upload.error ?? publish.error ?? signHere.error ?? generate.error ?? activate.error ?? remove.error;
  const hasActiveKey = !!keys.data?.some((k) => k.active);
  return (
    <div className="stack">
      <PageHeader title="Worker releases" description="Workers connected to this server update from here. Official releases are signed by the project; workers install only releases signed with a key they trust." />
      {error && <Alert tone="danger">{error instanceof SyntaxError ? 'The manifest file is not JSON' : (error as ApiError).message}</Alert>}
      <Card title="Update workers">
        <div className="stack" style={{ maxWidth: 640 }}>
          <p className="small muted">Fetches the project's newest signed worker release from GitHub and serves it to your workers. The signature and checksum are verified here and again by every worker; nothing is built or signed on this server.</p>
          <Field label="Channel">
            {(id) => (
              <Select id={id} value={channel} onChange={(e) => { setChannel(e.target.value as 'stable' | 'beta'); sync.reset(); }}>
                <option value="stable">stable</option>
                <option value="beta">beta (pre-releases)</option>
              </Select>
            )}
          </Field>
          <div className="row">
            <Button variant="primary" loading={sync.isPending} onClick={() => sync.mutate()}>{upstream.data?.available ? `Update workers to ${upstream.data.latest}` : 'Update workers'}</Button>
            {upstream.isLoading ? <Spinner /> : upstream.data ? (
              upstream.data.latest ? (
                <span className="small muted">
                  {upstream.data.available ? <Badge tone="ok">{upstream.data.latest} available</Badge> : <Badge>up to date</Badge>} serving {upstream.data.imported ?? 'nothing yet'} · <a href={upstream.data.releaseUrl ?? '#'} target="_blank" rel="noreferrer">release notes</a>
                </span>
              ) : (
                <span className="small muted">{upstream.data.repo} has no {channel} worker release yet.</span>
              )
            ) : (
              <span className="small muted">Could not reach GitHub to check for a newer release.</span>
            )}
          </div>
          {sync.data && <Alert tone="info">{sync.data.status === 'imported' ? `Worker ${sync.data.version} is now served to your workers.` : `Worker ${sync.data.version} is already served.`}</Alert>}
        </div>
      </Card>
      <Card title="Custom upload (forks, private builds, offline servers)">
        <div className="stack" style={{ maxWidth: 640 }}>
          <p className="small muted">Build it with <code>node scripts/package-worker.mjs --tarball</code>.</p>
          <div className="grid grid-2">
            <Field label="Channel">
              {(id) => (
                <Select id={id} value={channel} onChange={(e) => setChannel(e.target.value as 'stable' | 'beta')}>
                  <option value="stable">stable</option>
                  <option value="beta">beta</option>
                </Select>
              )}
            </Field>
            <Field label="Version">{(id) => <Input id={id} value={version} placeholder="X.Y.Z" onChange={(e) => setVersion(e.target.value)} />}</Field>
          </div>
          <Field label="Package (.tgz)">{(id) => <input id={id} type="file" accept=".tgz,.tar.gz,application/gzip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}</Field>
          <div><Button variant="primary" disabled={!file || !/^\d+\.\d+\.\d+/.test(version)} loading={upload.isPending} onClick={() => upload.mutate()}>Upload</Button></div>
        </div>
      </Card>
      <Card title="Signing keys held by this server (custom uploads only)">
        <div className="stack">
          <p className="small muted">Optional. Generate a key here and this server signs releases for you. The private key is encrypted and never shown. Anyone who controls this server can then sign releases that workers trusting these keys will install; for the strongest guarantee keep signing offline. Workers pick up these keys when installed from this server; add them to existing workers under Updates → Trusted keys.</p>
          {keys.data?.length ? (
            <table className="table" aria-label="Signing keys">
              <tbody>
                {keys.data.map((k) => (
                  <tr key={k.keyId}>
                    <td className="mono">{k.keyId}</td>
                    <td className="small">{k.active ? <Badge tone="ok">signing</Badge> : 'retired'} · created {new Date(k.createdAt).toLocaleDateString()}</td>
                    <td className="row">
                      {!k.active && <Button onClick={() => activate.mutate(k.keyId)}>Use for signing</Button>}
                      {!k.active && <Button onClick={() => window.confirm(`Delete ${k.keyId}? Workers that trust it will refuse releases signed with it.`) && remove.mutate(k.keyId)}>Delete</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="small muted">No keys yet.</p>
          )}
          <div><Button loading={generate.isPending} onClick={() => generate.mutate()}>Generate signing key</Button></div>
        </div>
      </Card>
      {uploaded && (
        <Card title={`Sign and publish ${uploaded.version}`}>
          <div className="stack">
            {hasActiveKey && (
              <div>
                <Button variant="primary" loading={signHere.isPending} onClick={() => signHere.mutate()}>Sign and publish with the server key</Button>
                <p className="small muted">Or sign offline:</p>
              </div>
            )}
            <p className="small">On the machine with your release key, sign the manifest for this package:</p>
            <pre className="log" style={{ whiteSpace: 'pre-wrap' }}>{uploaded.sign} &gt; manifest.json</pre>
            <p className="small muted">SHA-256 {uploaded.sha256}</p>
            <Field label="Signed manifest (manifest.json)">{(id) => <input id={id} type="file" accept=".json,application/json" onChange={(e) => e.target.files?.[0] && publish.mutate(e.target.files[0])} />}</Field>
          </div>
        </Card>
      )}
      {list.data!.map((c) => (
        <Card key={c.channel} title={<span className="row">{c.channel} {c.latest ? <Badge tone="ok">{c.latest}</Badge> : <Badge>nothing published</Badge>}</span>} padded={false}>
          <table className="table" aria-label={`${c.channel} releases`}>
            <tbody>
              {c.releases.length ? (
                c.releases.map((r) => (
                  <tr key={r.version}>
                    <td className="mono">{r.version}</td>
                    <td className="small">{r.publishedAt ? `${r.source === 'upstream' ? 'official release' : 'uploaded'} · published ${new Date(r.publishedAt).toLocaleString()} · key ${r.keyId}` : 'uploaded, not published'}</td>
                    <td className="small muted">{(r.size / 1024 / 1024).toFixed(1)} MB · {r.sha256.slice(0, 12)}</td>
                  </tr>
                ))
              ) : (
                <tr><td className="muted">No releases.</td></tr>
              )}
            </tbody>
          </table>
          <p className="small muted" style={{ padding: '8px 16px' }}>Workers read <code>{c.manifestUrl}</code></p>
        </Card>
      ))}
    </div>
  );
}
