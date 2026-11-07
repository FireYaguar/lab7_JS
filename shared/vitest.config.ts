import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 75 }, // Lab 7: shared/ ≥ 85 %
    },
  },
})
