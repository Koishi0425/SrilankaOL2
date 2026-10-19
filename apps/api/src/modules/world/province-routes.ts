import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { ProvinceService } from './province-service.js';
const game = z.object({ gameId: z.string().uuid() });
const params = game.extend({ provinceId: z.string().uuid() });
const decimal = (min: number, max: number) =>
  z.number().min(min).max(max).multipleOf(0.01);
const body = z.object({
  expectedRevision: z.number().int().min(0),
  expectedMapRevision: z.number().int().min(0),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  taxBase: z.number().int().min(0).max(1000000),
  productionBase: z.number().int().min(0).max(1000000),
  manpowerBase: z.number().int().min(0).max(1000000),
  autonomy: decimal(0, 100),
  unrest: decimal(-100, 100),
  reason: z.string().trim().min(1).max(2000),
});
export async function registerProvinceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  provinces: ProvinceService,
) {
  app.get('/api/v1/games/:gameId/provinces', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const parsed = game.safeParse(request.params);
    if (!parsed.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '游戏标识格式不正确。',
      );
    return {
      data: await provinces.list(parsed.data.gameId, user.id),
      meta: { requestId: request.id },
    };
  });
  app.put(
    '/api/v1/games/:gameId/provinces/:provinceId',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const parsed = params.safeParse(request.params),
        input = body.safeParse(request.body);
      if (!parsed.success || !input.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '省份资料格式不正确。',
        );
      return {
        data: await provinces.set(
          parsed.data.gameId,
          user.id,
          parsed.data.provinceId,
          input.data,
        ),
        meta: { requestId: request.id },
      };
    },
  );
}
