import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/auth-service.js';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { GovernmentService } from './government-service.js';
const base = {
  id: z.string().uuid(),
  actionId: z.string().uuid().nullable(),
  expectedRevision: z.number().int().min(0),
  expectedQuarterSequence: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
};
const percent = z.number().min(-100).max(1000).multipleOf(0.01);
export const governmentChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('Government'),
    countryId: z.string().uuid(),
    regime: z.string().trim().max(120),
    authority: z.string().trim().max(120),
    description: z.string().trim().max(5000),
  }),
  z.object({
    ...base,
    kind: z.literal('Policy'),
    policyId: z.string().uuid(),
    countryId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    type: z.enum(['Policy', 'Reform']),
    text: z.string().trim().min(1).max(20000),
    durationQuarters: z.number().int().min(1).max(400).nullable(),
    effects: z.strictObject({
      Tax: percent.optional(),
      Production: percent.optional(),
      Trade: percent.optional(),
      ManpowerGrowth: percent.optional(),
      ArmyMaintenance: percent.optional(),
      Administration: percent.optional(),
    }),
  }),
  z.object({
    ...base,
    kind: z.literal('EndPolicy'),
    policyId: z.string().uuid(),
  }),
]);
export async function registerGovernmentRoutes(
  app: FastifyInstance,
  auth: AuthService,
  government: GovernmentService,
) {
  for (const method of ['GET', 'PUT'] as const)
    app.route({
      method,
      url: '/api/v1/games/:gameId/government',
      bodyLimit: 4 * 1024 * 1024,
      handler: async (request, reply) => {
        const user = await requireUser(request, reply, auth);
        if (!user) return reply;
        const params = z
          .object({ gameId: z.string().uuid() })
          .safeParse(request.params);
        const query = z
          .object({ countryId: z.string().uuid().optional() })
          .safeParse(request.query);
        if (!params.success || !query.success)
          return sendApiError(
            request,
            reply,
            400,
            'VALIDATION_FAILED',
            '政府资料请求格式不正确。',
          );
        let data;
        if (method === 'GET')
          data = await government.get(
            params.data.gameId,
            user.id,
            query.data.countryId,
          );
        else {
          const body = z
            .object({
              changes: z.array(governmentChangeSchema).min(1).max(100),
            })
            .safeParse(request.body);
          if (!body.success)
            return sendApiError(
              request,
              reply,
              400,
              'VALIDATION_FAILED',
              '政府与政策设置格式不正确。',
            );
          data = await government.setup(
            params.data.gameId,
            user.id,
            body.data.changes,
          );
        }
        return { data, meta: { requestId: request.id } };
      },
    });
}
