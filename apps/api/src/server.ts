import type { FastifyInstance } from 'fastify';
import { captureError, createLogger, errorReporter, installCrashReporting } from '@ao/core';
import { connectDatabase, disconnectDatabase } from '@ao/database';
import { createServices, loadServerConfig, reencryptSecrets, type Services } from '@ao/server';
import { buildApp, type ControlPlaneExtension } from './app.js';

export { controlPlaneCommands, runCommandFromArgv } from './commands.js';

export interface StartControlPlaneOptions {
  /** Environment to read configuration from (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Extra routes and hooks, registered before the core routes (see `ControlPlaneExtension`). */
  extend?: ControlPlaneExtension;
  /** Logger name and the word used in log messages (default: "api"). */
  name?: string;
}

/**
 * Starts a control plane: database, services, HTTP server, scheduler, graceful shutdown. The self-hosted
 * entry point calls it without options; distributions that add their own routes pass `extend`, so the
 * startup sequence exists once.
 */
export async function startControlPlane(opts: StartControlPlaneOptions = {}): Promise<{ app: FastifyInstance; services: Services }> {
  const log = createLogger(opts.name ?? 'api');
  const config = loadServerConfig(opts.env);
  await connectDatabase({ uri: config.MONGODB_URI });
  log.info('connected to MongoDB');
  const services = await createServices(config);
  // Settings and feature flags changed in the web app; reloaded periodically for other instances.
  await services.settings.start();
  await services.features.start();
  installCrashReporting((err) => {
    log.fatal({ err: err instanceof Error ? err.stack : String(err) }, 'crashed');
    process.exit(1);
  });
  log.info({ queue: services.queue.driver }, 'services ready');
  if (services.queue.driver === 'memory') log.warn('REDIS_URL not set: using in-memory dispatch queue (single-instance only)');
  const app = await buildApp(services, { webDistDir: process.env.WEB_DIST_DIR, logger: true, extend: opts.extend });
  services.scheduler.start();
  services.github.start();
  await app.listen({ port: config.PORT, host: config.HOST });
  log.info({ port: config.PORT }, 'control plane listening');
  // Key rotation: move secrets to the current key in the background (SEC-007).
  if (config.ENCRYPTION_KEYS_PREVIOUS.length) void reencryptSecrets(services.box).catch((e) => {
      log.error({ err: String(e) }, 'secret re-encryption failed');
      captureError(e, { tags: { component: 'key-rotation' } });
    });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    services.scheduler.stop();
    services.github.stop();
    await app.close();
    await services.queue.close();
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  return { app, services };
}

/** For entry points: log a startup failure, report it, and exit. */
export function exitOnStartupFailure(name = 'api') {
  const log = createLogger(name);
  return (e: unknown) => {
    log.fatal({ err: String(e) }, 'failed to start');
    captureError(e, { level: 'fatal', tags: { component: 'startup' } });
    void errorReporter.flush(2000).finally(() => process.exit(1));
  };
}
