import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type {
  EconomicBill,
  EconomicRules,
  SaveSettlementInput,
} from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
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
  otherId: string,
  observerId: string,
  countryId: string,
  otherCountryId: string,
  armyId: string,
  provinceId: string,
  actionId: string,
  hostCookie: string,
  playerCookie: string,
  tiles: string[];
const rules: EconomicRules = {
  enabled: true,
  taxCoefficient: 10,
  productionCoefficient: 10,
  manpowerCoefficient: 100,
  armyMaintenancePer100: 1,
  administrationCost: 2,
};
const baseUrl = () => `/api/v1/games/${gameId}`;
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const national = () => settlements.countries.status(gameId, hostId);
const bill = (version = 1) =>
  settlements.economicPreview(gameId, hostId, quarterId, version);
const snapshot = async () =>
  (
    await database.query('SELECT economic_snapshot FROM quarters WHERE id=$1', [
      quarterId,
    ])
  ).rows[0]!.economic_snapshot;
async function save(
  economicBill: EconomicBill | null,
  expectedVersion = 1,
  extra: Partial<SaveSettlementInput> = {},
) {
  return app.inject({
    method: 'PUT',
    url: `${baseUrl()}/quarters/${quarterId}/settlement`,
    headers: { cookie: hostCookie },
    payload: {
      expectedVersion,
      publicReport: '本季各国经营与军备。',
      results: [{ actionId, feedback: '政策完成。' }],
      economicBill: economicBill ? economicBillInput(economicBill) : null,
      ...extra,
    },
  });
}
async function start(enable = true) {
  if (enable)
    await games.economics.set(gameId, hostId, {
      rules,
      expectedVersion: 0,
      reason: '开场经济规则',
    });
  await games.transitionCurrentQuarter({
    gameId,
    userId: hostId,
    state: 'ActionSubmission',
  });
  const action = await actions.create({
    gameId,
    userId: playerId,
    quarterId,
    title: '整军',
    originalText: '征募与整备',
    category: 'Military',
    secrecy: 'OwnerOnly',
    refs: [],
  });
  actionId = action.id;
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
    reason: '可行',
  });
  await settlements.begin(gameId, hostId, quarterId);
}
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'economy-host',
    'economy-north',
    'economy-south',
    'economy-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'economy-password',
      }),
    );
  [hostId, playerId, otherId, observerId] = users.map((u) => u.id) as [
    string,
    string,
    string,
    string,
  ];
  const game = await games.create({
    userId: hostId,
    name: '每季经济',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  [countryId, otherCountryId] = (await games.listCountries(gameId, hostId)).map(
    (c) => c.id,
  ) as [string, string];
  for (const [i, user] of users.slice(1).entries()) {
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
        countryId: i === 0 ? countryId : otherCountryId,
      });
  }
  const cookies = await Promise.all(
    users.slice(0, 2).map(
      async (user) =>
        String(
          (
            await app.inject({
              method: 'POST',
              url: '/api/v1/auth/login',
              payload: {
                username: user.username,
                password: 'economy-password',
              },
            })
          ).headers['set-cookie'],
        ).split(';')[0]!,
    ),
  );
  [hostCookie, playerCookie] = cookies as [string, string];
  for (const [id, treasury] of [
    [countryId, 1000],
    [otherCountryId, 400],
  ] as const)
    await settlements.countries.setBalances(gameId, hostId, id, {
      expectedRevision: 0,
      treasury,
      manpower: 500,
      reason: '开场余额',
    });
  await world.setup.create(gameId, hostId, {
    name: '本土',
    width: 6,
    height: 1,
  });
  const data = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 5,
      minR: 0,
      maxR: 0,
    })
  ).tiles;
  tiles = Array.from({ length: 6 }, (_, i) => data.find((t) => t.q === i)!.id);
  for (const [ids, name, owner] of [
    [tiles.slice(0, 4), '北境', countryId],
    [tiles.slice(4, 6), '南岸', otherCountryId],
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
      description: '',
      expectedRevision: 0,
      expectedMapRevision: await revision(),
      taxBase: name === '北境' ? 8 : 2,
      productionBase: name === '北境' ? 6 : 1,
      manpowerBase: name === '北境' ? 5 : 1,
      autonomy: name === '北境' ? 15 : 0,
      unrest: 0,
      reason: '省份基础',
    });
    if (name === '北境') provinceId = province.id;
  }
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tiles[3]!],
    controllerCountryId: otherCountryId,
  });
  await world.createArmy({
    gameId,
    userId: hostId,
    countryId,
    tileId: tiles[0]!,
    name: '北军',
    strength: 600,
  });
  armyId = (await world.getTile(gameId, hostId, tiles[0]!)).armies[0]!.id;
  await world.createArmy({
    gameId,
    userId: hostId,
    countryId: otherCountryId,
    tileId: tiles[4]!,
    name: '南军',
    strength: 300,
  });
});
afterAll(async () => {
  await app.close();
  await database.end();
});
describe('quarter economic accounting', () => {
  it('stages calculated income, occupation losses and fees before recruitment, atomically publishes once and retains private history', async () => {
    await start();
    const preview = await bill();
    const own = preview.lines.filter((l) => l.countryId === countryId);
    expect(own.map((l) => l.calculatedAmount)).toEqual([
      51, 38.25, 318, -6, -2,
    ]);
    expect(
      preview.lines
        .filter((l) => l.countryId === otherCountryId)
        .map((l) => l.calculatedAmount),
    ).toEqual([20, 10, 100, -3, -2]);
    const before = await national(),
      mapBefore = await revision(),
      worldBefore = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion;
    const recruit = {
      id: randomUUID(),
      actionId,
      kind: 'Reinforce' as const,
      armyId,
      strength: 900,
      treasuryCost: 100,
      manpowerCost: 900,
      expectedResourceRevision: 1,
      note: '征募新兵',
    };
    const extra: Partial<SaveSettlementInput> = {
      expectedMapRevision: mapBefore,
      recruitments: [recruit],
      stateChanges: [
        {
          id: randomUUID(),
          actionId,
          kind: 'Territory',
          tileIds: [tiles[3]!],
          controllerCountryId: countryId,
        },
      ],
      resourceChanges: [
        {
          id: randomUUID(),
          actionId: null,
          countryId,
          resource: 'Manpower',
          amount: 200,
          expectedResourceRevision: 1,
          reason: '迁入人口',
        },
        {
          id: randomUUID(),
          actionId: null,
          countryId,
          resource: 'Treasury',
          amount: -50,
          expectedResourceRevision: 1,
          reason: '修缮',
        },
      ],
    };
    const saved = await save(preview, 1, extra);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.resourceChanges).toHaveLength(2);
    expect(saved.json().data.economicBill.effects).toHaveLength(10);
    expect(
      saved
        .json()
        .data.recruitments[0].costs.find(
          (c: { resource: string }) => c.resource === 'Manpower',
        ),
    ).toMatchObject({ before: 1018, after: 118 });
    expect(await national()).toEqual(before);
    await expect(
      settlements.economicPreview(gameId, playerId, quarterId, 2),
    ).rejects.toMatchObject({ code: 'HOST_PERMISSION_REQUIRED' });
    for (const user of [playerId, otherId, observerId]) {
      const response = await settlements.get(gameId, user, quarterId);
      expect(response).not.toHaveProperty('economicBill');
      expect(response).not.toHaveProperty('economyStatus');
    }
    const published = await Promise.all([
      settlements.publish(gameId, hostId, quarterId, 2, mapBefore),
      settlements.publish(gameId, hostId, quarterId, 2, mapBefore),
    ]);
    expect(published[0].publishedAt).toBe(published[1].publishedAt);
    expect(
      (await national()).countries.find((c) => c.id === countryId),
    ).toMatchObject({
      treasury: 931.25,
      manpower: 118,
      resourceRevision: 2,
      armies: [{ strength: 1500 }],
    });
    expect(
      (await national()).countries.find((c) => c.id === otherCountryId),
    ).toMatchObject({ treasury: 425, manpower: 600 });
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(worldBefore + 1);
    expect(await revision()).toBe(mapBefore + 1);
    const ledger = await settlements.countries.ledger(
      gameId,
      playerId,
      countryId,
    );
    expect(ledger.entries).toHaveLength(11);
    expect(JSON.stringify(ledger)).not.toContain('南军');
    await settlements.advance(gameId, hostId, quarterId);
    await games.economics.set(gameId, hostId, {
      rules: { ...rules, taxCoefficient: 20 },
      expectedVersion: 1,
      reason: '下一季规则',
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).economicBill,
    ).toEqual(published[0].economicBill);
  });
  it('captures once at first opening, survives reopening and ignores later provincial, army and coefficient changes', async () => {
    await games.economics.set(gameId, hostId, {
      rules,
      expectedVersion: 0,
      reason: '规则',
    });
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const original = await snapshot();
    await world.createArmy({
      gameId,
      userId: hostId,
      countryId,
      tileId: tiles[0]!,
      name: '后建军队',
      expectedRevision: await revision(),
      correctionReason: '验收期初快照：补正军队',
      strength: 2000,
    });
    await database.query(
      'UPDATE provinces SET tax_base=800,autonomy=0 WHERE id=$1',
      [provinceId],
    );
    await database.query(
      'UPDATE games SET economic_rules=$2::jsonb WHERE id=$1',
      [gameId, JSON.stringify({ ...rules, taxCoefficient: 100 })],
    );
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'Locked',
    });
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    expect(await snapshot()).toEqual(original);
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
    const generated = await bill();
    expect(generated.rules.taxCoefficient).toBe(10);
    expect(
      generated.lines
        .filter((l) => l.countryId === countryId)
        .map((l) => l.amount),
    ).toEqual([51, 38.25, 318, -6, -2]);
    expect(
      generated.lines
        .find((l) => l.countryId === countryId && l.kind === 'ArmyMaintenance')!
        .sources.map((s) => s.name),
    ).toEqual(['北军']);
  });
  it('protects settings with phase, revision and permissions; disabled and migrated quarters keep manual settlement', async () => {
    expect((await games.economics.get(gameId, playerId)).rules.enabled).toBe(
      false,
    );
    const settingUrl = `${baseUrl()}/economic-rules`;
    const valid = { rules, expectedVersion: 0, reason: '规则' };
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: settingUrl,
          headers: { cookie: playerCookie },
          payload: valid,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: settingUrl,
          headers: { cookie: hostCookie },
          payload: { ...valid, rules: { ...rules, taxCoefficient: 0.001 } },
        })
      ).statusCode,
    ).toBe(400);
    await start(false);
    await expect(
      games.economics.set(gameId, hostId, valid),
    ).rejects.toMatchObject({ code: 'ECONOMIC_RULES_LOCKED' });
    await expect(bill()).rejects.toMatchObject({ code: 'ECONOMY_UNAVAILABLE' });
    expect((await save(null)).statusCode).toBe(200);
    await settlements.publish(gameId, hostId, quarterId, 2);
    expect(
      (await national()).countries.find((c) => c.id === countryId)!.treasury,
    ).toBe(1000);
    await settlements.advance(gameId, hostId, quarterId);
    quarterId = (await games.getCurrentQuarter(gameId, hostId)).id;
    await games.economics.set(gameId, hostId, valid);
    await expect(
      games.economics.set(gameId, hostId, valid),
    ).rejects.toMatchObject({ code: 'ECONOMIC_RULES_VERSION_CONFLICT' });
    expect(
      (
        await database.query(
          'SELECT id FROM economic_rule_history WHERE game_id=$1',
          [gameId],
        )
      ).rowCount,
    ).toBe(1);
    // A pre-migration active quarter has no trustworthy period-start snapshot.
    await database.query(
      "UPDATE quarters SET state='HostReview',economic_snapshot=NULL WHERE id=$1",
      [quarterId],
    );
    await settlements.begin(gameId, hostId, quarterId);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).economyStatus!.status,
    ).toBe('MissingSnapshot');
    await expect(bill()).rejects.toMatchObject({ code: 'ECONOMY_UNAVAILABLE' });
  });
  it('requires review, recomputes authoritative metadata, validates corrections and rejects missing, duplicate or foreign lines', async () => {
    await start();
    const preview = await bill();
    expect((await save(null)).statusCode).toBe(200);
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2),
    ).rejects.toMatchObject({ code: 'ECONOMIC_BILL_REQUIRED' });
    const invalid = [
      { ...preview, lines: preview.lines.slice(1) },
      {
        ...preview,
        lines: preview.lines.map((l, i) =>
          i === 1 ? { ...l, id: preview.lines[0]!.id } : l,
        ),
      },
      {
        ...preview,
        lines: preview.lines.map((l, i) =>
          i === 0 ? { ...l, countryId: randomUUID() } : l,
        ),
      },
      {
        ...preview,
        lines: preview.lines.map((l, i) =>
          i === 0 ? { ...l, amount: 50 } : l,
        ),
      },
      {
        ...preview,
        lines: preview.lines.map((l, i) =>
          i === 2 ? { ...l, amount: 1.5, adjustmentReason: '修正' } : l,
        ),
      },
      {
        ...preview,
        lines: preview.lines.map((l, i) =>
          i === 0 ? { ...l, amount: -1, adjustmentReason: '修正' } : l,
        ),
      },
      {
        ...preview,
        lines: preview.lines.map((l, i) =>
          i === 3 ? { ...l, amount: 1, adjustmentReason: '修正' } : l,
        ),
      },
    ];
    for (const changed of invalid)
      expect((await save(changed, 2)).statusCode).toBe(400);
    const corrected = {
      ...preview,
      lines: preview.lines.map((l) =>
        l.countryId === countryId && l.kind === 'Tax'
          ? {
              ...l,
              amount: 50,
              calculatedAmount: 9999,
              countryName: '伪造',
              sources: [],
              adjustmentReason: '减免税收',
            }
          : l,
      ),
    };
    const saved = await save(corrected, 2);
    expect(saved.statusCode).toBe(200);
    const savedTax = saved
      .json()
      .data.economicBill.lines.find(
        (l: { countryId: string; kind: string }) =>
          l.countryId === countryId && l.kind === 'Tax',
      );
    expect(savedTax).toMatchObject({
      amount: 50,
      calculatedAmount: 51,
      adjustmentReason: '减免税收',
    });
    expect(savedTax.sources).toHaveLength(1);
    await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 3,
      publicReport: '改文字',
      results: [{ actionId, feedback: '完成' }],
    });
    expect(
      (
        await settlements.get(gameId, hostId, quarterId)
      ).economicBill!.lines.find(
        (l) => l.countryId === countryId && l.kind === 'Tax',
      )!.amount,
    ).toBe(50);
    const duplicateCost = {
      id: preview.lines[0]!.id,
      actionId: null,
      countryId,
      resource: 'Treasury' as const,
      amount: -1,
      reason: '重复费用',
      expectedResourceRevision: 1,
    };
    expect(
      (await save(corrected, 4, { resourceChanges: [duplicateCost] }))
        .statusCode,
    ).toBe(400);
  });
  it('freezes saved balances, supports explicit regeneration and removes all automatic effects with the bill', async () => {
    await start();
    const preview = await bill();
    expect((await save(preview)).statusCode).toBe(200);
    await database.query(
      'UPDATE countries SET treasury=900,resource_revision=resource_revision+1 WHERE id=$1',
      [countryId],
    );
    await expect(
      settlements.save(gameId, hostId, quarterId, {
        expectedVersion: 2,
        publicReport: '文字',
        results: [],
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2),
    ).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    const regenerated = await bill(2);
    expect(
      regenerated.lines.find((l) => l.countryId === countryId)!
        .expectedResourceRevision,
    ).toBe(2);
    expect((await save(regenerated, 2)).statusCode).toBe(200);
    expect((await save(null, 3)).statusCode).toBe(200);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).economicBill,
    ).toBeNull();
    expect(
      (await national()).countries.find((c) => c.id === countryId)!.treasury,
    ).toBe(900);
    await expect(
      settlements.publish(gameId, hostId, quarterId, 4),
    ).rejects.toMatchObject({ code: 'ECONOMIC_BILL_REQUIRED' });
    expect((await save(await bill(4), 4)).statusCode).toBe(200);
    await settlements.publish(gameId, hostId, quarterId, 5);
    expect(
      (await national()).countries.find((c) => c.id === countryId)!.treasury,
    ).toBe(981.25);
  });
  it('allows manpower overflow to be corrected before saving, while preserving the original calculation', async () => {
    await start();
    await database.query(
      'UPDATE countries SET manpower=2147483600 WHERE id=$1',
      [countryId],
    );
    const preview = await bill();
    expect((await save(preview)).statusCode).toBe(400);
    const corrected = {
      ...preview,
      lines: preview.lines.map((l) =>
        l.countryId === countryId && l.kind === 'ManpowerGrowth'
          ? { ...l, amount: 47, adjustmentReason: '本季停止额外征募' }
          : l,
      ),
    };
    expect((await save(corrected)).statusCode).toBe(200);
    await settlements.publish(gameId, hostId, quarterId, 2);
    expect(
      (await national()).countries.find((c) => c.id === countryId)!.manpower,
    ).toBe(2147483647);
    expect(
      (
        await settlements.get(gameId, hostId, quarterId)
      ).economicBill!.lines.find(
        (l) => l.countryId === countryId && l.kind === 'ManpowerGrowth',
      )!.calculatedAmount,
    ).toBe(318);
  });
  it('rolls ledger, income, manpower and army truth back when a later exploration publication fails', async () => {
    await start();
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[0]!],
      state: 'Observed',
      note: '本土',
      sourceActionId: actionId,
    });
    const preview = await bill(),
      mapBefore = await revision();
    expect(
      (
        await save(preview, 1, {
          expectedMapRevision: mapBefore,
          stateChanges: [
            {
              id: randomUUID(),
              actionId: null,
              kind: 'ArmyStrength',
              armyId,
              strength: 800,
            },
          ],
        })
      ).statusCode,
    ).toBe(200);
    await database.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    const before = await national(),
      version = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion;
    const ledgerBefore = await settlements.countries.ledger(
      gameId,
      playerId,
      countryId,
    );
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2, mapBefore),
    ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
    expect(await national()).toEqual(before);
    expect(await revision()).toBe(mapBefore);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(version);
    expect(
      await settlements.countries.ledger(gameId, playerId, countryId),
    ).toEqual(ledgerBefore);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
  });
});
