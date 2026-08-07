import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadServiceConfig } from '@srilanka/config';
import { checkDatabase, createDatabasePool } from '@srilanka/database';
import { createClient } from 'redis';

import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const redis = createClient({ url: config.redisUrl });
const auth = new AuthService(database);
const games = new GameService(database);

const app = await buildApp({
  health: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: async () => {
      await redis.ping();
    },
  },
  auth,
  games,
});

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  if (typeof setCookie !== 'string')
    throw new Error('Login did not set a session cookie');
  return setCookie.split(';', 1)[0] ?? '';
}

async function logIn(email: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function registerUser(
  email: string,
  displayName: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, displayName, password },
  });
  expect(response.statusCode).toBe(201);
  return sessionCookie(response);
}

beforeAll(async () => {
  await redis.connect();
});

beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions, game_members, quarters, countries, games, users CASCADE',
  );
});

afterAll(async () => {
  await Promise.all([
    app.close(),
    database.end(),
    redis.isOpen ? redis.quit() : Promise.resolve(),
  ]);
});

describe('M1 identity and game boundaries', () => {
  it('requires a session for the current-user endpoint', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('keeps games isolated and reserves member management for hosts', async () => {
    const host = await auth.createDevelopmentUser({
      email: 'host@example.test',
      displayName: 'Host',
      password: 'host-password-123',
    });
    await auth.createDevelopmentUser({
      email: 'outsider@example.test',
      displayName: 'Outsider',
      password: 'outsider-password-123',
    });

    const hostCookie = await logIn('host@example.test', 'host-password-123');
    const outsiderCookie = await logIn(
      'outsider@example.test',
      'outsider-password-123',
    );

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { cookie: hostCookie },
      payload: { name: 'Northern Passage', countryNames: ['Kandy', 'Jaffna'] },
    });
    expect(created.statusCode).toBe(201);
    const gameId = created.json().data.id as string;

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}`,
      headers: { cookie: outsiderCookie },
    });
    expect(hidden.statusCode).toBe(404);

    const playerCookie = await registerUser(
      'player@example.test',
      'Player',
      'player-password-123',
    );

    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/members`,
      headers: { cookie: hostCookie },
      payload: { email: 'player@example.test', role: 'Player' },
    });
    expect(added.statusCode).toBe(201);

    await registerUser(
      'observer@example.test',
      'Observer',
      'observer-password-123',
    );

    const observer = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/members`,
      headers: { cookie: hostCookie },
      payload: { email: 'observer@example.test', role: 'Observer' },
    });
    expect(observer.statusCode).toBe(201);

    const playerGames = await app.inject({
      method: 'GET',
      url: '/api/v1/games',
      headers: { cookie: playerCookie },
    });
    expect(playerGames.statusCode).toBe(200);
    expect(playerGames.json().data).toMatchObject([
      { id: gameId, name: 'Northern Passage', role: 'Player' },
    ]);

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/members`,
      headers: { cookie: playerCookie },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('HOST_PERMISSION_REQUIRED');

    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/members`,
      headers: { cookie: hostCookie },
    });
    expect(members.json().data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'player@example.test',
          role: 'Player',
        }),
        expect.objectContaining({
          email: 'observer@example.test',
          role: 'Observer',
        }),
      ]),
    );

    const duplicateGame = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { cookie: hostCookie },
      payload: { name: 'Second active game', countryNames: [] },
    });
    expect(duplicateGame.statusCode).toBe(409);
    expect(duplicateGame.json().error.code).toBe('ACTIVE_GAME_ALREADY_EXISTS');

    const hostMembership = await database.query(
      `SELECT role FROM game_members WHERE game_id = $1 AND user_id = $2`,
      [gameId, host.id],
    );
    expect(hostMembership.rows[0]?.role).toBe('Host');
  });
});
