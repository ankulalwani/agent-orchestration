import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** Builds test-extension/ (a dashboard with a WebExtension) for tests/e2e/web-extension.test.ts. */
export default defineConfig({
  root: 'test-extension',
  plugins: [react()],
  build: { outDir: process.env.AO_FIXTURE_OUT ?? '../dist-extension-fixture', emptyOutDir: true },
});
