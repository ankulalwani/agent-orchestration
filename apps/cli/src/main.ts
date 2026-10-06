#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { API_PREFIX, type TaskDto } from '@ao/contracts';
import { ConfigStore, LOCAL_UI_TOKEN, createCredentialStore, defaultDataDir } from '@ao/worker';

/**
 * agentctl — CLI for the control plane and the local worker (spec §67). Uses the same HTTP API and
 * contracts as the web and mobile apps; worker commands talk to the loopback worker API.
 */

const HELP = `agentctl — Agent Orchestration CLI

Usage: agentctl <command> [options]

Control plane:
  login --server <url>                     Sign in through the web app (any method: password, Google, GitHub, SSO);
                                           opens the browser (--no-browser to only print the link)
  login --server <url> --email <email>     Sign in with a password (from AO_PASSWORD or prompt; two-factor code from AO_MFA_CODE or prompt)
  logout
  status                                   Overview of the current organization
  project list
  task list [--status S1,S2] [--project ID]
  task create --project ID --title T --prompt P [--priority HIGH] [--knowledge-file FILE]
              [--review-head BRANCH [--review-base main]]   Review a branch instead of changing code
              [--plan]                                     Break the goal into tasks (apply with task apply-plan)
  task apply-plan <id>                     Create the tasks a completed plan proposes
  task show <id>
  task cancel|retry|pause|resume <id>
  task input <id> --text "answer"
  logs <taskId> [--output]                 Task timeline
  insights [overview|cost|workers|reliability|flow] [--days 30] [--project ID]
                                           Analytics of finished tasks, spend, workers, failures and times
           [--csv TABLE]                   One table of the view as CSV (an unknown name lists the tables)
  agent list                               Agents reported by workers
  provider list                            Providers reported by workers

Local worker:
  worker status
  worker connect --server <url> | --hosted [--name N]   (--hosted: only in builds with a hosted service)
  worker disconnect
  doctor | diagnostics                     Run worker diagnostics
  update                                   Show update status

Options: --json for machine-readable output, --org <id> to pick an organization.

CI and scripts: set AO_SERVER, AO_TOKEN (a personal API token from Settings > Account) and AO_ORG
instead of logging in.
`;

const cliDir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'agentctl');
const cliFile = path.join(cliDir, 'config.json');
interface CliConfig {
  server?: string;
  organizationId?: string;
}
const readCli = (): CliConfig => {
  try {
    return JSON.parse(fs.readFileSync(cliFile, 'utf8'));
  } catch {
    return {};
  }
};
const writeCli = (c: CliConfig) => {
  fs.mkdirSync(cliDir, { recursive: true });
  fs.writeFileSync(cliFile, JSON.stringify(c, null, 2), { mode: 0o600 });
};

async function secrets() {
  return createCredentialStore(cliDir);
}

let json = false;
const out = (human: string, data?: unknown) => process.stdout.write((json && data !== undefined ? JSON.stringify(data, null, 2) : human) + '\n');
const fail = (msg: string): never => {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
};

