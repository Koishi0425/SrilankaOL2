import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';

import type { ApiErrorBody, HealthResponse } from '@srilanka/contracts';
import { createLogger } from '@srilanka/logger';

import { ApiFault } from './errors.js';
import { registerAssistantRoutes } from './modules/assistant/assistant-routes.js';
import type { AssistantService } from './modules/assistant/assistant-service.js';
import { registerActionRoutes } from './modules/actions/action-routes.js';
import type { ActionService } from './modules/actions/action-service.js';
import { getHealth, type HealthDependencies } from './health.js';
import { registerAuthRoutes } from './modules/auth/auth-routes.js';
import type { AuthService } from './modules/auth/auth-service.js';
import { registerCommunicationRoutes } from './modules/communications/communication-routes.js';
import type { CommunicationService } from './modules/communications/communication-service.js';
import { registerGameRoutes } from './modules/games/game-routes.js';
import type { GameService } from './modules/games/game-service.js';
import { registerSettlementRoutes } from './modules/settlements/settlement-routes.js';
import type { SettlementService } from './modules/settlements/settlement-service.js';
import { registerWorldRoutes } from './modules/world/world-routes.js';
import type { WorldService } from './modules/world/world-service.js';
import { resolveRequestId } from './request-id.js';

export interface AppOptions {
  health: HealthDependencies;
  logLevel?: string;
  webOrigin?: string;
  auth?: AuthService;
  games?: GameService;
  settlements?: SettlementService;
  world?: WorldService;
  actions?: ActionService;
  communications?: CommunicationService;
  assistant?: AssistantService;
  secureCookies?: boolean;
  trustProxyHops?: number;
}

export async function buildApp(options: AppOptions) {
  const app = Fastify({
    trustProxy: options.trustProxyHops || false,
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
    credentials: true,
  });
  await app.register(cookie);

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    if (request.url.startsWith('/api/v1/'))
      void reply.header('Cache-Control', 'no-store');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers.origin &&
      request.headers.origin !==
        (options.webOrigin ?? 'http://localhost:5173').replace(/\/$/u, '')
    ) {
      throw new ApiFault(403, 'ORIGIN_NOT_ALLOWED', '请求来源不被允许。');
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const httpStatus = (error as { statusCode?: number }).statusCode;
    if (
      !(error instanceof ApiFault) &&
      (httpStatus === 400 || httpStatus === 415)
    ) {
      return void reply.status(httpStatus).send({
        error: {
          code:
            httpStatus === 415
              ? 'UNSUPPORTED_MEDIA_TYPE'
              : 'INVALID_REQUEST_BODY',
          message:
            httpStatus === 415
              ? '请使用 JSON 格式提交内容。'
              : '提交内容格式不正确，请检查后重试。',
          details: {},
          retryable: false,
        },
        meta: { requestId: request.id },
      });
    }
    if ((error as { statusCode?: number }).statusCode === 413) {
      return void reply.status(413).send({
        error: {
          code: 'BODY_TOO_LARGE',
          message: '提交内容过长，请缩短后重试。',
          details: {},
          retryable: false,
        },
        meta: { requestId: request.id },
      });
    }
    const constraint = (error as { constraint?: string }).constraint;
    if (constraint === 'game_read_only' || constraint === 'game_busy') {
      const readOnly = constraint === 'game_read_only';
      return void reply.status(409).send({
        error: {
          code: readOnly ? 'GAME_READ_ONLY' : 'GAME_BUSY',
          message: readOnly
            ? '本局已结束，只能查看历史。'
            : '本局正在保存或结算，请稍后重试。',
          details: {},
          retryable: !readOnly,
        },
        meta: { requestId: request.id },
      });
    }
    if (error instanceof ApiFault) {
      if (error.statusCode === 429)
        void reply.header(
          'Retry-After',
          Number(error.details.retryAfter) || 60,
        );
      const body: ApiErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
          retryable: error.statusCode === 429,
        },
        meta: { requestId: request.id },
      };
      return void reply.status(error.statusCode).send(body);
    }
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

  if (options.auth && options.games) {
    await app.register(async (routes) => {
      await registerAuthRoutes(
        routes,
        options.auth!,
        options.secureCookies ?? false,
      );
      await registerGameRoutes(routes, options.auth!, options.games!);
      if (options.assistant)
        await registerAssistantRoutes(routes, options.auth!, options.assistant);
      if (options.settlements) {
        await registerSettlementRoutes(
          routes,
          options.auth!,
          options.settlements,
        );
      }
      if (options.world) {
        await registerWorldRoutes(routes, options.auth!, options.world);
      }
      if (options.actions) {
        await registerActionRoutes(routes, options.auth!, options.actions);
      }
      if (options.communications) {
        await registerCommunicationRoutes(
          routes,
          options.auth!,
          options.communications,
        );
      }
    });
  }

  return app;
}
