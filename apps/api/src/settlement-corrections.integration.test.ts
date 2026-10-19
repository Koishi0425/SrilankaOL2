import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabasePool } from '@srilanka/database';
import type {
  CorrectSettlementInput,
  QuarterSettlement,
  SettlementCorrectionChange,
} from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { WorldService } from './modules/world/world-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';

if (
  !process.env.DATABASE_URL ||
  new URL(process.env.DATABASE_URL).pathname !== '/srilanka_test'
)
  throw new Error('Correction tests require srilanka_test.');
const database = createDatabasePool(process.env.DATABASE_URL),
  auth = new AuthService(database),
  games = new GameService(database),
  actions = new ActionService(database),
  world = new WorldService(database),
  settlements = new SettlementService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  actions,
  world,
  settlements,
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string,
  quarterId: string,
  hostId: string,
  playerId: string,
  otherId: string,
  observerId: string,
  countryId: string,
  armyId: string,
  tileId: string;
let cookies: string[], published: QuarterSettlement;
const base = () => `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`;
async function input(
  change: SettlementCorrectionChange,
): Promise<CorrectSettlementInput> {
  const options = await settlements.corrections.options(
    gameId,
    hostId,
    quarterId,
  );
  return {
    id: randomUUID(),
    expectedCorrectionVersion: options.correctionVersion,
    expectedCurrentQuarterId: options.currentQuarter.id,
    reason: '核对原记录后更正',
    change,
  };
}
const post = (payload: CorrectSettlementInput, cookie = cookies[0]) =>
  app.inject({
    method: 'POST',
    url: `${base()}/corrections`,
    headers: { cookie },
    payload,
  });
beforeEach(async () => {
  await database.query('TRUNCATE users,games CASCADE');
  const users = [];
  cookies = [];
  for (const username of [
    'fix-host',
    'fix-player',
    'fix-other',
    'fix-observer',
  ]) {
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'correction-test-password',
      }),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password: 'correction-test-password' },
    });
    cookies.push(String(login.headers['set-cookie']).split(';')[0]!);
  }
  [hostId, playerId, otherId, observerId] = users.map((u) => u.id) as [
    string,
    string,
    string,
    string,
  ];
  const game = await games.create({
    userId: hostId,
    name: '更正验收',
    countryNames: ['甲国', '乙国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  countryId = countries[0]!.id;
  for (const [index, user] of users.slice(1).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: user.username,
      role: index === 2 ? 'Observer' : 'Player',
    });
    if (index < 2)
      await games.assignCountry({
        gameId,
        actorUserId: hostId,
        memberId: member.id,
        countryId: countries[index]!.id,
      });
  }
  await settlements.countries.setBalances(gameId, hostId, countryId, {
    expectedRevision: 0,
    treasury: 1000,
    manpower: 2000,
    reason: '开局',
  });
  await world.setup.create(gameId, hostId, {
    name: '世界',
    width: 3,
    height: 2,
  });
  tileId = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 2,
      minR: 0,
      maxR: 1,
    })
  ).tiles[0]!.id;
  await world.setup.batch(gameId, hostId, {
    expectedRevision: (await world.getMap(gameId, hostId)).revision!,
    tileIds: [tileId],
    controllerCountryId: countryId,
    legalOwnerCountryId: countryId,
  });
  await world.createCity({
    gameId,
    userId: hostId,
    tileId,
    countryId,
    name: '首都',
  });
  await world.createArmy({
    gameId,
    userId: hostId,
    tileId,
    countryId,
    name: '近卫军',
    strength: 100,
  });
  armyId = (await world.getTile(gameId, hostId, tileId)).armies[0]!.id;
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const action = await actions.create({
    gameId,
    userId: playerId,
    quarterId,
    title: '建设计划',
    originalText: '建设',
    category: 'Construction',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  await actions.submit({
    gameId,
    userId: playerId,
    actionId: action.id,
    idempotencyKey: randomUUID(),
  });
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
    actionId: action.id,
    target: 'Approved',
    reason: '批准',
  });
  const draft = await settlements.begin(gameId, hostId, quarterId);
  const saved = await settlements.save(gameId, hostId, quarterId, {
    expectedVersion: draft.version,
    publicReport: '原公报',
    results: [{ actionId: action.id, feedback: '原反馈' }],
  });
  published = await settlements.publish(
    gameId,
    hostId,
    quarterId,
    saved.version,
  );
});
afterAll(async () => {
  await app.close();
  await database.end();
});

