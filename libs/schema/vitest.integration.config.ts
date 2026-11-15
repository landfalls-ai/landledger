import { defineConfig } from 'vitest/config';

// Hooks create and drop a database; beside the API's suite (wave 4 added 14 tables) a drop can take over 10 s.
export default defineConfig({
  test: { include: ['test/**/*.integration.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
