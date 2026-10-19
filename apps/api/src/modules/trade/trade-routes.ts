import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { TradeService } from './trade-service.js';
const params = z.object({ gameId: z.string().uuid() });
const body = z.object({
  expectedRevision: z.number().int().min(0).nullable(),
  expectedMapRevision: z.number().int().min(0),
  name: z.string().trim().min(1).max(120),
  provinceIds: z.array(z.string().uuid()).max(1000),
  influences: z
    .array(
      z.object({
        countryId: z.string().uuid(),
        power: z.number().min(0).max(1000000).multipleOf(0.01),
      }),
    )
    .max(100),
  reason: z.string().trim().min(1).max(2000),
});
export async function registerTradeRoutes(
  app: FastifyInstance,
  auth: AuthService,
  trade: TradeService,
) {
  app.get('/api/v1/games/:gameId/trade', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const p = params.safeParse(request.params),
      q = z
        .object({ countryId: z.string().uuid().optional() })
        .safeParse(request.query);
    if (!p.success || !q.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '贸易请求格式不正确。',
      );
    return {
      data: await trade.get(p.data.gameId, user.id, q.data.countryId),
      meta: { requestId: request.id },
    };
  });
  app.put(
    '/api/v1/games/:gameId/trade-zones/:zoneId',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const p = params
          .extend({ zoneId: z.string().uuid() })
          .safeParse(request.params),
        input = body.safeParse(request.body);
      if (!p.success || !input.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '贸易区资料格式不正确。',
        );
      return {
        data: await trade.set(
          p.data.gameId,
          user.id,
          p.data.zoneId,
          input.data,
        ),
        meta: { requestId: request.id },
      };
    },
  );
}
