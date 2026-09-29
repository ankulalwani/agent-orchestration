import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // Workers started by tests must not scan this machine's disks for repositories on their own.
    // ...nor run the real harnesses installed here on their own login (that would use real subscriptions).
    env: { AO_DISCOVERY_AUTOSTART: '0', AO_HARNESS_OWN_LOGIN: '0' },
    // Many test files start real processes (mongod, redis-server, SeaweedFS, workers, agents,
    // Chromium). With one fork per core they starve each other and time out at random; half the
    // cores keeps the suite reliable. Override with VITEST_MAX_FORKS.
    poolOptions: { forks: { maxForks: Number(process.env.VITEST_MAX_FORKS) || 6, minForks: 1 } },
  },
});
