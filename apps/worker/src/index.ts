import { loadServiceConfig } from '@srilanka/config';
import { createLogger } from '@srilanka/logger';
import { createClient } from 'redis';

const config = loadServiceConfig();
const logger = createLogger(config.logLevel);
const redis = createClient({ url: config.redisUrl });

redis.on('error', (error) => {
  logger.error({ err: error }, 'Worker Redis connection error');
});

await redis.connect();
await redis.ping();
logger.info({ service: 'worker' }, 'Worker baseline is ready');

const shutdown = async (): Promise<void> => {
  await redis.quit();
  logger.info({ service: 'worker' }, 'Worker stopped');
  process.exitCode = 0;
};

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
