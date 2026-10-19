import { randomUUID } from 'node:crypto';
import { beforeEach, afterAll, it, expect } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { nationalPolicyStatus, toGovernmentInput } from '@srilanka/contracts';
import type {
  GovernmentChangeInput,
  GovernmentChange,
  EconomicBill,
  SaveSettlementInput,
} from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';
import { economicBillInput } from './modules/settlements/economy.js';
const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' }),
  db = createDatabasePool(config.databaseUrl);
const auth = new AuthService(db),
  games = new GameService(db),
  actions = new ActionService(db),
  settlements = new SettlementService(db),
  world = new WorldService(db);
const app = await buildApp({
  auth,
  games,
  actions,
  settlements,
  world,
  logLevel: 'silent',
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string,
  quarterId: string,
  host: string,
  player: string,
  _southUser: string,
  observer: string,
  outside: string,
  north: string,
  south: string,
  actionId: string,
  cookie: string,
  playerCookie: string;
const state = () => games.government.get(gameId, host);
const policy = (
  extra: Partial<Extract<GovernmentChangeInput, { kind: 'Policy' }>> = {},
): Extract<GovernmentChangeInput, { kind: 'Policy' }> => ({
  id: randomUUID(),
  actionId: null,
  expectedRevision: 0,
  expectedQuarterSequence: 1,
  reason: '主持人通过税制调整',
  kind: 'Policy',
  policyId: randomUUID(),
  countryId: north,
  title: '两季减税',
  type: 'Reform',
  text: '未来两季税收减少 10%，用于休养生息。',
  effects: { Tax: -10 },
  durationQuarters: 2,
  ...extra,
});
const profile = (rev = 0): GovernmentChangeInput => ({
  id: randomUUID(),
  actionId: null,
  expectedRevision: rev,
  expectedQuarterSequence: 1,
  reason: '开场资料',
  kind: 'Government',
  countryId: north,
  regime: '君主制',
  authority: '北王',
  description: '王权与贵族议会共同治理',
});
const setup = (changes: unknown[], withCookie = cookie) =>
  app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/government`,
    headers: { cookie: withCookie },
    payload: { changes },
  });
async function start() {
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'ActionSubmission',
  });
  const a = await actions.create({
    gameId,
    userId: player,
    quarterId,
    title: '税制改革',
    originalText: '休养生息',
    category: 'Reform',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  actionId = a.id;
  await actions.submit({
    gameId,
    userId: player,
    actionId,
    idempotencyKey: randomUUID(),
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'Locked',
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'HostReview',
  });
  await actions.hostTransition({
    gameId,
    userId: host,
    actionId,
    target: 'Approved',
    reason: '可行',
  });
  await settlements.begin(gameId, host, quarterId);
}
async function save(
  changes: GovernmentChangeInput[],
  version = 1,
  bill?: EconomicBill,
  extra: Partial<SaveSettlementInput> = {},
) {
  return settlements.save(gameId, host, quarterId, {
    expectedVersion: version,
    publicReport: '诸国本季改革完成。',
    results: [{ actionId, feedback: '政策通过' }],
    governmentChanges: changes,
    ...(bill ? { economicBill: economicBillInput(bill) } : {}),
    ...extra,
  });
}
async function economicSetup() {
  await games.economics.set(gameId, host, {
    expectedVersion: 0,
    reason: '开场经济',
    rules: {
      enabled: true,
      taxCoefficient: 10,
      productionCoefficient: 0,
      manpowerCoefficient: 0,
      armyMaintenancePer100: 0,
      administrationCost: 0,
    },
  });
  await world.setup.create(gameId, host, { name: '本土', width: 1, height: 1 });
  const tile = (
    await world.getViewport({
      gameId,
      userId: host,
      minQ: 0,
      maxQ: 0,
      minR: 0,
      maxR: 0,
    })
  ).tiles[0]!;
  await world.setup.batch(gameId, host, {
    expectedRevision: (await world.getMap(gameId, host)).revision!,
    tileIds: [tile.id],
    provinceName: '北境',
    regionName: '本土',
    legalOwnerCountryId: north,
    controllerCountryId: north,
  });
  const p = (await world.provinces.list(gameId, host)).provinces[0]!;
  await world.provinces.set(gameId, host, p.id, {
    name: p.name,
    description: '',
    expectedRevision: 0,
    expectedMapRevision: (await world.getMap(gameId, host)).revision!,
    taxBase: 8,
    productionBase: 0,
    manpowerBase: 0,
    autonomy: 15,
    unrest: 0,
    reason: '开场基础',
  });
}
const preview = () => settlements.economicPreview(gameId, host, quarterId, 1);
const tax = (bill: EconomicBill) =>
  bill.lines.find((l) => l.countryId === north && l.kind === 'Tax')!;
async function advance() {
  await settlements.advance(gameId, host, quarterId);
  quarterId = (await games.getCurrentQuarter(gameId, host)).id;
}
beforeEach(async () => {
  await db.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'gov-host',
    'gov-north',
    'gov-south',
    'gov-observer',
    'gov-outside',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'government-password',
      }),
    );
  [host, player, _southUser, observer, outside] = users.map((u) => u.id) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const game = await games.create({
    userId: host,
    name: '政府与长期政策',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, host);
  north = countries.find((c) => c.name === '北国')!.id;
  south = countries.find((c) => c.name === '南国')!.id;
  for (const [i, u] of users.slice(1, 4).entries()) {
    const m = await games.addMember({
      gameId,
      actorUserId: host,
      username: u.username,
      role: i < 2 ? 'Player' : 'Observer',
    });
    if (i < 2)
      await games.assignCountry({
        gameId,
        actorUserId: host,
        memberId: m.id,
        countryId: i === 0 ? north : south,
      });
  }
  const login = async (username: string) =>
    String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'government-password' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  cookie = await login('gov-host');
  playerCookie = await login('gov-north');
  await settlements.countries.setBalances(gameId, host, north, {
    expectedRevision: 0,
    treasury: 100,
    manpower: 0,
    reason: '开场',
  });
});
afterAll(async () => {
  await app.close();
  await db.end();
});
it('sets profiles and opening policies without a map, validates ownership/revisions and rolls back invalid batches', async () => {
  expect((await setup([profile(), policy()])).statusCode).toBe(200);
  expect((await state()).revision).toBe(1);
  expect(
    (await state()).profiles.find((p) => p.countryId === north)?.regime,
  ).toBe('君主制');
  expect((await state()).policies[0]!.startsAt.sequenceNumber).toBe(1);
  expect((await setup([profile(1)], playerCookie)).statusCode).toBe(403);
  expect((await setup([policy()])).statusCode).toBe(409);
  expect(
    (await setup([policy({ expectedRevision: 1, countryId: randomUUID() })]))
      .statusCode,
  ).toBe(400);
  expect(
    (await setup([policy({ expectedRevision: 1, effects: { Tax: 1001 } })]))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await setup([
        { ...policy({ expectedRevision: 1 }), effects: { Espionage: 10 } },
      ])
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await setup([
        policy({ expectedRevision: 1 }),
        policy({ expectedRevision: 1, durationQuarters: 0 }),
      ])
    ).statusCode,
  ).toBe(400);
  expect((await state()).policies).toHaveLength(1);
  expect(
    (await setup([policy({ expectedRevision: 1, expectedQuarterSequence: 2 })]))
      .statusCode,
  ).toBe(409);
});
it('stages changes, preserves old-client drafts, ignores forged metadata and publishes fees plus government exactly once', async () => {
  await start();
  const p = policy({ actionId }),
    before = (await games.getCurrentQuarter(gameId, host)).currentWorldVersion;
  const draft = await save(
    [
      {
        ...p,
        countryName: '假名称',
        summary: '假总结',
        after: { title: '假政策' },
      } as GovernmentChangeInput,
      profile(),
    ],
    1,
    undefined,
    {
      resourceChanges: [
        {
          id: randomUUID(),
          actionId,
          expectedResourceRevision: 1,
          countryId: north,
          resource: 'Treasury',
          amount: -20,
          reason: '改革费用',
        },
      ],
    },
  );
  expect((await state()).policies).toHaveLength(0);
  expect(draft.governmentChanges?.[0]?.summary).toContain('北国');
  const old = await settlements.save(gameId, host, quarterId, {
    expectedVersion: draft.version,
    publicReport: draft.publicReport,
    results: [{ actionId, feedback: '政策通过' }],
  });
  expect(old.governmentChanges).toEqual(draft.governmentChanges);
  await settlements.publish(gameId, host, quarterId, old.version);
  const current = await state();
  expect(current).toMatchObject({ revision: 1 });
  expect(current.policies[0]!).toMatchObject({
    title: '两季减税',
    startsAt: { sequenceNumber: 2 },
  });
  expect(
    (await settlements.countries.status(gameId, host)).countries.find(
      (c) => c.id === north,
    )?.treasury,
  ).toBe(80);
  expect(
    (await games.getCurrentQuarter(gameId, host)).currentWorldVersion,
  ).toBe(before + 1);
  await settlements.publish(gameId, host, quarterId, old.version);
  expect((await state()).revision).toBe(1);
  expect((await state()).history).toHaveLength(2);
  expect(
    (await settlements.get(gameId, player, quarterId)).governmentChanges,
  ).toBeUndefined();
});
it('starts next season, lasts two full seasons across the year and leaves earlier bill/history frozen', async () => {
  await db.query(
    "UPDATE quarters SET game_year=2,season='Winter',sequence_number=8 WHERE id=$1",
    [quarterId],
  );
  await economicSetup();
  await start();
  let b = await preview();
  expect(tax(b).calculatedAmount).toBe(68);
  const d = await save(
    [policy({ expectedQuarterSequence: 8, actionId })],
    1,
    b,
  );
  await settlements.publish(gameId, host, quarterId, d.version);
  const published = await settlements.get(gameId, host, quarterId);
  const p = (await state()).policies[0]!;
  expect(p.startsAt).toEqual({
    gameYear: 3,
    season: 'Spring',
    sequenceNumber: 9,
  });
  expect(p.expiresAt).toEqual({
    gameYear: 3,
    season: 'Autumn',
    sequenceNumber: 11,
  });
  expect(nationalPolicyStatus(p, 8)).toBe('Upcoming');
  for (const seq of [9, 10, 11]) {
    await advance();
    await start();
    b = await preview();
    expect(tax(b).calculatedAmount).toBe(seq === 11 ? 68 : 61.2);
    expect(b.policies?.length ?? 0).toBe(seq === 11 ? 0 : 1);
    const d = await save([], 1, b);
    await settlements.publish(gameId, host, quarterId, d.version);
  }
  expect(nationalPolicyStatus((await state()).policies[0]!, 11)).toBe(
    'Expired',
  );
  expect(
    (await settlements.get(gameId, host, published.quarter.id)).economicBill,
  ).toEqual(published.economicBill);
  expect(
    (await settlements.get(gameId, host, published.quarter.id))
      .governmentChanges,
  ).toEqual(published.governmentChanges);
});
it('keeps the first opening snapshot through reopen and replacement; applies replacement only next season', async () => {
  await economicSetup();
  const old = policy({ durationQuarters: null });
  await setup([old]);
  await games.transitionCurrentQuarter({
    gameId,
    userId: host,
    state: 'ActionSubmission',
  });
  // Returning to preparation does not recapture the economic basis.
  await db.query("UPDATE quarters SET state='Preparing' WHERE id=$1", [
    quarterId,
  ]);
  await setup([policy({ expectedRevision: 1, effects: { Tax: 50 } })]);
  await start();
  expect(tax(await preview()).calculatedAmount).toBe(61.2);
  const end: GovernmentChangeInput = {
    id: randomUUID(),
    actionId,
    expectedRevision: 2,
    expectedQuarterSequence: 1,
    reason: '改行新税制',
    kind: 'EndPolicy',
    policyId: old.policyId,
  };
  const d = await save(
    [
      end,
      policy({
        expectedRevision: 2,
        effects: { Tax: 20 },
        title: '新税制',
        durationQuarters: null,
      }),
    ],
    1,
    await preview(),
  );
  await settlements.publish(gameId, host, quarterId, d.version);
  expect(
    (await state()).policies.find((p) => p.id === old.policyId)?.endedAt
      ?.sequenceNumber,
  ).toBe(2);
  await advance();
  await start();
  expect(tax(await preview()).calculatedAmount).toBe(115.6);
});
it('projects only current own country history and frozen bill amounts, including host corrections', async () => {
  await economicSetup();
  await setup([
    profile(),
    policy(),
    policy({ countryId: south, title: '南国秘密改革' }),
  ]);
  await start();
  const b = await preview();
  const l = tax(b);
  l.amount = 60;
  l.adjustmentReason = '本季灾害';
  const d = await save([], 1, b);
  await settlements.publish(gameId, host, quarterId, d.version);
  const own = await games.government.get(gameId, player);
  expect(own.profiles).toHaveLength(1);
  expect(own.policies.map((p) => p.title)).toEqual(['两季减税']);
  expect(own).not.toHaveProperty('countries');
  expect(own.canEdit).toBe(false);
  expect(own.lastBill?.lines.find((l) => l.kind === 'Tax')).toMatchObject({
    baseAmount: 68,
    calculatedAmount: 61.2,
    actualAmount: 60,
    adjustmentReason: '本季灾害',
    policyEffects: [{ title: '两季减税', percent: -10 }],
  });
  expect(JSON.stringify(own)).not.toContain('南国秘密改革');
  expect(JSON.stringify(own)).not.toContain('actionId');
  expect(await games.government.get(gameId, observer)).toMatchObject({
    profiles: [],
    policies: [],
    lastBill: null,
  });
  await expect(
    games.government.get(gameId, player, south),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(games.government.get(gameId, outside)).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(
    (await games.government.get(gameId, host, south)).policies[0]?.title,
  ).toBe('南国秘密改革');
  await db.query(
    'UPDATE game_members SET controlled_country_id=NULL WHERE game_id=$1 AND user_id=$2',
    [gameId, player],
  );
  expect(await games.government.get(gameId, player)).toMatchObject({
    profiles: [],
    policies: [],
    lastBill: null,
  });
});
it('cannot rebase saved profile plans or apply unapproved/reused targets', async () => {
  await start();
  let d = await save([profile()]);
  await db.query('UPDATE games SET government_revision=1 WHERE id=$1', [
    gameId,
  ]);
  await expect(
    save(
      d.governmentChanges!.map((c) => ({
        ...toGovernmentInput(c),
        expectedRevision: 1,
      })),
      d.version,
    ),
  ).rejects.toMatchObject({ statusCode: 409 });
  await db.query('UPDATE games SET government_revision=0 WHERE id=$1', [
    gameId,
  ]);
  await expect(
    save([policy({ actionId: randomUUID() })], d.version),
  ).rejects.toMatchObject({ statusCode: 400 });
  await expect(save([profile(), profile()], d.version)).rejects.toMatchObject({
    statusCode: 400,
  });
  d = await save([policy()], d.version);
  await settlements.publish(gameId, host, quarterId, d.version);
  await advance();
  const c = d.governmentChanges![0] as GovernmentChange;
  expect(
    (
      await setup([
        {
          ...toGovernmentInput(c),
          expectedRevision: 1,
          expectedQuarterSequence: 2,
        },
      ])
    ).statusCode,
  ).toBe(400);
});
it('rolls back government, policies, fees and history if a later exploration plan fails', async () => {
  await world.setup.create(gameId, host, { name: '边境', width: 1, height: 1 });
  await start();
  const tile = (
    await world.getViewport({
      gameId,
      userId: host,
      minQ: 0,
      maxQ: 0,
      minR: 0,
      maxR: 0,
    })
  ).tiles[0]!;
  await world.setup.knowledge(gameId, host, {
    expectedRevision: (await world.getMap(gameId, host)).revision!,
    countryId: north,
    tileIds: [tile.id],
    state: 'Observed',
    sourceActionId: actionId,
    note: '边境情报',
  });
  const d = await save([profile(), policy()], 1, undefined, {
    resourceChanges: [
      {
        id: randomUUID(),
        actionId: null,
        expectedResourceRevision: 1,
        countryId: north,
        resource: 'Treasury',
        amount: -20,
        reason: '改革费用',
      },
    ],
  });
  await db.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
    actionId,
  ]);
  await expect(
    settlements.publish(
      gameId,
      host,
      quarterId,
      d.version,
      (await world.getMap(gameId, host)).revision!,
    ),
  ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
  expect(await state()).toMatchObject({
    revision: 0,
    policies: [],
    history: [],
  });
  expect((await state()).profiles[0]?.regime).toBe('');
  expect(
    (await settlements.countries.status(gameId, host)).countries.find(
      (c) => c.id === north,
    )?.treasury,
  ).toBe(100);
});
