import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type {
  RecruitmentInput,
  ResourceChangeInput,
} from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database),
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
  countryId: string,
  otherCountryId: string,
  actionId: string,
  armyId: string,
  tileId: string,
  hostCookie: string,
  playerCookie: string;
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const national = () => settlements.countries.status(gameId, hostId);
const ledger = () => settlements.countries.ledger(gameId, playerId, countryId);
const create = (extra: Partial<RecruitmentInput> = {}): RecruitmentInput =>
  ({
    id: randomUUID(),
    actionId: null,
    kind: 'Create',
    countryId,
    name: '第二军',
    tileId,
    strength: 300,
    treasuryCost: 100.15,
    manpowerCost: 300,
    expectedResourceRevision: 1,
    note: '征募本地志愿兵',
    ...extra,
  }) as RecruitmentInput;
const reinforce = (): RecruitmentInput => ({
  id: randomUUID(),
  actionId,
  kind: 'Reinforce',
  armyId,
  strength: 200,
  treasuryCost: 80,
  manpowerCost: 200,
  expectedResourceRevision: 1,
  note: '补足第一军',
});
async function save(
  recruitments: RecruitmentInput[],
  expectedVersion = 1,
  extra: Record<string, unknown> = {},
  cookie = hostCookie,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
    headers: { cookie },
    payload: {
      expectedVersion,
      expectedMapRevision: await revision(),
      publicReport: '各国整顿军备。',
      results: [{ actionId, feedback: '征募完成。' }],
      recruitments,
      ...extra,
    },
  });
}
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of ['recruit-host', 'recruit-player', 'recruit-other'])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'recruit-password',
      }),
    );
  [hostId, playerId, otherId] = users.map((u) => u.id) as [
    string,
    string,
    string,
  ];
  const game = await games.create({
    userId: hostId,
    name: '征兵结算',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  [countryId, otherCountryId] = (await games.listCountries(gameId, hostId)).map(
    (c) => c.id,
  ) as [string, string];
  for (const [index, user] of users.slice(1).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: user.username,
      role: 'Player',
    });
    await games.assignCountry({
      gameId,
      actorUserId: hostId,
      memberId: member.id,
      countryId: index === 0 ? countryId : otherCountryId,
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
                password: 'recruit-password',
              },
            })
          ).headers['set-cookie'],
        ).split(';')[0]!,
    ),
  );
  [hostCookie, playerCookie] = cookies as [string, string];
  await settlements.countries.setBalances(gameId, hostId, countryId, {
    expectedRevision: 0,
    treasury: 1000.25,
    manpower: 1000,
    reason: '开场',
  });
  await world.setup.create(gameId, hostId, {
    name: '本土',
    width: 2,
    height: 1,
  });
  tileId = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 1,
      minR: 0,
      maxR: 0,
    })
  ).tiles[0]!.id;
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tileId],
    controllerCountryId: countryId,
    legalOwnerCountryId: countryId,
  });
  await world.createArmy({
    gameId,
    userId: hostId,
    tileId,
    countryId,
    name: '第一军',
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
    title: '整军',
    originalText: '扩充常备军',
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
    reason: '允许整軍',
  });
  await settlements.begin(gameId, hostId, quarterId);
});
afterAll(async () => {
  await app.close();
  await database.end();
});
describe('recruitment settlement', () => {
  it('stages new armies and reinforcements with ordered costs, publishes once and keeps private immutable records', async () => {
    const plans = [create(), reinforce()];
    const income: ResourceChangeInput = {
      id: randomUUID(),
      actionId: null,
      countryId,
      expectedResourceRevision: 1,
      resource: 'Treasury',
      amount: 200.1,
      reason: '税收',
    };
    const before = await national(),
      mapRevision = await revision();
    const worldBefore = (await games.getForUser(gameId, hostId)).currentQuarter
      .currentWorldVersion;
    const saved = await save(plans, 1, { resourceChanges: [income] });
    expect(saved.statusCode).toBe(200);
    const data = saved.json().data;
    expect(data.resourceChanges).toHaveLength(1); // Fees have one owner, the recruitment.
    expect(data.recruitments[0]).toMatchObject({
      beforeStrength: 0,
      afterStrength: 300,
      costs: [
        { resource: 'Treasury', before: 1200.35, after: 1100.2 },
        { resource: 'Manpower', before: 1000, after: 700 },
      ],
    });
    expect(data.recruitments[1].costs[0]).toMatchObject({
      before: 1100.2,
      after: 1020.2,
    });
    expect(await national()).toEqual(before);
    expect((await ledger()).entries).toHaveLength(2);
    expect(
      await settlements.get(gameId, playerId, quarterId),
    ).not.toHaveProperty('recruitments');
    expect((await save(plans, 2, {}, playerCookie)).statusCode).toBe(403);
    const published = await Promise.all([
      settlements.publish(gameId, hostId, quarterId, 2, mapRevision),
      settlements.publish(gameId, hostId, quarterId, 2, mapRevision),
    ]);
    expect(published[0].publishedAt).toBe(published[1].publishedAt);
    expect(await revision()).toBe(mapRevision + 1);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(worldBefore + 1);
    const own = (await national()).countries.find((c) => c.id === countryId)!;
    expect(own).toMatchObject({
      treasury: 1020.2,
      manpower: 500,
      resourceRevision: 2,
    });
    expect(own.armies).toHaveLength(2);
    expect(own.armies.find((a) => a.id === plans[0]!.id)).toMatchObject({
      name: '第二军',
      strength: 300,
    });
    expect(own.armies.find((a) => a.id === armyId)!.strength).toBe(300);
    expect((await ledger()).entries).toHaveLength(7);
    expect(
      (await settlements.countries.status(gameId, otherId)).countries[0]!
        .armies,
    ).toHaveLength(0);
    expect(
      await settlements.get(gameId, otherId, quarterId),
    ).not.toHaveProperty('recruitments');
    await settlements.advance(gameId, hostId, quarterId);
    await settlements.countries.setBalances(gameId, hostId, countryId, {
      expectedRevision: 2,
      treasury: 2000,
      manpower: 500,
      reason: '次季资源',
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).recruitments,
    ).toEqual(published[0].recruitments);
  });
  it('rejects foreign targets, invalid fees, duplicate recruits and conflicting final strengths', async () => {
    const invalid = [
      create({ countryId: randomUUID() }),
      create({ tileId: randomUUID() }),
      create({ name: '第一军' }),
      create({ strength: 0 }),
      create({ treasuryCost: -1 }),
      create({ treasuryCost: 0.001 }),
      create({ manpowerCost: 1.5 }),
      create({ manpowerCost: 1001 }),
      create({ actionId: randomUUID() }),
      create({ note: '' }),
      create({ expectedResourceRevision: 0 }),
      create({ id: armyId }),
    ];
    for (const plan of invalid)
      expect((await save([plan])).statusCode).toBeGreaterThanOrEqual(400);
    expect((await save([create(), create()])).statusCode).toBe(400);
    expect((await save([reinforce(), reinforce()])).statusCode).toBe(400);
    const conflict = await save([reinforce()], 1, {
      stateChanges: [
        {
          id: randomUUID(),
          actionId,
          kind: 'ArmyStrength',
          armyId,
          strength: 50,
        },
      ],
    });
    expect(conflict.json().error.code).toBe('INVALID_RECRUITMENT');
    const costs = await save([
      create({ name: '第二军', manpowerCost: 600 }),
      create({ name: '第三军', manpowerCost: 600 }),
    ]);
    expect(costs.statusCode).toBe(400);
    expect(
      (await national()).countries.find((c) => c.id === countryId)!.armies,
    ).toHaveLength(1);
    // Ordinary manpower income is applied before recruitment expenses.
    expect(
      (
        await save([create({ manpowerCost: 1100 })], 1, {
          resourceChanges: [
            {
              id: randomUUID(),
              actionId: null,
              countryId,
              expectedResourceRevision: 1,
              resource: 'Manpower',
              amount: 200,
              reason: '人口迁入',
            },
          ],
        })
      ).statusCode,
    ).toBe(200);
  });
  it('preserves fees for older clients, updates them once and removes them with the recruitment', async () => {
    const plan = create();
    const first = await save([plan]);
    expect(first.statusCode).toBe(200);
    const ids = first
      .json()
      .data.recruitments[0].costs.map((c: { id: string }) => c.id);
    const changed = { ...plan, treasuryCost: 200, note: '增加训练开支' };
    const second = await save([changed], 2);
    expect(second.statusCode).toBe(200);
    expect(
      second.json().data.recruitments[0].costs.map((c: { id: string }) => c.id),
    ).toEqual(ids);
    await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 3,
      publicReport: '文字修订',
      results: [{ actionId, feedback: '整军完成' }],
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).recruitments![0]!
        .treasuryCost,
    ).toBe(200);
    const forged = await save([changed], 4, {
      resourceChanges: [
        {
          id: ids[0],
          actionId: null,
          countryId,
          expectedResourceRevision: 1,
          resource: 'Treasury',
          amount: -200,
          reason: '重复费用',
        },
      ],
    });
    expect(forged.statusCode).toBe(400);
    expect(
      (
        await save(
          [{ ...changed, kind: 'Create', name: '换名' } as RecruitmentInput],
          4,
        )
      ).statusCode,
    ).toBe(400);
    expect((await save([], 4)).statusCode).toBe(200);
    const before = await national(),
      entries = await ledger(),
      mapRevision = await revision();
    await settlements.publish(gameId, hostId, quarterId, 5);
    expect(await national()).toEqual(before);
    expect(await ledger()).toEqual(entries);
    expect(await revision()).toBe(mapRevision);
  });
  it('rejects stale resource and army baselines without silently rebasing', async () => {
    const plan = reinforce();
    expect((await save([plan])).statusCode).toBe(200);
    await database.query('UPDATE armies SET strength=101 WHERE id=$1', [
      armyId,
    ]);
    await expect(
      settlements.save(gameId, hostId, quarterId, {
        expectedVersion: 2,
        publicReport: '修改',
        results: [],
      }),
    ).rejects.toMatchObject({ code: 'RECRUITMENT_STATE_CONFLICT' });
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2, await revision()),
    ).rejects.toMatchObject({ code: 'RECRUITMENT_STATE_CONFLICT' });
    await database.query('UPDATE armies SET strength=100 WHERE id=$1', [
      armyId,
    ]);
    await database.query(
      'UPDATE countries SET resource_revision=2,manpower=900 WHERE id=$1',
      [countryId],
    );
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2, await revision()),
    ).rejects.toMatchObject({ code: 'RESOURCE_VERSION_CONFLICT' });
    expect(
      (await save([{ ...plan, expectedResourceRevision: 2 }], 2)).statusCode,
    ).toBe(409);
    expect(
      (
        await save(
          [{ ...plan, id: randomUUID(), expectedResourceRevision: 2 }],
          2,
        )
      ).statusCode,
    ).toBe(200);
  });
  it('refreshes exploration after creating and reinforcing armies and supports explicit zero cost', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tileId],
      state: 'Observed',
      note: '侦察本土',
      sourceActionId: actionId,
      armyErrorPercent: 25,
    });
    const plans = [
      create({ treasuryCost: 0, manpowerCost: 0 }),
      reinforce(),
      create({
        countryId: otherCountryId,
        name: '南国援军',
        expectedResourceRevision: 0,
        treasuryCost: 0,
        manpowerCost: 0,
      }),
    ];
    const saved = await save(plans);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.recruitments[0].costs).toEqual([]);
    const mapRevision = await revision();
    await settlements.publish(gameId, hostId, quarterId, 2, mapRevision);
    const seen = await world.getTile(gameId, playerId, tileId);
    expect(seen.discoveryState).toBe('Observed');
    expect(seen.armies).toHaveLength(3);
    expect(seen.armies.find((a) => a.id === plans[2]!.id)).toMatchObject({
      strength: { kind: 'Range', min: 225, max: 375 },
      outdated: false,
    });
    expect(JSON.stringify(seen.armies)).not.toContain('treasuryCost');
    expect(
      (await national()).countries.find((c) => c.id === countryId),
    ).toMatchObject({ treasury: 920.25, manpower: 800 });
    expect(await revision()).toBe(mapRevision + 2); // Truth and the fresh exploration batch.
  });
  it('rolls new armies, reinforcement and all costs back if later exploration publication fails', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tileId],
      state: 'Observed',
      note: '侦察',
      sourceActionId: actionId,
    });
    const plans = [create(), { ...reinforce(), actionId: null }];
    expect((await save(plans)).statusCode).toBe(200);
    // Deliberately invalidate only the exploration source, after the valid draft was stored.
    await database.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    const before = await national(),
      entries = await ledger(),
      mapRevision = await revision();
    const worldBefore = (await games.getForUser(gameId, hostId)).currentQuarter
      .currentWorldVersion;
    await expect(
      settlements.publish(gameId, hostId, quarterId, 2, mapRevision),
    ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
    expect(await national()).toEqual(before);
    expect(await ledger()).toEqual(entries);
    expect(await revision()).toBe(mapRevision);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(worldBefore);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
  });
});
