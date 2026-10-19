import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabasePool } from '@srilanka/database';
import type { EndGameInput, GameDetails } from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { CommunicationService } from './modules/communications/communication-service.js';
import { WorldService } from './modules/world/world-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';

if (
  !process.env.DATABASE_URL ||
  !new URL(process.env.DATABASE_URL).pathname.endsWith('/srilanka_test')
)
  throw new Error(
    'Lifecycle tests require the isolated srilanka_test database.',
  );
const database = createDatabasePool(process.env.DATABASE_URL);
const auth = new AuthService(database),
  games = new GameService(database),
  actions = new ActionService(database),
  communications = new CommunicationService(database),
  world = new WorldService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  actions,
  communications,
  world,
  settlements: new SettlementService(database),
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let game: GameDetails;
let hostId: string, playerId: string;
let hostCookie: string, playerCookie: string, otherCookie: string;
let payload: EndGameInput;
beforeEach(async () => {
  await database.query('TRUNCATE users, games CASCADE');
  const users = [];
  const cookies = [];
  for (const username of ['ending-host', 'ending-player', 'ending-other']) {
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'lifecycle-test-password',
      }),
    );
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'lifecycle-test-password' },
    });
    expect(result.statusCode).toBe(200);
    cookies.push(String(result.headers['set-cookie']).split(';')[0]!);
  }
  [hostId, playerId] = users.map((user) => user.id) as [string, string, string];
  [hostCookie, playerCookie, otherCookie] = cookies as [string, string, string];
  game = await games.create({
    userId: hostId,
    name: '待结束的剧本',
    countryNames: ['甲国', '乙国'],
  });
  const member = await games.addMember({
    gameId: game.id,
    actorUserId: hostId,
    username: 'ending-player',
    role: 'Player',
  });
  const country = (await games.listCountries(game.id, hostId))[0]!;
  await games.assignCountry({
    gameId: game.id,
    actorUserId: hostId,
    memberId: member.id,
    countryId: country.id,
  });
  payload = {
    expectedQuarterId: game.currentQuarter.id,
    expectedQuarterState: game.currentQuarter.state,
    reason: '剧本落幕，保留历史。',
  };
});
afterAll(async () => {
  await app.close();
  await database.end();
});
const end = (cookie = hostCookie, input = payload) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/games/${game.id}/end`,
    headers: { cookie },
    payload: input,
  });

describe('game ending and history', () => {
  it('archives exactly once, preserves memberships and history, and releases the active game slot', async () => {
    const action = await actions.create({
      gameId: game.id,
      userId: playerId,
      quarterId: game.currentQuarter.id,
      title: '未公开的计划',
      originalText: '秘密外交',
      category: 'Diplomacy',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    const response = await end();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'Archived',
      endingReason: payload.reason,
      currentQuarter: game.currentQuarter,
    });
    expect(response.json().data.endedAt).toBeTruthy();
    expect((await end()).statusCode).toBe(200);
    expect(
      (
        await database.query(
          'SELECT * FROM game_lifecycle_history WHERE game_id=$1',
          [game.id],
        )
      ).rows,
    ).toHaveLength(1);
    expect((await games.listForUser(hostId))[0]?.id).toBe(game.id);
    expect((await games.listForUser(playerId))[0]?.id).toBe(game.id);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { cookie: playerCookie },
        })
      ).json().data.canCreateGame,
    ).toBe(true);
    const own = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/actions/${action.id}`,
      headers: { cookie: playerCookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.currentText).toBe('秘密外交');
    const next = await app.inject({
      method: 'POST',
      url: '/api/v1/games',
      headers: { cookie: hostCookie },
      payload: { name: '下一局', countryNames: ['新国'] },
    });
    expect(next.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { cookie: playerCookie },
        })
      ).json().data.canCreateGame,
    ).toBe(false);
    expect((await games.listForUser(hostId)).map((item) => item.id)).toEqual([
      next.json().data.id,
      game.id,
    ]);
    expect((await games.listForUser(playerId)).map((item) => item.id)).toEqual([
      game.id,
    ]);
    expect(
      (
        await database.query('SELECT current_text FROM actions WHERE id=$1', [
          action.id,
        ])
      ).rows[0]?.current_text,
    ).toBe('秘密外交');
  });

  it('requires a host, current stage and an ending reason', async () => {
    expect((await end(playerCookie)).statusCode).toBe(403);
    expect((await end(otherCookie)).statusCode).toBe(404);
    expect((await end('')).statusCode).toBe(401);
    expect(
      (await end(hostCookie, { ...payload, reason: ' ' })).statusCode,
    ).toBe(400);
    expect(
      (
        await end(hostCookie, { ...payload, expectedQuarterId: randomUUID() })
      ).json().error.code,
    ).toBe('QUARTER_CHANGED');
    expect(
      (
        await end(hostCookie, { ...payload, expectedQuarterState: 'Published' })
      ).json().error.code,
    ).toBe('QUARTER_CHANGED');
    expect((await games.getForUser(game.id, hostId)).status).toBe('Preparing');
  });

  it('refuses content changes through existing endpoints while allowing private history and read receipts', async () => {
    await world.initializeDevelopmentMap(game.id, hostId);
    const action = await actions.create({
      gameId: game.id,
      userId: playerId,
      quarterId: game.currentQuarter.id,
      title: '草稿',
      originalText: '原文',
      category: 'Custom',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    const conversation = await communications.openHost(game.id, playerId);
    await communications.send({
      gameId: game.id,
      userId: playerId,
      conversationId: conversation.id,
      content: '仅玩家与主持人的私聊',
      clientMessageId: randomUUID(),
    });
    const rules = await games.getRules(game.id, hostId);
    expect((await end()).statusCode).toBe(200);
    const writes = [
      {
        method: 'POST' as const,
        url: `/api/v1/games/${game.id}/members`,
        cookie: hostCookie,
        payload: { username: 'ending-other', role: 'Player' },
      },
      {
        method: 'PATCH' as const,
        url: `/api/v1/games/${game.id}/quarters/current/state`,
        cookie: hostCookie,
        payload: { state: 'ActionSubmission' },
      },
      {
        method: 'PUT' as const,
        url: `/api/v1/games/${game.id}/rules`,
        cookie: hostCookie,
        payload: {
          quarterId: rules.quarterId,
          expectedVersion: rules.version,
          scenario: rules.scenario,
          quarter: rules.quarter,
        },
      },
      {
        method: 'PATCH' as const,
        url: `/api/v1/games/${game.id}/actions/${action.id}`,
        cookie: playerCookie,
        payload: {
          expectedVersion: action.version,
          title: action.title,
          originalText: '试图篡改',
          category: action.category,
          secrecy: action.secrecy,
          refs: [],
        },
      },
      {
        method: 'POST' as const,
        url: `/api/v1/games/${game.id}/conversations/${conversation.id}/messages`,
        cookie: playerCookie,
        payload: { content: '结束后不能发送', clientMessageId: randomUUID() },
      },
    ];
    for (const write of writes) {
      const response = await app.inject({
        method: write.method,
        url: write.url,
        headers: { cookie: write.cookie },
        payload: write.payload,
      });
      expect(response.statusCode, write.url).toBe(409);
      expect(response.json().error.code, write.url).toBe('GAME_READ_ONLY');
    }
    for (const table of [
      'hex_tiles',
      'countries',
      'game_members',
      'quarters',
      'country_tile_knowledge',
    ]) {
      const column =
        table === 'countries'
          ? 'name'
          : table === 'game_members'
            ? 'role'
            : table === 'quarters'
              ? 'state'
              : table === 'hex_tiles'
                ? 'movement_cost'
                : 'confidence';
      await expect(
        database.query(
          `UPDATE ${table} SET ${column}=${column} WHERE game_id=$1`,
          [game.id],
        ),
      ).rejects.toMatchObject({ constraint: 'game_read_only' });
    }
    const messages = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/conversations/${conversation.id}/messages`,
      headers: { cookie: hostCookie },
    });
    expect(messages.statusCode).toBe(200);
    expect(messages.json().data.items[0]?.content).toBe('仅玩家与主持人的私聊');
    const privateHistory = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/conversations/${conversation.id}/messages`,
      headers: { cookie: otherCookie },
    });
    expect(privateHistory.statusCode).toBe(404);
    const map = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/map/viewport?minQ=0&maxQ=11&minR=0&maxR=7`,
      headers: { cookie: hostCookie },
    });
    expect(map.statusCode).toBe(200);
    expect(map.json().data.tiles).toHaveLength(96);
    await expect(
      database.query("UPDATE games SET status='Running' WHERE id=$1", [
        game.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'game_read_only' });
  });

  it('refuses to end while another transaction writes and allows retry without a deadlock', async () => {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE countries SET name=name WHERE game_id=$1', [
        game.id,
      ]);
      expect((await end()).json().error.code).toBe('GAME_BUSY');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [
        game.id,
      ]);
      expect((await end()).json().error.code).toBe('GAME_BUSY');
      await client.query('ROLLBACK');
      expect((await end()).statusCode).toBe(200);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects writes from an older repeatable-read snapshot after ending', async () => {
    const client = await database.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await client.query('SELECT * FROM countries WHERE game_id=$1', [game.id]);
      expect((await end()).statusCode).toBe(200);
      await expect(
        client.query('UPDATE countries SET name=name WHERE game_id=$1', [
          game.id,
        ]),
      ).rejects.toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
