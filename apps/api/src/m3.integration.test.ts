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
    checkRedis: async () => void (await redis.ping()),
  },
  auth,
  games,
  world,
});

function cookie(response: { headers: Record<string, unknown> }): string {
  const value = response.headers['set-cookie'];
  if (typeof value !== 'string') throw new Error('Missing session cookie');
  return value.split(';', 1)[0] ?? '';
}

async function login(username: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return cookie(response);
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

describe('M3 player views', () => {
  it('projects army intelligence and enforces preview permissions', async () => {
    const host = await auth.createDevelopmentUser({
      username: 'm3-host',
      displayName: 'Host',
      password: 'host-password-123',
    });
    const playerA = await auth.createDevelopmentUser({
      username: 'm3-player-a',
      displayName: 'Player A',
      password: 'player-a-password-123',
    });
    const playerB = await auth.createDevelopmentUser({
      username: 'm3-player-b',
      displayName: 'Player B',
      password: 'player-b-password-123',
    });
    const observer = await auth.createDevelopmentUser({
      username: 'm3-observer',
      displayName: 'Observer',
      password: 'observer-password-123',
    });
    const game = await games.create({
      userId: host.id,
      name: 'Perception Test',
      countryNames: ['Kandy', 'Jaffna'],
    });
    await world.initializeDevelopmentMap(game.id, host.id);
    const countries = await database.query<{ id: string }>(
      'SELECT id FROM countries WHERE game_id = $1 ORDER BY created_at, id',
      [game.id],
    );
    const memberships = [
      [playerA.id, 'Player', countries.rows[0]!.id],
      [playerB.id, 'Player', countries.rows[1]!.id],
      [observer.id, 'Observer', null],
    ] as const;
    for (const [userId, role, countryId] of memberships) {
      await database.query(
        `INSERT INTO game_members (
           id, game_id, user_id, role, status, controlled_country_id
         ) VALUES (gen_random_uuid(), $1, $2, $3, 'Active', $4)`,
        [game.id, userId, role, countryId],
      );
    }

    const [hostCookie, playerACookie, playerBCookie, observerCookie] =
      await Promise.all([
        login('m3-host', 'host-password-123'),
        login('m3-player-a', 'player-a-password-123'),
        login('m3-player-b', 'player-b-password-123'),
        login('m3-observer', 'observer-password-123'),
      ]);
    const path = `/api/v1/games/${game.id}/map/viewport?minQ=0&maxQ=11&minR=0&maxR=7`;
    const requestView = async (session: string, suffix = '') => {
      const response = await app.inject({
        method: 'GET',
        url: `${path}${suffix}`,
        headers: { cookie: session },
      });
      return response;
    };
    const armyFrom = (response: Awaited<ReturnType<typeof requestView>>) =>
      response
        .json()
        .data.tiles.flatMap((tile: { armies: unknown[] }) => tile.armies)[0];

    const truth = await requestView(hostCookie);
    const own = await requestView(playerACookie);
    const informedEnemy = await requestView(playerBCookie);
    const publicView = await requestView(observerCookie);
    expect(armyFrom(truth).strength).toEqual({ kind: 'Exact', value: 1200 });
    expect(armyFrom(own).strength).toEqual({ kind: 'Exact', value: 1200 });
    expect(armyFrom(informedEnemy).strength).toEqual({
      kind: 'Range',
      min: 900,
      max: 1500,
    });
    expect(armyFrom(publicView)).toBeUndefined();

    const playerBMember = await database.query<{ id: string }>(
      'SELECT id FROM game_members WHERE game_id = $1 AND user_id = $2',
      [game.id, playerB.id],
    );
    const previewSuffix = `&previewMemberId=${playerBMember.rows[0]!.id}`;
    const preview = await requestView(hostCookie, previewSuffix);
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.tiles).toEqual(informedEnemy.json().data.tiles);
    expect(preview.json().data.viewMode).toBe('Preview');

    const forbiddenPreview = await requestView(playerACookie, previewSuffix);
    expect(forbiddenPreview.statusCode).toBe(403);
    expect(forbiddenPreview.json().error.code).toBe(
      'PLAYER_VIEW_PREVIEW_FORBIDDEN',
    );

    await database.query(
      'DELETE FROM country_army_intelligence WHERE game_id = $1 AND country_id = $2',
      [game.id, countries.rows[1]!.id],
    );
    const hiddenSearch = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/map/search?q=Central%20Guard`,
      headers: { cookie: playerBCookie },
    });
    expect(hiddenSearch.statusCode).toBe(200);
    expect(hiddenSearch.json().data).toEqual([]);
    const uninformed = await requestView(playerBCookie);
    expect(armyFrom(uninformed)).toBeUndefined();
    expect(JSON.stringify(uninformed.json())).not.toContain('1200');
  });
});
