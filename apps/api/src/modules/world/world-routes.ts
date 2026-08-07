import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuthService } from '../auth/auth-service.js';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { WorldService } from './world-service.js';

const gameParams = z.object({ gameId: z.string().uuid() });
const tileParams = gameParams.extend({ tileId: z.string().uuid() });
const armyParams = gameParams.extend({ armyId: z.string().uuid() });
const viewportQuery = z
  .object({
    minQ: z.coerce.number().int(),
    maxQ: z.coerce.number().int(),
    minR: z.coerce.number().int(),
    maxR: z.coerce.number().int(),
    zoom: z.coerce.number().positive().optional(),
    layers: z.string().optional(),
    previewMemberId: z.string().uuid().optional(),
  })
  .refine((value) => value.minQ <= value.maxQ && value.minR <= value.maxR);
const searchQuery = z.object({
  q: z.string().trim().min(1).max(120),
  previewMemberId: z.string().uuid().optional(),
});
const previewQuery = z.object({
  previewMemberId: z.string().uuid().optional(),
});
const updateTileBody = z
  .object({
    terrainTypeId: z.string().uuid().optional(),
    controllerCountryId: z.string().uuid().nullable().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const cityBody = z.object({
  tileId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  countryId: z.string().uuid().nullable().optional(),
});
const armyBody = z.object({
  tileId: z.string().uuid(),
  countryId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  strength: z.number().int().min(0).max(10_000_000),
});
const moveArmyBody = z.object({ tileId: z.string().uuid() });

function parsed<T>(
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
      '地图请求参数格式不正确。',
    );
    return null;
  }
  return result.data;
}

function envelope<T>(request: FastifyRequest, data: T) {
  return { data, meta: { requestId: request.id } };
}

export async function registerWorldRoutes(
  app: FastifyInstance,
  auth: AuthService,
  world: WorldService,
): Promise<void> {
  app.get('/api/v1/games/:gameId/map', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, gameParams, request.params);
    if (!params) return reply;
    return reply.send(
      envelope(request, await world.getMap(params.gameId, user.id)),
    );
  });

  app.get('/api/v1/games/:gameId/map/viewport', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, gameParams, request.params);
    const query = parsed(request, reply, viewportQuery, request.query);
    if (!params || !query) return reply;
    return reply.send(
      envelope(
        request,
        await world.getViewport({
          gameId: params.gameId,
          userId: user.id,
          ...query,
        }),
      ),
    );
  });

  app.get('/api/v1/games/:gameId/tiles/:tileId', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, tileParams, request.params);
    const query = parsed(request, reply, previewQuery, request.query);
    if (!params || !query) return reply;
    return reply.send(
      envelope(
        request,
        await world.getTile(
          params.gameId,
          user.id,
          params.tileId,
          query.previewMemberId,
        ),
      ),
    );
  });

  app.get(
    '/api/v1/games/:gameId/tiles/:tileId/neighbors',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const params = parsed(request, reply, tileParams, request.params);
      const query = parsed(request, reply, previewQuery, request.query);
      if (!params || !query) return reply;
      return reply.send(
        envelope(
          request,
          await world.getNeighbors(
            params.gameId,
            user.id,
            params.tileId,
            query.previewMemberId,
          ),
        ),
      );
    },
  );

  app.get('/api/v1/games/:gameId/map/search', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, gameParams, request.params);
    const query = parsed(request, reply, searchQuery, request.query);
    if (!params || !query) return reply;
    return reply.send(
      envelope(
        request,
        await world.search(
          params.gameId,
          user.id,
          query.q,
          query.previewMemberId,
        ),
      ),
    );
  });

  app.patch('/api/v1/games/:gameId/tiles/:tileId', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, tileParams, request.params);
    const body = parsed(request, reply, updateTileBody, request.body);
    if (!params || !body) return reply;
    return reply.send(
      envelope(
        request,
        await world.updateTile({
          gameId: params.gameId,
          userId: user.id,
          tileId: params.tileId,
          ...body,
        }),
      ),
    );
  });

  app.post('/api/v1/games/:gameId/cities', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, gameParams, request.params);
    const body = parsed(request, reply, cityBody, request.body);
    if (!params || !body) return reply;
    return reply.status(201).send(
      envelope(
        request,
        await world.createCity({
          gameId: params.gameId,
          userId: user.id,
          ...body,
        }),
      ),
    );
  });

  app.post('/api/v1/games/:gameId/armies', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = parsed(request, reply, gameParams, request.params);
    const body = parsed(request, reply, armyBody, request.body);
    if (!params || !body) return reply;
    return reply.status(201).send(
      envelope(
        request,
        await world.createArmy({
          gameId: params.gameId,
          userId: user.id,
          ...body,
        }),
      ),
    );
  });

  app.patch(
    '/api/v1/games/:gameId/armies/:armyId/location',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const params = parsed(request, reply, armyParams, request.params);
      const body = parsed(request, reply, moveArmyBody, request.body);
      if (!params || !body) return reply;
      return reply.send(
        envelope(
          request,
          await world.moveArmy({
            gameId: params.gameId,
            userId: user.id,
            armyId: params.armyId,
            tileId: body.tileId,
          }),
        ),
      );
    },
  );
}
