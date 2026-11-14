import { defineConfig } from 'vitest/config';

// Setup creates, migrates and seeds a database per file: allow it the same time as a test.
export default defineConfig({
  test: { include: ['test/**/*.integration.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
