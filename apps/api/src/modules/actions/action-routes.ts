import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { ActionService } from './action-service.js';

const category = z.enum([
  'EventResponse',
  'Policy',
  'Reform',
  'Diplomacy',
  'Construction',
  'Research',
  'Recruitment',
  'Military',
  'Intelligence',
  'Custom',
]);
const secrecy = z.enum(['OwnerOnly', 'Participants', 'Public']);
const refSchema = z.object({
  refKind: z.enum(['Actor', 'Target', 'Context']),
  objectType: z.enum([
    'Tile',
    'City',
    'Army',
    'Country',
    'Character',
    'Region',
  ]),
  objectId: z.string().uuid(),
  label: z.string().trim().max(160).default(''),
});
const createSchema = z.object({
  quarterId: z.string().uuid(),
  title: z.string().trim().min(1).max(160),
  originalText: z.string().max(20_000),
  category,
  secrecy,
  refs: z.array(refSchema).max(30).default([]),
});
const updateSchema = createSchema.omit({ quarterId: true, refs: true }).extend({
  expectedVersion: z.number().int().positive(),
});
const idempotencySchema = z.object({ idempotencyKey: z.string().uuid() });
const textSchema = z.object({ text: z.string().trim().min(1).max(20_000) });
const reasonSchema = z.object({ reason: z.string().trim().min(1).max(4000) });
const gameParams = z.object({ gameId: z.string().uuid() });
const actionParams = gameParams.extend({ actionId: z.string().uuid() });

function parse<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  schema: z.ZodType<T>,
  value: unknown,
): T | null {
  const result = schema.safeParse(value);
  if (!result.success) {
    sendApiError(
      request,
      reply,
      400,
      'VALIDATION_FAILED',
      '行动请求格式不正确。',
    );
    return null;
  }
  return result.data;
}

function envelope<T>(request: FastifyRequest, data: T) {
  return { data, meta: { requestId: request.id } };
}

export async function registerActionRoutes(
  app: FastifyInstance,
  auth: AuthService,
  actions: ActionService,
) {
  app.get('/api/v1/games/:gameId/actions', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    const params = parse(request, reply, gameParams, request.params);
    if (!user || !params) return reply;
    return reply.send(
      envelope(request, await actions.list(params.gameId, user.id)),
    );
  });

  app.post('/api/v1/games/:gameId/actions', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    const params = parse(request, reply, gameParams, request.params);
    const body = parse(request, reply, createSchema, request.body);
    if (!user || !params || !body) return reply;
    return reply.status(201).send(
      envelope(
        request,
        await actions.create({
          gameId: params.gameId,
          userId: user.id,
          ...body,
        }),
      ),
    );
  });

  app.get('/api/v1/games/:gameId/actions/:actionId', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    const params = parse(request, reply, actionParams, request.params);
    if (!user || !params) return reply;
    return reply.send(
      envelope(
        request,
        await actions.get(params.gameId, user.id, params.actionId),
      ),
    );
  });

  app.get(
    '/api/v1/games/:gameId/actions/:actionId/versions',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, actionParams, request.params);
      if (!user || !params) return reply;
      return reply.send(
        envelope(
          request,
          await actions.versions(params.gameId, user.id, params.actionId),
        ),
      );
    },
  );

  app.patch(
    '/api/v1/games/:gameId/actions/:actionId',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, actionParams, request.params);
      const body = parse(request, reply, updateSchema, request.body);
      if (!user || !params || !body) return reply;
      return reply.send(
        envelope(
          request,
          await actions.update({
            gameId: params.gameId,
            actionId: params.actionId,
            userId: user.id,
            ...body,
          }),
        ),
      );
    },
  );

  app.post(
    '/api/v1/games/:gameId/actions/:actionId/submit',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, actionParams, request.params);
      const body = parse(request, reply, idempotencySchema, request.body);
      if (!user || !params || !body) return reply;
      return reply.send(
        envelope(
          request,
          await actions.submit({
            gameId: params.gameId,
            actionId: params.actionId,
            userId: user.id,
            idempotencyKey: body.idempotencyKey,
          }),
        ),
      );
    },
  );

  app.post(
    '/api/v1/games/:gameId/actions/:actionId/withdraw',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, actionParams, request.params);
      if (!user || !params) return reply;
      return reply.send(
        envelope(
          request,
          await actions.withdraw({
            gameId: params.gameId,
            actionId: params.actionId,
            userId: user.id,
          }),
        ),
      );
    },
  );

  app.get(
    '/api/v1/games/:gameId/host/actions/review-queue',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, gameParams, request.params);
      if (!user || !params) return reply;
      return reply.send(
        envelope(request, await actions.list(params.gameId, user.id, true)),
      );
    },
  );

  app.post(
    '/api/v1/games/:gameId/host/actions/:actionId/interpretations',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      const params = parse(request, reply, actionParams, request.params);
      const body = parse(request, reply, textSchema, request.body);
      if (!user || !params || !body) return reply;
      return reply.status(201).send(
        envelope(
          request,
          await actions.hostInterpret({
            gameId: params.gameId,
            actionId: params.actionId,
            userId: user.id,
            text: body.text,
          }),
        ),
      );
    },
  );

  for (const [path, target] of [
    ['request-input', 'NeedPlayerInput'],
    ['approve', 'Approved'],
    ['reject', 'Rejected'],
  ] as const) {
    app.post(
      `/api/v1/games/:gameId/host/actions/:actionId/${path}`,
      async (request, reply) => {
        const user = await requireUser(request, reply, auth);
        const params = parse(request, reply, actionParams, request.params);
        const body = parse(request, reply, reasonSchema, request.body);
        if (!user || !params || !body) return reply;
        return reply.send(
          envelope(
            request,
            await actions.hostTransition({
              gameId: params.gameId,
              actionId: params.actionId,
              userId: user.id,
              target,
              reason: body.reason,
            }),
          ),
        );
      },
    );
  }
}
