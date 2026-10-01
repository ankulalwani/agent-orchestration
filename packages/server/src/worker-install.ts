import { API_PREFIX } from '@ao/contracts';
import { AppError } from '@ao/core';
import type { ServerConfig } from './config.js';
import type { WorkerReleaseService } from './worker-releases.js';

/**
 * One-click worker install. The dashboard shows a one-line command (`curl … | sh`, `irm … | iex`) that
 * fetches a small shell/PowerShell script from this server. The script checks Node.js and runs the
 * bootstrap below, which downloads the newest published worker release from this server, verifies the
 * signature against the keys in WORKER_RELEASE_TRUSTED_KEYS and the package checksum, unpacks it and runs
 * the installer inside it (installers/ in the package), which registers autostart and starts pairing.
 *
 * Trust: whoever serves these scripts can run code on the machine, as with any `curl | sh`. The signature
 * check stops a swapped or tampered package; it can't help against a server that serves a different script.
 */

const SERVER_PLACEHOLDER = '__AO_SERVER__';

/** The server's public URL, safe to put inside quotes in a shell or PowerShell script. */
function serverUrl(config: ServerConfig): string {
  const url = config.PUBLIC_URL.replace(/\/+$/, '');
  if (/[\s'"`\\$;|&<>(){}]/.test(url)) throw new AppError('INTERNAL', 'PUBLIC_URL contains characters that are not allowed in an install script');
  return url;
}

const INSTALL_SH = String.raw`#!/bin/sh
# Agent Orchestration worker installer for macOS and Linux (served by __AO_SERVER__).
#   curl -fsSL __AO_SERVER__/api/v1/install/worker.sh | sh
# Downloads the signed worker release from that server, verifies it, installs it as a background service
# for your user, and opens your browser to approve the worker. Read this script before running it.
# Options after "sh -s --": --channel stable|beta
set -eu
SERVER='__AO_SERVER__'

say() { printf '\033[36m==> %s\033[0m\n' "$1"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js 20+ is required. Install it from https://nodejs.org (macOS: brew install node), then run this command again."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js 20+ is required (found $(node -v))."

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t ao-install)"
trap 'rm -rf "$TMP"' EXIT INT TERM
say "Downloading the installer from $SERVER"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$SERVER/api/v1/install/bootstrap.mjs" -o "$TMP/bootstrap.mjs"
elif command -v wget >/dev/null 2>&1; then wget -qO "$TMP/bootstrap.mjs" "$SERVER/api/v1/install/bootstrap.mjs"
else die "curl or wget is required."; fi
# stdin is this script when piped from curl; keep the installer from reading it.
node "$TMP/bootstrap.mjs" --server "$SERVER" "$@" </dev/null
`;

const INSTALL_PS1 = String.raw`# Agent Orchestration worker installer for Windows (served by __AO_SERVER__).
#   irm __AO_SERVER__/api/v1/install/worker.ps1 | iex
# Downloads the signed worker release from that server, verifies it, installs it for your user (starts at
# logon), and opens your browser to approve the worker. Read this script before running it.
$ErrorActionPreference = 'Stop'
$Server = '__AO_SERVER__'

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Stop-Install($m) { Write-Host "ERROR: $m" -ForegroundColor Red }

try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Stop-Install 'Node.js 20+ is required. Install it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), open a new terminal, and run this command again.'; return }
$major = [int]((& node -p 'process.versions.node').Split('.')[0])
if ($major -lt 20) { Stop-Install "Node.js 20+ is required (found $(& node -v))."; return }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('ao-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Say "Downloading the installer from $Server"
  Invoke-WebRequest -UseBasicParsing -Uri "$Server/api/v1/install/bootstrap.mjs" -OutFile (Join-Path $tmp 'bootstrap.mjs')
  & node (Join-Path $tmp 'bootstrap.mjs') --server $Server
  if ($LASTEXITCODE -ne 0) { Stop-Install "The installer stopped (exit code $LASTEXITCODE). See the messages above." }
} catch {
  Stop-Install $_.Exception.Message
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
`;

/**
 * Node.js program run by the install scripts (no dependencies; Node 20+). Written without backticks or
 * dollar-brace sequences so it can sit in a template string unchanged.
 */
const BOOTSTRAP_MJS = String.raw`// Agent Orchestration worker bootstrap: download, verify, unpack and install the worker release.
// Served by the control plane at /api/v1/install/bootstrap.mjs. Usage: node bootstrap.mjs --server <url> [--channel stable|beta] [--no-pair] [--no-service]
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGunzip } from 'node:zlib';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes('--' + name);
const server = (opt('server') || '').replace(/\/+$/, '');
const channel = opt('channel') || 'stable';
const say = (m) => console.log('==> ' + m);
const fail = (m) => { console.error('ERROR: ' + m); process.exit(1); };

if (!/^https?:\/\//.test(server)) fail('Missing --server <url>');
if (Number(process.versions.node.split('.')[0]) < 20) fail('Node.js 20+ is required (found ' + process.version + ').');
if (!['stable', 'beta'].includes(channel)) fail('--channel must be stable or beta');

async function getJson(url, what) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(30000) }); } catch (e) { fail('Could not reach ' + url + ': ' + e.message); }
  if (res.status === 404 && what === 'manifest') fail('This server has no worker release on the ' + channel + ' channel yet. An administrator must publish one (dashboard: Server > Worker releases).');
  if (!res.ok) fail('Could not read the ' + what + ' (HTTP ' + res.status + ').');
  return res.json();
}

const canonical = (m) => Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(m).sort().map((k) => [k, m[k]]))), 'utf8');
const compareVersions = (a, b) => {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

/** Unpacks a .tgz without external tools. Refuses absolute paths and ".." entries; skips links and special files. */
async function extractTgz(file, dest) {
  let chunks = [];
  let have = 0;
  const take = (n) => {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    chunks = rest.length ? [rest] : [];
    have = rest.length;
    return out;
  };
  const text = (b, start, len) => { const end = b.indexOf(0, start); return b.toString('utf8', start, end >= 0 && end < start + len ? end : start + len); };
  let state = 'header';
  let need = 512;
  let entry = null;
  let nextPath = null;
  let finished = false;
  let count = 0;

  const write = (e, data) => {
    if (e.type === 'x' || e.type === 'g') {
      if (e.type === 'x') {
        let p = 0;
        while (p < data.length) {
          const sp = data.indexOf(32, p);
          const len = parseInt(data.toString('utf8', p, sp), 10);
          if (!(len > 0)) break;
          const rec = data.toString('utf8', sp + 1, p + len - 1);
          const eq = rec.indexOf('=');
          if (rec.slice(0, eq) === 'path') nextPath = rec.slice(eq + 1);
          p += len;
        }
      }
      return;
    }
    if (e.type === 'L') { nextPath = text(data, 0, data.length); return; }
    const name = (nextPath || e.name).replace(/\\/g, '/');
    nextPath = null;
    const parts = name.split('/').filter((s) => s && s !== '.');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.includes('..')) fail('The package has an unsafe path: ' + name);
    if (!parts.length) return;
    const target = path.join(dest, ...parts);
    if (e.type === '5') { fs.mkdirSync(target, { recursive: true }); return; }
    if (e.type !== '0' && e.type !== '\0') return; // links and special files are not part of worker packages
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: (e.mode & 0o777) || 0o644 });
    count++;
  };

  const gunzip = createGunzip();
  const input = fs.createReadStream(file);
  input.on('error', (e) => gunzip.destroy(e));
  input.pipe(gunzip);
  for await (const chunk of gunzip) {
    chunks.push(chunk);
    have += chunk.length;
    while (!finished && have >= need) {
      const block = take(need);
      if (state === 'header') {
        if (block.every((b) => b === 0)) { finished = true; break; }
        let name = text(block, 0, 100);
        if (block.toString('latin1', 257, 262) === 'ustar') { const prefix = text(block, 345, 155); if (prefix) name = prefix + '/' + name; }
        entry = { name, size: parseInt(text(block, 124, 12).trim() || '0', 8), mode: parseInt(text(block, 100, 8).trim() || '0', 8), type: String.fromCharCode(block[156]) };
        if (!(entry.size >= 0)) fail('The package is not a valid tar file.');
        if (entry.size === 0) { write(entry, Buffer.alloc(0)); } else { state = 'body'; need = Math.ceil(entry.size / 512) * 512; }
      } else {
        write(entry, block.subarray(0, entry.size));
        state = 'header';
        need = 512;
      }
    }
    if (finished) break;
  }
  if (!count) fail('The package is empty or not a valid tar.gz.');
}

function workerDataDir() {
  if (process.env.AO_WORKER_HOME) return process.env.AO_WORKER_HOME;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'AgentOrchestration', 'worker');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'AgentOrchestration', 'worker');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agent-orchestration', 'worker');
}

/** Lets the new worker verify its own later updates against the same keys. Keys it already trusts are kept. */
function trustKeys(keys) {
  const dir = workerDataDir();
  const file = path.join(dir, 'config.json');
  let cfg = { version: 1 };
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.warn('Could not read ' + file + '; not adding release keys to it.'); return; }
  }
  cfg.updates = { ...(cfg.updates || {}), trustedKeys: { ...keys, ...((cfg.updates || {}).trustedKeys || {}) } };
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function main() {
  const info = await getJson(server + '/api/v1/install/config', 'install settings');
  const trusted = info.trustedKeys || {};
  if (!Object.keys(trusted).length) fail('This server has no release signing key configured (WORKER_RELEASE_TRUSTED_KEYS), so the download cannot be verified. Ask its administrator to set it, or install from source (docs/workers/README.md).');

  say('Finding the latest worker release (' + channel + ')');
  const signed = await getJson(server + '/api/v1/worker-releases/' + channel + '/manifest.json', 'manifest');
  const manifest = signed.manifest;
  const pem = trusted[signed.keyId];
  if (!manifest || !pem) fail('The release is signed with a key this server does not list as trusted (' + signed.keyId + ').');
  if (!verify(null, canonical(manifest), createPublicKey(pem), Buffer.from(signed.signature, 'base64'))) fail('The release signature is invalid. Nothing was installed.');
  if (new URL(manifest.packageUrl).origin !== new URL(server).origin) fail('The release points to another server (' + manifest.packageUrl + '). Nothing was installed.');
  if (compareVersions(process.versions.node, manifest.minNodeVersion || '20.0.0') < 0) fail('This release needs Node.js ' + manifest.minNodeVersion + '+ (found ' + process.version + ').');
  console.log('    worker ' + manifest.version + ', signed by ' + signed.keyId);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-worker-'));
  try {
    say('Downloading the worker');
    const res = await fetch(manifest.packageUrl, { signal: AbortSignal.timeout(10 * 60000) });
    if (!res.ok) fail('Download failed (HTTP ' + res.status + ').');
    const data = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(data).digest('hex') !== manifest.sha256) fail('The download does not match the signed checksum. Nothing was installed.');
    const tgz = path.join(work, 'worker.tgz');
    fs.writeFileSync(tgz, data);

    say('Unpacking');
    const out = path.join(work, 'unpacked');
    fs.mkdirSync(out);
    await extractTgz(tgz, out);
    const entries = fs.readdirSync(out);
    const root = fs.existsSync(path.join(out, 'dist', 'main.js')) ? out : entries.length === 1 ? path.join(out, entries[0]) : out;
    if (!fs.existsSync(path.join(root, 'dist', 'main.js'))) fail('The package has no dist/main.js.');
    const packaged = fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() : '';
    if (packaged !== manifest.version) fail('The package contains version ' + (packaged || '(none)') + ', the manifest says ' + manifest.version + '.');

    const win = process.platform === 'win32';
    const dir = path.join(root, 'installers', win ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux');
    const installer = path.join(dir, win ? 'install-worker.ps1' : 'install-worker.sh');
    if (!fs.existsSync(installer)) fail('This release has no installer inside it. Publish a package built with the current scripts/package-worker.mjs.');

    trustKeys(trusted);
    say('Installing');
    const extra = [];
    if (has('no-service')) extra.push(win ? '-NoService' : '--no-service');
    if (!has('no-pair')) extra.push(win ? '-PairServer' : '--pair-server', server);
    const r = win
      ? spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer, '-SourceDir', root, ...extra], { stdio: 'inherit' })
      : spawnSync('bash', [installer, '--source', root, ...extra], { stdio: 'inherit' });
    if (r.error) fail('Could not run the installer: ' + r.error.message);
    process.exitCode = r.status ?? 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

await main();
`;

export interface InstallConfigResponse {
  server: string;
  channel: string;
  latest: string | null;
  /** Release public keys the install script trusts (set by the operator, WORKER_RELEASE_TRUSTED_KEYS). */
  trustedKeys: Record<string, string>;
}

/** Serves the one-click install scripts and the settings they read. All public: nothing here is secret. */
export class WorkerInstallService {
  constructor(
    private readonly config: ServerConfig,
    private readonly releases: WorkerReleaseService,
  ) {}

  private render(template: string) {
    return template.split(SERVER_PLACEHOLDER).join(serverUrl(this.config));
  }

  shellScript() {
    return this.render(INSTALL_SH);
  }

  powershellScript() {
    return this.render(INSTALL_PS1);
  }

  bootstrap() {
    return BOOTSTRAP_MJS;
  }

  async settings(): Promise<InstallConfigResponse> {
    const stable = (await this.releases.list()).find((c) => c.channel === 'stable');
    return { server: serverUrl(this.config), channel: 'stable', latest: stable?.latest ?? null, trustedKeys: await this.releases.trustedKeys() };
  }

  /** The commands the dashboard shows. */
  commands() {
    const base = `${serverUrl(this.config)}${API_PREFIX}/install`;
    return { windows: `irm ${base}/worker.ps1 | iex`, macos: `curl -fsSL ${base}/worker.sh | sh`, linux: `curl -fsSL ${base}/worker.sh | sh` };
  }
}
