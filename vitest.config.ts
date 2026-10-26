import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'json', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/client/dto.ts', 'src/rules/types.ts'],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 85,
        statements: 85,
        'src/domain/**': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'src/rules/**': { lines: 95, branches: 90, functions: 95, statements: 95 },
        'src/store/**': { lines: 92, branches: 88, functions: 92, statements: 92 },
        'src/engine/**': { lines: 90, branches: 85, functions: 90, statements: 90 },
        'src/tools/**': { lines: 85, branches: 85, functions: 85, statements: 85 },
        'src/commands/**': { lines: 85, branches: 85, functions: 85, statements: 85 },
        'src/remote/**': { lines: 85, branches: 85, functions: 85, statements: 85 },
        'src/client/**': { lines: 85, branches: 85, functions: 85, statements: 85 },
      },
    },
  },
})
