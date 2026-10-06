import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureError, createLogger, errorReporter, installCrashReporting } from '@ao/core';
import { WorkerRuntime, WORKER_VERSION } from './runtime.js';
import { buildLocalApi } from './local-api.js';

const log = createLogger('worker-main');

/** Worker entry point; startup order per spec §11. Run as an OS service by the installers. */
async function main() {
  // Installer helper: print the local UI link (with the local token) and exit.
  if (process.argv.includes('--print-ui-url')) {
    const { ConfigStore } = await import('./config.js');
    const { createCredentialStore, LOCAL_UI_TOKEN } = await import('./credentials.js');
    const cfg = new ConfigStore();
    const store = await createCredentialStore(cfg.dataDir);
    let token = await store.get(LOCAL_UI_TOKEN);
    if (!token) {
      const { newSecretToken } = await import('@ao/core');
      token = newSecretToken(24);
      await store.set(LOCAL_UI_TOKEN, token);
    }
    process.stdout.write(`http://127.0.0.1:${cfg.get().localPort}/#token=${token}\n`);
    return;
  }
  const rt = new WorkerRuntime();
  await rt.init(); // 1–2: configuration + secure credentials
  const tracking = rt.config.get().errorTracking;
  const dsn = process.env.AO_ERROR_TRACKING_DSN ?? tracking.dsn;
  const webhookUrl = process.env.AO_ERROR_TRACKING_WEBHOOK_URL ?? tracking.webhookUrl;
  if (dsn || webhookUrl) errorReporter.configure({ service: 'worker', dsn, webhookUrl, release: WORKER_VERSION, environment: process.env.NODE_ENV ?? 'production' });
  installCrashReporting((err) => {
    log.fatal({ err: err instanceof Error ? err.stack : String(err) }, 'worker crashed');
    process.exit(1);
  });
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Packaged layout ships the UI next to the bundle (dist/ui); the monorepo dev layout uses apps/worker-ui/dist.
  const uiDir = process.env.AO_WORKER_UI_DIR ?? [path.resolve(here, 'ui'), path.resolve(here, '../../worker-ui/dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));
  const api = await buildLocalApi(rt, { uiDir, onShutdown: process.env.AO_DESKTOP === '1' ? () => void shutdown('desktop-app') : undefined }); // 3–4: local API + UI
  const cfg = rt.config.get();
  await api.listen({ port: cfg.localPort, host: cfg.localHost });
  const url = `http://${cfg.localHost === '0.0.0.0' ? '127.0.0.1' : cfg.localHost}:${cfg.localPort}/#token=${await rt.localUiToken()}`;
  log.info({ version: WORKER_VERSION, dataDir: rt.dataDir }, 'worker started');
  // The URL (with the local token in the fragment, never sent to servers) is printed for the installer/user.
  process.stdout.write(`\nWorker local UI: ${url}\n\n`);
  // 5–11: agents/providers validated in init(); connect, authenticate, heartbeat, report capabilities.
  await rt.connect();

  // Updates (D-017). A version started as a pending update confirms once it is connected, or after
  // it has run for a while without crashing (the control plane may simply be unreachable).
  if (rt.updates.installState()?.pending?.version === WORKER_VERSION) {
    const confirm = () => void rt.updates.confirmStartup();
    rt.client?.onState((s) => s === 'connected' && confirm());
    setTimeout(confirm, Number(process.env.AO_UPDATE_CONFIRM_AFTER_MS ?? 30_000)).unref();
  }
  rt.updates.onRestart = (code) => {
    log.info({ code }, 'restarting into the updated version');
    void rt.stop().finally(() => api.close().finally(() => process.exit(code)));
  };
  rt.updates.startAutomatic();

  // Started by the launcher: stop if it is gone. On Windows a killed parent does not take its children
  // with it, and an orphaned worker would keep the local port so the next start could not bind it.
  const launcherPid = Number(process.env.AO_LAUNCHER_PID);
  if (launcherPid > 0) {
    setInterval(() => {
      try {
        process.kill(launcherPid, 0);
      } catch {
        log.warn({ launcherPid }, 'launcher is gone; stopping');
        void shutdown('launcher-exit');
      }
    }, 5000).unref();
  }

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker stopping');
    await rt.stop();
    await api.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  log.fatal({ err: String(e) }, 'worker failed to start');
  captureError(e, { level: 'fatal', tags: { component: 'startup' } });
  void errorReporter.flush(2000).finally(() => process.exit(1));
});
