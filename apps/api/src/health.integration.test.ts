import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadServiceConfig } from '@srilanka/config';
import { checkDatabase, createDatabasePool } from '@srilanka/database';
import { createClient } from 'redis';

import { buildApp } from './app.js';

const config = loadServiceConfig({
  ...process.env,
  NODE_ENV: 'test',
});
const database = createDatabasePool(config.databaseUrl);
const redis = createClient({ url: config.redisUrl });

const app = await buildApp({
  health: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: async () => {
      await redis.ping();
    },
  },
});

beforeAll(async () => {
  await redis.connect();
});

afterAll(async () => {
  await Promise.all([app.close(), database.end(), redis.quit()]);
});

describe('health dependencies', () => {
  it('checks the real test database and Redis namespace', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.dependencies).toEqual({
      database: 'up',
      redis: 'up',
    });
  });
});
