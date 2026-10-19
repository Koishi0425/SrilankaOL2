import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import type {
  EconomicRules,
  SaveSettlementInput,
  SetTradeZoneInput,
  SettlementStateChangeInput,
} from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { economicBillInput } from './modules/settlements/economy.js';
const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' }),
  db = createDatabasePool(config.databaseUrl);
const auth = new AuthService(db),
  games = new GameService(db),
  world = new WorldService(db),
  settlements = new SettlementService(db),
  actions = new ActionService(db);
const app = await buildApp({
  auth,
  games,
  world,
  settlements,
  actions,
  logLevel: 'silent',
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string,
  quarterId: string,
  hostId: string,
  northId: string,
  southId: string,
  observerId: string,
  outsideId: string,
  north: string,
  south: string,
  p1: string,
  p2: string,
  zoneId: string,
  actionId: string,
  hostCookie: string,
  playerCookie: string,
  tiles: string[];
const rules: EconomicRules = {
  enabled: true,
  taxCoefficient: 0,
  productionCoefficient: 0,
  manpowerCoefficient: 0,
  armyMaintenancePer100: 0,
  administrationCost: 0,
  tradeCoefficient: 10,
};
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const status = () => settlements.countries.status(gameId, hostId);
const zoneInput = async (
  extra: Partial<SetTradeZoneInput> = {},
): Promise<SetTradeZoneInput> => ({
  expectedRevision: 0,
  expectedMapRevision: await revision(),
  name: '海湾贸易区',
  provinceIds: [p1, p2],
  influences: [
    { countryId: north, power: 60 },
    { countryId: south, power: 40 },
  ],
  reason: '开场商贸',
  ...extra,
});
const power = (countryId = north, value = 80): SettlementStateChangeInput => ({
  id: randomUUID(),
  actionId,
  kind: 'TradeInfluence',
  zoneId,
  countryId,
  power: value,
  expectedZoneRevision: 0,
  reason: '商贸协议调整影响力',
});
async function setup(
  input: SetTradeZoneInput,
  id = zoneId,
  cookie = hostCookie,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/trade-zones/${id}`,
    headers: { cookie },
    payload: input,
  });
}
async function start() {
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const action = await actions.create({
    gameId,
    userId: northId,
    quarterId,
    title: '海湾商贸协议',
    originalText: '扩大工坊生产，争取港口商贸份额。',
    category: 'Diplomacy',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  actionId = action.id;
  await actions.submit({
    gameId,
    userId: northId,
    actionId,
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
    actionId,
    target: 'Approved',
    reason: '允许商贸协商',
  });
  await settlements.begin(gameId, hostId, quarterId);
}
async function save(
  changes: unknown[] = [],
  version = 1,
  extra: Partial<SaveSettlementInput> = {},
) {
  const bill = await settlements.economicPreview(
    gameId,
    hostId,
    quarterId,
    version,
  );
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
    headers: { cookie: hostCookie },
    payload: {
      expectedVersion: version,
      expectedMapRevision: await revision(),
      publicReport: '海湾商贸结算完成。',
      results: [{ actionId, feedback: '工坊与商贸协议完成，下季采用新分成。' }],
      stateChanges: changes,
      economicBill: economicBillInput(bill),
      ...extra,
    },
  });
}
const publish = async (version = 2) =>
  settlements.publish(gameId, hostId, quarterId, version, await revision());
beforeEach(async () => {
  await db.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'trade-host',
    'trade-north',
    'trade-south',
    'trade-observer',
    'trade-outside',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'trade-password',
      }),
    );
  [hostId, northId, southId, observerId, outsideId] = users.map(
    (u) => u.id,
  ) as [string, string, string, string, string];
  const game = await games.create({
    userId: hostId,
    name: '海湾商贸',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  north = countries.find((c) => c.name === '北国')!.id;
  south = countries.find((c) => c.name === '南国')!.id;
  for (const [i, user] of users.slice(1, 4).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: user.username,
      role: i < 2 ? 'Player' : 'Observer',
    });
    if (i < 2)
      await games.assignCountry({
        gameId,
        actorUserId: hostId,
        memberId: member.id,
        countryId: i === 0 ? north : south,
      });
  }
  const cookies = await Promise.all(
    users.slice(0, 2).map(
      async (u) =>
        String(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/auth/login',
              payload: { username: u.username, password: 'trade-password' },
            })
          ).headers['set-cookie'],
        ).split(';')[0]!,
    ),
  );
  [hostCookie, playerCookie] = cookies as [string, string];
  for (const countryId of [north, south])
    await settlements.countries.setBalances(gameId, hostId, countryId, {
      expectedRevision: 0,
      treasury: 100,
      manpower: 0,
      reason: '开场资源',
    });
  await world.setup.create(gameId, hostId, {
    name: '海湾',
    width: 4,
    height: 1,
  });
  tiles = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 3,
      minR: 0,
      maxR: 0,
    })
  ).tiles
    .sort((a, b) => a.q - b.q)
    .map((t) => t.id);
  for (const [ids, name, owner, production] of [
    [tiles.slice(0, 2), '北方省', north, 6],
    [tiles.slice(2), '南方省', south, 4],
  ] as const) {
    await world.setup.batch(gameId, hostId, {
      expectedRevision: await revision(),
      tileIds: [...ids],
      provinceName: name,
      regionName: name,
      legalOwnerCountryId: owner,
      controllerCountryId: owner,
    });
    const province = (
      await world.provinces.list(gameId, hostId)
    ).provinces.find((p) => p.name === name)!;
    await world.provinces.set(gameId, hostId, province.id, {
      name,
      description: name === '南方省' ? '南国保密生产资料' : '北方工坊',
      taxBase: 0,
      productionBase: production,
      manpowerBase: 0,
      autonomy: owner === south ? 50 : 0,
      unrest: 0,
      expectedRevision: 0,
      expectedMapRevision: await revision(),
      reason: '开场产出',
    });
    if (owner === north) p1 = province.id;
    else p2 = province.id;
  }
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tiles[3]!],
    controllerCountryId: north,
  });
  zoneId = randomUUID();
  expect(
    (await setup(await zoneInput({ expectedRevision: null }))).statusCode,
  ).toBe(200);
  await games.economics.set(gameId, hostId, {
    rules,
    expectedVersion: 0,
    reason: '启用单区贸易',
  });
});
afterAll(async () => {
  await app.close();
  await db.end();
});
describe('regional trade', () => {
  it('freezes trade, publishes income, fees and policy changes once, then uses new production and shares next season', async () => {
    await start();
    const bill = await settlements.economicPreview(
        gameId,
        hostId,
        quarterId,
        1,
      ),
      before = await status(),
      mapBefore = await revision(),
      version = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion;
    expect(
      bill.lines
        .filter((l) => l.kind === 'Trade')
        .map((l) => l.amount)
        .sort((a, b) => a - b),
    ).toEqual([40, 60]);
    expect(
      bill.trade![0]!.provinces.find((p) => p.id === p1)!.productionBase,
    ).toBe(6);
    const response = await save(
      [
        power(),
        power(south, 20),
        {
          id: randomUUID(),
          actionId,
          kind: 'Province',
          provinceId: p1,
          expectedProfileRevision: 1,
          values: { productionBase: 7 },
          reason: '新工坊建成',
        },
      ],
      1,
      {
        resourceChanges: [
          {
            id: randomUUID(),
            actionId,
            countryId: north,
            expectedResourceRevision: 1,
            resource: 'Treasury',
            amount: -50,
            reason: '商贸协商费用',
          },
        ],
      },
    );
    expect(response.statusCode).toBe(200);
    expect(await status()).toEqual(before);
    expect(
      (await games.trade.get(gameId, northId)).zones[0]!.ownInfluence,
    ).toBe(60);
    expect((await games.trade.get(gameId, northId)).lastIncome).toBeNull();
    await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 2,
      publicReport: '协议完成',
      results: [{ actionId, feedback: '下季扩大生产并执行新分成。' }],
    });
    const records = await Promise.all([publish(3), publish(3)]);
    expect(records[0].publishedAt).toBe(records[1].publishedAt);
    const after = await status();
    expect(after.countries.find((c) => c.id === north)).toMatchObject({
      treasury: 110,
      resourceRevision: 2,
    });
    expect(after.countries.find((c) => c.id === south)).toMatchObject({
      treasury: 140,
      resourceRevision: 2,
    });
    expect(await revision()).toBe(mapBefore + 1);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(version + 1);
    expect(
      (await db.query('SELECT revision FROM trade_zones WHERE id=$1', [zoneId]))
        .rows[0]!.revision,
    ).toBe(1);
    const own = await games.trade.get(gameId, northId);
    expect(own.zones[0]!.ownInfluence).toBe(80);
    expect(own.lastIncome).toMatchObject({
      actualIncome: 60,
      calculatedIncome: 60,
      sources: [{ name: '海湾贸易区', amount: 60 }],
    });
    expect(own.zones[0]).not.toHaveProperty('setup');
    expect(
      (
        await settlements.countries.ledger(gameId, northId, north)
      ).entries.filter((l) => l.reason === '每季经济结算 · 贸易收入'),
    ).toHaveLength(1);
    await settlements.advance(gameId, hostId, quarterId);
    const oldId = quarterId;
    quarterId = (await games.getCurrentQuarter(gameId, hostId)).id;
    await start();
    const next = await settlements.economicPreview(
      gameId,
      hostId,
      quarterId,
      1,
    );
    expect(
      next.lines.find((l) => l.kind === 'Trade' && l.countryId === north)!
        .amount,
    ).toBe(88);
    expect(
      next.lines.find((l) => l.kind === 'Trade' && l.countryId === south)!
        .amount,
    ).toBe(22);
    expect((await settlements.get(gameId, hostId, oldId)).economicBill).toEqual(
      records[0].economicBill,
    );
  });
  it('protects setup with phase, map and zone revisions, exclusive provinces, permissions and old rule clients', async () => {
    expect(
      (
        await setup(
          await zoneInput({
            influences: [
              { countryId: north, power: 60 },
              { countryId: north, power: 40 },
            ],
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await setup(
          await zoneInput({
            influences: [{ countryId: randomUUID(), power: 1 }],
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await setup(await zoneInput({ provinceIds: [p1, p1] }))).statusCode,
    ).toBe(400);
    expect(
      (await setup(await zoneInput({ provinceIds: [randomUUID()] })))
        .statusCode,
    ).toBe(400);
    expect((await setup(await zoneInput({ reason: ' ' }))).statusCode).toBe(
      400,
    );
    expect(
      (
        await setup(
          await zoneInput({ influences: [{ countryId: north, power: 0.001 }] }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await setup(
          await zoneInput({ name: '另一贸易区', expectedRevision: null }),
          randomUUID(),
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (await setup(await zoneInput({ name: '新海湾' }), zoneId, playerCookie))
        .statusCode,
    ).toBe(403);
    const input = await zoneInput({ name: '新海湾' });
    const responses = await Promise.all([setup(input), setup(input)]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(
      (await setup(await zoneInput({ name: '再修改', expectedRevision: 0 })))
        .statusCode,
    ).toBe(409);
    const { tradeCoefficient: _trade, ...oldRules } = rules;
    void _trade;
    await games.economics.set(gameId, hostId, {
      rules: { ...oldRules, taxCoefficient: 1 },
      expectedVersion: 1,
      reason: '旧客户端只改税收',
    });
    expect(
      (await games.economics.get(gameId, hostId)).rules.tradeCoefficient,
    ).toBe(10);
    await start();
    expect(
      (
        await setup(
          await zoneInput({ name: '锁定后修改', expectedRevision: 1 }),
        )
      ).statusCode,
    ).toBe(409);
  });
  it('rejects duplicate targets, invalid values and changed baselines, while recomputing metadata and retaining saved plans', async () => {
    await start();
    const input = power();
    expect((await save([input, { ...power(), power: 90 }])).statusCode).toBe(
      400,
    );
    for (const bad of [
      { ...input, power: -1 },
      { ...input, power: 1000001 },
      { ...input, power: 0.001 },
      { ...input, power: 60 },
      { ...input, reason: ' ' },
      { ...input, countryId: randomUUID() },
      { ...input, zoneId: randomUUID() },
      { ...input, actionId: randomUUID() },
    ])
      expect((await save([bad])).statusCode).toBe(400);
    expect(
      (await save([{ ...input, expectedZoneRevision: 1 }])).statusCode,
    ).toBe(409);
    const saved = await save([
      {
        ...input,
        beforePower: 999,
        zoneName: '伪造',
        countryName: '伪造',
        summary: '伪造',
      },
    ]);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.stateChanges[0]).toMatchObject({
      beforePower: 60,
      zoneName: '海湾贸易区',
      countryName: '北国',
      summary: '海湾贸易区 · 北国：贸易影响力 60 → 80',
    });
    expect((await save([{ ...input, countryId: south }], 2)).statusCode).toBe(
      400,
    );
    await db.query(
      'UPDATE trade_influences SET power=65 WHERE zone_id=$1 AND country_id=$2',
      [zoneId, north],
    );
    await expect(
      settlements.save(gameId, hostId, quarterId, {
        expectedVersion: 2,
        publicReport: '文字',
        results: [],
      }),
    ).rejects.toMatchObject({ code: 'STATE_CHANGE_CONFLICT' });
    await expect(publish()).rejects.toMatchObject({
      code: 'STATE_CHANGE_CONFLICT',
    });
    expect((await save([], 2)).statusCode).toBe(200);
    const recreated = power();
    expect((await save([recreated], 3)).statusCode).toBe(200);
    await db.query('UPDATE trade_zones SET revision=revision+1 WHERE id=$1', [
      zoneId,
    ]);
    expect(
      (await save([{ ...recreated, expectedZoneRevision: 1 }], 4)).statusCode,
    ).toBe(409);
  });
  it('publishes corrected private reports and keeps historical names and source values after later setup changes', async () => {
    await start();
    const bill = await settlements.economicPreview(
      gameId,
      hostId,
      quarterId,
      1,
    );
    const corrected = {
      ...bill,
      lines: bill.lines.map((l) =>
        l.kind === 'Trade' && l.countryId === north
          ? { ...l, amount: 50, adjustmentReason: '临时封锁' }
          : l,
      ),
    };
    expect(
      (await save([], 1, { economicBill: economicBillInput(corrected) }))
        .statusCode,
    ).toBe(200);
    await publish();
    const report = await games.trade.get(gameId, northId);
    expect(report.lastIncome).toMatchObject({
      actualIncome: 50,
      calculatedIncome: 60,
      adjustmentReason: '临时封锁',
      sources: [{ name: '海湾贸易区', amount: 60 }],
    });
    expect(JSON.stringify(report)).not.toContain('南方省');
    expect(JSON.stringify(report)).not.toContain('南国');
    expect(report).not.toHaveProperty('options');
    expect(report.zones[0]).not.toHaveProperty('setup');
    expect((await games.trade.get(gameId, observerId)).zones).toEqual([]);
    await expect(games.trade.get(gameId, northId, south)).rejects.toMatchObject(
      { code: 'COUNTRY_PERMISSION_REQUIRED' },
    );
    await expect(games.trade.get(gameId, outsideId)).rejects.toMatchObject({
      code: 'OBJECT_NOT_FOUND',
    });
    for (const userId of [northId, southId, observerId]) {
      const result = await settlements.get(gameId, userId, quarterId);
      expect(result).not.toHaveProperty('economicBill');
      expect(result).not.toHaveProperty('stateChanges');
    }
    const old = await settlements.get(gameId, hostId, quarterId);
    await settlements.advance(gameId, hostId, quarterId);
    expect(
      (await setup(await zoneInput({ name: '改名后的海湾' }))).statusCode,
    ).toBe(200);
    expect((await games.trade.get(gameId, northId)).lastIncome).toEqual(
      report.lastIncome,
    );
    expect(
      (await settlements.get(gameId, hostId, quarterId)).economicBill,
    ).toEqual(old.economicBill);
  });
  it('preserves legacy five-line bills, and creates no income with a zero coefficient or zero influence', async () => {
    await start();
    await db.query(
      "UPDATE quarters SET economic_snapshot=economic_snapshot-'trade' WHERE id=$1",
      [quarterId],
    );
    expect(
      (
        await settlements.economicPreview(gameId, hostId, quarterId, 1)
      ).lines.some((l) => l.kind === 'Trade'),
    ).toBe(false);
    expect((await save()).statusCode).toBe(200);
    await publish();
    expect((await status()).countries.every((c) => c.treasury === 100)).toBe(
      true,
    );
    await settlements.advance(gameId, hostId, quarterId);
    quarterId = (await games.getCurrentQuarter(gameId, hostId)).id;
    await games.economics.set(gameId, hostId, {
      rules: { ...rules, tradeCoefficient: 0 },
      expectedVersion: 1,
      reason: '暂不计贸易',
    });
    expect((await setup(await zoneInput({ influences: [] }))).statusCode).toBe(
      200,
    );
    await start();
    expect(
      (
        await settlements.economicPreview(gameId, hostId, quarterId, 1)
      ).lines.some((l) => l.kind === 'Trade'),
    ).toBe(false);
    expect((await save()).statusCode).toBe(200);
    await publish();
    await settlements.advance(gameId, hostId, quarterId);
    quarterId = (await games.getCurrentQuarter(gameId, hostId)).id;
    await games.economics.set(gameId, hostId, {
      rules,
      expectedVersion: 2,
      reason: '恢复贸易系数',
    });
    await start();
    const preview = await settlements.economicPreview(
      gameId,
      hostId,
      quarterId,
      1,
    );
    expect(
      preview.lines.filter((l) => l.kind === 'Trade').map((l) => l.amount),
    ).toEqual([0, 0]);
    expect((await save()).statusCode).toBe(200);
    await publish();
    expect(
      (await status()).countries.every(
        (c) => c.treasury === 100 && c.resourceRevision === 1,
      ),
    ).toBe(true);
  });
  it('rolls trade shares, province growth, income, fees and history back when later exploration delivery fails', async () => {
    await start();
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId: north,
      tileIds: [tiles[0]!],
      state: 'Observed',
      sourceActionId: actionId,
      note: '协议实施后的勘察',
    });
    expect(
      (
        await save(
          [
            { ...power(), actionId: null },
            {
              id: randomUUID(),
              actionId: null,
              kind: 'Province',
              provinceId: p1,
              expectedProfileRevision: 1,
              values: { productionBase: 7 },
              reason: '扩建工坊',
            },
          ],
          1,
          {
            resourceChanges: [
              {
                id: randomUUID(),
                actionId: null,
                countryId: north,
                expectedResourceRevision: 1,
                resource: 'Treasury',
                amount: -50,
                reason: '协商费用',
              },
            ],
          },
        )
      ).statusCode,
    ).toBe(200);
    await db.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    const before = await status(),
      zoneBefore = (await games.trade.get(gameId, hostId, north)).zones,
      provinceBefore = await world.provinces.list(gameId, hostId),
      mapBefore = await revision(),
      version = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion;
    await expect(publish()).rejects.toMatchObject({
      code: 'INVALID_EXPLORATION_RESULT',
    });
    expect(await status()).toEqual(before);
    expect((await games.trade.get(gameId, hostId, north)).zones).toEqual(
      zoneBefore,
    );
    expect(await world.provinces.list(gameId, hostId)).toEqual(provinceBefore);
    expect(await revision()).toBe(mapBefore);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(version);
    expect(
      (
        await db.query(
          "SELECT id FROM map_history WHERE game_id=$1 AND kind='PublishStateChanges'",
          [gameId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
  });
});
