#!/usr/bin/env node
// Connects a freshly installed worker to a server and opens the approval page, so the user only has to click Approve.
//   node pair-worker.mjs <launcher.js> <server-url> [--no-open]
// Called by the installers (--pair-server / -PairServer). Never fails the install: it prints what to do instead.
import { spawn, spawnSync } from 'node:child_process';

const [launcher, server, ...flags] = process.argv.slice(2);
if (!launcher || !server) {
  console.error('usage: pair-worker.mjs <launcher.js> <server-url> [--no-open]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function agentctl(...args) {
  const r = spawnSync(process.execPath, [launcher, 'agentctl', ...args, '--json'], { encoding: 'utf8' });
  try {
    return { ok: r.status === 0, data: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, data: null, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  }
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
  } catch {
    /* the URL is printed as well */
  }
}

// The worker has just started: wait until its local API answers.
let status;
for (let i = 0; i < 30; i++) {
  status = agentctl('worker', 'status');
  if (status.ok) break;
  await sleep(1000);
}
if (!status?.ok) {
  console.log(`Could not talk to the worker yet. Connect it later with: agentctl worker connect --server ${server}`);
  process.exit(0);
}
if (status.data.workerId) {
  console.log(`This worker is already connected to ${status.data.controlPlaneUrl ?? 'a server'}.`);
  process.exit(0);
}

const started = agentctl('worker', 'connect', '--server', server);
if (!started.ok || !started.data?.verificationUrl) {
  console.log(`Could not start pairing${started.text ? `: ${started.text}` : ''}. Try: agentctl worker connect --server ${server}`);
  process.exit(0);
}
const { verificationUrl, userCode } = started.data;
console.log('');
console.log('Last step: approve this worker in your browser.');
console.log(`  ${verificationUrl}`);
console.log(`  Code: ${userCode} (check it matches what the page shows)`);
if (!flags.includes('--no-open')) openBrowser(verificationUrl);

// Wait for the approval (the pairing code lasts 15 minutes).
for (let i = 0; i < 300; i++) {
  await sleep(2000);
  const s = agentctl('worker', 'status');
  if (s.ok && s.data.workerId) {
    console.log(`Connected: worker "${s.data.name}" is paired with ${s.data.controlPlaneUrl ?? server}.`);
    process.exit(0);
  }
  const p = s.ok ? s.data.pairing?.status : null;
  if (p === 'denied' || p === 'expired') {
    console.log(`Pairing ${p}. Start it again with: agentctl worker connect --server ${server}`);
    process.exit(1);
  }
}
console.log(`Still waiting for approval. Open the link above, or run: agentctl worker connect --server ${server}`);
