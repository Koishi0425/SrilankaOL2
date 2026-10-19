import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { CountryService } from './country-service.js';

const params = z.object({
  gameId: z.string().uuid(),
  countryId: z.string().uuid(),
});
export const treasurySchema = z
  .number()
  .min(-1_000_000_000)
  .max(1_000_000_000)
  .multipleOf(0.01);
export async function registerCountryRoutes(
  app: FastifyInstance,
  auth: AuthService,
  countries: CountryService,
) {
  app.get('/api/v1/games/:gameId/national-status', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const parsed = params.pick({ gameId: true }).safeParse(request.params);
    if (!parsed.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '游戏标识格式不正确。',
      );
    return {
      data: await countries.status(parsed.data.gameId, user.id),
      meta: { requestId: request.id },
    };
  });
  app.get(
    '/api/v1/games/:gameId/countries/:countryId/ledger',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const parsed = params.safeParse(request.params);
      const query = z
        .object({
          before: z
            .string()
            .regex(/^[1-9]\d{0,18}$/u)
            .refine((v) => BigInt(v) <= 9223372036854775807n)
            .optional(),
        })
        .safeParse(request.query);
      if (!parsed.success || !query.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '账目查询格式不正确。',
        );
      return {
        data: await countries.ledger(
          parsed.data.gameId,
          user.id,
          parsed.data.countryId,
          query.data.before,
        ),
        meta: { requestId: request.id },
      };
    },
  );
  app.put(
    '/api/v1/games/:gameId/countries/:countryId/balances',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const parsed = params.safeParse(request.params);
      const body = z
        .object({
          expectedRevision: z.number().int().min(0),
          treasury: treasurySchema,
          manpower: z.number().int().min(0).max(2_147_483_647),
          reason: z.string().trim().min(1).max(2000),
        })
        .safeParse(request.body);
      if (!parsed.success || !body.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '余额格式不正确，国库最多两位小数，人力为非负整数。',
        );
      return {
        data: await countries.setBalances(
          parsed.data.gameId,
          user.id,
          parsed.data.countryId,
          body.data,
        ),
        meta: { requestId: request.id },
      };
    },
  );
}
