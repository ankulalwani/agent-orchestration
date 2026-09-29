import fs from 'node:fs';
import path from 'node:path';

/**
 * Installed-worker layout for automatic updates (spec §66, decision D-017):
 *
 *   <install>/launcher.js       stable supervisor that the OS autostart entry runs
 *   <install>/state.json        which version is current, the previous one, a pending update, bad versions
 *   <install>/app/<version>/    one complete worker package per version (dist/main.js inside)
 *
 * Node built-ins only: the launcher uses this module and must run without node_modules.
 */
export interface InstallState {
  version: 1;
  current: string;
  previous: string | null;
  /** Set when switching to a new version; cleared when that version confirms it started correctly. */
  pending: { version: string; from: string; since: string } | null;
  /** Versions that failed to start and were rolled back; never switched to again automatically. */
  bad: string[];
}

/** Exit code the worker uses to ask the launcher to start the (new) current version. */
export const RESTART_FOR_UPDATE_EXIT_CODE = 75;

export const statePath = (installDir: string) => path.join(installDir, 'state.json');
export const versionDir = (installDir: string, version: string) => path.join(installDir, 'app', version);
export const versionMain = (installDir: string, version: string) => path.join(versionDir(installDir, version), 'dist', 'main.js');

export function readInstallState(installDir: string): InstallState {
  const s = JSON.parse(fs.readFileSync(statePath(installDir), 'utf8')) as Partial<InstallState>;
  if (s.version !== 1 || typeof s.current !== 'string') throw new Error(`Unrecognised install state in ${statePath(installDir)}`);
  return { version: 1, current: s.current, previous: s.previous ?? null, pending: s.pending ?? null, bad: s.bad ?? [] };
}

/** Atomic replace (write + rename), so a crash never leaves a half-written state file. */
export function writeInstallState(installDir: string, s: InstallState) {
  const file = statePath(installDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, file);
}

/** Which install directory this process runs from, when started by the launcher. */
export function launcherInstallDir(): string | null {
  return process.env.AO_INSTALL_DIR && fs.existsSync(statePath(process.env.AO_INSTALL_DIR)) ? process.env.AO_INSTALL_DIR : null;
}
