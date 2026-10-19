import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';

import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database);
const games = new GameService(database);
const actions = new ActionService(database);
const settlements = new SettlementService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  actions,
  settlements,
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});

let gameId: string;
let quarterId: string;
let hostId: string;
let playerId: string;
let otherId: string;
let hostCookie: string;
let playerCookie: string;
let otherCookie: string;
let observerCookie: string;

async function login(username: string) {
  const reply = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: 'settlement-test-password' },
  });
  expect(reply.statusCode).toBe(200);
  return String(reply.headers['set-cookie']).split(';')[0]!;
}

beforeAll(async () => {
  await database.query('SELECT 1');
});
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions, game_members, quarters, countries, games, users CASCADE',
  );
  const users = [];
  for (const username of [
    'settle-host',
    'settle-player',
    'settle-other',
    'settle-observer',
  ]) {
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'settlement-test-password',
      }),
    );
  }
  hostId = users[0]!.id;
  playerId = users[1]!.id;
  otherId = users[2]!.id;
  const game = await games.create({
    userId: hostId,
    name: '诸国时代',
    countryNames: ['康提', '贾夫纳'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const a = await games.addMember({
    gameId,
    actorUserId: hostId,
    username: users[1]!.username,
    role: 'Player',
  });
  const b = await games.addMember({
    gameId,
    actorUserId: hostId,
    username: users[2]!.username,
    role: 'Player',
  });
  await games.addMember({
    gameId,
    actorUserId: hostId,
    username: users[3]!.username,
    role: 'Observer',
  });
  const countries = await games.listCountries(gameId, hostId);
  await games.assignCountry({
    gameId,
    actorUserId: hostId,
    memberId: a.id,
    countryId: countries[0]!.id,
  });
  await games.assignCountry({
    gameId,
    actorUserId: hostId,
    memberId: b.id,
    countryId: countries[1]!.id,
  });
  const cookies = await Promise.all(users.map((user) => login(user.username)));
  hostCookie = cookies[0]!;
  playerCookie = cookies[1]!;
  otherCookie = cookies[2]!;
  observerCookie = cookies[3]!;
});
afterAll(async () => {
  await app.close();
  await database.end();
});

async function request(
  operation: '' | '/begin' | '/publish' | '/advance' = '',
  cookie = hostCookie,
  payload?: Record<string, unknown>,
  method: 'GET' | 'POST' | 'PUT' = operation ? 'POST' : 'GET',
) {
  return app.inject({
    method,
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement${operation}`,
    headers: { cookie },
    payload,
  });
}

async function submitted(
  userId: string,
  title: string,
  secrecy: 'OwnerOnly' | 'Public' = 'OwnerOnly',
) {
  const action = await actions.create({
    gameId,
    userId,
    quarterId,
    title,
    originalText: `${title}的原文`,
    category: 'Exploration',
    secrecy,
    refs: [],
  });
  return actions.submit({
    gameId,
    userId,
    actionId: action.id,
    idempotencyKey: crypto.randomUUID(),
  });
}

async function review() {
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'Locked',
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'HostReview',
  });
}

describe('quarter settlement and publication', () => {
  it('requires a checkpoint before publishing, rolls back failures and skips duplicate or unauthorized requests', async () => {
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    await review();
    await settlements.begin(gameId, hostId, quarterId);
    const draft = await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 1,
      publicReport: '存档测试。',
      results: [],
    });
    const checkpoint = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('Disk unavailable'))
      .mockResolvedValue(undefined);
    const protectedService = new SettlementService(database, checkpoint);
    await expect(
      protectedService.publish(gameId, playerId, quarterId, draft.version),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(checkpoint).not.toHaveBeenCalled();
    await expect(
      protectedService.publish(gameId, hostId, quarterId, draft.version),
    ).rejects.toThrow('Disk unavailable');
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
    expect(
      (
        await database.query('SELECT state FROM quarters WHERE id=$1', [
          quarterId,
        ])
      ).rows[0]!.state,
    ).toBe('Resolving');
    await protectedService.publish(gameId, hostId, quarterId, draft.version);
    await protectedService.publish(gameId, hostId, quarterId, draft.version);
    expect(checkpoint).toHaveBeenCalledTimes(2);
    expect(checkpoint).toHaveBeenLastCalledWith({
      gameId,
      quarterId,
      version: draft.version,
    });
  });

  it('freezes review, publishes all feedback privately, preserves snapshots and advances exactly once', async () => {
    await database.query(
      "UPDATE quarters SET game_year = 4, season = 'Winter' WHERE id = $1",
      [quarterId],
    );
    const rules = await games.getRules(gameId, hostId);
    await games.updateRules({
      gameId,
      userId: hostId,
      ...rules,
      expectedVersion: rules.version,
      quarter: {
        briefing: '冬季公告',
        actionGuidelines: '说明投入',
        suggestedLimits: [{ category: 'Exploration', limit: 1 }],
      },
    });
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const a = await submitted(playerId, '北方探索');
    const b = await submitted(otherId, '招募计划', 'Public');
    const unused = await actions.create({
      gameId,
      userId: playerId,
      quarterId,
      title: '未提交草稿',
      originalText: '尚未确定',
      category: 'Custom',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    await review();
    expect((await request('/begin')).json().error.code).toBe(
      'ACTION_REVIEW_INCOMPLETE',
    );
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: a.id,
      target: 'NeedPlayerInput',
      reason: '补充人数',
    });
    await actions.update({
      gameId,
      userId: playerId,
      actionId: a.id,
      expectedVersion: a.version,
      title: a.title,
      originalText: '派出三十人探索北方',
      category: a.category,
      secrecy: a.secrecy,
    });
    expect((await request('/begin')).statusCode).toBe(409);
    await actions.submit({
      gameId,
      userId: playerId,
      actionId: a.id,
      idempotencyKey: crypto.randomUUID(),
    });
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: a.id,
      target: 'Approved',
      reason: '可以执行',
    });
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: b.id,
      target: 'Rejected',
      reason: '粮草不足',
    });
    expect((await request('/begin', playerCookie)).statusCode).toBe(403);
    const begun = await request('/begin');
    expect(begun.statusCode).toBe(200);
    expect(
      begun
        .json()
        .data.actions.find(
          (item: { actionId: string }) => item.actionId === a.id,
        ).submittedText,
    ).toBe('派出三十人探索北方');
    expect((await request('/begin')).json().data.version).toBe(1);
    await expect(
      actions.hostInterpret({
        gameId,
        userId: hostId,
        actionId: a.id,
        text: '结算途中修改',
      }),
    ).rejects.toMatchObject({ code: 'ACTION_REVIEW_LOCKED' });
    await expect(
      actions.hostTransition({
        gameId,
        userId: hostId,
        actionId: b.id,
        target: 'Approved',
        reason: '改判',
      }),
    ).rejects.toMatchObject({ code: 'ACTION_REVIEW_LOCKED' });
    await expect(
      games.transitionCurrentQuarter({
        gameId,
        userId: hostId,
        state: 'ActionSubmission',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_QUARTER_TRANSITION' });
    expect((await request('/advance')).statusCode).toBe(409);
    const missing = await request('/publish', hostCookie, {
      expectedVersion: 1,
    });
    expect(missing.json().error.code).toBe('SETTLEMENT_INCOMPLETE');
    expect((await actions.get(gameId, hostId, a.id)).status).toBe('Approved');

    const payload = {
      expectedVersion: 1,
      publicReport: '诸国度过寒冬。',
      results: [
        {
          actionId: a.id,
          feedback: '山谷里发现一处铜矿。此消息只有本国知道。',
        },
        { actionId: b.id, feedback: '粮仓空虚，招募计划暂缓。' },
      ],
    };
    const saved = await request('', hostCookie, payload, 'PUT');
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.version).toBe(2);
    expect(
      (await request('', hostCookie, payload, 'PUT')).json().error.code,
    ).toBe('SETTLEMENT_VERSION_CONFLICT');
    const hidden = (await request('', playerCookie)).json().data;
    expect(hidden.actions).toEqual([]);
    expect(hidden.publicReport).toBe('');
    expect(hidden.version).toBe(0);
    expect(
      (await request('/publish', playerCookie, { expectedVersion: 2 }))
        .statusCode,
    ).toBe(403);
    const published = await request('/publish', hostCookie, {
      expectedVersion: 2,
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().data.quarter.state).toBe('Published');
    expect(
      (await request('/publish', hostCookie, { expectedVersion: 2 })).json()
        .data.publishedAt,
    ).toBe(published.json().data.publishedAt);
    expect(
      (
        await request('', hostCookie, { ...payload, expectedVersion: 2 }, 'PUT')
      ).json().error.code,
    ).toBe('SETTLEMENT_LOCKED');
    const visibleA = (await request('', playerCookie)).json().data;
    const visibleB = (await request('', otherCookie)).json().data;
    expect(
      visibleA.actions.map((item: { actionId: string }) => item.actionId),
    ).toEqual([a.id]);
    expect(
      visibleB.actions.map((item: { actionId: string }) => item.actionId),
    ).toEqual([b.id]);
    expect(visibleB.actions[0].feedback).not.toContain('铜矿');
    const observer = (await request('', observerCookie)).json().data;
    expect(observer.publicReport).toBe(payload.publicReport);
    expect(observer.actions).toEqual([]);
    expect((await actions.get(gameId, hostId, a.id)).status).toBe('Completed');
    expect((await actions.get(gameId, hostId, b.id)).status).toBe('Rejected');
    const advanced = await request('/advance');
    expect(advanced.statusCode).toBe(200);
    const next = advanced.json().data;
    expect(next).toMatchObject({
      gameYear: 5,
      season: 'Spring',
      sequenceNumber: 2,
      state: 'Preparing',
    });
    expect((await request('/advance')).json().data.id).toBe(next.id);
    expect((await actions.get(gameId, hostId, unused.id)).status).toBe(
      'Invalidated',
    );
    expect(await actions.list(gameId, hostId, true)).toEqual([]);
    expect((await settlements.list(gameId, playerId)).length).toBe(2);
    expect(
      (await request('', playerCookie)).json().data.actions[0].submittedText,
    ).toBe('派出三十人探索北方');
    expect((await request('', playerCookie)).json().data.quarter.state).toBe(
      'Completed',
    );
    const nextRules = await games.getRules(gameId, hostId);
    expect(nextRules.quarter).toEqual({
      briefing: '',
      actionGuidelines: '说明投入',
      suggestedLimits: [{ category: 'Exploration', limit: 1 }],
    });
    expect(nextRules.quarterId).toBe(next.id);
    expect(next.currentWorldVersion).toBe(0);
    const newDraft = await actions.create({
      gameId,
      userId: playerId,
      quarterId: next.id,
      title: '春季计划',
      originalText: '继续勘探',
      category: 'Exploration',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    await expect(
      actions.submit({
        gameId,
        userId: playerId,
        actionId: newDraft.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'ACTION_SUBMISSION_NOT_OPEN' });
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    expect(
      (
        await actions.submit({
          gameId,
          userId: playerId,
          actionId: newDraft.id,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe('Submitted');
    const currentCount = await database.query(
      'SELECT id FROM quarters WHERE game_id = $1 AND is_current',
      [gameId],
    );
    expect(currentCount.rowCount).toBe(1);
  });

  it('rejects foreign or duplicate actions and allows only one concurrent save', async () => {
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const action = await submitted(playerId, '筑路');
    await review();
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: action.id,
      target: 'Approved',
      reason: '同意',
    });
    await request('/begin');
    const result = { actionId: action.id, feedback: '道路通行。' };
    expect(
      (
        await request(
          '',
          hostCookie,
          { expectedVersion: 1, publicReport: '', results: [result, result] },
          'PUT',
        )
      ).json().error.code,
    ).toBe('INVALID_SETTLEMENT_ACTION');
    expect(
      (
        await request(
          '',
          hostCookie,
          {
            expectedVersion: 1,
            publicReport: '',
            results: [{ actionId: crypto.randomUUID(), feedback: '其他回合' }],
          },
          'PUT',
        )
      ).statusCode,
    ).toBe(400);
    const responses = await Promise.all(
      ['甲', '乙'].map((text) =>
        request(
          '',
          hostCookie,
          { expectedVersion: 1, publicReport: text, results: [result] },
          'PUT',
        ),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const draft = (await request()).json().data;
    expect(draft.version).toBe(2);
    expect(draft.publicReport).toBe(
      responses.find((response) => response.statusCode === 200)!.json().data
        .publicReport,
    );
    await database.query("UPDATE games SET status = 'Archived' WHERE id = $1", [
      gameId,
    ]);
    const otherGame = await games.create({
      userId: hostId,
      name: '其他游戏',
      countryNames: [],
    });
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${otherGame.id}/quarters/${quarterId}/settlement`,
      headers: { cookie: hostCookie },
    });
    expect(foreign.statusCode).toBe(404);
    const outsider = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${otherGame.id}/settlements`,
      headers: { cookie: playerCookie },
    });
    expect(outsider.statusCode).toBe(404);
  });

  it('handles a round without submitted policies and requires a public report', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/settlements`,
    });
    expect(anonymous.statusCode).toBe(401);
    expect((await request('/begin')).statusCode).toBe(409);
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    await review();
    await request('/begin');
    expect(
      (await request('/publish', hostCookie, { expectedVersion: 1 }))
        .statusCode,
    ).toBe(409);
    await request(
      '',
      hostCookie,
      { expectedVersion: 1, publicReport: '本季无事。', results: [] },
      'PUT',
    );
    const published = await request('/publish', hostCookie, {
      expectedVersion: 2,
    });
    expect(published.statusCode).toBe(200);
    expect((await request('/advance')).json().data).toMatchObject({
      gameYear: 1,
      season: 'Summer',
    });
  });
});
