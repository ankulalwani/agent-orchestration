import { StrictMode, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@ao/ui/styles.css';
import './worker.css';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, KeyValue, Select, Spinner, Stat, Textarea, timeAgo, type Tone } from '@ao/ui';

/**
 * Worker local UI (spec §12). Talks only to the worker's loopback API. The local token arrives in the
 * URL fragment (never sent to any server), is moved to sessionStorage, and the fragment is cleared.
 */

const TOKEN_KEY = 'ao.worker.token';
function readToken(): string | null {
  const m = /token=([^&]+)/.exec(location.hash);
  if (m) {
    try {
      sessionStorage.setItem(TOKEN_KEY, m[1]!);
    } catch {
      /* private mode */
    }
    history.replaceState(null, '', location.pathname + location.search);
    return m[1]!;
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
const token = readToken();

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

function useData<T>(path: string, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<T>('GET', path).then((d) => (setData(d), setError(null))).catch((e: Error) => setError(e.message)), [path]);
  useEffect(() => {
    void load();
    if (!intervalMs) return;
    const t = setInterval(() => void load(), intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { data, error, reload: load };
}

type Section = 'dashboard' | 'connection' | 'tasks' | 'projects' | 'agents' | 'providers' | 'mcp' | 'logs' | 'diagnostics' | 'settings' | 'updates';
const SECTIONS: Array<[Section, string]> = [
  ['dashboard', 'Dashboard'],
  ['connection', 'Connection'],
  ['tasks', 'Tasks'],
  ['projects', 'Projects'],
  ['agents', 'Agents'],
  ['providers', 'AI models'],
  ['mcp', 'MCP Servers'],
  ['logs', 'Logs'],
  ['diagnostics', 'Diagnostics'],
  ['settings', 'Settings'],
  ['updates', 'Updates'],
];

interface Status {
  version: string;
  name: string;
  workerId: string | null;
  organizationId: string | null;
  connectionMode: string | null;
  controlPlaneUrl: string | null;
  /** The build's hosted service, if it has one. */
  hostedUrl: string | null;
  connection: { state: string; lastConnectedAt?: string | null; lastError?: string | null };
  lastHeartbeatAt: string | null;
  pairing: { status: string; userCode?: string; verificationUrl?: string; expiresAt?: string; error?: string };
  metrics: { cpuCount: number; cpuLoadPercent: number | null; totalMemoryMb: number; freeMemoryMb: number; freeDiskMb: number | null };
  activeTasks: Array<{ taskId: string; status: string }>;
  maxConcurrentTasks: number;
  unsentEvents: number;
  credentialBackend: string;
  tools: Array<{ tag: string; path: string | null; version: string | null }>;
}

function App() {
  const [section, setSection] = useState<Section>(() => (location.hash.replace('#', '') as Section) || 'dashboard');
  useEffect(() => {
    if (section) history.replaceState(null, '', `#${section}`);
  }, [section]);
  const status = useData<Status>('/api/status', 5000);

  if (!token) {
    return (
      <div className="center-screen">
        <Card title="Open the worker UI from the worker">
          <p style={{ margin: 0 }}>For security this page needs the local access link printed by the worker when it starts (or run <code>agentctl worker status</code>). The link looks like <code>http://127.0.0.1:47821/#token=…</code>.</p>
        </Card>
      </div>
    );
  }
  if (status.error && !status.data) return <div className="center-screen"><Alert tone="danger">{status.error}</Alert></div>;
  if (!status.data) return <div className="center-screen"><Spinner label="Connecting to worker…" /></div>;
  const s = status.data;
  const connTone: Tone = s.connection.state === 'connected' ? 'ok' : s.connection.state === 'unauthorized' ? 'danger' : 'warn';

  return (
    <div className="wshell">
      <aside className="wside" aria-label="Worker sections">
        <div className="brand"><span className="brand-mark" aria-hidden="true">▲</span> Worker</div>
        <nav className="wnav">
          {SECTIONS.map(([id, label]) => (
            <button key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} onClick={() => setSection(id)}>
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="wmain">
        <header className="spread" style={{ marginBottom: 20 }}>
          <div>
            <h1>{s.name}</h1>
            <div className="muted small">v{s.version} · {s.workerId ?? 'not paired'}</div>
          </div>
          <Badge tone={connTone} live={s.connection.state === 'connected'}>{s.connection.state === 'not-configured' ? 'Not connected' : s.connection.state}</Badge>
        </header>
        {section === 'dashboard' && <Dashboard s={s} go={setSection} />}
        {section === 'connection' && <Connection s={s} reload={status.reload} />}
        {section === 'tasks' && <Tasks s={s} />}
        {section === 'projects' && (
          <>
            <RepositoryDiscovery />
            <Projects />
          </>
        )}
        {section === 'agents' && <Agents />}
        {section === 'providers' && <Providers />}
        {section === 'mcp' && <Mcp />}
        {section === 'logs' && <Logs />}
        {section === 'diagnostics' && <Diagnostics />}
        {section === 'settings' && (
          <div className="stack">
            <Settings />
            <GitHosting />
          </div>
        )}
        {section === 'updates' && <Updates />}
      </main>
    </div>
  );
}

function Dashboard({ s, go }: { s: Status; go: (x: Section) => void }) {
  const agents = useData<Array<{ id: string; name: string; installed: boolean; enabled: boolean; version: string | null }>>('/api/agents', 30_000);
  const providers = useData<Array<{ id: string; name: string; healthy: boolean; limited: boolean }>>('/api/providers', 30_000);
  return (
    <div className="stack">
      {!s.workerId && (
        <Alert tone="warn">
          This worker is not connected to a control plane yet. <button className="btn btn-sm" onClick={() => go('connection')}>Connect</button>
        </Alert>
      )}
      <div className="grid grid-stats">
        <Stat label="Active tasks" value={`${s.activeTasks.length}/${s.maxConcurrentTasks}`} />
        <Stat label="CPU" value={s.metrics.cpuLoadPercent !== null ? `${s.metrics.cpuLoadPercent}%` : '—'} />
        <Stat label="RAM free" value={`${Math.round(s.metrics.freeMemoryMb / 1024)} GB`} />
        <Stat label="Disk free" value={s.metrics.freeDiskMb !== null ? `${Math.round(s.metrics.freeDiskMb / 1024)} GB` : '—'} />
      </div>
      <div className="grid grid-2">
        <Card title="Control plane">
          <KeyValue
            items={[
              ['Mode', s.connectionMode ?? 'not chosen'],
              ['URL', s.controlPlaneUrl],
              ['Organization', s.organizationId],
              ['Last heartbeat', timeAgo(s.lastHeartbeatAt)],
              ['Unsent events', s.unsentEvents],
              ['Credential storage', s.credentialBackend === 'os-keyring' ? 'OS credential store' : 'Encrypted file'],
            ]}
          />
        </Card>
        <Card title="Agents & providers">
          <ul className="check-list">
            {agents.data?.filter((a) => a.installed).map((a) => <li key={a.id}><Badge tone={a.enabled ? 'ok' : 'neutral'}>{a.enabled ? 'on' : 'off'}</Badge> {a.name} <span className="muted small">{a.version}</span></li>)}
            {providers.data?.map((p) => <li key={p.id}><Badge tone={p.limited ? 'warn' : p.healthy ? 'ok' : 'danger'}>{p.limited ? 'limited' : p.healthy ? 'healthy' : 'error'}</Badge> {p.name}</li>)}
            {!providers.data?.length && <li className="muted">No AI providers configured.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Connection({ s, reload }: { s: Status; reload: () => void }) {
  const [mode, setMode] = useState<'hosted' | 'self-hosted'>(s.connectionMode === 'hosted' && s.hostedUrl ? 'hosted' : 'self-hosted');
  const [url, setUrl] = useState(s.controlPlaneUrl ?? '');
  const [name, setName] = useState(s.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('POST', '/api/connect', { mode, url: mode === 'self-hosted' ? url : null, name });
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      {s.pairing.status === 'waiting' && (
        <Card title="Approve this worker">
          <div className="stack">
            <p style={{ margin: 0 }}>Open the link below while signed in, check the details and approve. This page updates automatically.</p>
            <div className="code-block" aria-label="Pairing code">{s.pairing.userCode}</div>
            <a className="btn btn-primary" href={s.pairing.verificationUrl} target="_blank" rel="noreferrer">Open approval page</a>
            <span className="muted small">Code expires {timeAgo(s.pairing.expiresAt)}.</span>
          </div>
        </Card>
      )}
      {s.pairing.status === 'denied' && <Alert tone="danger">Pairing was denied.</Alert>}
      {s.pairing.status === 'expired' && <Alert tone="warn">The pairing code expired. Start again.</Alert>}
      {s.workerId ? (
        <Card title="Connected">
          <div className="stack">
            <KeyValue items={[['Control plane', s.controlPlaneUrl], ['Worker ID', s.workerId], ['State', s.connection.state], ['Last error', s.connection.lastError ?? null]]} />
            <div><Button variant="danger" onClick={() => confirm('Disconnect and remove this worker’s credential?') && void api('POST', '/api/disconnect').then(reload)}>Disconnect</Button></div>
          </div>
        </Card>
      ) : (
        <Card title="Connect to">
          <div className="stack">
            {err && <Alert tone="danger">{err}</Alert>}
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="sr-only">Control plane</legend>
              {s.hostedUrl && <label className="row"><input type="radio" name="mode" checked={mode === 'hosted'} onChange={() => setMode('hosted')} /> Hosted service ({new URL(s.hostedUrl).host})</label>}
              <label className="row"><input type="radio" name="mode" checked={mode === 'self-hosted'} onChange={() => setMode('self-hosted')} /> My self-hosted server</label>
            </fieldset>
            {mode === 'self-hosted' && <Field label="Control plane URL">{(id) => <Input id={id} placeholder="https://orchestrator.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />}</Field>}
            <Field label="Worker name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <div><Button variant="primary" loading={busy} disabled={mode === 'self-hosted' && !url} onClick={() => void connect()}>Start pairing</Button></div>
          </div>
        </Card>
      )}
    </div>
  );
}

function Tasks({ s }: { s: Status }) {
  return (
    <Card title="Tasks on this worker" padded={false}>
      {s.activeTasks.length ? (
        <table className="table">
          <tbody>
            {s.activeTasks.map((t) => (
              <tr key={t.taskId}>
                <td className="mono">{t.taskId}</td>
                <td><Badge tone="accent" live>{t.status}</Badge></td>
                <td>{s.controlPlaneUrl && <a href={`${s.controlPlaneUrl.replace(/\/+$/, '')}/tasks/${t.taskId}`} target="_blank" rel="noreferrer">Open in dashboard</a>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <EmptyState title="No tasks running on this worker" />
      )}
    </Card>
  );
}

type DiscoveryView = {
  settings: { enabled: boolean; roots: string[]; exclude: string[]; intervalHours: number; maxDepth: number };
  projectsRoot: string | null;
  running: boolean;
  error: string | null;
  clones: Array<{ name: string; url: string; status: 'cloning' | 'done' | 'failed'; localPath: string | null; error: string | null; at: string }>;
  last: {
    scannedAt: string;
    roots: string[];
    durationMs: number;
    directories: number;
    truncated: boolean;
    repos: Array<{ localPath: string; name: string; remotes: Array<{ name: string; url: string }>; branch: string | null; mapped: { projectId: string } | null }>;
  } | null;
};

/** Finding repositories on this computer, and the folder new repositories are cloned into. */
function RepositoryDiscovery() {
  const d = useData<DiscoveryView>('/api/discovery', 3000);
  const [form, setForm] = useState<{ enabled: boolean; roots: string; exclude: string; intervalHours: number; maxDepth: number; projectsRoot: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (d.data && !form) setForm({ ...d.data.settings, roots: d.data.settings.roots.join('\n'), exclude: d.data.settings.exclude.join('\n'), projectsRoot: d.data.projectsRoot ?? '' });
  }, [d.data, form]);
  if (!d.data || !form) return <Spinner />;
  const lines = (s: string) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const save = () =>
    api('PUT', '/api/discovery/settings', { enabled: form.enabled, roots: lines(form.roots), exclude: lines(form.exclude), intervalHours: Number(form.intervalHours), maxDepth: Number(form.maxDepth), projectsRoot: form.projectsRoot.trim() || null })
      .then(() => (setMsg({ tone: 'info', text: 'Saved.' }), d.reload()))
      .catch((e: Error) => setMsg({ tone: 'danger', text: e.message }));
  const scan = () => api('POST', '/api/discovery/scan').then(() => d.reload());
  const last = d.data.last;
  const unmapped = last?.repos.filter((r) => !r.mapped).length ?? 0;
  return (
    <Card
      title="Repositories on this computer"
      actions={
        <div className="row" style={{ gap: 6 }}>
          <Button loading={d.data.running} disabled={d.data.running} onClick={() => void scan()}>{d.data.running ? 'Scanning…' : 'Scan now'}</Button>
          <Button variant="primary" onClick={() => void save()}>Save</Button>
        </div>
      }
    >
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          The worker looks for Git repositories and reports them to the control plane. Clones of repositories that are in a project are mapped here automatically; the others are suggested in the dashboard (Projects). Only folder paths and remote URLs are sent, never file contents.
        </p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {d.data.error && <Alert tone="danger">Last scan failed: {d.data.error}</Alert>}
        {d.data.clones.map((c) => (
          <Alert key={c.at + c.name} tone={c.status === 'failed' ? 'danger' : 'info'}>
            {c.status === 'cloning' ? `Cloning ${c.name}…` : c.status === 'done' ? `Cloned ${c.name} to ${c.localPath}` : `Could not clone ${c.name}: ${c.error}`}
          </Alert>
        ))}
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          <span>Scan for repositories every {form.intervalHours} hours</span>
        </label>
        <Field label="Folders to scan" hint="One absolute path per line. Empty: every fixed drive (system, program and dependency folders are skipped).">
          {(id) => <Textarea id={id} rows={3} className="mono" value={form.roots} onChange={(e) => setForm({ ...form, roots: e.target.value })} />}
        </Field>
        <Field label="Never scan" hint="Folder names (e.g. archive) or absolute paths, one per line.">
          {(id) => <Textarea id={id} rows={2} className="mono" value={form.exclude} onChange={(e) => setForm({ ...form, exclude: e.target.value })} />}
        </Field>
        <div className="row" style={{ gap: 12 }}>
          <Field label="Hours between scans">{(id) => <Input id={id} type="number" min={1} max={168} value={form.intervalHours} onChange={(e) => setForm({ ...form, intervalHours: Number(e.target.value) })} />}</Field>
          <Field label="Folder depth">{(id) => <Input id={id} type="number" min={1} max={20} value={form.maxDepth} onChange={(e) => setForm({ ...form, maxDepth: Number(e.target.value) })} />}</Field>
        </div>
        <Field label="Projects folder" hint="New repositories (for example created from the dashboard) are cloned here, one folder each. Empty: don't clone to this computer.">
          {(id) => <Input id={id} className="mono" value={form.projectsRoot} placeholder="E:\Projects" onChange={(e) => setForm({ ...form, projectsRoot: e.target.value })} />}
        </Field>
        {last ? (
          <>
            <div className="muted small">
              Last scan {timeAgo(last.scannedAt)} of {last.roots.join(', ')}: {last.repos.length} repositories in {last.directories.toLocaleString()} folders ({Math.round(last.durationMs / 1000)} s){last.truncated ? ', stopped early' : ''}. {unmapped ? `${unmapped} not in a project yet.` : ''}
            </div>
            {last.repos.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Remote</th>
                    <th>Project</th>
                  </tr>
                </thead>
                <tbody>
                  {last.repos.map((r) => (
                    <tr key={r.localPath}>
                      <td>
                        <strong>{r.name}</strong>
                        <div className="muted small mono">{r.localPath}</div>
                      </td>
                      <td className="small mono">{r.remotes.find((x) => x.name === 'origin')?.url ?? r.remotes[0]?.url ?? <span className="muted">none</span>}</td>
                      <td>{r.mapped ? <Badge tone="ok">mapped</Badge> : <Badge>suggested</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : (
          <div className="muted small">{d.data.running ? 'Scanning… the first scan of whole drives can take a few minutes.' : 'Not scanned yet.'}</div>
        )}
      </div>
    </Card>
  );
}

function Projects() {
  const projects = useData<Array<{ projectId: string; repositoryId?: string; localPath: string; name?: string; exists: boolean; isGit: boolean }>>('/api/projects');
  const [rows, setRows] = useState<Array<{ projectId: string; repositoryId?: string; localPath: string; name?: string }>>([]);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    if (projects.data) setRows(projects.data.map(({ projectId, repositoryId, localPath, name }) => ({ projectId, repositoryId, localPath, name })));
  }, [projects.data]);
  const save = () =>
    api('PUT', '/api/projects', rows.filter((r) => r.projectId && r.localPath).map((r) => ({ ...r, repositoryId: r.repositoryId || undefined })))
      .then(() => (setMsg({ tone: 'info', text: 'Saved. The control plane is updated with the next heartbeat.' }), projects.reload()))
      .catch((e: Error) => setMsg({ tone: 'danger', text: e.message }));
  return (
    <Card title="Project checkouts" actions={<Button variant="primary" onClick={() => void save()}>Save</Button>}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Agents on this worker can only work inside these directories. Copy the project ID from the dashboard's project page. For a project with several repositories, add one row per repository with its repository ID; without one, the folder is the project's primary repository.</p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {rows.map((r, i) => {
          const info = projects.data?.find((p) => p.projectId === r.projectId && p.localPath === r.localPath);
          return (
            <div key={i} className="row" style={{ alignItems: 'flex-end' }}>
              <Field label="Project ID">{(id) => <Input id={id} className="mono" value={r.projectId} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, projectId: e.target.value.trim() } : x)))} />}</Field>
              <Field label="Repository ID (optional)">{(id) => <Input id={id} className="mono" value={r.repositoryId ?? ''} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, repositoryId: e.target.value.trim() } : x)))} />}</Field>
              <div style={{ flex: 1, minWidth: 260 }}>
                <Field label="Local path" hint={info ? (info.exists ? (info.isGit ? 'Git repository' : 'Not a Git repository') : 'Path does not exist') : undefined}>{(id) => <Input id={id} value={r.localPath} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, localPath: e.target.value } : x)))} />}</Field>
              </div>
              <Button variant="ghost" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          );
        })}
        <div><Button onClick={() => setRows([...rows, { projectId: '', localPath: '' }])}>Add project</Button></div>
      </div>
    </Card>
  );
}

function Agents() {
  const agents = useData<Array<{ id: string; name: string; installed: boolean; enabled: boolean; version: string | null; path: string | null; authenticated: boolean | null; supportedProviders: string[]; capabilities: string[]; notes: string[] }>>('/api/agents');
  if (!agents.data) return <Spinner />;
  return (
    <div className="grid grid-2">
      {agents.data.map((a) => (
        <Card key={a.id} title={a.name} actions={a.installed && <label className="row small"><input type="checkbox" checked={a.enabled} onChange={(e) => void api('PUT', `/api/agents/${a.id}`, { enabled: e.target.checked }).then(agents.reload)} /> Enabled</label>}>
          <KeyValue
            items={[
              ['Installed', a.installed ? <Badge key="i" tone="ok">{a.version ?? 'yes'}</Badge> : <Badge key="i">no</Badge>],
              ['Path', a.path ? <code key="p">{a.path}</code> : null],
              ['Authenticated', a.authenticated === null ? 'checked on first run' : a.authenticated ? 'yes' : 'no'],
              ['Providers', a.supportedProviders.join(', ')],
              ['Capabilities', a.capabilities.join(', ')],
              ['Notes', a.notes.length ? a.notes.join(' · ') : null],
            ]}
          />
        </Card>
      ))}
    </div>
  );
}

/** Add-on provider presets: OpenAI-compatible services (any other works as "OpenAI-compatible"). */
const PRESETS: Array<{ kind: string; label: string; keyless?: boolean; baseUrl?: string; baseUrlRequired?: boolean; models: string; note?: string }> = [
  { kind: 'openrouter', label: 'OpenRouter', models: 'e.g. qwen/qwen3-coder:free, deepseek/deepseek-chat-v3.1:free', note: 'One key for many models, including free ones. You can also sign in with OpenRouter after saving instead of pasting a key.' },
  { kind: 'nvidia-nim', label: 'NVIDIA NIM', models: 'e.g. moonshotai/kimi-k2-instruct, qwen/qwen3-coder-480b-a35b-instruct', note: 'Free API key from build.nvidia.com.' },
  { kind: 'groq', label: 'Groq', models: 'e.g. moonshotai/kimi-k2-instruct, openai/gpt-oss-120b' },
  { kind: 'deepseek', label: 'DeepSeek', models: 'e.g. deepseek-chat' },
  { kind: 'openai', label: 'OpenAI', models: 'e.g. gpt-5-mini' },
  { kind: 'google', label: 'Google Gemini', models: 'e.g. gemini-2.5-flash', note: 'Through the Gemini API\'s OpenAI-compatible endpoint.' },
  { kind: 'anthropic', label: 'Anthropic (API key)', models: 'e.g. claude-sonnet-4-5' },
  { kind: 'ollama', label: 'Ollama (local)', keyless: true, baseUrl: 'http://127.0.0.1:11434', models: 'e.g. qwen2.5-coder:14b' },
  { kind: 'lmstudio', label: 'LM Studio (local)', keyless: true, baseUrl: 'http://127.0.0.1:1234/v1', models: 'the model id shown in LM Studio' },
  { kind: 'openai-compatible', label: 'Other OpenAI-compatible', baseUrlRequired: true, models: 'the model ids the service offers', note: 'Any service with an OpenAI-compatible /chat/completions API (vLLM, LiteLLM, Together, Fireworks, …).' },
];
/** Providers some harnesses use directly (not through the gateway). */
const ADVANCED_KINDS = ['azure-openai', 'bedrock', 'vertex'];

type ProviderView = { id: string; kind: string; name: string; healthy: boolean; limited: boolean; limitedUntil: string | null; models: Array<{ id: string }>; credentialMasked: string | null; baseUrl: string | null; error: string | null; lastCheckedAt: string | null };

/**
 * Harnesses run on their own login and model choice by default. Add-on models are extra: when a
 * harness reaches its usage limit, the task can continue on them (any harness can use them through the
 * worker's model gateway).
 */
function Providers() {
  const providers = useData<ProviderView[]>('/api/providers', 5000);
  const addons = useData<{ onHarnessLimit: 'ask' | 'switch' }>('/api/addons');
  const [onLimit, setOnLimit] = useState<'ask' | 'switch' | null>(null);
  const [form, setForm] = useState({ id: '', kind: 'openrouter', name: '', baseUrl: '', models: '', key: '' });
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const preset = PRESETS.find((p) => p.kind === form.kind);
  const own = (providers.data ?? []).filter((p) => p.kind === 'native');
  const extra = (providers.data ?? []).filter((p) => p.kind !== 'native');
  const add = async () => {
    setMsg(null);
    try {
      const id = form.id || form.kind;
      const models = form.models.split(',').map((m) => m.trim()).filter(Boolean);
      await api('PUT', `/api/providers/${id}`, {
        kind: form.kind,
        name: form.name || preset?.label || form.kind,
        baseUrl: form.baseUrl || null,
        useAgentLogin: false,
        models: models.map((m) => ({ id: m })),
        // Listed models are the ones to use (a provider may list hundreds).
        restrictModels: models.length > 0,
      });
      if (form.key) await api('POST', `/api/providers/${id}/credential`, { value: form.key });
      setForm({ id: '', kind: form.kind, name: '', baseUrl: '', models: '', key: '' });
      setMsg({ tone: 'info', text: 'Saved. The key is kept in this computer\'s credential store and only shown masked.' });
      providers.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };
  const move = (id: string, by: number) => {
    const ids = extra.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void api('PUT', '/api/providers-order', { ids }).then(providers.reload);
  };
  const status = (p: ProviderView) => (p.limited ? <Badge tone="warn">limit reached{p.limitedUntil ? ` until ${new Date(p.limitedUntil).toLocaleTimeString()}` : ''}</Badge> : p.healthy ? <Badge tone="ok">available</Badge> : <Badge tone="danger">error</Badge>);
  return (
    <div className="stack">
      <Card title="Harnesses on their own login">
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            By default every task runs on the harness's own login and model choice (for example your Claude subscription). Nothing needs to be set up here for that.
          </p>
          {own.length ? (
            <ul className="check-list">
              {own.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong> {status(p)}
                </li>
              ))}
            </ul>
          ) : (
            <Alert tone="warn">No harness is installed and enabled on this computer (see Agents).</Alert>
          )}
        </div>
      </Card>

      <Card title="When a harness reaches its limit">
        {addons.data ? (
          <div className="stack">
            {(['ask', 'switch'] as const).map((v) => (
              <label key={v} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="radio"
                  name="onHarnessLimit"
                  checked={(onLimit ?? addons.data!.onHarnessLimit) === v}
                  onChange={() => {
                    setOnLimit(v);
                    void api('PUT', '/api/addons', { onHarnessLimit: v }).then(addons.reload);
                  }}
                />
                <span>
                  {v === 'ask' ? <strong>Ask me</strong> : <strong>Switch to add-on models automatically</strong>}
                  <div className="small muted">
                    {v === 'ask'
                      ? 'The task waits for your answer in the dashboard: continue on add-on models, or wait for the limit to reset.'
                      : 'The task continues right away on the first available add-on model below, from its last checkpoint.'}
                  </div>
                </span>
              </label>
            ))}
            <p className="small muted" style={{ margin: 0 }}>Either way, tasks go back to the harness's own login once its limit has reset. Without add-on models, tasks wait for the reset.</p>
          </div>
        ) : (
          <Spinner />
        )}
      </Card>

      <Card title="Add-on models" actions={<Button size="sm" onClick={() => void api('POST', '/api/providers/x/check').then(providers.reload)}>Check now</Button>} padded={false}>
        <p className="card-body muted small" style={{ margin: 0 }}>
          Used in this order. Any harness can use them: the worker's built-in gateway translates between the harness and the provider, and moves on to the next model when one is at its limit or unavailable.
        </p>
        {extra.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Key</th>
                <th>Models</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {extra.map((p, i) => (
                <tr key={p.id}>
                  <td>
                    {i + 1}. {p.name}
                    <div className="small muted">{PRESETS.find((x) => x.kind === p.kind)?.label ?? p.kind}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</div>
                  </td>
                  <td>{status(p)}{p.error && <div className="small muted">{p.error}</div>}</td>
                  <td className="mono small">{p.credentialMasked ?? '—'}</td>
                  <td className="small">{p.models.map((m) => m.id).slice(0, 8).join(', ') || '—'}{p.models.length > 8 ? ` +${p.models.length - 8}` : ''}</td>
                  <td className="row" style={{ gap: 4 }}>
                    <Button size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => move(p.id, -1)}>↑</Button>
                    <Button size="sm" variant="ghost" aria-label="Move down" disabled={i === extra.length - 1} onClick={() => move(p.id, 1)}>↓</Button>
                    {p.kind === 'openrouter' && (
                      <Button size="sm" onClick={() => void api<{ url: string }>('POST', `/api/providers/${p.id}/oauth/start`).then((r) => window.open(r.url, '_blank', 'noopener'))}>Sign in with OpenRouter</Button>
                    )}
                    <Button size="sm" variant="danger" onClick={() => confirm(`Remove ${p.name} and its stored key?`) && void api('DELETE', `/api/providers/${p.id}`).then(providers.reload)}>Remove</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body">
            <EmptyState title="No add-on models">Optional. Add one to keep tasks going when a harness reaches its usage limit.</EmptyState>
          </div>
        )}
      </Card>

      <Card title="Add an add-on model">
        <div className="stack" style={{ maxWidth: 640 }}>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <div className="grid grid-2">
            <Field label="Provider">
              {(id) => (
                <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, baseUrl: '' })}>
                  {PRESETS.map((p) => (
                    <option key={p.kind} value={p.kind}>{p.label}</option>
                  ))}
                  <optgroup label="Used directly by some harnesses">
                    {ADVANCED_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </optgroup>
                </Select>
              )}
            </Field>
            <Field label="ID" hint="Lowercase; defaults to the provider type">{(id) => <Input id={id} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value.toLowerCase() })} />}</Field>
          </div>
          {preset?.note && <p className="small muted" style={{ margin: 0 }}>{preset.note}</p>}
          <Field label="Models" hint={`Comma separated, first is preferred (${preset?.models ?? 'the model ids to use'}). Empty: every model the provider lists.`}>
            {(id) => <Input id={id} value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />}
          </Field>
          <Field label="Base URL" hint={preset?.baseUrlRequired || !preset ? 'The API address, usually ending in /v1' : `Optional (a proxy or another region). Default: ${preset.baseUrl ?? 'the provider\'s own address'}`}>
            {(id) => <Input id={id} value={form.baseUrl} placeholder={preset?.baseUrl ?? 'https://…/v1'} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />}
          </Field>
          {!preset?.keyless && (
            <Field label="API key" hint="Stored in this computer's credential store; never shown again.">
              {(id) => <Input id={id} type="password" autoComplete="off" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />}
            </Field>
          )}
          <div><Button variant="primary" onClick={() => void add()}>Add</Button></div>
        </div>
      </Card>
    </div>
  );
}

