import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadServiceConfig } from '@srilanka/config';
import { checkDatabase, createDatabasePool } from '@srilanka/database';
import { BackupManager } from '@srilanka/database/backup-manager';
import {
  redact,
  toolsFromEnvironment,
} from '@srilanka/database/postgres-tools';
import { createClient } from 'redis';

import { buildApp } from './app.js';
import { ApiFault } from './errors.js';
import { CompatibleAssistantModel } from './modules/assistant/assistant-model.js';
import { AssistantService } from './modules/assistant/assistant-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { CommunicationService } from './modules/communications/communication-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig();
const database = createDatabasePool(config.databaseUrl);
const sourceRoot = resolve(
  process.env.BACKUP_SOURCE_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
);
const backups =
  process.env.BACKUP_ENABLED === 'true'
    ? new BackupManager(
        {
          databaseUrl: config.databaseUrl,
          sourceRoot,
          directory: resolve(
            process.env.BACKUP_DIRECTORY || resolve(sourceRoot, 'backups'),
          ),
          tools: toolsFromEnvironment(),
        },
        Number(process.env.BACKUP_INTERVAL_MINUTES || 60),
        Number(process.env.BACKUP_KEEP || 48),
        (event, detail) => {
          const message = redact(detail, config.databaseUrl);
          if (event === 'failed')
            app.log.error({ detail: message }, 'Database backup failed');
          else app.log.info({ path: message }, 'Database backup complete');
        },
      )
    : undefined;
const redis = createClient({ url: config.redisUrl });
const auth = new AuthService(database, config.registrationMode);
const games = new GameService(database);
const settlements = new SettlementService(
  database,
  backups
    ? async (context) => {
        try {
          await backups.checkpoint(context);
        } catch {
          throw new ApiFault(
            503,
            'BACKUP_UNAVAILABLE',
            '发布前存档备份失败，本次结算尚未发布，请联系维护者检查后重试。',
          );
        }
      }
    : undefined,
);
const world = new WorldService(database);
const actions = new ActionService(database);
const communications = new CommunicationService(database);
const assistant = new AssistantService(
  database,
  games,
  settlements,
  new CompatibleAssistantModel(config.llm),
);
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
  trustProxyHops: config.trustProxyHops,
  auth,
  games,
  settlements,
  world,
  actions,
  communications,
  assistant,
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
  await backups?.stop();
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
app.log.info({ enabled: Boolean(backups) }, 'Automatic database backups');
backups?.start();
