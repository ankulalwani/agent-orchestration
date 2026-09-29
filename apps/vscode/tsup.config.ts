import { defineConfig } from 'tsup';

/** VS Code loads extensions as CommonJS; `vscode` is provided by the editor at runtime. */
export default defineConfig({
  entry: ['src/extension.ts'],
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  external: ['vscode'],
});
