import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type {
  ApiResponse,
  CountrySummary,
  GameDetails,
  GameMemberSummary,
  GameSummary,
  MeData,
  QuarterSummary,
} from '@srilanka/contracts';

import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { GameService } from './game-service.js';

const gameParamsSchema = z.object({ gameId: z.string().uuid() });
const createGameSchema = z.object({
  name: z.string().trim().min(1).max(120),
  countryNames: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});
const addMemberSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['Player', 'Observer']),
});
const assignmentSchema = z.object({
  memberId: z.string().uuid(),
  countryId: z.string().uuid(),
  role: z.literal('PrimaryController').optional(),
});

function parseGameId(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const parsed = gameParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    sendApiError(
      request,
      reply,
      400,
      'VALIDATION_FAILED',
      '游戏标识格式不正确。',
    );
    return null;
  }
  return parsed.data.gameId;
}

function response<T>(request: FastifyRequest, data: T): ApiResponse<T> {
  return { data, meta: { requestId: request.id } };
}

export async function registerGameRoutes(
  app: FastifyInstance,
  auth: AuthService,
  games: GameService,
): Promise<void> {
  app.get('/api/v1/me', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const accessibleGames = await games.listForUser(user.id);
    const data: MeData = {
      ...user,
      games: accessibleGames,
      unreadNotificationCount: 0,
    };
    return reply.send(response(request, data));
  });

  app.get('/api/v1/games', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const data: GameSummary[] = await games.listForUser(user.id);
    return reply.send(response(request, data));
  });

  app.post('/api/v1/games', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const parsed = createGameSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '游戏信息格式不正确。',
      );
    }
    const data: GameDetails = await games.create({
      userId: user.id,
      ...parsed.data,
    });
    return reply.status(201).send(response(request, data));
  });

  app.get('/api/v1/games/:gameId', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    return reply.send(
      response(request, await games.getForUser(gameId, user.id)),
    );
  });

  app.get('/api/v1/games/:gameId/quarters/current', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const data: QuarterSummary = await games.getCurrentQuarter(gameId, user.id);
    return reply.send(response(request, data));
  });

  app.get('/api/v1/games/:gameId/countries', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const data: CountrySummary[] = await games.listCountries(gameId, user.id);
    return reply.send(response(request, data));
  });

  app.get('/api/v1/games/:gameId/members', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const data: GameMemberSummary[] = await games.listMembers(gameId, user.id);
    return reply.send(response(request, data));
  });

  app.post('/api/v1/games/:gameId/members', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const parsed = addMemberSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '成员信息格式不正确。',
      );
    }
    const data = await games.addMember({
      gameId,
      actorUserId: user.id,
      ...parsed.data,
    });
    return reply.status(201).send(response(request, data));
  });

  app.post(
    '/api/v1/games/:gameId/country-assignments',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const gameId = parseGameId(request, reply);
      if (!gameId) return reply;
      const parsed = assignmentSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '国家分配信息格式不正确。',
        );
      }
      const data = await games.assignCountry({
        gameId,
        actorUserId: user.id,
        memberId: parsed.data.memberId,
        countryId: parsed.data.countryId,
      });
      return reply.send(response(request, data));
    },
  );
}
