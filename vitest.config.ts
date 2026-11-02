import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/__tests__/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/index.ts'],
      reporter: ['text', 'json-summary', 'lcov']
    }
  }
})