// ── Control-plane HTTP with transparent refresh ───────────────────────────
async function api<T>(method: string, p: string, body?: unknown, retry = true): Promise<T> {
  // CI and scripts: AO_SERVER + AO_TOKEN (a personal API token) instead of `agentctl login`.
  const cfg = { ...readCli(), ...(process.env.AO_SERVER ? { server: process.env.AO_SERVER } : {}) };
  if (!cfg.server) fail('Not logged in. Run: agentctl login --server <url> --email <email>, or set AO_SERVER and AO_TOKEN');
  const store = await secrets();
  const apiToken = process.env.AO_TOKEN;
  const token = apiToken ?? (await store.get('access-token'));
  const res = await fetch(cfg.server!.replace(/\/+$/, '') + API_PREFIX + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && apiToken) fail('The API token in AO_TOKEN is invalid, expired or revoked.');
  if (res.status === 401 && retry) {
    const rt = await store.get('refresh-token');
    if (rt) {
      const r = await fetch(cfg.server!.replace(/\/+$/, '') + API_PREFIX + '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) });
      if (r.ok) {
        const s = (await r.json()) as { accessToken: string; refreshToken: string };
        await store.set('access-token', s.accessToken);
        await store.set('refresh-token', s.refreshToken);
        return api(method, p, body, false);
      }
    }
    fail('Session expired. Run agentctl login again.');
  }
  const text = await res.text();
  // Everything is JSON, except a CSV export.
  const data = !text ? undefined : (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
  if (!res.ok) fail(`${data?.error?.message ?? `HTTP ${res.status}`}${data?.error?.correlationId ? ` (ref ${data.error.correlationId})` : ''}`);
  return data as T;
}

function orgId(flag?: string) {
  const id = flag ?? process.env.AO_ORG ?? readCli().organizationId;
  if (!id) fail('No organization selected; pass --org <id>');
  return id!;
}

/** Opens a URL in the default browser; failures are ignored (the link is printed anyway). */
function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    /* printed above */
  }
}

async function prompt(q: string): Promise<string> {
  process.stdout.write(q);
  return new Promise((resolve) => {
    process.stdin.once('data', (d) => resolve(d.toString('utf8').trim()));
  });
}

// ── Local worker API ──────────────────────────────────────────────────────
async function local<T>(method: string, p: string, body?: unknown): Promise<T> {
  const dataDir = defaultDataDir();
  // A worker creates its data folder and local UI token on first start; config.json appears only once
  // something is configured, so a freshly installed worker has none.
  if (!fs.existsSync(dataDir)) fail(`No worker installed for this user (looked in ${dataDir})`);
  const token = await (await createCredentialStore(dataDir)).get(LOCAL_UI_TOKEN);
  if (!token) fail(`No worker has started for this user yet (looked in ${dataDir})`);
  const cfg = new ConfigStore(dataDir).get();
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.localPort}${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return fail(`Worker is not running on 127.0.0.1:${cfg.localPort}. Start the worker service (see docs/workers/).`);
  }
  const data = (await res.json()) as { error?: { message?: string } };
  if (!res.ok) fail(data?.error?.message ?? `HTTP ${res.status}`);
  return data as T;
}

const pad = (s: unknown, n: number) => String(s ?? '').slice(0, n).padEnd(n);
const ICON: Record<string, string> = { ok: '✔', warn: '!', fail: '✖', info: '·' };

