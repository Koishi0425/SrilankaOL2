import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { CommunicationService } from './communication-service.js';

const gameParams = z.object({ gameId: z.string().uuid() });
const conversationParams = gameParams.extend({
  conversationId: z.string().uuid(),
});
const createSchema = z.object({
  type: z.enum([
    'HostPlayer',
    'BilateralDiplomacy',
    'Multilateral',
    'ActionReview',
  ]),
  title: z.string().trim().min(1).max(160),
  participantCountryIds: z.array(z.string().uuid()).max(20).default([]),
  linkedObjectType: z.string().trim().max(40).optional(),
  linkedObjectId: z.string().uuid().optional(),
});
const messageSchema = z.object({
  content: z.string().trim().min(1).max(10_000),
  clientMessageId: z.string().uuid(),
});
const pageSchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function parse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: z.ZodType<T>,
  value: unknown,
) {
  const result = schema.safeParse(value);
  if (!result.success) {
    sendApiError(
      request,
      reply,
      400,
      'VALIDATION_FAILED',
      '消息请求格式不正确。',
    );
    return null;
  }
  return result.data;
}

function envelope<T>(request: FastifyRequest, data: T) {
  return { data, meta: { requestId: request.id } };
}

export async function registerCommunicationRoutes(
  app: FastifyInstance,
  auth: AuthService,
  communications: CommunicationService,
) {
  app.get('/api/v1/games/:gameId/conversations', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    const params = parse(request, reply, gameParams, request.params);
    if (!user || !params) return reply;
    return reply.send(
      envelope(request, await communications.list(params.gameId, user.id)),
    );
  });

  app.post('/api/v1/games/:gameId/conversations', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    const params = parse(request, reply, gameParams, request.params);
    const body = parse(request, reply, createSchema, request.body);
    if (!user || !params || !body) return reply;
    return reply.status(201).send(
      envelope(
        request,
        await communications.create({
          gameId: params.gameId,
          userId: user.id,
          ...body,
        }),
      ),
    );
  });

  app.get(
    '/api/v1/games/:gameId/conversations/:conversationId/messages',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, conversationParams, request.params);
      const query = parse(request, reply, pageSchema, request.query);
      if (!user || !params || !query) return reply;
      return reply.send(
        envelope(
          request,
          await communications.messages({
            gameId: params.gameId,
            conversationId: params.conversationId,
            userId: user.id,
            ...query,
          }),
        ),
      );
    },
  );

  app.post(
    '/api/v1/games/:gameId/conversations/:conversationId/messages',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, conversationParams, request.params);
      const body = parse(request, reply, messageSchema, request.body);
      if (!user || !params || !body) return reply;
      return reply.status(201).send(
        envelope(
          request,
          await communications.send({
            gameId: params.gameId,
            conversationId: params.conversationId,
            userId: user.id,
            ...body,
          }),
        ),
      );
    },
  );
}
