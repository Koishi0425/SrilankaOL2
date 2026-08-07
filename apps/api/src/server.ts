import { loadServiceConfig } from '@srilanka/config';
import { checkDatabase, createDatabasePool } from '@srilanka/database';
import { createClient } from 'redis';

import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { CommunicationService } from './modules/communications/communication-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig();
const database = createDatabasePool(config.databaseUrl);
const redis = createClient({ url: config.redisUrl });
const auth = new AuthService(database);
const games = new GameService(database);
const world = new WorldService(database);
const actions = new ActionService(database);
const communications = new CommunicationService(database);
let redisConnection: Promise<void> | undefined;

async function ensureRedis(): Promise<void> {
  if (redis.isReady) return;

  redisConnection ??= redis
    .connect()
    .then(() => undefined)
    .finally(() => {
      redisConnection = undefined;
    });
  await redisConnection;
}

const app = await buildApp({
  logLevel: config.logLevel,
  webOrigin: config.webOrigin,
  auth,
  games,
  world,
  actions,
  communications,
  secureCookies: config.nodeEnv === 'production',
  health: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: async () => {
      await ensureRedis();
      await redis.ping();
    },
  },
});

redis.on('error', (error) => {
  app.log.warn({ err: error }, 'Redis connection is unavailable');
});

void ensureRedis().catch((error: unknown) => {
  app.log.warn({ err: error }, 'API started in degraded mode');
});

app.addHook('onClose', async () => {
  await database.end();
  if (redis.isOpen) await redis.quit();
});

const shutdown = async (): Promise<void> => {
  await app.close();
  process.exitCode = 0;
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ host: config.host, port: config.port });
