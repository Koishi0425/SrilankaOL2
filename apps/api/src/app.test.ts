import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/v1/health', () => {
  it('returns the documented envelope and preserves safe request IDs', async () => {
    const app = await buildApp({
      health: {
        checkDatabase: async () => undefined,
        checkRedis: async () => undefined,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'req_test_123' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('req_test_123');
    expect(response.json()).toEqual({
      data: {
        status: 'ok',
        service: 'api',
        version: '0.0.0',
        dependencies: { database: 'up', redis: 'up' },
      },
      meta: { requestId: 'req_test_123' },
    });
  });

  it('returns 503 without leaking dependency errors', async () => {
    const app = await buildApp({
      health: {
        checkDatabase: async () => {
          throw new Error('postgresql://secret-host/private');
        },
        checkRedis: async () => undefined,
      },
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('secret-host');
    expect(response.json().data.dependencies.database).toBe('down');
  });
});
