import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { diplomacyChangeSchema } from '../diplomacy/diplomacy-routes.js';
import { governmentChangeSchema } from '../government/government-routes.js';

import { requireUser, sendApiError } from '../auth/auth-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { SettlementService } from './settlement-service.js';
import {
  registerCountryRoutes,
  treasurySchema,
} from '../games/country-routes.js';

import { tagChangeFields } from '../world/tile-tags.js';

const paramsSchema = z.object({
  gameId: z.string().uuid(),
  quarterId: z.string().uuid(),
});
const versionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  expectedMapRevision: z.number().int().min(0).optional(),
});
const changeBase = {
  id: z.string().uuid(),
  actionId: z.string().uuid().nullable(),
};
const stateChangeSchema = z.discriminatedUnion('kind', [
  z.object({ ...changeBase, kind: z.literal('TileTag'), ...tagChangeFields }),
  z.object({
    ...changeBase,
    kind: z.literal('TradeInfluence'),
    zoneId: z.string().uuid(),
    countryId: z.string().uuid(),
    power: z.number().min(0).max(1000000).multipleOf(0.01),
    expectedZoneRevision: z.number().int().min(0),
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    ...changeBase,
    kind: z.literal('ArmyMove'),
    armyId: z.string().uuid(),
    destinationTileId: z.string().uuid(),
  }),
  z.object({
    ...changeBase,
    kind: z.literal('ArmyStrength'),
    armyId: z.string().uuid(),
    strength: z.number().int().min(0).max(2_147_483_647),
  }),
  z.object({
    ...changeBase,
    kind: z.literal('Province'),
    provinceId: z.string().uuid(),
    expectedProfileRevision: z.number().int().min(0),
    values: z
      .strictObject({
        taxBase: z.number().int().min(0).max(1000000).optional(),
        productionBase: z.number().int().min(0).max(1000000).optional(),
        manpowerBase: z.number().int().min(0).max(1000000).optional(),
        autonomy: z.number().min(0).max(100).multipleOf(0.01).optional(),
        unrest: z.number().min(-100).max(100).multipleOf(0.01).optional(),
      })
      .refine((v) => Object.keys(v).length > 0),
    reason: z.string().trim().min(1).max(2000),
  }),
  z.object({
    ...changeBase,
    kind: z.literal('Territory'),
    tileIds: z.array(z.string().uuid()).min(1).max(2500),
    controllerCountryId: z.string().uuid().nullable().optional(),
    legalOwnerCountryId: z.string().uuid().nullable().optional(),
  }),
]);
const saveSchema = versionSchema.extend({
  diplomacyChanges: z.array(diplomacyChangeSchema).max(100).optional(),
  governmentChanges: z.array(governmentChangeSchema).max(100).optional(),
  economicBill: z
    .object({
      lines: z
        .array(
          z.object({
            id: z.string().uuid(),
            countryId: z.string().uuid(),
            kind: z.enum([
              'Tax',
              'Production',
              'ManpowerGrowth',
              'Trade',
              'ArmyMaintenance',
              'Administration',
            ]),
            amount: z.number(),
            expectedResourceRevision: z.number().int().min(0),
            adjustmentReason: z.string().trim().max(2000),
          }),
        )
        .max(500),
    })
    .nullable()
    .optional(),
  recruitments: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          ...changeBase,
          kind: z.literal('Create'),
          countryId: z.string().uuid(),
          name: z.string().trim().min(1).max(120),
          tileId: z.string().uuid(),
          strength: z.number().int().min(1).max(2_147_483_647),
          treasuryCost: treasurySchema.refine((v) => v >= 0),
          manpowerCost: z.number().int().min(0).max(2_147_483_647),
          expectedResourceRevision: z.number().int().min(0),
          note: z.string().trim().min(1).max(2000),
        }),
        z.object({
          ...changeBase,
          kind: z.literal('Reinforce'),
          armyId: z.string().uuid(),
          strength: z.number().int().min(1).max(2_147_483_647),
          treasuryCost: treasurySchema.refine((v) => v >= 0),
          manpowerCost: z.number().int().min(0).max(2_147_483_647),
          expectedResourceRevision: z.number().int().min(0),
          note: z.string().trim().min(1).max(2000),
        }),
      ]),
    )
    .max(100)
    .optional(),
  resourceChanges: z
    .array(
      z.discriminatedUnion('resource', [
        z.object({
          ...changeBase,
          countryId: z.string().uuid(),
          expectedResourceRevision: z.number().int().min(0),
          resource: z.literal('Treasury'),
          amount: treasurySchema.refine((v) => v !== 0),
          reason: z.string().trim().min(1).max(2000),
        }),
        z.object({
          ...changeBase,
          countryId: z.string().uuid(),
          expectedResourceRevision: z.number().int().min(0),
          resource: z.literal('Manpower'),
          amount: z
            .number()
            .int()
            .min(-2_147_483_647)
            .max(2_147_483_647)
            .refine((v) => v !== 0),
          reason: z.string().trim().min(1).max(2000),
        }),
      ]),
    )
    .max(500)
    .optional(),
  battles: z
    .array(
      z.object({
        ...changeBase,
        title: z.string().trim().min(1).max(200),
        kind: z.enum(['Field', 'Siege']),
        tileId: z.string().uuid(),
        attackers: z
          .array(
            z.object({
              armyId: z.string().uuid(),
              committedStrength: z.number().int().min(1).max(2_147_483_647),
            }),
          )
          .min(1)
          .max(10),
        defenders: z
          .array(
            z.object({
              armyId: z.string().uuid(),
              committedStrength: z.number().int().min(1).max(2_147_483_647),
            }),
          )
          .min(1)
          .max(10),
        resolution: z
          .object({
            outcome: z.enum([
              'AttackerVictory',
              'DefenderVictory',
              'Draw',
              'Inconclusive',
            ]),
            narrative: z.string().trim().min(1).max(5000),
            armies: z
              .array(
                z.object({
                  armyId: z.string().uuid(),
                  casualties: z.number().int().min(0).max(2_147_483_647),
                  destinationTileId: z.string().uuid().nullable(),
                }),
              )
              .min(2)
              .max(20),
            occupyCountryId: z.string().uuid().nullable(),
          })
          .nullable(),
      }),
    )
    .max(50)
    .optional(),
  stateChanges: z.array(stateChangeSchema).max(500).optional(),
  publicReport: z.string().max(20_000),
  results: z
    .array(
      z.object({
        actionId: z.string().uuid(),
        feedback: z.string().max(20_000),
        resultAudience: z
          .union([
            z.object({ kind: z.enum(['OwnerOnly', 'Public', 'HostOnly']) }),
            z.object({
              kind: z.literal('Countries'),
              countryIds: z.array(z.uuid()).min(1).max(500),
            }),
          ])
          .optional(),
      }),
    )
    .max(1000),
});

