import cors from '@fastify/cors';
import Fastify from 'fastify';

import type { ApiErrorBody, HealthResponse } from '@srilanka/contracts';
import { createLogger } from '@srilanka/logger';

import { getHealth, type HealthDependencies } from './health.js';
import { resolveRequestId } from './request-id.js';

export interface AppOptions {
  health: HealthDependencies;
  logLevel?: string;
  webOrigin?: string;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    loggerInstance: createLogger(options.logLevel),
    genReqId: (request) =>
      resolveRequestId(
        typeof request.headers['x-request-id'] === 'string'
          ? request.headers['x-request-id']
          : undefined,
      ),
  });

  await app.register(cors, {
    origin: options.webOrigin ?? 'http://localhost:5173',
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    const body: ApiErrorBody = {
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时无法处理该请求。',
        details: {},
        retryable: false,
      },
      meta: { requestId: request.id },
    };
    void reply.status(500).send(body);
  });

  app.get('/api/v1/health', async (request, reply) => {
    const data = await getHealth(options.health);
    const body: HealthResponse = {
      data,
      meta: { requestId: request.id },
    };

    return reply.status(data.status === 'ok' ? 200 : 503).send(body);
  });

  return app;
}
