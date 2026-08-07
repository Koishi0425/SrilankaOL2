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
  username: z.string().trim().min(1).max(64).regex(/^\S+$/u),
  password: z.string().min(8).max(256),
});
const registrationSchema = loginSchema.extend({
  displayName: z.string().trim().min(1).max(120),
});

function setSessionCookie(
  reply: FastifyReply,
  result: { token: string; expiresAt: Date },
  secureCookies: boolean,
): void {
  void reply.setCookie(SESSION_COOKIE, result.token, {
    path: '/api/v1',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    expires: result.expiresAt,
  });
}

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
  app.post('/api/v1/auth/register', async (request, reply) => {
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '用户名、显示名称或密码格式不正确。',
      );
    }

    const result = await auth.register(parsed.data);
    if (!result) {
      return sendApiError(
        request,
        reply,
        409,
        'USERNAME_ALREADY_REGISTERED',
        '该用户名已经注册。',
      );
    }
    setSessionCookie(reply, result, secureCookies);
    const body: ApiResponse<CurrentUser> = {
      data: result.user,
      meta: { requestId: request.id },
    };
    return reply.status(201).send(body);
  });

  app.post('/api/v1/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        '用户名或密码格式不正确。',
      );
    }

    const result = await auth.login(parsed.data.username, parsed.data.password);
    if (!result) {
      return sendApiError(
        request,
        reply,
        401,
        'UNAUTHENTICATED',
        '用户名或密码不正确。',
      );
    }

    setSessionCookie(reply, result, secureCookies);
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