export async function registerSettlementRoutes(
  app: FastifyInstance,
  auth: AuthService,
  settlements: SettlementService,
) {
  await registerCountryRoutes(app, auth, settlements.countries);
  const correctionSchema = z.object({
    id: z.string().uuid(),
    expectedCorrectionVersion: z.number().int().min(0),
    expectedCurrentQuarterId: z.string().uuid(),
    reason: z.string().trim().min(1).max(2000),
    change: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('PublicReport'),
        text: z.string().max(20000),
      }),
      z.object({
        kind: z.literal('ActionFeedback'),
        actionId: z.string().uuid(),
        text: z.string().min(1).max(20000),
      }),
      z.object({
        kind: z.literal('Resource'),
        countryId: z.string().uuid(),
        resource: z.enum(['Treasury', 'Manpower']),
        amount: z.number(),
        expectedResourceRevision: z.number().int().min(0),
      }),
      z.object({
        kind: z.literal('ArmyStrength'),
        armyId: z.string().uuid(),
        strength: z.number().int().min(0).max(2147483647),
        expectedStrength: z.number().int().min(0),
        expectedMapRevision: z.number().int().min(0),
      }),
    ]),
  });
  for (const operation of ['options', 'correct'] as const) {
    app.route({
      method: operation === 'options' ? 'GET' : 'POST',
      url: `/api/v1/games/:gameId/quarters/:quarterId/settlement/corrections${operation === 'options' ? '/options' : ''}`,
      handler: async (request, reply) => {
        const user = await requireUser(request, reply, auth);
        if (!user) return reply;
        const params = paramsSchema.safeParse(request.params);
        if (!params.success)
          return sendApiError(
            request,
            reply,
            400,
            'VALIDATION_FAILED',
            '回合标识格式不正确。',
          );
        const { gameId, quarterId } = params.data;
        if (operation === 'options')
          return {
            data: await settlements.corrections.options(
              gameId,
              user.id,
              quarterId,
            ),
            meta: { requestId: request.id },
          };
        const body = correctionSchema.safeParse(request.body);
        if (!body.success)
          return sendApiError(
            request,
            reply,
            400,
            'VALIDATION_FAILED',
            '更正内容格式不正确。',
          );
        await settlements.corrections.correct(
          gameId,
          user.id,
          quarterId,
          body.data,
        );
        return {
          data: await settlements.get(gameId, user.id, quarterId),
          meta: { requestId: request.id },
        };
      },
    });
  }
  app.get(
    '/api/v1/games/:gameId/quarters/:quarterId/settlement/economy',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const params = paramsSchema.safeParse(request.params),
        query = z
          .object({ expectedVersion: z.coerce.number().int().positive() })
          .safeParse(request.query);
      if (!params.success || !query.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '经济账单请求格式不正确。',
        );
      return {
        data: await settlements.economicPreview(
          params.data.gameId,
          user.id,
          params.data.quarterId,
          query.data.expectedVersion,
        ),
        meta: { requestId: request.id },
      };
    },
  );
  app.post(
    '/api/v1/games/:gameId/quarters/:quarterId/settlement/battles/:battleId/roll',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const params = paramsSchema
        .extend({ battleId: z.string().uuid() })
        .safeParse(request.params);
      const body = versionSchema
        .extend({
          expectedMapRevision: z.number().int().min(0),
          idempotencyKey: z.string().uuid(),
          phase: z.enum(['Fire', 'Shock', 'Siege', 'Custom']),
          count: z.number().int().min(1).max(20),
          sides: z.number().int().min(2).max(1000),
          zeroBased: z.boolean(),
          attackerModifier: z.number().int().min(-10000).max(10000),
          defenderModifier: z.number().int().min(-10000).max(10000),
          modifierNote: z.string().max(2000),
          note: z.string().max(2000),
        })
        .safeParse(request.body);
      if (!params.success || !body.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '掷骰参数格式不正确。',
        );
      return {
        data: await settlements.roll(
          params.data.gameId,
          user.id,
          params.data.quarterId,
          params.data.battleId,
          body.data,
        ),
        meta: { requestId: request.id },
      };
    },
  );
  app.get(
    '/api/v1/games/:gameId/quarters/:quarterId/settlement/options',
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const params = paramsSchema.safeParse(request.params);
      if (!params.success)
        return sendApiError(
          request,
          reply,
          400,
          'VALIDATION_FAILED',
          '回合标识格式不正确。',
        );
      return {
        data: await settlements.options(
          params.data.gameId,
          user.id,
          params.data.quarterId,
        ),
        meta: { requestId: request.id },
      };
    },
  );
  app.get('/api/v1/games/:gameId/settlements', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const params = paramsSchema
      .omit({ quarterId: true })
      .safeParse(request.params);
    if (!params.success)
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '游戏标识格式不正确。',
      );
    return {
      data: await settlements.list(params.data.gameId, user.id),
      meta: { requestId: request.id },
    };
  });

  for (const operation of [
    'get',
    'begin',
    'save',
    'publish',
    'advance',
  ] as const) {
    app.route({
      bodyLimit: 16 * 1024 * 1024,
      method:
        operation === 'get' ? 'GET' : operation === 'save' ? 'PUT' : 'POST',
      url: `/api/v1/games/:gameId/quarters/:quarterId/settlement${['get', 'save'].includes(operation) ? '' : `/${operation}`}`,
      handler: async (request, reply) => {
        const user = await requireUser(request, reply, auth);
        if (!user) return reply;
        const params = paramsSchema.safeParse(request.params);
        if (!params.success)
          return sendApiError(
            request,
            reply,
            400,
            'VALIDATION_FAILED',
            '回合标识格式不正确。',
          );
        const { gameId, quarterId } = params.data;
        let data;
        if (operation === 'save') {
          const body = saveSchema.safeParse(request.body);
          if (!body.success)
            return sendApiError(
              request,
              reply,
              400,
              'VALIDATION_FAILED',
              '结算内容格式不正确。',
            );
          data = await settlements.save(gameId, user.id, quarterId, body.data);
        } else if (operation === 'publish') {
          const body = versionSchema.safeParse(request.body);
          if (!body.success)
            return sendApiError(
              request,
              reply,
              400,
              'VALIDATION_FAILED',
              '结算修订号格式不正确。',
            );
          data = await settlements.publish(
            gameId,
            user.id,
            quarterId,
            body.data.expectedVersion,
            body.data.expectedMapRevision,
          );
        } else {
          data = await settlements[operation](gameId, user.id, quarterId);
        }
        return { data, meta: { requestId: request.id } };
      },
    });
  }
}
