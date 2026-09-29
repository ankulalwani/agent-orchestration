import { defineConfig } from 'tsup';

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
  noExternal: [/^@ao\//],
  external: [/^(?!@ao\/)[^./]/],
});
