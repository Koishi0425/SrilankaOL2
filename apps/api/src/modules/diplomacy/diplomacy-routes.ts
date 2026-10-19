import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../auth/auth-service.js';
import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { DiplomacyService } from './diplomacy-service.js';
const base = {
  id: z.string().uuid(),
  actionId: z.string().uuid().nullable(),
  expectedRevision: z.number().int().min(0),
  expectedQuarterSequence: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
};
export const diplomacyChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    ...base,
    kind: z.literal('WarStatus'),
    countryIds: z.tuple([z.string().uuid(), z.string().uuid()]),
    state: z.enum(['Peace', 'War']),
  }),
  z.object({
    ...base,
    kind: z.literal('Treaty'),
    treatyId: z.string().uuid(),
    title: z.string().trim().min(1).max(200),
    type: z.enum([
      'Alliance',
      'Truce',
      'PeaceTreaty',
      'Guarantee',
      'Trade',
      'Custom',
    ]),
    countryIds: z.array(z.string().uuid()).min(2).max(20),
    terms: z.string().trim().min(1).max(20000),
    visibility: z.enum(['Public', 'Participants']),
    durationQuarters: z.number().int().min(1).max(400).nullable(),
    grantorCountryId: z.string().uuid().nullable(),
  }),
  z.object({
    ...base,
    kind: z.literal('EndTreaty'),
    treatyId: z.string().uuid(),
  }),
]);
export async function registerDiplomacyRoutes(
  app: FastifyInstance,
  auth: AuthService,
  diplomacy: DiplomacyService,
) {
  for (const method of ['GET', 'PUT'] as const)
    app.route({
      method,
      url: '/api/v1/games/:gameId/diplomacy',
      bodyLimit: 4 * 1024 * 1024,
      handler: async (request, reply) => {
        const user = await requireUser(request, reply, auth);
        if (!user) return reply;
        const params = z
          .object({ gameId: z.string().uuid() })
          .safeParse(request.params);
        if (!params.success)
          return sendApiError(
            request,
            reply,
            400,
            'VALIDATION_FAILED',
            '游戏标识格式不正确。',
          );
        let data;
        if (method === 'GET')
          data = await diplomacy.get(params.data.gameId, user.id);
        else {
          const body = z
            .object({ changes: z.array(diplomacyChangeSchema).min(1).max(100) })
            .safeParse(request.body);
          if (!body.success)
            return sendApiError(
              request,
              reply,
              400,
              'VALIDATION_FAILED',
              '外交设置格式不正确。',
            );
          data = await diplomacy.setup(
            params.data.gameId,
            user.id,
            body.data.changes,
          );
        }
        return { data, meta: { requestId: request.id } };
      },
    });
}
