import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';
import { CountryService } from './modules/games/country-service.js';

const database = createDatabasePool(
  loadServiceConfig({ ...process.env, NODE_ENV: 'test' }).databaseUrl,
);
const auth = new AuthService(database);
const games = new GameService(database);
const world = new WorldService(database);
const countries = new CountryService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  world,
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let hostId: string, playerId: string, hostCookie: string, playerCookie: string;
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'opening-host',
    'opening-player',
    'opening-other',
    'opening-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'opening-password-2026',
      }),
    );
  hostId = users[0]!.id;
  playerId = users[1]!.id;
  const cookie = async (username: string) =>
    String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'opening-password-2026' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  [hostCookie, playerCookie] = await Promise.all([
    cookie('opening-host'),
    cookie('opening-player'),
  ]);
});
afterAll(async () => {
  await app.close();
  await database.end();
});
async function create() {
  return games.create({
    userId: hostId,
    name: '诸国开局',
    countryNames: ['北国', '南国', '海国'],
  });
}
async function assign(
  gameId: string,
  username = 'opening-player',
  countryIndex = 0,
) {
  const member = await games.addMember({
    gameId,
    actorUserId: hostId,
    username,
    role: 'Player',
  });
  return games.assignCountry({
    gameId,
    actorUserId: hostId,
    memberId: member.id,
    countryId: (await games.listCountries(gameId, hostId))[countryIndex]!.id,
  });
}
async function opening(gameId: string, cookie = hostCookie) {
  const prep = await games.getPreparation(gameId, hostId);
  return app.inject({
    method: 'POST',
    url: `/api/v1/games/${gameId}/preparation/open`,
    headers: { cookie },
    payload: { quarterId: prep.quarter.id, expectedRevision: prep.revision },
  });
}
describe('new game and reviewed opening', () => {
  it('replays creation safely and preserves the single active game constraint', async () => {
    const payload = {
      name: '诸国时代',
      countryNames: ['北国', '南国', '海国'],
      creationId: randomUUID(),
    };
    const send = (body = payload, cookie = hostCookie) =>
      app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: { cookie },
        payload: body,
      });
    const results = await Promise.all([send(), send()]);
    expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
    expect(results[0]!.json().data.id).toBe(results[1]!.json().data.id);
    expect((await database.query('SELECT * FROM countries')).rowCount).toBe(3);
    expect(
      (await send({ ...payload, name: '不同内容' })).json().error.code,
    ).toBe('CREATION_REQUEST_CONFLICT');
    expect(
      (await send({ ...payload, creationId: randomUUID() })).json().error.code,
    ).toBe('ACTIVE_GAME_ALREADY_EXISTS');
    expect((await send(payload, playerCookie)).json().error.code).toBe(
      'ACTIVE_GAME_ALREADY_EXISTS',
    );
  });
  it('restricts preparation details and opening to the host', async () => {
    const game = await create();
    await assign(game.id);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/games/${game.id}/preparation`,
          headers: { cookie: playerCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect((await opening(game.id, playerCookie)).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/games/${game.id}/preparation`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/games/${game.id}/preparation/open`,
          headers: { cookie: hostCookie },
          payload: { quarterId: 'bad', expectedRevision: 'bad' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('requires assigned players while allowing empty optional settings, NPC countries and observers', async () => {
    const game = await create();
    expect((await opening(game.id)).json().error.code).toBe(
      'PREPARATION_INCOMPLETE',
    );
    await games.addMember({
      gameId: game.id,
      actorUserId: hostId,
      username: 'opening-player',
      role: 'Player',
    });
    let prep = await games.getPreparation(game.id, hostId);
    expect(prep.unassignedPlayers).toHaveLength(1);
    await assign(game.id);
    await games.addMember({
      gameId: game.id,
      actorUserId: hostId,
      username: 'opening-observer',
      role: 'Observer',
    });
    prep = await games.getPreparation(game.id, hostId);
    expect(prep).toMatchObject({
      canOpen: true,
      playerCount: 1,
      countryCount: 3,
      map: null,
      rulesSaved: false,
      resourceCountryCount: 0,
      automaticEconomy: false,
      governmentCountryCount: 0,
    });
    expect((await opening(game.id)).statusCode).toBe(200);
    expect(
      (await games.getForUser(game.id, playerId)).currentQuarter.state,
    ).toBe('ActionSubmission');
  });
  it('reports saved map, rules and partially adjusted balances accurately', async () => {
    const game = await create();
    await assign(game.id);
    const countryId = (await games.listCountries(game.id, hostId))[0]!.id;
    await countries.setBalances(game.id, hostId, countryId, {
      expectedRevision: 0,
      treasury: 100,
      manpower: 0,
      reason: '初始国库',
    });
    await world.setup.create(game.id, hostId, {
      name: '三国地图',
      width: 3,
      height: 2,
    });
    const rules = await games.getRules(game.id, hostId);
    await games.updateRules({
      gameId: game.id,
      userId: hostId,
      quarterId: rules.quarterId,
      expectedVersion: rules.version,
      scenario: { ...rules.scenario, title: '诸国时代' },
      quarter: rules.quarter,
    });
    expect(await games.getPreparation(game.id, hostId)).toMatchObject({
      rulesSaved: true,
      map: { name: '三国地图', tileCount: 6, controlledTileCount: 0 },
      resourceCountryCount: 1,
    });
  });
  it('rejects changed preparation without freezing an economic snapshot', async () => {
    const game = await create();
    await assign(game.id);
    const prep = await games.getPreparation(game.id, hostId);
    await assign(game.id, 'opening-other', 1);
    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/preparation/open`,
      headers: { cookie: hostCookie },
      payload: { quarterId: prep.quarter.id, expectedRevision: prep.revision },
    });
    expect(result.json().error.code).toBe('PREPARATION_CHANGED');
    expect(
      (
        await database.query(
          'SELECT state,economic_snapshot FROM quarters WHERE id=$1',
          [prep.quarter.id],
        )
      ).rows[0],
    ).toEqual({ state: 'Preparing', economic_snapshot: null });
  });
  it('opens once under concurrent retries and preserves its first economic snapshot', async () => {
    const game = await create();
    await assign(game.id);
    const prep = await games.getPreparation(game.id, hostId);
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/v1/games/${game.id}/preparation/open`,
        headers: { cookie: hostCookie },
        payload: {
          quarterId: prep.quarter.id,
          expectedRevision: prep.revision,
        },
      });
    const results = await Promise.all([send(), send()]);
    expect(results.map((result) => result.statusCode)).toEqual([200, 200]);
    const snapshot = (
      await database.query(
        'SELECT economic_snapshot FROM quarters WHERE id=$1',
        [prep.quarter.id],
      )
    ).rows[0].economic_snapshot;
    expect(snapshot.rules.enabled).toBe(false);
    expect((await send()).statusCode).toBe(200);
    expect(
      (
        await database.query(
          'SELECT economic_snapshot FROM quarters WHERE id=$1',
          [prep.quarter.id],
        )
      ).rows[0].economic_snapshot,
    ).toEqual(snapshot);
    expect(
      (
        await database.query(
          'SELECT * FROM quarter_state_history WHERE quarter_id=$1',
          [prep.quarter.id],
        )
      ).rowCount,
    ).toBe(1);
    expect((await games.getForUser(game.id, hostId)).status).toBe('Running');
  });
  it('does not use the opening entry to reopen a locked or different quarter', async () => {
    const game = await create();
    await assign(game.id);
    await opening(game.id);
    await games.transitionCurrentQuarter({
      gameId: game.id,
      userId: hostId,
      state: 'Locked',
    });
    expect((await opening(game.id)).statusCode).toBe(409);
    const prep = await games.getPreparation(game.id, hostId);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v1/games/${game.id}/preparation/open`,
          headers: { cookie: hostCookie },
          payload: { quarterId: randomUUID(), expectedRevision: prep.revision },
        })
      ).json().error.code,
    ).toBe('QUARTER_CHANGED');
  });
});