// ── Insights as text ───────────────────────────────────────────────────────
const pct = (v: number | null) => (v == null ? '-' : `${Math.round(v * 100)}%`);
const usd = (v: number | null) => (v == null ? '-' : `$${v.toFixed(2)}`);
function dur(ms: number | null) {
  if (ms == null) return '-';
  const m = Math.round(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : m < 2880 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
/** Rows as aligned columns under a header. */
function columns(header: string[], rows: Array<Array<string | number>>) {
  if (!rows.length) return '  (none)';
  const all = [header, ...rows.map((r) => r.map(String))];
  const width = header.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all.map((r) => '  ' + r.map((c, i) => c.padEnd(width[i]!)).join('  ').trimEnd()).join('\n');
}
const outcome = (title: string, label: string, rows: any[], name: (r: any) => string) =>
  `${title}\n` + columns([label, 'Finished', 'Failed', 'Success', 'First pass', 'Cost/completed', 'Agent time'], rows.map((r) => [name(r), r.finished, r.failed, pct(r.successRate), pct(r.firstPassRate), usd(r.costPerCompletedUsd), dur(r.avgActiveMs)]));

function insights(view: string, d: any): string {
  const head = `Last ${d.days} days (since ${String(d.since).slice(0, 10)}, UTC)`;
  switch (view) {
    case 'cost':
      return [
        head,
        `Spend ${usd(d.totals.costUsd)} (period before: ${usd(d.previous.costUsd)})  Sessions ${d.totals.sessions}  Tokens in ${d.totals.inputTokens} out ${d.totals.outputTokens}`,
        'Budgets this month',
        columns(['Budget', 'Spent', 'Limit', 'Forecast', ''], d.budgets.map((b: any) => [b.name, usd(b.spentUsd), b.limitUsd == null ? 'none' : usd(b.limitUsd), usd(b.forecastUsd), b.state === 'exceeded' ? 'limit reached' : b.forecastExceeds ? 'over the limit at this rate' : ''])),
        'By project',
        columns(['Project', 'Cost', 'Sessions'], d.byProject.map((r: any) => [r.name, usd(r.costUsd), r.sessions])),
        'By model',
        columns(['Model', 'Cost', 'Sessions'], d.byModel.map((r: any) => [`${r.providerId}/${r.modelId}`, usd(r.costUsd), r.sessions])),
        'Most expensive tasks',
        columns(['Task', 'Cost', 'Title'], d.topTasks.map((t: any) => [t.taskId, usd(t.costUsd), t.title])),
      ].join('\n');
    case 'workers':
      return [
        head,
        columns(
          ['Worker', 'Status', 'Finished', 'Success', 'Agent time', 'Online', 'Utilization', 'Cost', 'Stopped'],
          d.workers.map((w: any) => [w.name, w.status, w.finished, pct(w.successRate), dur(w.sessionMs), w.onlineMs == null ? '-' : `${dur(w.onlineMs)} (${pct(w.onlineShare)})`, pct(w.utilization), usd(w.costUsd), w.stops]),
        ),
      ].join('\n');
    case 'reliability':
      return [
        head,
        `Stopped ${d.totals.stops} (period before: ${d.totals.previousStops})  Still stopped ${d.totals.stillStopped}  Recovered ${d.totals.recovered}`,
        `Limits hit ${d.totals.limitHits}  Fell back ${d.totals.fallbacks}  Context resets ${d.totals.contextResets}  Restarts ${d.totals.restarts}  Fix rounds ${d.totals.remediations}`,
        'Why tasks stopped',
        columns(['Reason', 'Stopped', 'Still stopped', 'Recovered'], d.byCategory.map((c: any) => [c.category, c.stops, c.stillStopped, c.recovered])),
        'Verification steps',
        columns(['Step', 'Runs', 'Failed', 'Failure rate', 'Average time'], d.verificationSteps.map((s: any) => [s.name, s.runs, s.failed, pct(s.failureRate), dur(s.avgDurationMs)])),
      ].join('\n');
    case 'flow':
      return [
        head,
        `Times of ${d.samples} completed tasks${d.capped ? ' (the most recent)' : ''}`,
        columns(
          ['Time', 'Median', '90th percentile', 'Average'],
          ([['Waiting to start', d.times.startWait], ['Agent and verification', d.times.active], ['Created to completed', d.times.lead]] as Array<[string, any]>).map(([l, s]) => [l, dur(s.p50Ms), dur(s.p90Ms), dur(s.avgMs)]),
        ),
        outcome('By creator', 'Creator', d.byCreator, (r) => r.name),
        outcome('By source', 'Source', d.bySource, (r) => r.source),
        outcome('By kind', 'Kind', d.byKind, (r) => r.kind),
        outcome('By priority', 'Priority', d.byPriority, (r) => r.priority),
      ].join('\n');
    default: {
      const t = d.totals;
      return [
        head,
        `Finished ${t.finished} (period before: ${d.previous.finished})  Completed ${t.completed}  Failed ${t.failed}  Created ${t.created}`,
        `Success ${pct(t.successRate)}  First pass ${pct(t.firstPassRate)}  Cost ${usd(t.costUsd)}  Cost/completed ${usd(t.costPerCompletedUsd)}  Agent time ${dur(t.avgActiveMs)}  Lead time ${dur(t.avgLeadMs)}`,
        outcome('By agent', 'Agent', d.byAgent, (r) => r.agentId),
        outcome('By model', 'Model', d.byModel, (r) => `${r.providerId}/${r.modelId}`),
        outcome('By project', 'Project', d.byProject, (r) => r.name),
      ].join('\n');
    }
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      server: { type: 'string' },
      email: { type: 'string' },
      org: { type: 'string' },
      status: { type: 'string' },
      project: { type: 'string' },
      title: { type: 'string' },
      prompt: { type: 'string' },
      'knowledge-file': { type: 'string' },
      'review-head': { type: 'string' },
      'review-base': { type: 'string' },
      plan: { type: 'boolean' },
      priority: { type: 'string' },
      text: { type: 'string' },
      hosted: { type: 'boolean' },
      name: { type: 'string' },
      output: { type: 'boolean' },
      days: { type: 'string' },
      csv: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'no-browser': { type: 'boolean' },
    },
  });
  json = Boolean(values.json);
  const [cmd, sub, arg] = positionals;
  if (!cmd || values.help || cmd === 'help') return out(HELP);

  switch (cmd) {
    case 'login': {
      const server = values.server ?? readCli().server ?? fail('--server is required');
      const save = async (data: any) => {
        const store = await secrets();
        await store.set('access-token', data.accessToken);
        await store.set('refresh-token', data.refreshToken);
        writeCli({ server, organizationId: values.org ?? data.memberships[0]?.organizationId });
        out(`Signed in as ${data.user.email}. Organization: ${data.memberships[0]?.organizationName ?? '(none)'}`, { user: data.user, memberships: data.memberships });
        process.exit(0);
      };
      if (!values.email) {
        // Device sign-in: approve in the web app, where any sign-in method (including SSO) works.
        const call = async (p: string, body: unknown) => {
          const res = await fetch(server.replace(/\/+$/, '') + API_PREFIX + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
          return { res, data: (await res.json()) as any };
        };
        const start = await call('/auth/device/start', { clientName: `agentctl on ${os.hostname()}` });
        if (!start.res.ok) fail(start.data?.error?.message ?? 'Could not start signing in');
        process.stderr.write(`To sign in, open ${start.data.verificationUrl}\nand check that it shows the code ${start.data.userCode}.\n`);
        if (!values['no-browser']) openBrowser(start.data.verificationUrl);
        const deadline = new Date(start.data.expiresAt).getTime();
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, start.data.intervalSec * 1000));
          const poll = await call('/auth/device/poll', { pollSecret: start.data.pollSecret });
          if (!poll.res.ok) fail(poll.data?.error?.message ?? 'Signing in failed');
          if (poll.data.status === 'approved') await save(poll.data);
        }
        fail('The code expired before it was approved. Run agentctl login again.');
      }
      const email = values.email!;
      const password = process.env.AO_PASSWORD ?? (await prompt('Password: '));
      const loginOnce = async (mfaCode?: string) => {
        const res = await fetch(server.replace(/\/+$/, '') + API_PREFIX + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, mfaCode }) });
        return { res, data: (await res.json()) as any };
      };
      let { res, data } = await loginOnce();
      if (!res.ok && data?.error?.code === 'MFA_REQUIRED') {
        // Two-factor account: authenticator or recovery code (AO_MFA_CODE for scripts).
        ({ res, data } = await loginOnce(process.env.AO_MFA_CODE ?? (await prompt('Authentication code: '))));
      }
      if (!res.ok) fail(data?.error?.message ?? 'Login failed');
      await save(data);
      return;
    }
    case 'logout': {
      const store = await secrets();
      const rt = await store.get('refresh-token');
      if (rt && readCli().server) await fetch(readCli().server + API_PREFIX + '/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: rt }) }).catch(() => undefined);
      await store.delete('access-token');
      await store.delete('refresh-token');
      return out('Signed out');
    }
    case 'status': {
      const o = await api<any>('GET', `/orgs/${orgId(values.org)}/overview`);
      return out(
        [
          `Active ${o.activeTasks}  Waiting ${o.waitingTasks}  Completed today ${o.completedToday}  Failed ${o.failedTasks}  Recovery required ${o.recoveryRequired}`,
          `Workers online ${o.workersOnline}  offline ${o.workersOffline}  Pending approvals ${o.pendingApprovals}`,
          ...o.needsAttention.map((t: any) => `  ! ${t.status.padEnd(20)} ${t.title}${t.reason ? ` — ${t.reason}` : ''}`),
        ].join('\n'),
        o,
      );
    }
    case 'insights': {
      const view = sub ?? 'overview';
      if (!['overview', 'cost', 'workers', 'reliability', 'flow'].includes(view)) fail('insights takes one of: overview, cost, workers, reliability, flow');
      const qs = new URLSearchParams({ days: values.days ?? '30', ...(values.project ? { projectId: values.project } : {}), ...(values.csv ? { format: 'csv', table: values.csv } : {}) });
      const data = await api<any>('GET', `/orgs/${orgId(values.org)}/analytics${view === 'overview' ? '' : `/${view}`}?${qs}`);
      if (values.csv) return void process.stdout.write(data);
      return out(insights(view, data), data);
    }
    case 'project':
      if (sub === 'list') {
        const ps = await api<any[]>('GET', `/orgs/${orgId(values.org)}/projects`);
        return out(ps.map((p) => `${p.id}  ${p.name}`).join('\n') || '(no projects)', ps);
      }
      break;
    case 'task': {
      const org = orgId(values.org);
      if (sub === 'list') {
        const qs = new URLSearchParams({ limit: '50', ...(values.status ? { status: values.status } : {}), ...(values.project ? { projectId: values.project } : {}) });
        const r = await api<{ items: TaskDto[] }>('GET', `/orgs/${org}/tasks?${qs}`);
        return out(r.items.map((t) => `${t.id}  ${pad(t.status, 20)} ${pad(t.priority, 8)} ${t.title}`).join('\n') || '(no tasks)', r.items);
      }
      if (sub === 'create') {
        const t = await api<TaskDto>('POST', `/orgs/${org}/tasks`, {
          projectId: values.project ?? fail('--project is required'),
          title: values.title ?? fail('--title is required'),
          prompt: values.prompt ?? fail('--prompt is required'),
          priority: values.priority?.toUpperCase() ?? 'NORMAL',
          ...(values['knowledge-file'] ? { knowledge: fs.readFileSync(values['knowledge-file'], 'utf8') } : {}),
          ...(values['review-head'] ? { kind: 'review', review: { base: values['review-base'] ?? 'main', head: values['review-head'] } } : values.plan ? { kind: 'plan' } : {}),
        });
        return out(`Created task ${t.id} (${t.status})`, t);
      }
      if (sub === 'apply-plan' && arg) {
        const r = await api<{ taskIds: string[] }>('POST', `/orgs/${org}/tasks/${arg}/apply-plan`);
        return out(`Created ${r.taskIds.length} task(s):\n${r.taskIds.join('\n')}`, r);
      }
      if (sub === 'show' && arg) {
        const t = await api<TaskDto>('GET', `/orgs/${org}/tasks/${arg}`);
        return out(
          [
            `${t.title}  [${t.status}]${t.statusReason ? ` — ${t.statusReason}` : ''}`,
            `Agent ${t.agentId ?? '-'} · Provider ${t.providerId ?? '-'} · Model ${t.modelId ?? '-'} · Worker ${t.workerId ?? '-'}`,
            `Verification ${t.verificationStatus} · Git ${t.gitStatus}${t.gitResult?.commit ? ` ${t.gitResult.commit.slice(0, 10)}` : ''}`,
            `Restarts ${t.restartCount} · Limit hits ${t.limitHitCount} · Context resets ${t.contextResetCount} · Remediations ${t.remediationCount}`,
            t.pendingInteraction ? `Needs ${t.pendingInteraction.kind}: ${t.pendingInteraction.question}` : '',
            t.completionReport ? `\n${t.completionReport.summary}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
          t,
        );
      }
      if (['cancel', 'retry', 'restart', 'pause', 'resume', 'approve', 'deny'].includes(sub ?? '') && arg) {
        const t = await api<TaskDto>('POST', `/orgs/${org}/tasks/${arg}/actions`, { action: sub });
        return out(`${sub}: task is ${t.status}`, t);
      }
      if (sub === 'input' && arg) {
        const t = await api<TaskDto>('POST', `/orgs/${org}/tasks/${arg}/actions`, { action: 'input', input: values.text ?? fail('--text is required') });
        return out(`Input sent (${t.status})`, t);
      }
      break;
    }
    case 'logs': {
      const id = sub ?? fail('task id required');
      const r = await api<{ items: any[] }>('GET', `/orgs/${orgId(values.org)}/tasks/${id}/events?limit=500${values.output ? '&includeOutput=true' : ''}`);
      return out(
        r.items
          .map((e) => `${e.timestamp}  ${pad(e.type, 24)} ${e.type === 'AgentOutput' ? (e.payload.lines ?? []).join('\n' + ' '.repeat(50)) : JSON.stringify(e.payload).slice(0, 160)}`)
          .join('\n'),
        r.items,
      );
    }
    case 'agent':
    case 'provider': {
      const ws = await api<any[]>('GET', `/orgs/${orgId(values.org)}/workers`);
      if (cmd === 'agent') {
        const rows = ws.flatMap((w) => w.agents.map((a: any) => ({ worker: w.name, ...a })));
        return out(rows.map((a) => `${pad(a.worker, 16)} ${pad(a.id, 12)} ${a.installed ? `installed ${a.version ?? ''}` : 'not installed'}`).join('\n') || '(none)', rows);
      }
      const rows = ws.flatMap((w) => w.providers.map((p: any) => ({ worker: w.name, ...p })));
      return out(rows.map((p) => `${pad(p.worker, 16)} ${pad(p.id, 14)} ${p.limited ? 'LIMITED' : p.healthy ? 'healthy' : 'unhealthy'}  ${p.models.length} models`).join('\n') || '(none)', rows);
    }
    case 'worker': {
      if (sub === 'status') {
        const s = await local<any>('GET', '/api/status');
        return out(
          [
            `Worker ${s.name} (${s.workerId ?? 'not paired'}) v${s.version}`,
            `Control plane: ${s.controlPlaneUrl ?? '-'} [${s.connection.state}]`,
            `CPU ${s.metrics.cpuLoadPercent ?? '?'}%  RAM free ${s.metrics.freeMemoryMb} MB  Disk free ${s.metrics.freeDiskMb ?? '?'} MB`,
            `Active tasks ${s.activeTasks.length}/${s.maxConcurrentTasks}  Unsent events ${s.unsentEvents}  Credentials: ${s.credentialBackend}`,
          ].join('\n'),
          s,
        );
      }
      if (sub === 'connect') {
        const r = await local<any>('POST', '/api/connect', { mode: values.hosted ? 'hosted' : 'self-hosted', url: values.hosted ? null : (values.server ?? fail('--server <url> or --hosted is required')), name: values.name });
        return out(`Open ${r.verificationUrl} and enter code ${r.userCode} to approve this worker.`, r);
      }
      if (sub === 'disconnect') {
        await local('POST', '/api/disconnect');
        return out('Worker disconnected and credential removed');
      }
      break;
    }
    case 'doctor':
    case 'diagnostics': {
      const checks = await local<Array<{ label: string; status: string; detail: string; fix?: string }>>('GET', '/api/diagnostics');
      out(checks.map((c) => `${ICON[c.status] ?? '?'} ${pad(c.label, 34)} ${c.detail}${c.fix ? `\n    → ${c.fix}` : ''}`).join('\n'), checks);
      if (checks.some((c) => c.status === 'fail')) process.exitCode = 2;
      return;
    }
    case 'update': {
      const u = await local<any>('GET', '/api/updates');
      return out(`Worker ${u.currentVersion}. ${u.supported ? '' : u.reason}`, u);
    }
  }
  out(HELP);
  process.exitCode = 1;
}

main().catch((e) => fail(String(e?.message ?? e)));
