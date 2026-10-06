/**
 * Worker launcher (spec §66, D-017): the small, stable program the OS autostart entry runs. It starts
 * the current worker version and supervises it:
 * - exit code 75 → the worker installed an update; start the new current version;
 * - a pending (unconfirmed) version that exits → roll back to the previous version and mark it bad;
 * - any other exit → restart the same version with a growing delay (like `Restart=on-failure`).
 * Node built-ins only, so it keeps working whatever the installed versions contain.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESTART_FOR_UPDATE_EXIT_CODE, readInstallState, versionMain, writeInstallState, type InstallState } from './install-state.js';

const installDir = process.env.AO_INSTALL_DIR ?? path.dirname(fileURLToPath(import.meta.url));
const MAX_BACKOFF_MS = 60_000;
// stderr: stdout belongs to the worker (installers read `--print-ui-url` output from it).
const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} launcher: ${msg}\n`);

let stopping = false;
let child: ReturnType<typeof spawn> | null = null;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child) child.kill(sig);
    else process.exit(0);
  });
}

/** A new version must confirm within this time, or it is stopped and rolled back (a hang counts as failure). */
const CONFIRM_TIMEOUT_MS = Number(process.env.AO_UPDATE_CONFIRM_TIMEOUT_MS ?? 5 * 60_000);

function run(version: string, args: string[]): Promise<number> {
  const main = versionMain(installDir, version);
  if (!fs.existsSync(main)) return Promise.resolve(-1);
  log(`starting worker ${version}`);
  const c = spawn(process.execPath, [main, ...args], {
    cwd: path.dirname(path.dirname(main)),
    stdio: 'inherit',
    windowsHide: true, // no console window when the launcher itself has none (the desktop app)
    env: { ...process.env, AO_INSTALL_DIR: installDir, AO_WORKER_VERSION: version, AO_LAUNCHER_PID: String(process.pid) },
  });
  child = c;
  const startedAt = Date.now();
  const watchdog = setInterval(() => {
    try {
      const s = readInstallState(installDir);
      if (s.pending?.version === version && Date.now() - startedAt > CONFIRM_TIMEOUT_MS) {
        log(`worker ${version} did not confirm within ${Math.round(CONFIRM_TIMEOUT_MS / 1000)} s; stopping it`);
        c.kill();
      }
    } catch {
      /* state briefly unreadable during a write; check again next tick */
    }
  }, 1000);
  return new Promise((resolve) =>
    c.once('exit', (code, signal) => {
      clearInterval(watchdog);
      resolve(code ?? (signal ? 1 : 0));
    }),
  );
}

/**
 * `launcher.js record-install <version>` (used by the installers): make an installed version current.
 * The version it replaces is kept as `previous`; an explicit reinstall clears a rollback mark.
 */
function recordInstall(version: string) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) || !fs.existsSync(versionMain(installDir, version))) {
    throw new Error(`Version ${version} is not installed in ${installDir}`);
  }
  let old: InstallState | null = null;
  try {
    old = readInstallState(installDir);
  } catch {
    /* first install */
  }
  const previous = old ? (old.current !== version ? old.current : old.previous) : null;
  writeInstallState(installDir, { version: 1, current: version, previous, pending: null, bad: (old?.bad ?? []).filter((v) => v !== version) });
  log(`installed version ${version}${previous ? ` (previous: ${previous})` : ''}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'record-install') return recordInstall(args[1] ?? '');
  // `launcher.js agentctl …` runs the CLI of the current version (stable path for the shell shim).
  if (args[0] === 'agentctl') {
    const cli = path.join(path.dirname(versionMain(installDir, readInstallState(installDir).current)), 'agentctl.js');
    const c = spawn(process.execPath, [cli, ...args.slice(1)], { stdio: 'inherit' });
    c.once('exit', (code) => process.exit(code ?? 1));
    return;
  }
  // Started by the desktop app: stop when it is gone (it may have crashed), or the worker would keep the
  // local port and the next start of the app could not run its own.
  const supervisorPid = Number(process.env.AO_SUPERVISOR_PID);
  if (supervisorPid > 0) {
    setInterval(() => {
      try {
        process.kill(supervisorPid, 0);
      } catch {
        log('the desktop app is gone; stopping');
        stopping = true;
        if (child) child.kill();
        else process.exit(0);
      }
    }, 5000).unref();
  }
  let failures = 0;
  for (;;) {
    const state = readInstallState(installDir);
    const version = state.current;
    const code = await run(version, args);
    child = null;
    if (stopping) process.exit(0);

    const after = readInstallState(installDir);
    if (code === RESTART_FOR_UPDATE_EXIT_CODE && after.current !== version) {
      log(`switching ${version} → ${after.current}`);
      failures = 0;
      continue;
    }
    if (after.pending && after.pending.version === version) {
      // The new version never confirmed that it works: go back.
      log(`worker ${version} failed before confirming (exit ${code}); rolling back to ${after.pending.from}`);
      writeInstallState(installDir, { ...after, current: after.pending.from, previous: null, pending: null, bad: [...new Set([...after.bad, version])] });
      failures = 0;
      continue;
    }
    if (code === 0) {
      log(`worker ${version} exited normally`);
      process.exit(0);
    }
    failures++;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(failures - 1, 6));
    log(`worker ${version} exited with ${code}; restarting in ${Math.round(delay / 1000)} s`);
    await new Promise((r) => setTimeout(r, delay));
  }
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
