import { expect, it } from 'vitest';
import { buildApp } from './app.js';

it('uses only the configured proxy hop for client limits, ignoring a forged extra forwarded address', async () => {
  for (const hops of [0, 1]) {
    const app = await buildApp({
      logLevel: 'silent',
      trustProxyHops: hops,
      health: { checkDatabase: async () => {}, checkRedis: async () => {} },
    });
    let observed = '';
    app.addHook('onRequest', async (request) => {
      observed = request.ip;
    });
    try {
      await app.inject({
        method: 'GET',
        url: '/api/v1/health',
        headers: { 'x-forwarded-for': '192.0.2.99, 198.51.100.7' },
      });
      expect(observed).toBe(hops ? '198.51.100.7' : '127.0.0.1');
    } finally {
      await app.close();
    }
  }
});
