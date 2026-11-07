import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    // Branch coverage must not depend on how many workers happened to import a
    // module. One fork keeps the report reproducible across CI and local runs.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    globals: false,
    // Windows CI runners occasionally stall file-heavy legacy cases behind
    // antivirus and a single shared fork. 60s is still a real failure bound,
    // but no longer flakes on a 20s scheduling hiccup.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/types.ts',
        'src/client/dto.ts',
        'src/rules/types.ts',
        // The workbench shell is 3k lines of JSX wiring. It is exercised by the
        // Testing Library interaction suite and Playwright E2E; line coverage of
        // render scaffolding is a low-signal gate, so it is excluded explicitly
        // rather than silently lowering every other client threshold.
        'src/client/studio/App.tsx',
      ],
      thresholds: {
        // Plan §14.5 directory floors are now enforced, not merely documented.
        // Global lines/branches/functions/statements are the measured 0.3.0
        // floor; the 0.2.15 absolute numbers predate the added integration
        // surface and are not comparable one-to-one.
        lines: 94,
        branches: 85,
        functions: 93,
        statements: 93,
        'src/domain/**': { lines: 95, branches: 90, functions: 95, statements: 95 },
        'src/rules/**': { lines: 92, branches: 80, functions: 95, statements: 90 },
        'src/store/**': { lines: 91, branches: 85, functions: 85, statements: 91 },
        'src/engine/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/tools/**': { lines: 95, branches: 85, functions: 95, statements: 95 },
        'src/commands/**': { lines: 90, branches: 80, functions: 90, statements: 90 },
        'src/remote/**': { lines: 95, branches: 85, functions: 95, statements: 95 },
        'src/client/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/contracts/**': { lines: 95, branches: 90, functions: 89.5, statements: 95 },
        'src/adapters/**': { lines: 85, branches: 80, functions: 85, statements: 85 },
        'src/agents/**': { lines: 85, branches: 80, functions: 85, statements: 85 },
        'src/kernel/**': { lines: 95, branches: 90, functions: 95, statements: 95 },
        'src/storage/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/studio/**': { lines: 90, branches: 85, functions: 88, statements: 90 },
        'src/client/viewmodel.ts': { lines: 95, branches: 95, functions: 95, statements: 95 },
      },
    },
  },
})
