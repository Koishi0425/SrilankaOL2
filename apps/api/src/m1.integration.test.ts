import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadServiceConfig } from '@srilanka/config';
import { checkDatabase, createDatabasePool } from '@srilanka/database';
import { createClient } from 'redis';

import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const redis = createClient({ url: config.redisUrl });
const auth = new AuthService(database);
const games = new GameService(database);
const world = new WorldService(database);

const app = await buildApp({
  health: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: async () => {
      await redis.ping();
    },
  },
  auth,
  games,
  world,
});

function sessionCookie(response: { headers: Record<string, unknown> }): string {
  const setCookie = response.headers['set-cookie'];
  if (typeof setCookie !== 'string')
    throw new Error('Login did not set a session cookie');
  return setCookie.split(';', 1)[0] ?? '';
}

async function logIn(username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return sessionCookie(response);
}

async function registerUser(
  username: string,
  displayName: string,
  password: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { username, displayName, password },
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
      username: 'host',
      displayName: 'Host',
      password: 'host-password-123',
    });
    await auth.createDevelopmentUser({
      username: 'outsider',
      displayName: 'Outsider',
      password: 'outsider-password-123',
    });

    const hostCookie = await logIn('host', 'host-password-123');
    const outsiderCookie = await logIn('outsider', 'outsider-password-123');

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { cookie: hostCookie },
      payload: { name: 'Northern Passage', countryNames: ['Kandy', 'Jaffna'] },
    });
    expect(created.statusCode).toBe(201);
    const gameId = created.json().data.id as string;
    await world.initializeDevelopmentMap(gameId, host.id);

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}`,
      headers: { cookie: outsiderCookie },
    });
    expect(hidden.statusCode).toBe(404);

    const playerCookie = await registerUser(
      'player',
      'Player',
      'player-password-123',
    );

    const added = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/members`,
      headers: { cookie: hostCookie },
      payload: { username: 'player', role: 'Player' },
    });
    expect(added.statusCode).toBe(201);

    const viewport = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/map/viewport?minQ=1&maxQ=3&minR=1&maxR=3`,
      headers: { cookie: playerCookie },
    });
    expect(viewport.statusCode).toBe(200);
    expect(viewport.json().data.tiles).toHaveLength(9);
    expect(viewport.json().data.tiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ q: 1, r: 1 }),
        expect.objectContaining({ q: 3, r: 3 }),
      ]),
    );
    const tileId = viewport.json().data.tiles[0].id as string;

    const forbiddenEdit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${gameId}/tiles/${tileId}`,
      headers: { cookie: playerCookie },
      payload: { notes: 'player edit' },
    });
    expect(forbiddenEdit.statusCode).toBe(403);

    const invalidCity = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/cities`,
      headers: { cookie: hostCookie },
      payload: { tileId: randomUUID(), name: 'Nowhere' },
    });
    expect(invalidCity.statusCode).toBe(404);

    const city = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/cities`,
      headers: { cookie: hostCookie },
      payload: { tileId, name: 'Matale' },
    });
    expect(city.statusCode).toBe(201);
    expect(city.json().data.cities).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Matale' })]),
    );

    const country = await database.query<{ id: string }>(
      'SELECT id FROM countries WHERE game_id = $1 ORDER BY name LIMIT 1',
      [gameId],
    );
    const army = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/armies`,
      headers: { cookie: hostCookie },
      payload: {
        tileId,
        countryId: country.rows[0]!.id,
        name: 'Test Guard',
        strength: 800,
      },
    });
    expect(army.statusCode).toBe(201);
    const armyId = army
      .json()
      .data.armies.find(
        (candidate: { name: string }) => candidate.name === 'Test Guard',
      ).id as string;
    const destinationTileId = viewport.json().data.tiles.at(-1).id as string;
    const moved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${gameId}/armies/${armyId}/location`,
      headers: { cookie: hostCookie },
      payload: { tileId: destinationTileId },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data.armies).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: armyId })]),
    );

    await registerUser('observer', 'Observer', 'observer-password-123');

    const observer = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${gameId}/members`,
      headers: { cookie: hostCookie },
      payload: { username: 'observer', role: 'Observer' },
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
          username: 'player',
          role: 'Player',
        }),
        expect.objectContaining({
          username: 'observer',
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
import { randomUUID } from 'node:crypto';
