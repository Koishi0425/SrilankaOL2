import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from './app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('GET /api/v1/health', () => {
  it('returns client errors for malformed JSON or unsupported content types without echoing submitted secrets', async () => {
    const app = await buildApp({
      logLevel: 'silent',
      health: { checkDatabase: async () => {}, checkRedis: async () => {} },
    });
    apps.push(app);
    app.post('/api/v1/check', async (request) => request.body);
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/check',
      headers: { 'content-type': 'application/json' },
      payload: '{"password":"secret-value"',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('INVALID_REQUEST_BODY');
    expect(malformed.body).not.toContain('secret-value');
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/check',
      headers: { 'content-type': 'application/x-unknown' },
      payload: 'secret-value',
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(unsupported.body).not.toContain('secret-value');
  });
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
