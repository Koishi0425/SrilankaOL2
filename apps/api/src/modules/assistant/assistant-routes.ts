import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFault } from '../../errors.js';
import { requireUser } from '../auth/auth-routes.js';
import type { AuthService } from '../auth/auth-service.js';
import type { AssistantService } from './assistant-service.js';
import { globalAssistantInputSchema } from './assistant-settings.js';

const paramsSchema = z.object({ gameId: z.string().uuid() });
const settingsSchema = z
  .object({ enabled: z.boolean(), expectedEnabled: z.boolean() })
  .strict();
export const assistantInputSchema = z
  .object({
    purpose: z.enum(['Digest', 'Feedback']),
    quarterId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative(),
    expectedCorrectionVersion: z.number().int().nonnegative(),
    length: z.enum(['Brief', 'Normal', 'Detailed']).default('Normal'),
    actionId: z.string().uuid().optional(),
    ruling: z.string().trim().min(1).max(4000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.purpose === 'Digest' && (input.actionId || input.ruling))
      context.addIssue({
        code: 'custom',
        message: '结果速览不接受自定义资料。',
      });
    if (input.purpose === 'Feedback' && (!input.actionId || !input.ruling))
      context.addIssue({
        code: 'custom',
        message: '起草反馈需要政策与主持人裁定。',
      });
  });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new ApiFault(400, 'VALIDATION_FAILED', '辅助请求格式不正确。');
  return parsed.data;
}

export async function registerAssistantRoutes(
  app: FastifyInstance,
  auth: AuthService,
  assistant: AssistantService,
) {
  if (assistant.settings) {
    const settings = assistant.settings;
    app.get('/api/v1/admin/assistant', async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      return {
        data: await settings.get(user.id),
        meta: { requestId: request.id },
      };
    });
    app.put(
      '/api/v1/admin/assistant',
      { bodyLimit: 14000 },
      async (request, reply) => {
        const user = await requireUser(request, reply, auth);
        if (!user) return reply;
        const input = parse(globalAssistantInputSchema, request.body);
        return {
          data: await settings.save(user.id, input),
          meta: { requestId: request.id },
        };
      },
    );
    app.post('/api/v1/admin/assistant/test', async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const data = await settings.test(user.id);
      if (!(await requireUser(request, reply, auth))) return reply;
      return { data, meta: { requestId: request.id } };
    });
  }
  app.get('/api/v1/games/:gameId/assistant', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const { gameId } = parse(paramsSchema, request.params);
    return {
      data: await assistant.status(gameId, user.id),
      meta: { requestId: request.id },
    };
  });
  app.put('/api/v1/games/:gameId/assistant', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return reply;
    const { gameId } = parse(paramsSchema, request.params);
    const input = parse(settingsSchema, request.body);
    return {
      data: await assistant.configure(
        gameId,
        user.id,
        input.enabled,
        input.expectedEnabled,
      ),
      meta: { requestId: request.id },
    };
  });
  app.post(
    '/api/v1/games/:gameId/assistant/generate',
    { bodyLimit: 24_000 },
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return reply;
      const { gameId } = parse(paramsSchema, request.params);
      const input = parse(assistantInputSchema, request.body);
      const data = await assistant.generate(gameId, user.id, input);
      // Session could be revoked while the external request was running.
      if (!(await requireUser(request, reply, auth))) return reply;
      return { data, meta: { requestId: request.id } };
    },
  );
}
