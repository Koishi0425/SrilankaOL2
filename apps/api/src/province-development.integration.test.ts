import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import type { SaveSettlementInput, ProvinceStats } from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { economicBillInput } from './modules/settlements/economy.js';
const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' }),
  database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database),
  games = new GameService(database),
  world = new WorldService(database),
  settlements = new SettlementService(database),
  actions = new ActionService(database);
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
  playerId: string,
  observerId: string,
  countryId: string,
  otherCountryId: string,
  provinceId: string,
  mixedId: string,
  actionId: string,
  hostCookie: string,
  playerCookie: string,
  tiles: string[];
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const profile = async () =>
  (
    await database.query(
      'SELECT name,tax_base,production_base,manpower_base,autonomy,unrest,profile_revision FROM provinces WHERE id=$1',
      [provinceId],
    )
  ).rows[0]!;
const nation = async () =>
  (await settlements.countries.status(gameId, hostId)).countries.find(
    (c) => c.id === countryId,
  )!;
const change = (values: Partial<ProvinceStats> = { productionBase: 7 }) => ({
  id: randomUUID(),
  actionId,
  kind: 'Province' as const,
  provinceId,
  expectedProfileRevision: 1,
  values,
  reason: '修建工坊，扩大地方生产。',
});
async function save(
  stateChanges: unknown[],
  version = 1,
  extra: Partial<SaveSettlementInput> = {},
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
    headers: { cookie: hostCookie },
    payload: {
      expectedVersion: version,
      expectedMapRevision: await revision(),
      publicReport: '各国建设与治理。',
      results: [{ actionId, feedback: '工坊建成，地方秩序得到改善。' }],
      stateChanges,
      economicBill: economicBillInput(
        await settlements.economicPreview(gameId, hostId, quarterId, version),
      ),
      ...extra,
    },
  });
}
const publish = (version = 2, mapRevision?: number) =>
  settlements.publish(gameId, hostId, quarterId, version, mapRevision);
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'development-host',
    'development-north',
    'development-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'development-password',
      }),
    );
  [hostId, playerId, observerId] = users.map((u) => u.id) as [
    string,
    string,
    string,
  ];
  const game = await games.create({
    userId: hostId,
    name: '省份发展与治理',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  countryId = countries.find((c) => c.name === '北国')!.id;
  otherCountryId = countries.find((c) => c.name === '南国')!.id;
  for (const [i, user] of users.slice(1).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: user.username,
      role: i === 0 ? 'Player' : 'Observer',
    });
    if (i === 0)
      await games.assignCountry({
        gameId,
        actorUserId: hostId,
        memberId: member.id,
        countryId,
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
              payload: {
                username: u.username,
                password: 'development-password',
              },
            })
          ).headers['set-cookie'],
        ).split(';')[0]!,
    ),
  );
  [hostCookie, playerCookie] = cookies as [string, string];
  await settlements.countries.setBalances(gameId, hostId, countryId, {
    expectedRevision: 0,
    treasury: 1000,
    manpower: 5000,
    reason: '开场国力',
  });
  await world.setup.create(gameId, hostId, {
    name: '本土',
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
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: tiles.slice(0, 2),
    provinceName: '北境',
    regionName: '北境',
    legalOwnerCountryId: countryId,
    controllerCountryId: countryId,
  });
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: tiles.slice(2),
    provinceName: '边境',
    regionName: '边境',
    legalOwnerCountryId: countryId,
    controllerCountryId: countryId,
  });
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tiles[3]!],
    legalOwnerCountryId: otherCountryId,
    controllerCountryId: otherCountryId,
  });
  const provinces = (await world.provinces.list(gameId, hostId)).provinces;
  provinceId = provinces.find((p) => p.name === '北境')!.id;
  mixedId = provinces.find((p) => p.name === '边境')!.id;
  await world.provinces.set(gameId, hostId, provinceId, {
    name: '北境',
    description: '农业与工坊',
    taxBase: 8,
    productionBase: 6,
    manpowerBase: 5,
    autonomy: 15,
    unrest: 2,
    expectedRevision: 0,
    expectedMapRevision: await revision(),
    reason: '开场省份',
  });
  await world.provinces.set(gameId, hostId, mixedId, {
    name: '边境',
    description: '跨国地区',
    taxBase: 2,
    productionBase: 1,
    manpowerBase: 1,
    autonomy: 0,
    unrest: 0,
    expectedRevision: 0,
    expectedMapRevision: await revision(),
    reason: '边境基础',
  });
  await games.economics.set(gameId, hostId, {
    expectedVersion: 0,
    rules: {
      enabled: true,
      taxCoefficient: 10,
      productionCoefficient: 10,
      manpowerCoefficient: 100,
      armyMaintenancePer100: 0,
      administrationCost: 0,
    },
    reason: '基础经济',
  });
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const policy = await actions.create({
    gameId,
    userId: playerId,
    quarterId,
    title: '修建工坊',
    originalText: '投资工坊，安抚地方。',
    category: 'Construction',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  actionId = policy.id;
  await actions.submit({
    gameId,
    userId: playerId,
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
    reason: '允许实施',
  });
  await settlements.begin(gameId, hostId, quarterId);
});
afterAll(async () => {
  await app.close();
  await database.end();
});
describe('provincial policy settlement', () => {
  it('stages costs and development, publishes concurrently once, retains the current economy and changes next season income', async () => {
    const before = await profile(),
      balance = await nation(),
      mapBefore = await revision(),
      worldBefore = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion;
    const input = change({ productionBase: 7, unrest: -1.5 });
    const response = await save(
      [
        {
          ...input,
          beforeValues: { productionBase: 999 },
          provinceName: '伪造',
          summary: '伪造摘要',
        },
      ],
      1,
      {
        resourceChanges: [
          {
            id: randomUUID(),
            actionId,
            countryId,
            expectedResourceRevision: 1,
            resource: 'Treasury',
            amount: -100,
            reason: '修建北境工坊',
          },
        ],
      },
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().data.stateChanges[0]).toMatchObject({
      provinceName: '北境',
      beforeValues: { productionBase: 6, unrest: 2 },
      values: { productionBase: 7, unrest: -1.5 },
      summary: '北境：生产基础 6 → 7，不满 2 → -1.5',
      reason: input.reason,
    });
    expect(await profile()).toEqual(before);
    expect(await nation()).toEqual(balance);
    await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 2,
      publicReport: '保留建设结果',
      results: [{ actionId, feedback: '工坊建成，地方秩序得到改善。' }],
    });
    const records = await Promise.all([
      publish(3, mapBefore),
      publish(3, mapBefore),
    ]);
    expect(records[0].publishedAt).toEqual(records[1].publishedAt);
    expect(await profile()).toMatchObject({
      production_base: 7,
      unrest: '-1.50',
      profile_revision: 2,
    });
    expect(await nation()).toMatchObject({
      treasury: 1034,
      manpower: 5475,
      resourceRevision: 2,
    });
    expect(await revision()).toBe(mapBefore + 1);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(worldBefore + 1);
    const source = records[0]
      .economicBill!.lines.find(
        (l) => l.countryId === countryId && l.kind === 'Production',
      )!
      .sources.find((s) => s.name === '北境')!;
    expect(source.amount).toBe(51);
    const ledger = await settlements.countries.ledger(
      gameId,
      playerId,
      countryId,
    );
    expect(
      ledger.entries.filter((l) => l.reason === '修建北境工坊'),
    ).toHaveLength(1);
    const audit = (
      await database.query(
        "SELECT details FROM map_history WHERE game_id=$1 AND kind='PublishStateChanges'",
        [gameId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details.changes[0].before[0].values.productionBase).toBe(
      6,
    );
    await settlements.advance(gameId, hostId, quarterId);
    const oldId = quarterId;
    quarterId = (await games.getCurrentQuarter(gameId, hostId)).id;
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
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
    await settlements.begin(gameId, hostId, quarterId);
    const next = await settlements.economicPreview(
      gameId,
      hostId,
      quarterId,
      1,
    );
    expect(
      next.lines
        .find((l) => l.countryId === countryId && l.kind === 'Production')!
        .sources.find((s) => s.name === '北境')!.amount,
    ).toBe(59.5);
    expect((await settlements.get(gameId, hostId, oldId)).stateChanges).toEqual(
      records[0].stateChanges,
    );
    expect((await settlements.get(gameId, hostId, oldId)).economicBill).toEqual(
      records[0].economicBill,
    );
  });
  it('allows separate fields on the same province, rejects duplicate final values and preserves untouched attributes', async () => {
    const tax = change({ taxBase: 9 }),
      autonomy = {
        ...change({ autonomy: 10 }),
        actionId: null,
        reason: '回合事件：调整地方权力',
      };
    expect((await save([tax, { ...change({ taxBase: 10 }) }])).statusCode).toBe(
      400,
    );
    expect((await save([tax, autonomy])).statusCode).toBe(200);
    await publish(2, await revision());
    expect(await profile()).toMatchObject({
      tax_base: 9,
      production_base: 6,
      manpower_base: 5,
      autonomy: '10.00',
      unrest: '2.00',
      profile_revision: 2,
    });
  });
  it('validates bounds, reasons, game membership, policy approval and immutable targets', async () => {
    const invalid = [
      { ...change(), values: {} },
      { ...change(), values: { productionBase: 6 } },
      { ...change(), reason: ' ' },
      { ...change(), values: { productionBase: 1.5 } },
      { ...change(), values: { productionBase: 1000001 } },
      { ...change(), values: { autonomy: 100.01 } },
      { ...change(), values: { unrest: -100.01 } },
      { ...change(), values: { unrest: 0.001 } },
      { ...change(), values: { unknown: 2 } },
      { ...change(), provinceId: randomUUID() },
      { ...change(), actionId: randomUUID() },
    ];
    for (const input of invalid)
      expect((await save([input])).statusCode).toBe(400);
    const old = change();
    expect((await save([old])).statusCode).toBe(200);
    expect(
      (await save([{ ...old, values: { taxBase: 9 } }], 2)).statusCode,
    ).toBe(400);
    expect((await save([{ ...old, provinceId: mixedId }], 2)).statusCode).toBe(
      400,
    );
    expect(
      (
        await save(
          [{ ...old, values: { productionBase: 8 }, reason: '修订计划' }],
          2,
        )
      ).statusCode,
    ).toBe(200);
    // Build a real second game after ending the first; historical games cannot be edited.
    await games.end(gameId, hostId, {
      expectedQuarterId: quarterId,
      expectedQuarterState: 'Resolving',
      reason: '建立跨局隔离测试',
    });
    const wrongGame = await games.create({
      userId: hostId,
      name: '外部游戏',
      countryNames: [],
    });
    const foreign = randomUUID(),
      foreignMap = randomUUID();
    await database.query(
      "INSERT INTO world_maps(id,game_id,name,width,height) VALUES($1,$2,'外部地图',1,1)",
      [foreignMap, wrongGame.id],
    );
    await database.query(
      'INSERT INTO provinces(id,game_id,map_id,name) VALUES($1,$2,$3,$4)',
      [foreign, wrongGame.id, foreignMap, '外省'],
    );
    expect(
      (
        await save(
          [{ ...change(), provinceId: foreign, expectedProfileRevision: 0 }],
          3,
        )
      ).statusCode,
    ).toBe(400);
  });
  it('freezes original profile and map revisions even for older clients or refreshed drafts', async () => {
    expect(
      (await save([{ ...change(), expectedProfileRevision: 0 }])).statusCode,
    ).toBe(409);
    const input = change();
    expect((await save([input])).statusCode).toBe(200);
    await database.query('UPDATE provinces SET manpower_base=50 WHERE id=$1', [
      provinceId,
    ]);
    await expect(
      settlements.save(gameId, hostId, quarterId, {
        expectedVersion: 2,
        publicReport: '文字',
        results: [],
      }),
    ).rejects.toMatchObject({ code: 'STATE_CHANGE_CONFLICT' });
    await expect(publish(2, await revision())).rejects.toMatchObject({
      code: 'STATE_CHANGE_CONFLICT',
    });
    expect(
      (await save([{ ...input, expectedProfileRevision: 1 }], 2)).statusCode,
    ).toBe(409);
    expect((await save([], 2)).statusCode).toBe(200);
    const recreated = { ...change(), id: randomUUID() };
    expect((await save([recreated], 3)).statusCode).toBe(200);
    await database.query(
      'UPDATE world_maps SET asset_version=asset_version+1 WHERE game_id=$1',
      [gameId],
    );
    await expect(publish(4, (await revision()) - 1)).rejects.toMatchObject({
      code: 'MAP_VERSION_CONFLICT',
    });
  });
  it('limits options and complete adjudication to hosts and retains mixed-province privacy after publication', async () => {
    const options = await settlements.options(gameId, hostId, quarterId);
    expect(options.provinces).toHaveLength(2);
    expect(options.provinces!.find((p) => p.id === provinceId)).toMatchObject({
      revision: 1,
      values: { productionBase: 6 },
    });
    for (const userId of [playerId, observerId])
      await expect(
        settlements.options(gameId, userId, quarterId),
      ).rejects.toMatchObject({ code: 'HOST_PERMISSION_REQUIRED' });
    const input = { ...change({ unrest: 1 }), provinceId: mixedId };
    expect((await save([input])).statusCode).toBe(200);
    const denied = await app.inject({
      method: 'PUT',
      url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
      headers: { cookie: playerCookie },
      payload: {
        expectedVersion: 2,
        expectedMapRevision: await revision(),
        publicReport: '',
        results: [],
        stateChanges: [input],
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      await settlements.get(gameId, playerId, quarterId),
    ).not.toHaveProperty('stateChanges');
    await publish(2, await revision());
    for (const userId of [playerId, observerId])
      expect(
        await settlements.get(gameId, userId, quarterId),
      ).not.toHaveProperty('stateChanges');
    expect(
      (await world.provinces.list(gameId, playerId)).provinces.find(
        (p) => p.id === mixedId,
      )!.values,
    ).toBeNull();
    expect((await world.provinces.list(gameId, observerId)).provinces).toEqual(
      [],
    );
  });
  it('rolls province changes, revisions, costs, income and history back when later exploration delivery fails', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[0]!],
      state: 'Observed',
      sourceActionId: actionId,
      note: '建设完成后勘察',
    });
    expect(
      (
        await save([change()], 1, {
          resourceChanges: [
            {
              id: randomUUID(),
              actionId: null,
              countryId,
              expectedResourceRevision: 1,
              resource: 'Treasury',
              amount: -100,
              reason: '建设拨款',
            },
          ],
        })
      ).statusCode,
    ).toBe(200);
    await database.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    // Leave the development as a valid round event so the failure happens after truth writes.
    await database.query(
      "UPDATE quarter_settlements SET state_changes=jsonb_set(state_changes,'{0,change,actionId}','null'::jsonb) WHERE quarter_id=$1",
      [quarterId],
    );
    const before = await profile(),
      nationalBefore = await nation(),
      mapBefore = await revision(),
      version = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
      ledgerBefore = await settlements.countries.ledger(
        gameId,
        playerId,
        countryId,
      );
    await expect(publish(2, mapBefore)).rejects.toMatchObject({
      code: 'INVALID_EXPLORATION_RESULT',
    });
    expect(await profile()).toEqual(before);
    expect(await nation()).toEqual(nationalBefore);
    expect(await revision()).toBe(mapBefore);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(version);
    expect(
      await settlements.countries.ledger(gameId, playerId, countryId),
    ).toEqual(ledgerBefore);
    expect(
      (
        await database.query(
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