interface McpHealthView {
  ok: boolean;
  checkedAt: string;
  serverName?: string;
  toolCount?: number;
  error?: string;
}
type McpServerView = { id: string; name: string; health: McpHealthView | null } & Record<string, unknown>;

function Mcp() {
  const mcp = useData<McpServerView[]>('/api/mcp');
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  useEffect(() => {
    // The editor holds configuration only; health is shown separately.
    if (mcp.data) setText(JSON.stringify(mcp.data.map(({ health: _h, ...cfg }) => cfg), null, 2));
  }, [mcp.data]);
  const save = () => {
    let list: unknown;
    try {
      list = JSON.parse(text);
    } catch {
      return setMsg({ tone: 'danger', text: 'Invalid JSON' });
    }
    setMsg({ tone: 'info', text: 'Saving and checking servers…' });
    void api<McpServerView[]>('PUT', '/api/mcp', list)
      .then((r) => {
        const bad = r.filter((s) => !s.health?.ok).map((s) => s.id);
        setMsg(bad.length ? { tone: 'danger', text: `Saved. Not advertised until they pass the health check: ${bad.join(', ')}` } : { tone: 'info', text: 'Saved. All servers are healthy and advertised as mcp:<id>.' });
        mcp.reload();
      })
      .catch((e: Error) => setMsg({ tone: 'danger', text: e.message }));
  };
  const check = (id: string) => {
    setChecking(id);
    void api('POST', `/api/mcp/${encodeURIComponent(id)}/check`).finally(() => {
      setChecking(null);
      mcp.reload();
    });
  };
  return (
    <div className="stack">
      {(mcp.data?.length ?? 0) > 0 && (
        <Card title="Health">
          <ul className="list" aria-label="MCP server health">
            {mcp.data!.map((s) => (
              <li key={s.id} className="row" style={{ justifyContent: 'space-between', gap: 12 }}>
                <span>
                  <Badge tone={!s.health ? 'neutral' : s.health.ok ? 'ok' : 'danger'}>{!s.health ? 'not checked' : s.health.ok ? 'healthy' : 'unhealthy'}</Badge> {s.name} <code className="small">mcp:{s.id}</code>
                  <div className="small muted">
                    {s.health?.ok ? `${s.health.serverName ?? 'server'} · ${s.health.toolCount ?? 0} tools · checked ${timeAgo(s.health.checkedAt)}` : s.health?.error ?? 'Checking…'}
                  </div>
                </span>
                <Button size="sm" loading={checking === s.id} onClick={() => check(s.id)}>Check now</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="MCP servers available on this worker" actions={<Button variant="primary" onClick={save}>Save</Button>}>
        <div className="stack">
          <p className="muted" style={{ margin: 0 }}>
            Locally installed MCP servers. Each one is checked with a real MCP handshake when saved and every 10 minutes; only healthy servers are advertised as <code>mcp:&lt;id&gt;</code>, so tasks that need one are scheduled only where it works. Organization MCP capabilities are configured from the dashboard.
          </p>
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <Textarea aria-label="MCP servers JSON" rows={12} className="mono" value={text} onChange={(e) => setText(e.target.value)} placeholder='[{"id":"shopify-mcp","name":"Shopify","transport":"stdio","command":["npx","shopify-mcp"]}]' />
        </div>
      </Card>
    </div>
  );
}

function Logs() {
  const events = useData<Array<{ eventId: string; taskId: string; timestamp: string; type: string; payload: Record<string, unknown> }>>('/api/events/recent', 3000);
  return (
    <Card title="Recent events" padded={false}>
      {events.data?.length ? (
        <pre className="log" style={{ margin: 16 }}>
          {[...events.data].reverse().map((e) => `${new Date(e.timestamp).toLocaleTimeString()}  ${e.type.padEnd(24)} ${e.taskId.slice(-8)}  ${e.type === 'AgentOutput' ? ((e.payload.lines as string[]) ?? []).join(' ⏎ ').slice(0, 300) : JSON.stringify(e.payload).slice(0, 200)}`).join('\n')}
        </pre>
      ) : (
        <EmptyState title="No events yet" />
      )}
    </Card>
  );
}

function Diagnostics() {
  const d = useData<Array<{ id: string; label: string; status: 'ok' | 'warn' | 'fail' | 'info'; detail: string; fix?: string }>>('/api/diagnostics');
  const tone: Record<string, Tone> = { ok: 'ok', warn: 'warn', fail: 'danger', info: 'neutral' };
  return (
    <Card title="Diagnostics" actions={<Button size="sm" onClick={() => void d.reload()}>Run again</Button>} padded={false}>
      {!d.data ? (
        <div className="card-body"><Spinner label="Running checks…" /></div>
      ) : (
        <table className="table">
          <tbody>
            {d.data.map((c) => (
              <tr key={c.id}>
                <td><Badge tone={tone[c.status]}>{c.status}</Badge></td>
                <td><strong>{c.label}</strong><div className="small muted">{c.detail}</div>{c.fix && <div className="small">→ {c.fix}</div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Settings() {
  const settings = useData<{ name: string; labels: string[]; maxConcurrentTasks: number; localPort: number; localHost: string; git: { authorName?: string; authorEmail?: string }; telemetry: boolean; plugins: { enabled: boolean }; policy: unknown }>('/api/settings');
  const [form, setForm] = useState<{ name: string; labels: string; max: number; authorName: string; authorEmail: string; telemetry: boolean; plugins: boolean; policy: string } | null>(null);
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  useEffect(() => {
    const s = settings.data;
    if (s) setForm({ name: s.name, labels: s.labels.join(', '), max: s.maxConcurrentTasks, authorName: s.git.authorName ?? '', authorEmail: s.git.authorEmail ?? '', telemetry: s.telemetry, plugins: s.plugins.enabled, policy: JSON.stringify(s.policy ?? {}, null, 2) });
  }, [settings.data]);
  if (!form || !settings.data) return <Spinner />;
  const save = async () => {
    try {
      await api('PATCH', '/api/settings', {
        name: form.name,
        labels: form.labels.split(',').map((l) => l.trim()).filter(Boolean),
        maxConcurrentTasks: form.max,
        git: { authorName: form.authorName || undefined, authorEmail: form.authorEmail || undefined },
        telemetry: form.telemetry,
        plugins: { enabled: form.plugins },
        policy: JSON.parse(form.policy),
      });
      setMsg({ tone: 'info', text: 'Saved.' });
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };
  return (
    <Card title="Settings" actions={<Button variant="primary" onClick={() => void save()}>Save</Button>}>
      <div className="stack" style={{ maxWidth: 640 }}>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        <Field label="Worker name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Labels" hint="Comma separated">{(id) => <Input id={id} value={form.labels} onChange={(e) => setForm({ ...form, labels: e.target.value })} />}</Field>
        <Field label="Maximum concurrent tasks">{(id) => <Input id={id} type="number" min={1} max={32} value={form.max} onChange={(e) => setForm({ ...form, max: Number(e.target.value) })} />}</Field>
        <div className="grid grid-2">
          <Field label="Git author name" hint="Defaults to your Git config">{(id) => <Input id={id} value={form.authorName} onChange={(e) => setForm({ ...form, authorName: e.target.value })} />}</Field>
          <Field label="Git author email">{(id) => <Input id={id} value={form.authorEmail} onChange={(e) => setForm({ ...form, authorEmail: e.target.value })} />}</Field>
        </div>
        <Field label="Worker policy (JSON)" hint="Overrides organization/project policy on this worker, e.g. fallback chain or agent preferences.">{(id) => <Textarea id={id} rows={8} className="mono" value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value })} />}</Field>
        <label className="row"><input type="checkbox" checked={form.telemetry} onChange={(e) => setForm({ ...form, telemetry: e.target.checked })} /> Send anonymous health telemetry to my control plane (never code, prompts or secrets)</label>
        <label className="row"><input type="checkbox" checked={form.plugins} onChange={(e) => setForm({ ...form, plugins: e.target.checked })} /> Run approved plugin code on this machine (in a restricted process, when your organization has plugins turned on)</label>
        <p className="small muted">Local UI: {settings.data.localHost}:{settings.data.localPort}. Change the bind address only if you understand the exposure.</p>
      </div>
    </Card>
  );
}

function Updates() {
  const u = useData<{
    currentVersion: string;
    supported: boolean;
    reason?: string;
    error?: string;
    canInstall: boolean;
    policy: { policy: string; channel: string };
    manifestUrl: string | null;
    manifestUrlFromControlPlane: boolean;
    trustedKeyIds: string[];
    updateAvailable?: boolean;
    latest?: { version: string; publishedAt: string; notes: string } | null;
  }>('/api/updates');
  const [key, setKey] = useState({ keyId: '', pem: '' });
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'info', text: ok });
      u.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };
  if (!u.data) return <Spinner />;
  const d = u.data;
  return (
    <div className="stack">
      <Card title="Updates">
        <div className="stack">
          {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
          <KeyValue
            items={[
              ['Current version', d.currentVersion],
              ['Latest release', d.latest ? `${d.latest.version} (${new Date(d.latest.publishedAt).toLocaleDateString()})` : '—'],
              ['Update policy', d.policy.policy],
              ['Channel', d.policy.channel],
              ['Release source', d.manifestUrl ? `${d.manifestUrl}${d.manifestUrlFromControlPlane ? ' (your control plane)' : ''}` : 'none'],
            ]}
          />
          {!d.supported && <Alert tone="warn">{d.reason}</Alert>}
          {d.error && <Alert tone="danger">{d.error}</Alert>}
          {d.latest?.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{d.latest.notes}</p>}
          {d.updateAvailable && (
            <div>
              <Button variant="primary" disabled={!d.canInstall} onClick={() => void act(() => api('POST', '/api/updates/apply'), 'The update is installed. The worker restarts into it once running tasks have finished.')}>
                Install {d.latest?.version}
              </Button>
            </div>
          )}
        </div>
      </Card>
      <Card title="Trusted release keys">
        <div className="stack" style={{ maxWidth: 640 }}>
          <p className="small muted">Updates are installed only if they are signed with one of these keys. Add the publisher's Ed25519 public key (the <code>.public.pem</code> file from <code>scripts/sign-release.mjs keygen</code>). The control plane only delivers releases; it cannot add keys.</p>
          {d.trustedKeyIds.length > 0 && (
            <table className="table" aria-label="Trusted release keys">
              <tbody>
                {d.trustedKeyIds.map((id) => (
                  <tr key={id}>
                    <td className="mono">{id}</td>
                    <td><Button size="sm" variant="danger" onClick={() => confirm(`Stop trusting ${id}?`) && void act(() => api('DELETE', `/api/updates/trusted-keys/${encodeURIComponent(id)}`), `Removed ${id}.`)}>Remove</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Field label="Key id" hint="The id the releases are signed with">{(id) => <Input id={id} value={key.keyId} onChange={(e) => setKey({ ...key, keyId: e.target.value.trim() })} />}</Field>
          <Field label="Public key (PEM)">{(id) => <Textarea id={id} rows={4} className="mono" placeholder="-----BEGIN PUBLIC KEY-----" value={key.pem} onChange={(e) => setKey({ ...key, pem: e.target.value })} />}</Field>
          <div>
            <Button disabled={!key.keyId || !key.pem.includes('BEGIN PUBLIC KEY')} onClick={() => void act(() => api('PUT', `/api/updates/trusted-keys/${encodeURIComponent(key.keyId)}`, { publicKeyPem: key.pem }).then(() => setKey({ keyId: '', pem: '' })), 'Key added.')}>
              Trust this key
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function Root(): ReactNode {
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

/** Tokens for opening pull/merge requests through GitHub's or GitLab's API (GIT-004). */
function GitHosting() {
  const accounts = useData<Array<{ host: string; kind: 'github' | 'gitlab'; apiBaseUrl: string; tokenMasked: string | null }>>('/api/git-hosting');
  const [form, setForm] = useState({ host: 'github.com', kind: 'github' as 'github' | 'gitlab', apiBaseUrl: '', token: '' });
  const [msg, setMsg] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const save = async () => {
    try {
      await api('PUT', `/api/git-hosting/${encodeURIComponent(form.host.trim())}`, { kind: form.kind, token: form.token, ...(form.apiBaseUrl ? { apiBaseUrl: form.apiBaseUrl } : {}) });
      setForm({ ...form, token: '' });
      setMsg({ tone: 'info', text: 'Saved. The token is in the credential store and shown masked only.' });
      accounts.reload();
    } catch (e) {
      setMsg({ tone: 'danger', text: (e as Error).message });
    }
  };
  return (
    <Card title="Git hosting (pull requests)">
      <div className="stack" style={{ maxWidth: 640 }}>
        <p className="small muted">For tasks whose Git policy opens a pull request: a token for the repository's host lets this worker open it through GitHub's or GitLab's API. Without one, the GitHub CLI (gh) is used if it is installed and signed in.</p>
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
        {accounts.data?.length ? (
          <table className="table" aria-label="Git hosting accounts">
            <tbody>
              {accounts.data.map((a) => (
                <tr key={a.host}>
                  <td>{a.host}<div className="small muted">{a.kind} · {a.apiBaseUrl}</div></td>
                  <td className="mono small">{a.tokenMasked ?? '—'}</td>
                  <td><Button size="sm" variant="danger" onClick={() => confirm(`Remove the token for ${a.host}?`) && void api('DELETE', `/api/git-hosting/${encodeURIComponent(a.host)}`).then(accounts.reload)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className="grid grid-2">
          <Field label="Host" hint="As in the remote URL, e.g. github.com">{(id) => <Input id={id} value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />}</Field>
          <Field label="Type">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'github' | 'gitlab' })}><option value="github">GitHub</option><option value="gitlab">GitLab</option></Select>}</Field>
          <Field label="API URL" hint="Only for GitHub Enterprise or self-managed GitLab">{(id) => <Input id={id} value={form.apiBaseUrl} placeholder="https://github.example.com/api/v3" onChange={(e) => setForm({ ...form, apiBaseUrl: e.target.value })} />}</Field>
          <Field label="Token" hint="Needs permission to push and open pull/merge requests">{(id) => <Input id={id} type="password" autoComplete="off" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} />}</Field>
        </div>
        <div><Button variant="primary" disabled={!form.host.trim() || form.token.length < 8} onClick={() => void save()}>Save token</Button></div>
      </div>
    </Card>
  );
}
