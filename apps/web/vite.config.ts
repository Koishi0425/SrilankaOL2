import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('../..', import.meta.url));
  const fileEnvironment = loadEnv(mode, envDir, '');
  const proxyTarget =
    process.env.VITE_API_PROXY_TARGET ??
    fileEnvironment.VITE_API_PROXY_TARGET ??
    'http://localhost:3000';

  return {
    // API、worker 与 Web 共用仓库根目录的 .env，避免每个 workspace 重复维护配置。
    envDir,
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': proxyTarget,
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.ts',
    },
  };
});
