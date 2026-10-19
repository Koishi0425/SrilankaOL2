import { fileURLToPath } from 'node:url';

import { z } from 'zod';

let workspaceEnvironmentLoaded = false;

function loadWorkspaceEnvironment(): void {
  if (workspaceEnvironmentLoaded) return;

  const environmentFile = fileURLToPath(
    new URL('../../../.env', import.meta.url),
  );
  try {
    process.loadEnvFile(environmentFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  workspaceEnvironmentLoaded = true;
}

const environmentSchema = z.enum(['development', 'test', 'production']);

export interface ServiceConfig {
  nodeEnv: z.infer<typeof environmentSchema>;
  logLevel: string;
  host: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webOrigin: string;
  registrationMode: 'Open' | 'InviteOnly' | 'Closed';
  llm: {
    provider: 'deepseek' | 'glm' | 'compatible';
    baseUrl: string;
    apiKey: string;
    model: string;
    jsonMode: boolean;
    disableThinking: boolean;
    timeoutMs: number;
  };
  objectStorage: {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
}

const rawConfigSchema = z
  .object({
    NODE_ENV: environmentSchema.default('development'),
    LOG_LEVEL: z.string().default('info'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DATABASE_URL: z.string().min(1).optional(),
    REDIS_URL: z.string().min(1).optional(),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    REGISTRATION_MODE: z.enum(['open', 'invite', 'closed']).optional(),
    LLM_PROVIDER: z.enum(['deepseek', 'glm', 'compatible']).default('deepseek'),
    LLM_BASE_URL: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, 'LLM_BASE_URL 只填写服务基础地址，不包含密钥、查询参数或片段。')
      .optional(),
    LLM_API_KEY: z.string().trim().default(''),
    LLM_MODEL: z.string().trim().max(160).default(''),
    LLM_JSON_MODE: z.enum(['true', 'false']).default('true'),
    LLM_DISABLE_THINKING: z.enum(['true', 'false']).default('true'),
    LLM_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(120_000)
      .default(60_000),
    OBJECT_STORAGE_ENDPOINT: z.string().url().default('http://localhost:9000'),
    OBJECT_STORAGE_BUCKET: z.string().min(1).default('srilanka-dev'),
    OBJECT_STORAGE_ACCESS_KEY: z.string().min(1).default('srilanka'),
    OBJECT_STORAGE_SECRET_KEY: z.string().min(1).default('change-me'),
  })
  .refine(
    (value) => value.LLM_PROVIDER !== 'compatible' || !!value.LLM_BASE_URL,
    {
      message: '兼容服务需要显式填写 LLM_BASE_URL。',
      path: ['LLM_BASE_URL'],
    },
  );

export function loadServiceConfig(
  source: NodeJS.ProcessEnv = process.env,
): ServiceConfig {
  // 仅在调用者使用真实进程环境时读取仓库根目录 .env；测试传入的隔离配置不会被本地文件污染。
  if (source === process.env) loadWorkspaceEnvironment();
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
    registrationMode:
      parsed.REGISTRATION_MODE === 'open'
        ? 'Open'
        : parsed.REGISTRATION_MODE === 'invite'
          ? 'InviteOnly'
          : parsed.REGISTRATION_MODE === 'closed' ||
              parsed.NODE_ENV === 'production'
            ? 'Closed'
            : 'Open',
    llm: {
      provider: parsed.LLM_PROVIDER,
      baseUrl:
        parsed.LLM_BASE_URL ??
        (parsed.LLM_PROVIDER === 'glm'
          ? 'https://open.bigmodel.cn/api/paas/v4'
          : 'https://api.deepseek.com'),
      apiKey: parsed.LLM_API_KEY,
      model: parsed.LLM_MODEL,
      jsonMode: parsed.LLM_JSON_MODE === 'true',
      disableThinking: parsed.LLM_DISABLE_THINKING === 'true',
      timeoutMs: parsed.LLM_TIMEOUT_MS,
    },
    objectStorage: {
      endpoint: parsed.OBJECT_STORAGE_ENDPOINT,
      bucket: parsed.OBJECT_STORAGE_BUCKET,
      accessKey: parsed.OBJECT_STORAGE_ACCESS_KEY,
      secretKey: parsed.OBJECT_STORAGE_SECRET_KEY,
    },
  };
}
