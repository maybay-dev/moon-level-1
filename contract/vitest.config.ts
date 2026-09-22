import { defineConfig } from 'vitest/config';

export default {
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
} as import('vitest/config').ViteUserConfig;
