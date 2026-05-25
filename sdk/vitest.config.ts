import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    retry: 1,
    fileParallelism: false,
    pool: 'forks',
    forkOptions: {
      singleFork: true,
    },
  },
});
