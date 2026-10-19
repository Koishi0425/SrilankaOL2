import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDatabasePool } from '@srilanka/database';
import type {
  AssistantInput,
  AssistantAnswer,
  QuarterSettlement,
} from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { AssistantService } from './modules/assistant/assistant-service.js';
import type { ModelRequest } from './modules/assistant/assistant-model.js';

if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).pathname !== '/srilanka_test'
)
  throw new Error('Assistant tests require srilanka_test.');
const database = createDatabasePool(process.env.DATABASE_URL);
const auth = new AuthService(database);
const games = new GameService(database);
const actions = new ActionService(database);
const settlements = new SettlementService(database);
const model = {
  configured: true,
  provider: 'Test',
  generate: vi.fn<(input: ModelRequest) => Promise<AssistantAnswer>>(),
};
const assistant = new AssistantService(database, games, settlements, model);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  settlements,
  assistant,
  health: { checkDatabase: async () => {}, checkRedis: async () => {} },
});

let hostId: string, playerId: string, otherId: string, observerId: string;
let hostCookie: string, playerCookie: string;
let gameId: string, quarterId: string, ownCountry: string, otherCountry: string;
let draft: QuarterSettlement;
let ownActionId: string;

function answer(request: ModelRequest): AssistantAnswer {
  return {
    overview: '结算摘要。',
    highlights: [
      { text: '已记录的结果。', sourceIds: [request.sources[0]!.id] },
    ],
    notices: [],
    draft: request.purpose === 'Feedback' ? '探索完成，损失10人。' : null,
  };
}
async function login(username: string) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password: 'assistant-test-password' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie']).split(';')[0]!;
}
function input(purpose: AssistantInput['purpose'] = 'Digest'): AssistantInput {
  return {
    purpose,
    quarterId,
    expectedVersion: draft.version,
    expectedCorrectionVersion: 0,
    length: 'Normal',
    ...(purpose === 'Feedback'
      ? { actionId: ownActionId, ruling: '探索完成，损失10人。' }
      : {}),
  };
}
function request(body = input(), cookie = playerCookie) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/games/${gameId}/assistant/generate`,
    headers: { cookie },
    payload: body,
  });
}
async function publish() {
  draft = await settlements.publish(gameId, hostId, quarterId, draft.version);
}

beforeAll(async () => {
  await database.query(
    'TRUNCATE auth_sessions, game_members, quarters, countries, games, users CASCADE',
  );
  const users = [];
  for (const name of ['host', 'player', 'other', 'observer'])
    users.push(
      await auth.createDevelopmentUser({
        username: `assistant-${name}`,
        displayName: name,
        password: 'assistant-test-password',
      }),
    );
  [hostId, playerId, otherId, observerId] = users.map((user) => user.id) as [
    string,
    string,
    string,
    string,
  ];
  hostCookie = await login('assistant-host');
  playerCookie = await login('assistant-player');
});
beforeEach(async () => {
  model.configured = true;
  model.generate
    .mockReset()
    .mockImplementation(async (request) => answer(request));
  await database.query('TRUNCATE games CASCADE');
  const game = await games.create({
    userId: hostId,
    name: '速览测试',
    countryNames: ['河国', '海国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  ownCountry = countries[0]!.id;
  otherCountry = countries[1]!.id;
  for (const [userId, countryId, role] of [
    [playerId, ownCountry, 'Player'],
    [otherId, otherCountry, 'Player'],
    [observerId, null, 'Observer'],
  ] as const)
    await database.query(
      "INSERT INTO game_members (id,game_id,user_id,role,status,controlled_country_id) VALUES ($1,$2,$3,$4,'Active',$5)",
      [crypto.randomUUID(), gameId, userId, role, countryId],
    );
  await assistant.configure(gameId, hostId, true, false);
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const submitted = [];
  for (const [userId, text] of [
    [playerId, '意图：获得传说神器，尚未实现'],
    [otherId, '敌国秘密意图VIOLET'],
  ] as const) {
    const a = await actions.create({
      gameId,
      userId,
      quarterId,
      title: userId === playerId ? '北方探索' : '秘密行动',
      originalText: text,
      category: 'Exploration',
      secrecy: 'Public',
      refs: [],
    });
    submitted.push(
      await actions.submit({
        gameId,
        userId,
        actionId: a.id,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
  }
  ownActionId = submitted[0]!.id;
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
  for (const action of submitted)
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: action.id,
      target: 'Approved',
      reason: '允许尝试，尚未执行',
    });
  await settlements.begin(gameId, hostId, quarterId);
  draft = await settlements.save(gameId, hostId, quarterId, {
    expectedVersion: 1,
    publicReport: '春季探索结束。',
    results: submitted.map((action, index) => ({
      actionId: action.id,
      feedback:
        index === 0
          ? '自己的私密反馈GREEN：没有发现神器，损失10人。'
          : '敌国私密反馈VIOLET：发现秘银矿。',
    })),
    resourceChanges: [
      {
        id: crypto.randomUUID(),
        actionId: ownActionId,
        countryId: ownCountry,
        expectedResourceRevision: 0,
        resource: 'Treasury',
        amount: 30.25,
        reason: '自己的正式收入GREEN',
      },
      {
        id: crypto.randomUUID(),
        actionId: null,
        countryId: otherCountry,
        expectedResourceRevision: 0,
        resource: 'Treasury',
        amount: 900,
        reason: '敌国秘密收支VIOLET',
      },
    ],
  });
});
afterAll(async () => {
  await app.close();
  await database.end();
});

describe('scoped model assistance', () => {
  it('keeps configuration private, requires host authority and fails before model calls when unavailable', async () => {
    const status = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/assistant`,
      headers: { cookie: playerCookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.json().data).toEqual({
      configured: true,
      enabled: true,
      canManage: false,
      provider: 'Test',
    });
    const set = await app.inject({
      method: 'PUT',
      url: `/api/v1/games/${gameId}/assistant`,
      headers: { cookie: playerCookie },
      payload: { enabled: false, expectedEnabled: true },
    });
    expect(set.statusCode).toBe(403);
    await assistant.configure(gameId, hostId, false, true);
    expect((await request()).json().error.code).toBe('ASSISTANT_DISABLED');
    model.configured = false;
    await expect(
      assistant.configure(gameId, hostId, true, false),
    ).rejects.toMatchObject({ code: 'ASSISTANT_NOT_CONFIGURED' });
    expect(model.generate).not.toHaveBeenCalled();
    expect(
      (await app.inject({ url: `/api/v1/games/${gameId}/assistant` }))
        .statusCode,
    ).toBe(401);
  });
  it('does not summarize drafts or let players provide authoritative outcomes', async () => {
    expect((await request()).json().error.code).toBe(
      'SETTLEMENT_NOT_PUBLISHED',
    );
    expect((await request(input('Feedback'))).statusCode).toBe(403);
    const injected = await request({
      ...input(),
      sources: [{ text: '伪造结算' }],
    } as AssistantInput);
    expect(injected.statusCode).toBe(400);
    expect(model.generate).not.toHaveBeenCalled();
  });
  it('sends only visible published outcomes and actual own ledger, excluding foreign secrets and policy intentions', async () => {
    await publish();
    const result = await request();
    expect(result.statusCode).toBe(200);
    const sent = JSON.stringify(model.generate.mock.calls[0]![0]);
    expect(sent).toContain('GREEN');
    expect(sent).not.toContain('VIOLET');
    expect(sent).not.toContain('传说神器');
    expect(sent).not.toContain('尚未实现');
    expect(result.json().data.resourceTotals).toEqual([
      { countryName: countriesName(), resource: 'Treasury', amount: 30.25 },
    ]);
    expect(JSON.stringify(result.json())).not.toContain('VIOLET');
    expect(
      (await settlements.get(gameId, hostId, quarterId)).actions.find(
        (a) => a.actionId === ownActionId,
      )!.feedback,
    ).toContain('GREEN');
  });
  it('does not leak national feedback or ledger to an observer with a residual country binding', async () => {
    await publish();
    await database.query(
      "UPDATE game_members SET role='Observer' WHERE game_id=$1 AND user_id=$2",
      [gameId, playerId],
    );
    const result = await request();
    expect(result.statusCode).toBe(200);
    const sent = JSON.stringify(model.generate.mock.calls[0]![0]);
    expect(sent).toContain('春季探索结束');
    expect(sent).not.toContain('GREEN');
    expect(sent).not.toContain('VIOLET');
    expect(result.json().data.resourceTotals).toEqual([]);
  });
  it('requires explicit host ruling and returns an uncommitted feedback draft from saved sources', async () => {
    const invalid = await request(
      { ...input('Feedback'), ruling: '' },
      hostCookie,
    );
    expect(invalid.statusCode).toBe(400);
    const response = await request(input('Feedback'), hostCookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.answer.draft).toBe('探索完成，损失10人。');
    const sent = JSON.stringify(model.generate.mock.calls[0]![0]);
    expect(sent).toContain('主持人本次裁定');
    expect(sent).toContain('尚未发布');
    expect(sent).not.toContain('VIOLET');
    expect(
      (await settlements.get(gameId, hostId, quarterId)).actions.find(
        (a) => a.actionId === ownActionId,
      )!.feedback,
    ).toContain('GREEN');
  });
  it('invalidates output when country access changes while inference is running', async () => {
    await publish();
    model.generate.mockImplementationOnce(async (context) => {
      await database.query(
        'UPDATE game_members SET controlled_country_id=$3 WHERE game_id=$1 AND user_id=$2',
        [gameId, playerId, otherCountry],
      );
      return answer(context);
    });
    const response = await request();
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('ASSISTANT_CONTEXT_CHANGED');
    expect(JSON.stringify(response.json())).not.toContain('GREEN');
  });
  it('rejects stale versions before inference and discards drafts updated during inference', async () => {
    expect(
      (
        await request({ ...input('Feedback'), expectedVersion: 0 }, hostCookie)
      ).json().error.code,
    ).toBe('ASSISTANT_CONTEXT_CHANGED');
    expect(model.generate).not.toHaveBeenCalled();
    model.generate.mockImplementationOnce(async (context) => {
      await settlements.save(gameId, hostId, quarterId, {
        expectedVersion: draft.version,
        publicReport: '主持人已更新结算',
        results: draft.actions.map((a) => ({
          actionId: a.actionId,
          feedback: a.feedback,
        })),
      });
      return answer(context);
    });
    expect(
      (await request(input('Feedback'), hostCookie)).json().error.code,
    ).toBe('ASSISTANT_CONTEXT_CHANGED');
  });
  it('rejects overlapping requests and releases its slot on failure without retrying', async () => {
    await publish();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    model.generate.mockImplementationOnce(async (context) => {
      entered();
      await gate;
      return answer(context);
    });
    const first = request();
    await started;
    expect((await request()).json().error.code).toBe(
      'ASSISTANT_ALREADY_RUNNING',
    );
    release();
    expect((await first).statusCode).toBe(200);
    model.generate.mockRejectedValueOnce(new Error('offline'));
    expect((await request()).statusCode).toBe(500);
    expect((await request()).statusCode).toBe(200);
    expect(model.generate).toHaveBeenCalledTimes(3);
  });
  it('persists user call limits across service instances', async () => {
    await publish();
    const another = new AssistantService(database, games, settlements, model);
    for (let count = 0; count < 30; count++)
      await (count % 2 ? assistant : another).generate(
        gameId,
        playerId,
        input(),
      );
    await expect(
      another.generate(gameId, playerId, input()),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'ASSISTANT_RATE_LIMITED',
    });
    expect(model.generate).toHaveBeenCalledTimes(30);
  });
  it('rechecks the login session before delivering a result', async () => {
    await publish();
    const temporaryCookie = await login('assistant-player');
    model.generate.mockImplementationOnce(async (context) => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie: temporaryCookie },
      });
      return answer(context);
    });
    expect((await request(input(), temporaryCookie)).statusCode).toBe(401);
  });
  it('uses corrected feedback, includes executed resource corrections, and rejects the previous revision', async () => {
    await publish();
    const correct = async (
      change: Parameters<typeof settlements.corrections.correct>[3]['change'],
    ) => {
      const options = await settlements.corrections.options(
        gameId,
        hostId,
        quarterId,
      );
      await settlements.corrections.correct(gameId, hostId, quarterId, {
        id: crypto.randomUUID(),
        expectedCorrectionVersion: options.correctionVersion,
        expectedCurrentQuarterId: options.currentQuarter.id,
        reason: '自己的更正原因GREEN',
        change,
      });
    };
    await correct({
      kind: 'ActionFeedback',
      actionId: ownActionId,
      text: '更正后没有损失。',
    });
    const options = await settlements.corrections.options(
      gameId,
      hostId,
      quarterId,
    );
    await correct({
      kind: 'Resource',
      countryId: ownCountry,
      resource: 'Treasury',
      amount: -5,
      expectedResourceRevision: options.countries.find(
        (c) => c.id === ownCountry,
      )!.resourceRevision,
    });
    expect((await request()).json().error.code).toBe(
      'ASSISTANT_CONTEXT_CHANGED',
    );
    const response = await request({
      ...input(),
      expectedCorrectionVersion: 2,
    });
    expect(response.statusCode).toBe(200);
    const sent = JSON.stringify(model.generate.mock.calls[0]![0]);
    expect(sent).toContain('更正后没有损失');
    expect(sent).not.toContain('损失10人');
    expect(sent).toContain('已执行的资源更正通知');
    expect(response.json().data.resourceTotals[0].amount).toBe(25.25);
  });
  it('discards a digest when an official correction arrives during generation', async () => {
    await publish();
    model.generate.mockImplementationOnce(async (context) => {
      const options = await settlements.corrections.options(
        gameId,
        hostId,
        quarterId,
      );
      await settlements.corrections.correct(gameId, hostId, quarterId, {
        id: crypto.randomUUID(),
        expectedCorrectionVersion: options.correctionVersion,
        expectedCurrentQuarterId: options.currentQuarter.id,
        reason: '公告笔误',
        change: { kind: 'PublicReport', text: '公告已正式更正。' },
      });
      return answer(context);
    });
    expect((await request()).json().error.code).toBe(
      'ASSISTANT_CONTEXT_CHANGED',
    );
  });
  it('keeps later monetary corrections in their execution quarter when summarizing history', async () => {
    await publish();
    await settlements.advance(gameId, hostId, quarterId);
    const options = await settlements.corrections.options(
      gameId,
      hostId,
      quarterId,
    );
    await settlements.corrections.correct(gameId, hostId, quarterId, {
      id: crypto.randomUUID(),
      expectedCorrectionVersion: 0,
      expectedCurrentQuarterId: options.currentQuarter.id,
      reason: '在下一季补记收入',
      change: {
        kind: 'Resource',
        countryId: ownCountry,
        resource: 'Treasury',
        amount: 5,
        expectedResourceRevision: options.countries.find(
          (c) => c.id === ownCountry,
        )!.resourceRevision,
      },
    });
    const response = await request({
      ...input(),
      expectedCorrectionVersion: 1,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.resourceTotals[0].amount).toBe(30.25);
    const sent = JSON.stringify(model.generate.mock.calls[0]![0]);
    expect(sent).toContain('第1年夏季入账');
  });
});

// Country ordering belongs to GameService; do not assume locale sorting.
function countriesName() {
  return draft.actions.find((a) => a.actionId === ownActionId)!.countryName;
}
