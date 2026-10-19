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
import { updateGameRulesSchema } from './game-rules.js';
import { registerEconomicRoutes } from './economic-routes.js';
import { registerTradeRoutes } from '../trade/trade-routes.js';
import { registerDiplomacyRoutes } from '../diplomacy/diplomacy-routes.js';
import { registerGovernmentRoutes } from '../government/government-routes.js';

const gameParamsSchema = z.object({ gameId: z.string().uuid() });
const createGameSchema = z.object({
  name: z.string().trim().min(1).max(120),
  countryNames: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  creationId: z.string().uuid().optional(),
});
const addMemberSchema = z.object({
  username: z.string().trim().min(1).max(64).regex(/^\S+$/u),
  role: z.enum(['Player', 'Observer']),
});
const assignmentSchema = z.object({
  memberId: z.string().uuid(),
  countryId: z.string().uuid().nullable(),
  role: z.literal('PrimaryController').optional(),
});
const quarterStateSchema = z.object({
  state: z.enum(['ActionSubmission', 'Locked', 'HostReview']),
  actionDeadline: z.string().datetime().nullable().optional(),
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
  await registerEconomicRoutes(app, auth, games.economics);
  await registerTradeRoutes(app, auth, games.trade);
  await registerDiplomacyRoutes(app, auth, games.diplomacy);
  await registerGovernmentRoutes(app, auth, games.government);
  app.get('/api/v1/me', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const accessibleGames = await games.listForUser(user.id);
    const data: MeData = {
      ...user,
      games: accessibleGames,
      canCreateGame: await games.canCreateGame(),
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

  app.post('/api/v1/games/:gameId/end', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const parsed = z
      .object({
        expectedQuarterId: z.string().uuid(),
        expectedQuarterState: z.enum([
          'Preparing',
          'EventResponse',
          'ActionSubmission',
          'Locked',
          'HostReview',
          'AIProcessing',
          'Resolving',
          'PendingPublication',
          'Published',
          'DisputeReview',
          'Correcting',
          'Completed',
        ]),
        reason: z.string().trim().min(1).max(2000),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '请填写结束说明并确认当前回合。',
      );
    return reply.send(
      response(request, await games.end(gameId, user.id, parsed.data)),
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

  app.get('/api/v1/games/:gameId/preparation', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    return reply.send(
      response(request, await games.getPreparation(gameId, user.id)),
    );
  });

  app.post('/api/v1/games/:gameId/preparation/open', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const parsed = z
      .object({
        quarterId: z.string().uuid(),
        expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '开局信息格式不正确。',
      );
    return reply.send(
      response(
        request,
        await games.transitionCurrentQuarter({
          gameId,
          userId: user.id,
          state: 'ActionSubmission',
          preparation: parsed.data,
        }),
      ),
    );
  });

  app.get('/api/v1/games/:gameId/rules', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    return reply.send(response(request, await games.getRules(gameId, user.id)));
  });

  app.put('/api/v1/games/:gameId/rules', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const gameId = parseGameId(request, reply);
    if (!gameId) return reply;
    const parsed = updateGameRulesSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '规则内容格式不正确，同一类别不能重复设置建议额度。',
      );
    }
    return reply.send(
      response(
        request,
        await games.updateRules({
          gameId,
          userId: user.id,
          ...parsed.data,
        }),
      ),
    );
  });

  app.patch(
    '/api/v1/games/:gameId/quarters/current/state',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const gameId = parseGameId(request, reply);
      if (!gameId) return reply;
      const parsed = quarterStateSchema.safeParse(request.body);
      if (!parsed.success) {
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '季度状态信息格式不正确。',
        );
      }
      return reply.send(
        response(
          request,
          await games.transitionCurrentQuarter({
            gameId,
            userId: user.id,
            ...parsed.data,
          }),
        ),
      );
    },
  );

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
