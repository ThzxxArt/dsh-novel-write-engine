import { defineConfig } from 'vitest/config'

/**
 * Opt-in live-model suite. Kept out of the default include so `pnpm test` stays
 * hermetic; the repository forbids skipped tests, so this is a separate config.
 */
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globals: false,
    testTimeout: 900_000,
    hookTimeout: 60_000,
  },
})
