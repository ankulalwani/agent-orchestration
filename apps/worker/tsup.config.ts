import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Bundle workspace (@ao/*) TypeScript; keep third-party packages external (resolved from node_modules at runtime). */
export default defineConfig({
  // launcher.js is copied next to the versioned installs; it only uses Node built-ins.
  entry: ['src/main.ts', 'src/launcher.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // Stamped from package.json (release-worker.yml sets it from the tag before building); no hardcoded version.
  define: { __WORKER_VERSION__: JSON.stringify(version) },
  noExternal: [/^@ao\//],
  external: [/^(?!@ao\/)[^./]/],
});
