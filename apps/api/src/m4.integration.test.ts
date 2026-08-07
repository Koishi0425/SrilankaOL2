import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadServiceConfig } from '@srilanka/config';
import { checkDatabase, createDatabasePool } from '@srilanka/database';
import { createClient } from 'redis';

import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { CommunicationService } from './modules/communications/communication-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const redis = createClient({ url: config.redisUrl });
const auth = new AuthService(database);
const games = new GameService(database);
const world = new WorldService(database);
const actions = new ActionService(database);
const communications = new CommunicationService(database);
const app = await buildApp({
  health: {
    checkDatabase: () => checkDatabase(database),
    checkRedis: async () => void (await redis.ping()),
  },
  auth,
  games,
  world,
  actions,
  communications,
});

function sessionCookie(response: { headers: Record<string, unknown> }) {
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

describe('M4 actions and communications', () => {
  it('preserves action history, rejects stale writes, and isolates conversations', async () => {
    const host = await auth.createDevelopmentUser({
      username: 'm4-host',
      displayName: 'Host',
      password: 'host-password-123',
    });
    const playerA = await auth.createDevelopmentUser({
      username: 'm4-a',
      displayName: 'Player A',
      password: 'player-a-password-123',
    });
    const playerB = await auth.createDevelopmentUser({
      username: 'm4-b',
      displayName: 'Player B',
      password: 'player-b-password-123',
    });
    const observer = await auth.createDevelopmentUser({
      username: 'm4-observer',
      displayName: 'Observer',
      password: 'observer-password-123',
    });
    const game = await games.create({
      userId: host.id,
      name: 'M4 Test',
      countryNames: ['Kandy', 'Jaffna'],
    });
    await world.initializeDevelopmentMap(game.id, host.id);
    const countries = await database.query<{ id: string }>(
      'SELECT id FROM countries WHERE game_id = $1 ORDER BY created_at, id',
      [game.id],
    );
    const members = [
      [playerA.id, 'Player', countries.rows[0]!.id],
      [playerB.id, 'Player', countries.rows[1]!.id],
      [observer.id, 'Observer', null],
    ] as const;
    for (const [userId, role, countryId] of members) {
      await database.query(
        `INSERT INTO game_members (
           id, game_id, user_id, role, status, controlled_country_id
         ) VALUES (gen_random_uuid(), $1, $2, $3, 'Active', $4)`,
        [game.id, userId, role, countryId],
      );
    }
    const [hostCookie, aCookie, bCookie, observerCookie] = await Promise.all([
      login('m4-host', 'host-password-123'),
      login('m4-a', 'player-a-password-123'),
      login('m4-b', 'player-b-password-123'),
      login('m4-observer', 'observer-password-123'),
    ]);
    const quarter = await games.transitionCurrentQuarter({
      gameId: game.id,
      userId: host.id,
      state: 'ActionSubmission',
    });
    const tile = await database.query<{ id: string }>(
      'SELECT id FROM hex_tiles WHERE game_id = $1 ORDER BY r, q LIMIT 1',
      [game.id],
    );

    const created = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/actions`,
      headers: { cookie: aCookie },
      payload: {
        quarterId: quarter.id,
        title: 'Secure the road',
        originalText: 'First immutable player text',
        category: 'Military',
        secrecy: 'OwnerOnly',
        refs: [
          {
            refKind: 'Target',
            objectType: 'Tile',
            objectId: tile.rows[0]!.id,
            label: 'Road tile',
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const actionId = created.json().data.id as string;

    const saved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${game.id}/actions/${actionId}`,
      headers: { cookie: aCookie },
      payload: {
        expectedVersion: 1,
        title: 'Secure the northern road',
        originalText: 'First immutable player text',
        category: 'Military',
        secrecy: 'OwnerOnly',
        refs: [
          {
            refKind: 'Target',
            objectType: 'Tile',
            objectId: tile.rows[0]!.id,
            label: 'Road tile · coordinates 0,0',
          },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.version).toBe(2);
    expect(saved.json().data.refs[0].label).toBe('Road tile · coordinates 0,0');

    const versionsAfterAutosave = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/actions/${actionId}/versions`,
      headers: { cookie: aCookie },
    });
    expect(versionsAfterAutosave.statusCode).toBe(200);
    expect(
      versionsAfterAutosave
        .json()
        .data.map(({ version }: { version: number }) => version),
    ).toEqual([1]);

    const manuallySaved = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/actions/${actionId}/versions`,
      headers: { cookie: aCookie },
      payload: { expectedVersion: 2 },
    });
    expect(manuallySaved.statusCode).toBe(201);
    expect(
      manuallySaved
        .json()
        .data.map(({ version }: { version: number }) => version),
    ).toEqual([2, 1]);

    const stale = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${game.id}/actions/${actionId}`,
      headers: { cookie: aCookie },
      payload: {
        expectedVersion: 1,
        title: 'Stale overwrite',
        originalText: 'must not win',
        category: 'Custom',
        secrecy: 'OwnerOnly',
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ACTION_VERSION_CONFLICT');

    const hidden = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/actions/${actionId}`,
      headers: { cookie: bCookie },
    });
    expect(hidden.statusCode).toBe(404);

    const idempotencyKey = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const submitted = await app.inject({
        method: 'POST',
        url: `/api/v1/games/${game.id}/actions/${actionId}/submit`,
        headers: { cookie: aCookie },
        payload: { idempotencyKey },
      });
      expect(submitted.statusCode).toBe(200);
    }
    const submitHistory = await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM action_status_history
       WHERE action_id = $1 AND to_status = 'Submitted'`,
      [actionId],
    );
    expect(Number(submitHistory.rows[0]!.count)).toBe(1);

    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/host/actions/${actionId}/request-input`,
      headers: { cookie: hostCookie },
      payload: { reason: '请补充投入规模。' },
    });
    expect(requested.statusCode).toBe(200);
    expect(requested.json().data.pendingInputRequest).toBe('请补充投入规模。');

    const amended = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${game.id}/actions/${actionId}`,
      headers: { cookie: aCookie },
      payload: {
        expectedVersion: 2,
        title: 'Secure the northern road',
        originalText: 'Amended with two companies',
        category: 'Military',
        secrecy: 'OwnerOnly',
      },
    });
    expect(amended.statusCode).toBe(200);
    const resubmitted = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/actions/${actionId}/submit`,
      headers: { cookie: aCookie },
      payload: { idempotencyKey: crypto.randomUUID() },
    });
    expect(resubmitted.statusCode).toBe(200);
    expect(resubmitted.json().data.submittedOriginalText).toBe(
      'First immutable player text',
    );

    const interpreted = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/host/actions/${actionId}/interpretations`,
      headers: { cookie: hostCookie },
      payload: { text: 'Host interpretation kept separately.' },
    });
    expect(interpreted.statusCode).toBe(201);
    expect(interpreted.json().data.submittedOriginalText).toBe(
      'First immutable player text',
    );

    const conversation = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/conversations`,
      headers: { cookie: aCookie },
      payload: {
        type: 'BilateralDiplomacy',
        title: 'Border talks',
        participantCountryIds: [countries.rows[1]!.id],
      },
    });
    expect(conversation.statusCode).toBe(201);
    const conversationId = conversation.json().data.id as string;
    const forbiddenMessages = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/conversations/${conversationId}/messages`,
      headers: { cookie: observerCookie },
    });
    expect(forbiddenMessages.statusCode).toBe(404);

    const clientMessageId = crypto.randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sent = await app.inject({
        method: 'POST',
        url: `/api/v1/games/${game.id}/conversations/${conversationId}/messages`,
        headers: { cookie: aCookie },
        payload: { content: 'Private proposal', clientMessageId },
      });
      expect(sent.statusCode).toBe(201);
    }
    const messageCount = await database.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM messages WHERE conversation_id = $1',
      [conversationId],
    );
    expect(Number(messageCount.rows[0]!.count)).toBe(1);
    const received = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${game.id}/conversations/${conversationId}/messages`,
      headers: { cookie: bCookie },
    });
    expect(received.statusCode).toBe(200);
    expect(received.json().data.items[0].content).toBe('Private proposal');

    const secondDraft = await app.inject({
      method: 'POST',
      url: `/api/v1/games/${game.id}/actions`,
      headers: { cookie: aCookie },
      payload: {
        quarterId: quarter.id,
        title: 'Locked draft',
        originalText: 'Cannot change after lock',
        category: 'Custom',
        secrecy: 'OwnerOnly',
        refs: [],
      },
    });
    await games.transitionCurrentQuarter({
      gameId: game.id,
      userId: host.id,
      state: 'Locked',
    });
    const lockedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${game.id}/actions/${secondDraft.json().data.id}`,
      headers: { cookie: aCookie },
      payload: {
        expectedVersion: 1,
        title: 'Should fail',
        originalText: 'Should fail',
        category: 'Custom',
        secrecy: 'OwnerOnly',
      },
    });
    expect(lockedUpdate.statusCode).toBe(409);
    expect(lockedUpdate.json().error.code).toBe('ACTION_SUBMISSION_LOCKED');

    await games.transitionCurrentQuarter({
      gameId: game.id,
      userId: host.id,
      state: 'HostReview',
    });
    const reopened = await games.transitionCurrentQuarter({
      gameId: game.id,
      userId: host.id,
      state: 'ActionSubmission',
    });
    expect(reopened.state).toBe('ActionSubmission');
    const reopenedAction = await actions.get(game.id, playerA.id, actionId);
    expect(reopenedAction.status).toBe('Submitted');

    const reopenedUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${game.id}/actions/${secondDraft.json().data.id}`,
      headers: { cookie: aCookie },
      payload: {
        expectedVersion: 1,
        title: 'Editable after reopening',
        originalText: 'The host reopened policy submission',
        category: 'Policy',
        secrecy: 'OwnerOnly',
      },
    });
    expect(reopenedUpdate.statusCode).toBe(200);
  });
});
