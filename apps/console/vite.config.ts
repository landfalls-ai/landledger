import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const workspace = resolve(import.meta.dirname, '../..');

export default defineConfig(({ mode }) => {
  // Ports come from the workspace .env like every other process (LANDLEDGER_* only; nothing reaches the bundle).
  const env = { ...loadEnv(mode, workspace, 'LANDLEDGER_'), ...process.env };
  const port = Number(env.LANDLEDGER_CONSOLE_PORT ?? 4811);
  const api = `http://127.0.0.1:${Number(env.LANDLEDGER_API_PORT ?? 4810)}`;
  const server = {
    host: '127.0.0.1',
    port,
    strictPort: true,
    // Landbright redirects to http://localhost:4811; pods in landledger-dev reach this dev server through
    // host.orb.internal once Landledger runs beside the cluster.
    allowedHosts: [
      'localhost',
      '127.0.0.1',
      'landledger-console.landledger-dev',
      'landledger-console.landledger-dev.svc.cluster.local',
      'host.orb.internal',
    ],
    // The API keeps its own paths (/api/...), including the OIDC callback Landbright redirects to.
    proxy: { '/api': { target: api, changeOrigin: false }, '/scim': api },
  };
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, 'src'),
        '@landledger/contracts': resolve(workspace, 'libs/contracts/src/index.ts'),
        '@landledger/focus': resolve(workspace, 'libs/focus/src/index.ts'),
        '@landledger/money': resolve(workspace, 'libs/money/src/index.ts'),
      },
    },
    server,
    preview: server,
    build: { chunkSizeWarningLimit: 1500 },
    test: {
      environment: 'jsdom',
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.{ts,tsx}'],
      css: false,
    },
  };
});
