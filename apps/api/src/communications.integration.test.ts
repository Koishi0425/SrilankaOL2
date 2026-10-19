import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { CommunicationService } from './modules/communications/communication-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database);
const games = new GameService(database);
const actions = new ActionService(database);
const communications = new CommunicationService(database);
const settlements = new SettlementService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  actions,
  communications,
  settlements,
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string, quarterId: string;
let hostId: string,
  playerId: string,
  otherId: string,
  playerMemberId: string,
  otherMemberId: string;
let hostCookie: string,
  playerCookie: string,
  otherCookie: string,
  observerCookie: string;

beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions, game_members, quarters, countries, games, users CASCADE',
  );
  const users = [];
  for (const username of [
    'chat-host',
    'chat-player',
    'chat-other',
    'chat-observer',
  ]) {
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'communication-test-password',
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
  const countries = await games.listCountries(gameId, hostId);
  for (let index = 1; index < users.length; index++) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: users[index]!.username,
      role: index === 3 ? 'Observer' : 'Player',
    });
    if (index < 3) {
      await games.assignCountry({
        gameId,
        actorUserId: hostId,
        memberId: member.id,
        countryId: countries[index - 1]!.id,
      });
      if (index === 1) playerMemberId = member.id;
      else otherMemberId = member.id;
    }
  }
  const cookies = [];
  for (const user of users) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        username: user.username,
        password: 'communication-test-password',
      },
    });
    expect(response.statusCode).toBe(200);
    cookies.push(String(response.headers['set-cookie']).split(';')[0]!);
  }
  [hostCookie, playerCookie, otherCookie, observerCookie] = cookies as [
    string,
    string,
    string,
    string,
  ];
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
});
afterAll(async () => {
  await app.close();
  await database.end();
});

async function call(
  path: string,
  cookie = playerCookie,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method: payload ? 'POST' : 'GET',
    url: `/api/v1/games/${gameId}/${path}`,
    headers: { cookie },
    payload,
  });
}
async function policy(userId = playerId) {
  const draft = await actions.create({
    gameId,
    userId,
    quarterId,
    title: '探索航路',
    originalText: '两船探索北方',
    category: 'Exploration',
    secrecy: 'Public',
    refs: [],
  });
  return actions.submit({
    gameId,
    userId,
    actionId: draft.id,
    idempotencyKey: crypto.randomUUID(),
  });
}
async function send(
  conversationId: string,
  content: string,
  userId = hostId,
  clientMessageId = crypto.randomUUID(),
) {
  return communications.send({
    gameId,
    conversationId,
    userId,
    content,
    clientMessageId,
  });
}

