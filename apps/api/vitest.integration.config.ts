import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.integration.test.ts'],
    fileParallelism: false,
    setupFiles: ['./src/integration-setup.ts'],
    testTimeout: 10_000,
  },
});
