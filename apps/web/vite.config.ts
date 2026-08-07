import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig(() => {
  const proxyTarget =
    process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3000';

  return {
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