describe('host and policy communication', () => {
  it('does not mutate a former country policy after its author is assigned elsewhere', async () => {
    const a = await actions.create({
      gameId,
      userId: playerId,
      quarterId,
      title: '旧国原政策',
      originalText: '必须保持不变的原文',
      category: 'Custom',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    const otherCountry = (await games.listMembers(gameId, hostId)).find(
      (m) => m.id === otherMemberId,
    )!.controlledCountryId!;
    await games.assignCountry({
      gameId,
      actorUserId: hostId,
      memberId: playerMemberId,
      countryId: otherCountry,
    });
    const edit = await app.inject({
      method: 'PATCH',
      url: `/api/v1/games/${gameId}/actions/${a.id}`,
      headers: { cookie: playerCookie },
      payload: {
        expectedVersion: a.version,
        title: a.title,
        originalText: '换国后越权修改',
        category: a.category,
        secrecy: a.secrecy,
        refs: [],
      },
    });
    expect(edit.statusCode).toBe(404);
    expect(
      (
        await call(`actions/${a.id}/versions`, playerCookie, {
          expectedVersion: a.version,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(`actions/${a.id}/submit`, playerCookie, {
          idempotencyKey: crypto.randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await call(`actions/${a.id}/withdraw`, playerCookie, {})).statusCode,
    ).toBe(404);
    const original = (
      await database.query(
        'SELECT current_text,status,version FROM actions WHERE id=$1',
        [a.id],
      )
    ).rows[0];
    expect(original).toMatchObject({
      current_text: a.currentText,
      status: 'Draft',
      version: a.version,
    });
    expect(
      (
        await database.query(
          'SELECT COUNT(*)::int n FROM action_submissions WHERE action_id=$1',
          [a.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it('creates a single policy when concurrent retries reuse a creation id, including after submission closes', async () => {
    const creationId = crypto.randomUUID();
    const payload = {
      creationId,
      quarterId,
      title: '安全重试的政策',
      originalText: '服务器收到后响应断开，重试仍是同一份。',
      category: 'Exploration',
      secrecy: 'OwnerOnly',
      refs: [],
    };
    const replies = await Promise.all(
      Array.from({ length: 12 }, () => call('actions', playerCookie, payload)),
    );
    expect(replies.every((r) => r.statusCode === 201)).toBe(true);
    const id = replies[0]!.json().data.id as string;
    expect(new Set(replies.map((r) => r.json().data.id)).size).toBe(1);
    expect(await actions.list(gameId, playerId)).toHaveLength(1);
    const conflict = await call('actions', playerCookie, {
      ...payload,
      originalText: '重试时已改过的另一份内容',
    });
    expect(conflict.statusCode).toBe(409);
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'Locked',
    });
    const retry = await call('actions', playerCookie, payload);
    expect(retry.statusCode).toBe(201);
    expect(retry.json().data.id).toBe(id);
    expect((await call('actions', otherCookie, payload)).statusCode).toBe(409);
    const count = (
      await database.query(
        'SELECT COUNT(*)::int n FROM actions WHERE game_id=$1',
        [gameId],
      )
    ).rows[0].n;
    expect(count).toBe(1);
  });
  it('clears country control on becoming an observer and rejects legacy residual access', async () => {
    const a = await policy();
    const changed = await call('members', hostCookie, {
      username: 'chat-player',
      role: 'Observer',
    });
    expect(changed.statusCode).toBe(201);
    expect(changed.json().data.controlledCountryId).toBeNull();
    expect((await call('actions')).json().data).toEqual([]);
    // Older data must not bypass the role check, even if a country remains stored.
    await database.query(
      'UPDATE game_members SET controlled_country_id=$1 WHERE id=$2',
      [a.countryId, playerMemberId],
    );
    expect((await call('actions')).json().data).toEqual([]);
    expect((await call(`actions/${a.id}`)).statusCode).toBe(404);
    expect((await call(`actions/${a.id}/versions`)).statusCode).toBe(404);
    const rejected = await call('country-assignments', hostCookie, {
      memberId: playerMemberId,
      countryId: a.countryId,
    });
    expect(rejected.statusCode).toBe(404);
    await games.assignCountry({
      gameId,
      actorUserId: hostId,
      memberId: otherMemberId,
      countryId: a.countryId,
    });
    const conversation = await communications.create({
      gameId,
      userId: otherId,
      type: 'BilateralDiplomacy',
      title: '新任玩家的会谈',
      participantCountryIds: [a.countryId],
    });
    expect(
      (await call(`conversations/${conversation.id}/messages`)).statusCode,
    ).toBe(404);
  });
  it('can unassign an active player without transferring or exposing the old national policies', async () => {
    const a = await policy();
    const cleared = await call('country-assignments', hostCookie, {
      memberId: playerMemberId,
      countryId: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.controlledCountryId).toBeNull();
    expect((await call('actions')).json().data).toEqual([]);
    expect((await call(`actions/${a.id}`)).statusCode).toBe(404);
    const hostMember = (await games.listMembers(gameId, hostId)).find(
      (m) => m.role === 'Host',
    )!;
    expect(
      (
        await call('country-assignments', hostCookie, {
          memberId: hostMember.id,
          countryId: a.countryId,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call('country-assignments', playerCookie, {
          memberId: otherMemberId,
          countryId: a.countryId,
        })
      ).statusCode,
    ).toBe(403);
  });
  it('opens one private host channel concurrently and prevents inviting or impersonating another player', async () => {
    const replies = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('conversations/host', playerCookie, {}),
      ),
    );
    expect(replies.every((reply) => reply.statusCode === 200)).toBe(true);
    const id = replies[0]!.json().data.id as string;
    expect(new Set(replies.map((reply) => reply.json().data.id)).size).toBe(1);
    const hostOpen = await call('conversations/host', hostCookie, {
      memberId: playerMemberId,
    });
    expect(hostOpen.json().data.id).toBe(id);
    expect(
      (
        await call('conversations/host', playerCookie, {
          memberId: otherMemberId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('conversations', playerCookie, {
          type: 'HostPlayer',
          title: '不能混入别国',
          participantCountryIds: [
            (await games.listCountries(gameId, hostId))[1]!.id,
          ],
        })
      ).statusCode,
    ).toBe(400);
    await send(id, '主持人私聊');
    expect(
      (await call('conversations/' + id + '/messages', otherCookie)).statusCode,
    ).toBe(404);
    expect(
      (await call('conversations/' + id + '/messages', observerCookie))
        .statusCode,
    ).toBe(404);
    expect(
      (await communications.list(gameId, otherId)).some(
        (item) => item.id === id,
      ),
    ).toBe(false);
  });

  it('connects supplements, formal resubmission, settlement and historical discussion without exposing policies', async () => {
    const a = await policy();
    const b = await policy(otherId);
    const open = await call(
      'actions/' + a.id + '/conversation',
      playerCookie,
      {},
    );
    expect(open.statusCode).toBe(200);
    const conversationId = open.json().data.id as string;
    expect(open.json().data.linkedActionId).toBe(a.id);
    expect(
      (await call('actions/' + a.id + '/conversation', otherCookie, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (await call('actions/' + a.id + '/conversation', observerCookie, {}))
        .statusCode,
    ).toBe(404);
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
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: a.id,
      target: 'NeedPlayerInput',
      reason: '请说明补给安排。',
    });
    expect(
      (await communications.list(gameId, playerId)).find(
        (item) => item.id === conversationId,
      )!.unreadCount,
    ).toBe(1);
    const page = await call('conversations/' + conversationId + '/messages');
    expect(page.json().data.items[0].content).toContain('请说明补给安排');
    await send(conversationId, '会带三个月粮食', playerId);
    expect((await actions.get(gameId, playerId, a.id)).status).toBe(
      'NeedPlayerInput',
    );
    await actions.update({
      gameId,
      userId: playerId,
      actionId: a.id,
      expectedVersion: 1,
      title: a.title,
      originalText: '两船带三个月粮食探索北方',
      category: a.category,
      secrecy: a.secrecy,
    });
    await actions.submit({
      gameId,
      userId: playerId,
      actionId: a.id,
      idempotencyKey: crypto.randomUUID(),
    });
    for (const item of [a, b])
      await actions.hostTransition({
        gameId,
        userId: hostId,
        actionId: item.id,
        target: 'Approved',
        reason: '可以执行',
      });
    const base = 'quarters/' + quarterId + '/settlement';
    expect((await call(base + '/begin', hostCookie, {})).statusCode).toBe(200);
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/v1/games/${gameId}/${base}`,
      headers: { cookie: hostCookie },
      payload: {
        expectedVersion: 1,
        publicReport: '春季探索结束。',
        results: [
          { actionId: a.id, feedback: '北方发现海湾。' },
          { actionId: b.id, feedback: '发现草场。' },
        ],
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(
      (
        await call(base + '/publish', hostCookie, {
          expectedVersion: saved.json().data.version,
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(base + '/advance', hostCookie, {})).statusCode).toBe(
      200,
    );
    expect(
      (await call('actions/' + a.id + '/conversation', hostCookie, {})).json()
        .data.id,
    ).toBe(conversationId);
    await send(conversationId, '下回合可以在海湾建港吗？', playerId);
    expect(
      (await call(base))
        .json()
        .data.actions.map((item: { actionId: string }) => item.actionId),
    ).toEqual([a.id]);
    expect(
      (await call('conversations/' + conversationId + '/messages', otherCookie))
        .statusCode,
    ).toBe(404);
    await database.query(
      'UPDATE game_members SET controlled_country_id = NULL WHERE id = $1',
      [playerMemberId],
    );
    await database.query(
      'UPDATE game_members SET controlled_country_id = $1 WHERE id = $2',
      [a.countryId, otherMemberId],
    );
    expect(
      (
        await call(
          'conversations/' + conversationId + '/messages',
          playerCookie,
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await communications.list(gameId, playerId)).some(
        (item) => item.id === conversationId,
      ),
    ).toBe(false);
    expect(
      (await call('actions/' + a.id + '/conversation', otherCookie, {}))
        .statusCode,
    ).toBe(200);
  });

  it('reads only fetched messages, keeps unread while paging history, and rejects message-key conflicts', async () => {
    const conversation = await communications.openHost(gameId, playerId);
    const first = await send(conversation.id, '第一条');
    await communications.messages({
      gameId,
      userId: playerId,
      conversationId: conversation.id,
      limit: 50,
    });
    const second = await send(conversation.id, '第二条');
    const third = await send(conversation.id, '第三条');
    const page = await communications.messages({
      gameId,
      userId: playerId,
      conversationId: conversation.id,
      after: first.id,
      limit: 1,
    });
    expect(page.items.map((item) => item.id)).toEqual([second.id]);
    expect(page.nextCursor).toBe(second.id);
    expect((await communications.list(gameId, playerId))[0]!.unreadCount).toBe(
      1,
    );
    await communications.messages({
      gameId,
      userId: playerId,
      conversationId: conversation.id,
      cursor: second.id,
      limit: 50,
    });
    expect((await communications.list(gameId, playerId))[0]!.unreadCount).toBe(
      1,
    );
    const next = await communications.messages({
      gameId,
      userId: playerId,
      conversationId: conversation.id,
      after: second.id,
      limit: 100,
    });
    expect(next.items.map((item) => item.id)).toEqual([third.id]);
    expect((await communications.list(gameId, playerId))[0]!.unreadCount).toBe(
      0,
    );
    const key = crypto.randomUUID();
    const sent = await Promise.all([
      send(conversation.id, '只发送一次', playerId, key),
      send(conversation.id, '只发送一次', playerId, key),
    ]);
    expect(sent[0]!.id).toBe(sent[1]!.id);
    expect(
      (
        await call(
          'conversations/' + conversation.id + '/messages',
          hostCookie,
          { content: '冒用标识', clientMessageId: key },
        )
      ).statusCode,
    ).toBe(409);
    const count = await database.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM messages WHERE conversation_id = $1 AND client_message_id = $2',
      [conversation.id, key],
    );
    expect(Number(count.rows[0]!.count)).toBe(1);
    await database.query(
      "UPDATE messages SET sent_at = '2026-10-09T00:00:00.000000Z' WHERE id = $1",
      [first.id],
    );
    await database.query(
      "UPDATE messages SET sent_at = '2026-10-09T00:00:00.000001Z' WHERE id = $1",
      [second.id],
    );
    await database.query(
      "UPDATE messages SET sent_at = '2026-10-09T00:00:00.000002Z' WHERE id = $1",
      [third.id],
    );
    await database.query(
      'UPDATE conversation_participants SET last_read_at = (SELECT sent_at FROM messages WHERE id = $1), last_read_message_id = $1 WHERE conversation_id = $2 AND member_id = $3',
      [second.id, conversation.id, playerMemberId],
    );
    expect((await communications.list(gameId, playerId))[0]!.unreadCount).toBe(
      1,
    );
  });
  it('catches up a backlog in order without dropping messages past the page limit', async () => {
    const conversation = await communications.openHost(gameId, playerId);
    const first = await send(conversation.id, '起点');
    const hostMember = await database.query<{ id: string }>(
      'SELECT id FROM game_members WHERE game_id = $1 AND user_id = $2',
      [gameId, hostId],
    );
    await database.query(
      `INSERT INTO messages (id, game_id, conversation_id, sender_member_id, content, client_message_id, sent_at)
       SELECT gen_random_uuid(), $1, $2, $3, '消息 ' || n, gen_random_uuid(),
         (SELECT sent_at FROM messages WHERE id = $4) + n * INTERVAL '1 microsecond'
       FROM generate_series(1,150) n`,
      [gameId, conversation.id, hostMember.rows[0]!.id, first.id],
    );
    const firstPage = await communications.messages({
      gameId,
      userId: playerId,
      conversationId: conversation.id,
      after: first.id,
      limit: 100,
    });
    expect(firstPage.items).toHaveLength(100);
    expect((await communications.list(gameId, playerId))[0]!.unreadCount).toBe(
      50,
    );
    const secondPage = await communications.messages({
      gameId,
      userId: playerId,
      conversationId: conversation.id,
      after: firstPage.nextCursor!,
      limit: 100,
    });
    expect(secondPage.items).toHaveLength(50);
    expect(
      [...firstPage.items, ...secondPage.items].map((item) => item.content),
    ).toEqual(Array.from({ length: 150 }, (_, index) => `消息 ${index + 1}`));
    expect((await communications.list(gameId, playerId))[0]!.unreadCount).toBe(
      0,
    );
  });
});
