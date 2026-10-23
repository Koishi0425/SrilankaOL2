import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINIMUM_PASSWORD_LENGTH } from '@srilanka/contracts';
import { buildApp } from '../../app.js';
import { registerAuthRoutes } from './auth-routes.js';
import type { AuthService } from './auth-service.js';
import {
  assertNewPassword,
  hashPassword,
  verifyPassword,
} from './credentials.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture() {
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'player',
    displayName: '玩家',
    systemRole: 'User' as const,
  };
  const session = { user, token: 'session', expiresAt: new Date('2030-01-01') };
  const auth = {
    options: { registrationMode: 'InviteOnly', minimumPasswordLength: 6 },
    limit: vi.fn(),
    authenticate: vi.fn().mockResolvedValue(user),
    login: vi.fn().mockResolvedValue(session),
    register: vi.fn().mockResolvedValue(session),
    security: {
      changePassword: vi.fn(),
      redeemReset: vi.fn(),
      issueReset: vi.fn(),
      issueInvitation: vi.fn(),
    },
  };
  const app = await buildApp({
    logLevel: 'silent',
    health: { checkDatabase: async () => {}, checkRedis: async () => {} },
  });
  apps.push(app);
  await app.register(async (routes) => {
    await registerAuthRoutes(routes, auth as unknown as AuthService, false);
  });
  return { app, auth };
}

describe('six-character account passwords', () => {
  it('accepts the boundary, rejects shorter/blank/oversized passwords and preserves hashing', async () => {
    expect(MINIMUM_PASSWORD_LENGTH).toBe(6);
    expect(() => assertNewPassword('abc123')).not.toThrow();
    expect(() => assertNewPassword('六个中文字符')).not.toThrow();
    for (const value of ['12345', '      ', 'x'.repeat(257)])
      expect(() => assertNewPassword(value)).toThrow();
    const encoded = await hashPassword('abc123');
    expect(await verifyPassword('abc123', encoded)).toBe(true);
    expect(await verifyPassword('abc124', encoded)).toBe(false);
  });

  it.each([
    ['/auth/login', { username: 'player', password: 'abc123' }, 200],
    [
      '/auth/register',
      { username: 'player', displayName: '玩家', password: 'abc123' },
      201,
    ],
    [
      '/auth/password',
      { currentPassword: 'abc123', newPassword: 'xyz789' },
      200,
    ],
    [
      '/auth/password-reset',
      { username: 'player', code: 'one-time-code', newPassword: 'abc123' },
      200,
    ],
    [
      '/games/00000000-0000-4000-8000-000000000002/registration-invitations',
      { currentPassword: 'abc123' },
      201,
    ],
    [
      '/games/00000000-0000-4000-8000-000000000002/members/00000000-0000-4000-8000-000000000003/password-reset',
      { currentPassword: 'abc123', reason: '本人请求' },
      201,
    ],
  ] as const)('accepts six characters at %s', async (path, payload, status) => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      headers: { cookie: 'srilanka_session=session' },
      payload,
    });
    expect(response.statusCode).toBe(status);
  });

  it.each([
    ['/auth/login', { username: 'player', password: '12345' }],
    [
      '/auth/register',
      { username: 'player', displayName: '玩家', password: '12345' },
    ],
    ['/auth/password', { currentPassword: 'abc123', newPassword: '12345' }],
    [
      '/auth/password-reset',
      { username: 'player', code: 'one-time-code', newPassword: '12345' },
    ],
  ] as const)(
    'rejects five characters at %s before changing credentials',
    async (path, payload) => {
      const { app, auth } = await fixture();
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1${path}`,
        headers: { cookie: 'srilanka_session=session' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(auth.login).not.toHaveBeenCalled();
      expect(auth.register).not.toHaveBeenCalled();
      expect(auth.security.changePassword).not.toHaveBeenCalled();
      expect(auth.security.redeemReset).not.toHaveBeenCalled();
    },
  );
});
