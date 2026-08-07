import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type {
  ApiErrorBody,
  ApiResponse,
  CurrentUser,
} from '@srilanka/contracts';

import type { AuthService } from './auth-service.js';

export const SESSION_COOKIE = 'srilanka_session';

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
});

export function sendApiError(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
): FastifyReply {
  const body: ApiErrorBody = {
    error: { code, message, details: {}, retryable: false },
    meta: { requestId: request.id },
  };
  return reply.status(status).send(body);
}

export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
): Promise<CurrentUser | null> {
  const user = await auth.authenticate(request.cookies[SESSION_COOKIE]);
  if (!user) {
    sendApiError(request, reply, 401, 'UNAUTHENTICATED', '请先登录。');
    return null;
  }
  return user;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  secureCookies: boolean,
): Promise<void> {
  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '邮箱或密码格式不正确。',
      );
    }

    const result = await auth.login(parsed.data.email, parsed.data.password);
    if (!result) {
      return sendApiError(
        request,
        reply,
        401,
        'UNAUTHENTICATED',
        '邮箱或密码不正确。',
      );
    }

    void reply.setCookie(SESSION_COOKIE, result.token, {
      path: '/api/v1',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      expires: result.expiresAt,
    });
    const body: ApiResponse<CurrentUser> = {
      data: result.user,
      meta: { requestId: request.id },
    };
    return reply.send(body);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await auth.logout(request.cookies[SESSION_COOKIE]);
    void reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
    const body: ApiResponse<{ loggedOut: true }> = {
      data: { loggedOut: true },
      meta: { requestId: request.id },
    };
    return reply.send(body);
  });
}
