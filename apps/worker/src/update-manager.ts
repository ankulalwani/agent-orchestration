import path from 'node:path';
import { AppError, captureError, createLogger } from '@ao/core';
import { RESTART_FOR_UPDATE_EXIT_CODE, launcherInstallDir, readInstallState, type InstallState } from './install-state.js';
import { Updater, confirmInstalledVersion, installStagedUpdate } from './updater.js';
import type { WorkerRuntime } from './runtime.js';

const log = createLogger('worker-updates');
const AUTO_CHECK_INTERVAL_MS = 6 * 3_600_000;

/**
 * Worker self-update (spec §66, D-017): check → download + verify (signature, checksum) → install as a
 * new version (pending) → drain (finish running tasks, claim nothing new) → exit 75 → the launcher
 * starts the new version, which confirms itself; if it never does, the launcher rolls back.
 * Only available when the worker runs under the launcher (installed layout).
 */
export class UpdateManager {
  private timer: NodeJS.Timeout | null = null;
  private applying = false;
  /** Set by the process entry point: stop cleanly and exit with the given code. */
  onRestart: (exitCode: number) => void = (code) => process.exit(code);

  constructor(
    private rt: WorkerRuntime,
    private currentVersion: string,
    private installDir: string | null = launcherInstallDir(),
  ) {}

  private updater() {
    const u = this.rt.config.get().updates;
    return new Updater({ currentVersion: this.currentVersion, manifestUrl: this.manifestUrl(), trustedKeys: u.trustedKeys, stagingDir: path.join(this.rt.dataDir, 'updates') });
  }

  installState(): InstallState | null {
    try {
      return this.installDir ? readInstallState(this.installDir) : null;
    } catch {
      return null;
    }
  }

  /** Why automatic installation is not possible here, or null. */
  /**
   * Where releases come from: `updates.manifestUrl`, or else the control plane this worker is connected to
   * (it hosts signed releases, WORKER-012). Trust never comes from there: only from `updates.trustedKeys`.
   */
  manifestUrl(): string | null {
    const u = this.rt.config.get().updates;
    if (u.manifestUrl) return u.manifestUrl;
    const cp = this.rt.controlPlaneUrl();
    return cp ? `${cp.replace(/\/+$/, '')}/api/v1/worker-releases/${u.channel}/manifest.json` : null;
  }

  unsupportedReason(): string | null {
    const u = this.rt.config.get().updates;
    if (!Object.keys(u.trustedKeys).length) return "No release signing key is trusted on this worker. Add the publisher's public key (Updates → Trusted keys), or update by re-running the installer.";
    if (!this.manifestUrl()) return 'No update source: connect the worker to a control plane or set updates.manifestUrl. Until then, update by re-running the installer.';
    if (!this.installDir) return 'This worker was not started by the installed launcher, so it cannot replace itself. Update by re-running the installer.';
    return null;
  }

  /** The newly started version reports that it works (called once it is up and running). */
  confirmStartup(): boolean {
    if (!this.installDir) return false;
    try {
      const confirmed = confirmInstalledVersion(this.installDir, this.currentVersion);
      if (confirmed) log.info({ version: this.currentVersion }, 'update confirmed');
      return confirmed;
    } catch (e) {
      log.warn({ err: String(e) }, 'could not confirm the installed version');
      return false;
    }
  }

  /** Install the available update, if any, then restart once running tasks have finished. */
  async applyAvailable(): Promise<{ installed: boolean; version?: string; reason?: string }> {
    const reason = this.unsupportedReason();
    if (reason) throw new AppError('CONFLICT', reason);
    if (this.applying) return { installed: false, reason: 'An update is already being installed' };
    this.applying = true;
    try {
      const u = this.updater();
      const check = await u.check();
      if (!check.updateAvailable || !check.latest) return { installed: false, reason: 'Already up to date' };
      if (this.installState()?.bad.includes(check.latest.version)) return { installed: false, reason: `Version ${check.latest.version} failed to start before and was rolled back` };
      const file = await u.stage(check.latest);
      installStagedUpdate(this.installDir!, file, check.latest);
      log.info({ from: this.currentVersion, to: check.latest.version }, 'update installed; restarting when idle');
      void this.drainAndRestart();
      return { installed: true, version: check.latest.version };
    } finally {
      this.applying = false;
    }
  }

  /** Stop claiming work, wait for running tasks to finish, then hand over to the launcher. */
  async drainAndRestart(pollMs = 1000) {
    this.rt.executor.draining = true;
    while (this.rt.executor.running.size > 0) await new Promise((r) => setTimeout(r, pollMs));
    await this.rt.flush().catch(() => undefined);
    this.onRestart(RESTART_FOR_UPDATE_EXIT_CODE);
  }

  /** `updates.policy = automatic`: check periodically and install when an update is available. */
  startAutomatic(firstCheckMs = 2 * 60_000) {
    this.stopAutomatic();
    const tick = async () => {
      if (this.rt.config.get().updates.policy !== 'automatic' || this.unsupportedReason()) return;
      try {
        await this.applyAvailable();
      } catch (e) {
        log.warn({ err: String(e) }, 'automatic update failed');
        captureError(e, { tags: { component: 'worker.update' } });
      }
    };
    const first = setTimeout(() => {
      void tick();
      this.timer = setInterval(() => void tick(), AUTO_CHECK_INTERVAL_MS);
      this.timer.unref?.();
    }, firstCheckMs);
    first.unref?.();
    this.timer = first;
  }

  stopAutomatic() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