describe('published settlement corrections', () => {
  it('keeps original snapshots, overlays successive text changes, and filters private feedback and reasons', async () => {
    const original = (
      await database.query(
        'SELECT published_snapshot FROM quarter_settlements WHERE game_id=$1',
        [gameId],
      )
    ).rows[0]!.published_snapshot;
    expect(
      (await post(await input({ kind: 'PublicReport', text: '新公报' })))
        .statusCode,
    ).toBe(200);
    const feedback = await input({
      kind: 'ActionFeedback',
      actionId: published.actions[0]!.actionId,
      text: '秘密修正反馈',
    });
    feedback.reason = '秘密反馈笔误';
    expect((await post(feedback)).statusCode).toBe(200);
    expect(
      (
        await post(
          await input({
            kind: 'ActionFeedback',
            actionId: published.actions[0]!.actionId,
            text: '第二次修正',
          }),
        )
      ).statusCode,
    ).toBe(200);
    const own = await settlements.get(gameId, playerId, quarterId),
      other = await settlements.get(gameId, otherId, quarterId),
      observer = await settlements.get(gameId, observerId, quarterId);
    expect(own.actions[0]!.feedback).toBe('第二次修正');
    expect(own.corrections).toHaveLength(3);
    expect(other.corrections).toHaveLength(1);
    expect(observer.corrections).toHaveLength(1);
    expect(other.publicReport).toBe('新公报');
    expect(JSON.stringify(other)).not.toContain('秘密');
    expect(other.correctionVersion).toBeUndefined();
    expect(
      (
        await database.query(
          'SELECT published_snapshot FROM quarter_settlements WHERE game_id=$1',
          [gameId],
        )
      ).rows[0]!.published_snapshot,
    ).toEqual(original);
    await expect(
      database.query(
        "UPDATE settlement_corrections SET reason='覆盖历史' WHERE game_id=$1",
        [gameId],
      ),
    ).rejects.toThrow('append-only');
  });
  it('applies historical monetary corrections to current balances exactly once and records the current quarter', async () => {
    const next = await settlements.advance(gameId, hostId, quarterId);
    const request = await input({
      kind: 'Resource',
      countryId,
      resource: 'Treasury',
      amount: -75.25,
      expectedResourceRevision: 1,
    });
    const results = await Promise.all([post(request), post(request)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const country = (
      await settlements.countries.status(gameId, hostId)
    ).countries.find((c) => c.id === countryId)!;
    expect(country.treasury).toBe(924.75);
    expect(country.resourceRevision).toBe(2);
    expect(
      (await settlements.list(gameId, playerId)).find(
        (round) => round.quarterId === quarterId,
      )?.correctedAt,
    ).toBeTruthy();
    expect(
      (await settlements.list(gameId, otherId)).find(
        (round) => round.quarterId === quarterId,
      )?.correctedAt,
    ).toBeNull();
    expect(
      (await settlements.list(gameId, observerId)).find(
        (round) => round.quarterId === quarterId,
      )?.correctedAt,
    ).toBeNull();
    const ledger = await settlements.countries.ledger(
      gameId,
      playerId,
      countryId,
    );
    expect(ledger.entries[0]).toMatchObject({
      kind: 'Correction',
      quarterId: next.id,
      amount: -75.25,
      before: 1000,
      after: 924.75,
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).corrections,
    ).toHaveLength(1);
    expect(
      (await post({ ...request, reason: '替换已用标识' })).statusCode,
    ).toBe(409);
    expect(
      (await settlements.get(gameId, otherId, quarterId)).corrections,
    ).toHaveLength(0);
  });
  it('corrects army strength with map audit and vision refresh, never sharing enemy exact strength', async () => {
    const map = (await world.getMap(gameId, hostId)).revision!;
    const request = await input({
      kind: 'ArmyStrength',
      armyId,
      strength: 0,
      expectedStrength: 100,
      expectedMapRevision: map,
    });
    expect((await post(request)).statusCode).toBe(200);
    expect((await world.getMap(gameId, hostId)).revision).toBe(map + 1);
    expect(
      (
        await database.query('SELECT strength FROM armies WHERE id=$1', [
          armyId,
        ])
      ).rows[0]!.strength,
    ).toBe(0);
    expect((await world.setup.history(gameId, hostId))[0]).toMatchObject({
      kind: 'Correction',
      note: request.reason,
    });
    expect(
      (await settlements.get(gameId, playerId, quarterId)).corrections?.[0]
        ?.change,
    ).toMatchObject({ kind: 'ArmyStrength', before: 100, after: 0 });
    expect(
      (await settlements.get(gameId, otherId, quarterId)).corrections,
    ).toHaveLength(0);
    expect(
      (await settlements.get(gameId, observerId, quarterId)).corrections,
    ).toHaveLength(0);
  });
  it('rejects stale revisions, invalid balances, foreign actions, unauthorized callers, and archived writes atomically', async () => {
    const request = await input({
      kind: 'Resource',
      countryId,
      resource: 'Manpower',
      amount: -3000,
      expectedResourceRevision: 1,
    });
    expect((await post(request)).statusCode).toBe(400);
    expect(
      (
        await post({
          ...request,
          id: randomUUID(),
          change: {
            kind: 'Resource',
            countryId,
            resource: 'Treasury',
            amount: -1,
            expectedResourceRevision: 0,
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await post({
          ...request,
          id: randomUUID(),
          change: {
            kind: 'ActionFeedback',
            actionId: randomUUID(),
            text: '错误',
          },
        })
      ).statusCode,
    ).toBe(400);
    expect((await post(request, cookies[1])).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          url: `${base()}/corrections/options`,
          headers: { cookie: cookies[1] },
        })
      ).statusCode,
    ).toBe(403);
    const valid = await input({ kind: 'PublicReport', text: '一版' }),
      stale = await input({ kind: 'PublicReport', text: '过期版' });
    expect((await post(valid)).statusCode).toBe(200);
    expect((await post(stale)).statusCode).toBe(409);
    const staleQuarter = await input({
      kind: 'Resource',
      countryId,
      resource: 'Treasury',
      amount: 20,
      expectedResourceRevision: 1,
    });
    await settlements.advance(gameId, hostId, quarterId);
    expect((await post(staleQuarter)).statusCode).toBe(409);
    const current = await games.getForUser(gameId, hostId);
    await games.end(gameId, hostId, {
      expectedQuarterId: current.currentQuarter.id,
      expectedQuarterState: current.currentQuarter.state,
      reason: '结束',
    });
    expect(
      (await post(await input({ kind: 'PublicReport', text: '归档后更改' })))
        .statusCode,
    ).toBe(409);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).corrections,
    ).toHaveLength(1);
    expect(
      (await settlements.countries.status(gameId, hostId)).countries.find(
        (c) => c.id === countryId,
      )?.treasury,
    ).toBe(1000);
  });
  it('requires an explicit reason and fresh map version for live immediate edits, preserving setup and settlement flows', async () => {
    const revision = (await world.getMap(gameId, hostId)).revision!;
    await expect(
      world.moveArmy({ gameId, userId: hostId, armyId, tileId }),
    ).rejects.toMatchObject({ code: 'INSTANT_CORRECTION_REQUIRED' });
    await expect(
      world.setup.batch(gameId, hostId, {
        expectedRevision: revision,
        tileIds: [tileId],
        controllerCountryId: null,
      }),
    ).rejects.toMatchObject({ code: 'INSTANT_CORRECTION_REQUIRED' });
    await expect(
      world.createArmy({
        gameId,
        userId: hostId,
        tileId,
        countryId,
        name: '意外提前征募',
        strength: 50,
      }),
    ).rejects.toMatchObject({ code: 'INSTANT_CORRECTION_REQUIRED' });
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId,
      expectedRevision: revision,
      correctionReason: '修正标记位置',
    });
    expect((await world.setup.history(gameId, hostId))[0]).toMatchObject({
      kind: 'MoveArmy',
      note: '修正标记位置',
    });
    await expect(
      world.updateTile({
        gameId,
        userId: hostId,
        tileId,
        controllerCountryId: null,
        expectedRevision: revision,
        correctionReason: '旧窗口',
      }),
    ).rejects.toMatchObject({ code: 'MAP_VERSION_CONFLICT' });
    await settlements.advance(gameId, hostId, quarterId);
    await expect(
      world.createArmy({
        gameId,
        userId: hostId,
        tileId,
        countryId,
        name: '下一季也不能提前征募',
        strength: 50,
      }),
    ).rejects.toMatchObject({ code: 'INSTANT_CORRECTION_REQUIRED' });
  });
  it('invalidates an unpublished resource plan when an earlier settlement is supplemented', async () => {
    const next = await settlements.advance(gameId, hostId, quarterId);
    for (const state of ['ActionSubmission', 'Locked', 'HostReview'] as const)
      await games.transitionCurrentQuarter({ gameId, userId: hostId, state });
    const draft = await settlements.begin(gameId, hostId, next.id);
    const saved = await settlements.save(gameId, hostId, next.id, {
      expectedVersion: draft.version,
      publicReport: '下季',
      results: [],
      resourceChanges: [
        {
          id: randomUUID(),
          actionId: null,
          countryId,
          resource: 'Treasury',
          amount: -50,
          reason: '尚未发布的费用',
          expectedResourceRevision: 1,
        },
      ],
    });
    expect(
      (
        await post(
          await input({
            kind: 'Resource',
            countryId,
            resource: 'Treasury',
            amount: -10,
            expectedResourceRevision: 1,
          }),
        )
      ).statusCode,
    ).toBe(200);
    await expect(
      settlements.publish(gameId, hostId, next.id, saved.version),
    ).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    expect(
      (await settlements.countries.status(gameId, hostId)).countries.find(
        (c) => c.id === countryId,
      )?.treasury,
    ).toBe(990);
    expect(
      (await settlements.get(gameId, hostId, next.id)).publishedAt,
    ).toBeNull();
  });
});
