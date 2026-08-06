import { z } from 'zod';

const environmentSchema = z.enum(['development', 'test', 'production']);

export interface ServiceConfig {
  nodeEnv: z.infer<typeof environmentSchema>;
  logLevel: string;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webOrigin: string;
  objectStorage: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
}

const rawConfigSchema = z.object({
  NODE_ENV: environmentSchema.default('development'),
  LOG_LEVEL: z.string().default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  OBJECT_STORAGE_ENDPOINT: z.string().url().default('http://localhost:9000'),
  OBJECT_STORAGE_BUCKET: z.string().min(1).default('srilanka-dev'),
  OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).default('srilanka'),
  OBJECT_STORAGE_SECRET_KEY: z.string().min(1).default('change-me'),
});

export function loadServiceConfig(
  source: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  const parsed = rawConfigSchema.parse(source);
  const isTest = parsed.NODE_ENV === 'test';

  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    host: parsed.HOST,
    port: parsed.PORT,
    databaseUrl:
      parsed.DATABASE_URL ??
      `postgresql://srilanka:srilanka@localhost:5432/${isTest ? 'srilanka_test' : 'srilanka_dev'}`,
    redisUrl:
      parsed.REDIS_URL ?? `redis://localhost:6379/${isTest ? '1' : '0'}`,
    webOrigin: parsed.WEB_ORIGIN,
    objectStorage: {
      endpoint: parsed.OBJECT_STORAGE_ENDPOINT,
      bucket: parsed.OBJECT_STORAGE_BUCKET,
      accessKey: parsed.OBJECT_STORAGE_ACCESS_KEY,
      secretKey: parsed.OBJECT_STORAGE_SECRET_KEY,
    },
  };
}
