import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService } from '../auth/auth-service.js';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { EconomicService } from './economic-service.js';
const params = z.object({ gameId: z.string().uuid() });
const coefficient = z.number().min(0).max(1000000).multipleOf(0.01);
const rulesSchema = z.object({
  enabled: z.boolean(),
  taxCoefficient: coefficient,
  productionCoefficient: coefficient,
  manpowerCoefficient: coefficient,
  armyMaintenancePer100: coefficient,
  administrationCost: coefficient,
  tradeCoefficient: coefficient.optional(),
});
const input = z.object({
  expectedVersion: z.number().int().min(0),
  reason: z.string().trim().min(1).max(2000),
  rules: rulesSchema,
});
export async function registerEconomicRoutes(
  app: FastifyInstance,
  auth: AuthService,
  economics: EconomicService,
) {
  app.put(
    '/api/v1/games/:gameId/preparation/economy',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const parsed = params.safeParse(request.params);
      const body = z
        .object({
          quarterId: z.string().uuid(),
          expectedPreparationRevision: z.string().regex(/^[a-f0-9]{64}$/u),
          rules: rulesSchema,
          reason: z.string().trim().min(1).max(2000),
          seedBlankProvinces: z.boolean().optional(),
          countries: z
            .array(
              z
                .object({
                  id: z.string().uuid(),
                  treasury: z.number().min(-1e9).max(1e9).multipleOf(0.01),
                  manpower: z.number().int().min(0).max(2147483647),
                })
                .strict(),
            )
            .min(1)
            .max(20),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success || !body.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '开局设置格式不正确。',
        );
      return {
        data: await economics.saveOpening(
          parsed.data.gameId,
          user.id,
          body.data,
        ),
        meta: { requestId: request.id },
      };
    },
  );
  app.post(
    '/api/v1/games/:gameId/economic-rules/preview',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const parsed = params.safeParse(request.params);
      const body = z
        .object({
          rules: rulesSchema.optional(),
          seedBlankProvinces: z.boolean().optional(),
        })
        .strict()
        .safeParse(request.body);
      if (!parsed.success || !body.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '经济试算参数格式不正确。',
        );
      return {
        data: await economics.preview(
          parsed.data.gameId,
          user.id,
          body.data.rules,
          body.data.seedBlankProvinces,
        ),
        meta: { requestId: request.id },
      };
    },
  );
  app.get('/api/v1/games/:gameId/economic-rules', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const parsed = params.safeParse(request.params);
    if (!parsed.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '游戏标识格式不正确。',
      );
    return {
      data: await economics.get(parsed.data.gameId, user.id),
      meta: { requestId: request.id },
    };
  });
  app.put('/api/v1/games/:gameId/economic-rules', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const parsed = params.safeParse(request.params),
      body = input.safeParse(request.body);
    if (!parsed.success || !body.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '经济规则格式不正确。',
      );
    return {
      data: await economics.set(parsed.data.gameId, user.id, body.data),
      meta: { requestId: request.id },
    };
  });
}
