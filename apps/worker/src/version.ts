declare const __WORKER_VERSION__: string | undefined;

/** Launcher-provided version first, then the one stamped from package.json at build time (see tsup.config.ts). */
export const WORKER_VERSION: string =
  process.env.AO_WORKER_VERSION ?? (typeof __WORKER_VERSION__ === 'string' ? __WORKER_VERSION__ : '0.0.0-dev');
