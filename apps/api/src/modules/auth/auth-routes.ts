import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type {
  ApiErrorBody,
  ApiResponse,
  CurrentUser,
} from '@srilanka/contracts';

import type { AuthService } from './auth-service.js';
import { ApiFault } from '../../errors.js';
import { MINIMUM_PASSWORD_LENGTH } from './credentials.js';

export const SESSION_COOKIE = 'srilanka_session';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64).regex(/^\S+$/u),
  password: z.string().min(MINIMUM_PASSWORD_LENGTH).max(256),
});
const registrationSchema = loginSchema.extend({
  displayName: z.string().trim().min(1).max(120),
  password: loginSchema.shape.password,
  inviteCode: z.string().trim().max(128).optional(),
});
const passwordSchema = z.object({
  currentPassword: loginSchema.shape.password,
  newPassword: loginSchema.shape.password,
});
const resetSchema = z.object({
  username: loginSchema.shape.username,
  code: z.string().trim().min(1).max(128),
  newPassword: passwordSchema.shape.newPassword,
});
const assistanceSchema = z.object({
  currentPassword: passwordSchema.shape.currentPassword,
  reason: z.string().trim().min(1).max(500),
});
const gameParams = z.object({ gameId: z.uuid() });
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiFault(
      400,
      'VALIDATION_FAILED',
      `请检查填写内容；新密码需${MINIMUM_PASSWORD_LENGTH}至256个字符。`,
    );
  return result.data;
}
function identifier(body: unknown): string {
  return typeof body === 'object' &&
    body !== null &&
    'username' in body &&
    typeof body.username === 'string'
    ? body.username.slice(0, 64)
    : '';
}

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
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url.startsWith('/api/v1/auth/') ||
      /\/(?:password-reset|registration-invitations|account-history)(?:\?|$)/u.test(
        request.url,
      )
    )
      void reply.header('Cache-Control', 'no-store');
  });
  const smallBody = { bodyLimit: 8192 };
  const respond = (request: FastifyRequest, data: unknown) => ({
    data,
    meta: { requestId: request.id },
  });
  app.get('/api/v1/auth/options', async (request) =>
    respond(request, auth.options),
  );
  app.post('/api/v1/auth/register', smallBody, async (request, reply) => {
    await auth.limit('Register', request.ip, identifier(request.body));
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendApiError(
        request,
        reply,
        400,
        'VALIDATION_FAILED',
        `请检查用户名和显示名称；新密码需${MINIMUM_PASSWORD_LENGTH}至256个字符。`,
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

  app.post('/api/v1/auth/login', smallBody, async (request, reply) => {
    await auth.limit('Login', request.ip, identifier(request.body));
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

  app.post('/api/v1/auth/password', smallBody, async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return;
    await auth.limit('Reauthenticate', request.ip, user.id);
    const input = parsed(passwordSchema, request.body);
    await auth.security.changePassword(
      user,
      request.cookies[SESSION_COOKIE]!,
      input.currentPassword,
      input.newPassword,
    );
    void reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
    return respond(request, { changed: true });
  });
  app.post('/api/v1/auth/password-reset', smallBody, async (request, reply) => {
    await auth.limit('Reset', request.ip, identifier(request.body));
    const input = parsed(resetSchema, request.body);
    await auth.security.redeemReset(
      input.username,
      input.code,
      input.newPassword,
    );
    void reply.clearCookie(SESSION_COOKIE, { path: '/api/v1' });
    return respond(request, { changed: true });
  });
  app.post(
    '/api/v1/games/:gameId/members/:memberId/password-reset',
    smallBody,
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return;
      await auth.limit('Reauthenticate', request.ip, user.id);
      await auth.limit('IssueCode', request.ip, user.id);
      const params = parsed(
          gameParams.extend({ memberId: z.uuid() }),
          request.params,
        ),
        input = parsed(assistanceSchema, request.body);
      const data = await auth.security.issueReset(
        params.gameId,
        params.memberId,
        user,
        request.cookies[SESSION_COOKIE]!,
        input.currentPassword,
        input.reason,
      );
      return reply.code(201).send(respond(request, data));
    },
  );
  app.post(
    '/api/v1/games/:gameId/registration-invitations',
    smallBody,
    async (request, reply) => {
      const user = await requireUser(request, reply, auth);
      if (!user) return;
      await auth.limit('Reauthenticate', request.ip, user.id);
      await auth.limit('IssueCode', request.ip, user.id);
      const params = parsed(gameParams, request.params),
        input = parsed(
          z.object({ currentPassword: passwordSchema.shape.currentPassword }),
          request.body,
        );
      if (auth.options.registrationMode !== 'InviteOnly')
        throw new ApiFault(
          409,
          'INVITATION_NOT_REQUIRED',
          '当前注册方式不使用邀请码。',
        );
      return reply
        .code(201)
        .send(
          respond(
            request,
            await auth.security.issueInvitation(
              params.gameId,
              user,
              request.cookies[SESSION_COOKIE]!,
              input.currentPassword,
            ),
          ),
        );
    },
  );
  app.get('/api/v1/games/:gameId/account-history', async (request, reply) => {
    const user = await requireUser(request, reply, auth);
    if (!user) return;
    return respond(
      request,
      await auth.security.history(
        parsed(gameParams, request.params).gameId,
        user,
      ),
    );
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
