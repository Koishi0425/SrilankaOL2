import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type { SettlementStateChangeInput } from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { ActionService } from './modules/actions/action-service.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database);
const games = new GameService(database);
const actions = new ActionService(database);
const world = new WorldService(database);
const settlements = new SettlementService(database);
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
  otherId: string;
let countryId: string, otherCountryId: string, actionId: string, armyId: string;
let hostCookie: string, playerCookie: string, observerCookie: string;
let tiles: string[];
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const base = () => ({ id: randomUUID(), actionId });
const changes = (): SettlementStateChangeInput[] => [
  { ...base(), kind: 'ArmyMove', armyId, destinationTileId: tiles[1]! },
  { ...base(), kind: 'ArmyStrength', armyId, strength: 720 },
  {
    ...base(),
    kind: 'Territory',
    tileIds: [tiles[1]!],
    controllerCountryId: countryId,
  },
];
const truth = async () => ({
  army: (
    await database.query('SELECT tile_id,strength FROM armies WHERE id=$1', [
      armyId,
    ])
  ).rows[0],
  tile: (
    await database.query(
      'SELECT controller_country_id,legal_owner_country_id FROM hex_tiles WHERE id=$1',
      [tiles[1]],
    )
  ).rows[0],
  city: (
    await database.query(
      'SELECT controller_country_id FROM cities WHERE tile_id=$1',
      [tiles[1]],
    )
  ).rows[0],
  world: (
    await database.query(
      'SELECT current_world_version FROM games WHERE id=$1',
      [gameId],
    )
  ).rows[0]!.current_world_version,
});
async function save(
  stateChanges: SettlementStateChangeInput[],
  expectedVersion = 1,
  cookie = hostCookie,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
    headers: { cookie },
    payload: {
      expectedVersion,
      expectedMapRevision: await revision(),
      publicReport: '边境战事结束。',
      results: [{ actionId, feedback: '北军攻占边城，余下七百二十人。' }],
      stateChanges,
    },
  });
}
async function publish(expectedVersion = 2, expectedMapRevision?: number) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement/publish`,
    headers: { cookie: hostCookie },
    payload: {
      expectedVersion,
      expectedMapRevision: expectedMapRevision ?? (await revision()),
    },
  });
}
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'state-host',
    'state-player',
    'state-other',
    'state-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'state-test-password',
      }),
    );
  hostId = users[0]!.id;
  playerId = users[1]!.id;
  otherId = users[2]!.id;
  const game = await games.create({
    userId: hostId,
    name: '状态结算测试',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  quarterId = game.currentQuarter.id;
  const countries = await games.listCountries(gameId, hostId);
  countryId = countries[0]!.id;
  otherCountryId = countries[1]!.id;
  for (const [index, role] of ['Player', 'Player', 'Observer'].entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: users[index + 1]!.username,
      role: role as 'Player' | 'Observer',
    });
    if (index < 2)
      await games.assignCountry({
        gameId,
        actorUserId: hostId,
        memberId: member.id,
        countryId: index === 0 ? countryId : otherCountryId,
      });
  }
  const login = async (username: string) =>
    String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'state-test-password' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  [hostCookie, playerCookie, observerCookie] = await Promise.all([
    login('state-host'),
    login('state-player'),
    login('state-observer'),
  ]);
  await world.setup.create(gameId, hostId, {
    name: '边境',
    width: 4,
    height: 2,
  });
  tiles = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 3,
      minR: 0,
      maxR: 1,
    })
  ).tiles.map((tile) => tile.id);
  await world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tiles[1]!],
    controllerCountryId: otherCountryId,
    legalOwnerCountryId: otherCountryId,
  });
  await world.createCity({
    gameId,
    userId: hostId,
    tileId: tiles[1]!,
    name: '边城',
  });
  await world.createArmy({
    gameId,
    userId: hostId,
    tileId: tiles[0]!,
    countryId,
    name: '北军',
    strength: 1000,
  });
  armyId = (await world.getTile(gameId, hostId, tiles[0]!)).armies[0]!.id;
  await world.setup.knowledge(gameId, hostId, {
    expectedRevision: await revision(),
    countryId: otherCountryId,
    tileIds: [tiles[0]!],
    state: 'Observed',
    note: '北军在边境',
    armyErrorPercent: 25,
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
    title: '攻占边城',
    originalText: '出兵攻占边城',
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
    reason: '允许执行',
  });
});
afterAll(async () => {
  await app.close();
  await database.end();
});

describe('settlement world changes', () => {
  it('keeps nearby occupation current without refreshing neutral intelligence', async () => {
    const neutral = randomUUID();
    await database.query(
      'INSERT INTO countries(id,game_id,name) VALUES($1,$2,$3)',
      [neutral, gameId, '中立国'],
    );
    for (const id of [countryId, otherCountryId, neutral])
      await world.setup.knowledge(gameId, hostId, {
        expectedRevision: await revision(),
        countryId: id,
        tileIds: [tiles[1]!],
        state: 'Observed',
        note: '旧地理记录',
      });
    const previous = await world.getTile(gameId, playerId, tiles[1]!);
    await world.createCity({
      gameId,
      userId: hostId,
      tileId: tiles[1]!,
      name: '尚未报告的新城',
      expectedRevision: await revision(),
      correctionReason: '验收情报保留：修正地图中的城市',
    });
    await settlements.begin(gameId, hostId, quarterId);
    expect(
      (
        await save([
          {
            ...base(),
            kind: 'Territory',
            tileIds: [tiles[1]!],
            controllerCountryId: countryId,
          },
        ])
      ).statusCode,
    ).toBe(200);
    expect((await publish()).statusCode).toBe(200);
    const player = await world.getTile(gameId, playerId, tiles[1]!);
    expect(player.controllerCountryId).toBe(countryId);
    expect(player.legalOwnerCountryId).toBe(otherCountryId);
    expect(player.discoveryState).toBe('Observed');
    expect(player.observedWorldVersion).toBeGreaterThan(
      previous.observedWorldVersion!,
    );
    expect(player.cities.map((c) => c.name)).toContain('尚未报告的新城');
    expect(
      (await world.getTile(gameId, otherId, tiles[1]!)).controllerCountryId,
    ).toBe(countryId);
    const unaffected = (
      await database.query<{
        snapshot: { controllerCountryId: string };
        discovery_state: string;
      }>(
        'SELECT snapshot,discovery_state FROM country_tile_knowledge WHERE game_id=$1 AND country_id=$2 AND tile_id=$3',
        [gameId, neutral, tiles[1]],
      )
    ).rows[0]!;
    expect(unaffected.snapshot.controllerCountryId).toBe(otherCountryId);
    expect(unaffected.discovery_state).toBe('Mapped');
  });

  it('reports enemy movement and casualties from the same settlement while retaining older saved geography', async () => {
    await world.createArmy({
      gameId,
      userId: hostId,
      tileId: tiles[2]!,
      countryId: otherCountryId,
      name: '南军',
      expectedRevision: await revision(),
      correctionReason: '验收结算前状态冲突：补正军队',
      strength: 1200,
    });
    const enemyId = (await world.getTile(gameId, hostId, tiles[2]!)).armies[0]!
      .id;
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[1]!, tiles[2]!],
      state: 'Observed',
      note: '侦察南軍',
      armyErrorPercent: 25,
      sourceActionId: actionId,
    });
    await settlements.begin(gameId, hostId, quarterId);
    expect(
      (
        await save([
          {
            ...base(),
            kind: 'ArmyMove',
            armyId: enemyId,
            destinationTileId: tiles[1]!,
          },
          { ...base(), kind: 'ArmyStrength', armyId: enemyId, strength: 600 },
        ])
      ).statusCode,
    ).toBe(200);
    expect((await publish()).statusCode).toBe(200);
    const report = await world.getTile(gameId, playerId, tiles[1]!);
    expect(report.discoveryState).toBe('Observed');
    expect(report.armies[0]).toMatchObject({
      id: enemyId,
      outdated: false,
      strength: { kind: 'Range', min: 450, max: 750 },
    });
    expect((await world.getTile(gameId, playerId, tiles[2]!)).armies).toEqual(
      [],
    );
  });

  it("does not refresh an already stale exploration snapshot when applying this turn's state changes", async () => {
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId: tiles[7]!,
      expectedRevision: await revision(),
      correctionReason: '验收旧情报：修正军队位置',
    });
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[1]!],
      state: 'Observed',
      note: '早前情报',
      sourceActionId: actionId,
    });
    await world.createCity({
      gameId,
      userId: hostId,
      tileId: tiles[1]!,
      name: '未报告的新城',
      expectedRevision: await revision(),
      correctionReason: '验收旧情报：修正城市',
    });
    await settlements.begin(gameId, hostId, quarterId);
    expect((await save([changes()[1]!])).statusCode).toBe(200);
    expect((await publish()).statusCode).toBe(200);
    const report = await world.getTile(gameId, playerId, tiles[1]!);
    expect(report.discoveryState).toBe('Mapped');
    expect(report.cities.map((city) => city.name)).toEqual(['边城']);
    expect(report.knowledgeNote).toBe('早前情报');
  });
  it('stages changes privately, publishes movement, losses and occupation atomically, folds in fresh exploration and preserves history', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[1]!],
      state: 'Observed',
      note: '攻占边城',
      armyErrorPercent: 25,
      sourceActionId: actionId,
    });
    await settlements.begin(gameId, hostId, quarterId);
    const before = await truth();
    const pending = changes();
    const saved = await save(pending);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.stateChanges).toHaveLength(3);
    expect(await truth()).toEqual(before);
    expect(
      (await settlements.get(gameId, playerId, quarterId)).stateChanges,
    ).toBeUndefined();
    const mapRevision = await revision();
    const responses = await Promise.all([
      publish(2, mapRevision),
      publish(2, mapRevision),
    ]);
    responses.forEach((response) => expect(response.statusCode).toBe(200));
    expect(responses[0]!.json().data.publishedAt).toBe(
      responses[1]!.json().data.publishedAt,
    );
    const after = await truth();
    expect(after.army).toEqual({ tile_id: tiles[1], strength: 720 });
    expect(after.tile).toEqual({
      controller_country_id: countryId,
      legal_owner_country_id: otherCountryId,
    });
    expect(after.city.controller_country_id).toBe(countryId);
    expect(Number(after.world)).toBe(Number(before.world) + 1);
    const playerTile = await world.getTile(gameId, playerId, tiles[1]!);
    expect(playerTile).toMatchObject({
      discoveryState: 'Observed',
      controllerCountryId: countryId,
    });
    expect(playerTile.armies[0]).toMatchObject({
      id: armyId,
      strength: { kind: 'Exact', value: 720 },
    });
    const otherTile = await world.getTile(gameId, otherId, tiles[0]!);
    expect(otherTile.discoveryState).toBe('Mapped');
    expect(otherTile.armies[0]).toMatchObject({
      id: armyId,
      outdated: true,
      strength: { kind: 'Range', min: 750, max: 1250 },
    });
    expect(
      (await settlements.get(gameId, playerId, quarterId)).stateChanges,
    ).toBeUndefined();
    const observer = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/quarters/${quarterId}/settlement`,
      headers: { cookie: observerCookie },
    });
    expect(observer.json().data.stateChanges).toBeUndefined();
    expect(observer.json().data.actions).toEqual([]);
    expect(
      (await world.setup.history(gameId, playerId)).some(
        (entry) => entry.kind === 'PublishStateChanges',
      ),
    ).toBe(false);
    expect(
      (
        await database.query(
          "SELECT id FROM map_history WHERE game_id=$1 AND kind='PublishStateChanges'",
          [gameId],
        )
      ).rowCount,
    ).toBe(1);
    const published = responses[0]!.json().data.stateChanges;
    await settlements.advance(gameId, hostId, quarterId);
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId: tiles[2]!,
      expectedRevision: await revision(),
      correctionReason: '验收历史保留：修正军队位置',
    });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).stateChanges,
    ).toEqual(published);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).quarter
        .currentWorldVersion,
    ).toBe(Number(after.world));
  });

  it('validates permissions, current approved policies, scoped objects, passability, numeric limits and duplicate target fields', async () => {
    const optionsUrl = `/api/v1/games/${gameId}/quarters/${quarterId}/settlement/options`;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: optionsUrl,
          headers: { cookie: hostCookie },
        })
      ).statusCode,
    ).toBe(409);
    await settlements.begin(gameId, hostId, quarterId);
    for (const cookie of [playerCookie, observerCookie]) {
      expect(
        (
          await app.inject({
            method: 'GET',
            url: optionsUrl,
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
      expect((await save(changes(), 1, cookie)).statusCode).toBe(403);
    }
    const options = (
      await app.inject({
        method: 'GET',
        url: optionsUrl,
        headers: { cookie: hostCookie },
      })
    ).json().data;
    expect(options.armies[0]).toMatchObject({ id: armyId, strength: 1000 });
    const terrain = (await world.setup.get(gameId, hostId)).terrains.find(
      (item) => !item.passable,
    )!;
    await world.setup.batch(gameId, hostId, {
      expectedRevision: await revision(),
      tileIds: [tiles[3]!],
      terrainTypeId: terrain.id,
      correctionReason: '验收不可通行目标：修正地形',
    });
    const invalid: SettlementStateChangeInput[][] = [
      [
        {
          ...base(),
          kind: 'ArmyMove',
          armyId: randomUUID(),
          destinationTileId: tiles[1]!,
        },
      ],
      [{ ...base(), kind: 'ArmyMove', armyId, destinationTileId: tiles[3]! }],
      [{ ...base(), kind: 'ArmyMove', armyId, destinationTileId: tiles[0]! }],
      [{ ...base(), kind: 'ArmyStrength', armyId, strength: -1 }],
      [{ ...base(), kind: 'ArmyStrength', armyId, strength: 2_147_483_648 }],
      [
        {
          ...base(),
          actionId: randomUUID(),
          kind: 'ArmyStrength',
          armyId,
          strength: 700,
        },
      ],
      [
        {
          ...base(),
          kind: 'Territory',
          tileIds: [tiles[1]!],
          controllerCountryId: randomUUID(),
        },
      ],
      [
        {
          ...base(),
          kind: 'Territory',
          tileIds: [randomUUID()],
          controllerCountryId: countryId,
        },
      ],
      [
        {
          ...base(),
          kind: 'Territory',
          tileIds: [tiles[1]!, tiles[1]!],
          controllerCountryId: countryId,
        },
      ],
      [{ ...base(), kind: 'Territory', tileIds: [tiles[1]!] }],
      [
        changes()[0]!,
        { ...base(), kind: 'ArmyMove', armyId, destinationTileId: tiles[2]! },
      ],
      [
        {
          ...base(),
          kind: 'Territory',
          tileIds: [tiles[1]!],
          controllerCountryId: countryId,
        },
        {
          ...base(),
          kind: 'Territory',
          tileIds: [tiles[1]!],
          controllerCountryId: null,
        },
      ],
    ];
    const before = await truth();
    for (const input of invalid)
      expect((await save(input)).statusCode).toBe(400);
    expect(await truth()).toEqual(before);
    expect((await settlements.get(gameId, hostId, quarterId)).version).toBe(1);
    const disjoint = [
      {
        ...base(),
        kind: 'Territory' as const,
        tileIds: [tiles[1]!],
        controllerCountryId: countryId,
      },
      {
        ...base(),
        kind: 'Territory' as const,
        tileIds: [tiles[1]!],
        legalOwnerCountryId: null,
      },
    ];
    expect((await save(disjoint)).statusCode).toBe(200);
  });

  it('refuses stale publication and never silently rebases an existing draft onto edited truth', async () => {
    await settlements.begin(gameId, hostId, quarterId);
    const pending = changes();
    expect((await save(pending)).statusCode).toBe(200);
    const savedRevision = await revision();
    await world.moveArmy({
      gameId,
      userId: hostId,
      armyId,
      tileId: tiles[2]!,
      expectedRevision: await revision(),
      correctionReason: '验收草稿冲突：修正军队位置',
    });
    const before = await truth();
    expect((await publish(2, savedRevision)).json().error.code).toBe(
      'MAP_VERSION_CONFLICT',
    );
    expect((await publish()).json().error.code).toBe('STATE_CHANGE_CONFLICT');
    expect((await save(pending, 2)).json().error.code).toBe(
      'STATE_CHANGE_CONFLICT',
    );
    expect(await truth()).toEqual(before);
    const data = await settlements.get(gameId, hostId, quarterId);
    expect(data).toMatchObject({ version: 2, publishedAt: null });
    expect(data.stateChanges![0]!.summary).toContain('(0, 0)');
    const remaining = pending.filter((change) => change.kind !== 'ArmyMove');
    expect((await save(remaining, 2)).statusCode).toBe(200);
    expect((await publish(3)).statusCode).toBe(200);
    expect((await truth()).army).toEqual({ tile_id: tiles[2], strength: 720 });
  });

  it('rolls back world updates, audit, feedback publication and versions if an exploration result is invalid', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[1]!],
      state: 'Observed',
      note: '边城',
      sourceActionId: actionId,
    });
    await database.query("UPDATE actions SET status='Rejected' WHERE id=$1", [
      actionId,
    ]);
    await settlements.begin(gameId, hostId, quarterId);
    expect(
      (await save(changes().map((change) => ({ ...change, actionId: null }))))
        .statusCode,
    ).toBe(200);
    const before = await truth();
    const perceivedBefore = await world.getTile(gameId, playerId, tiles[1]!);
    const mapRevision = await revision();
    const result = await publish();
    expect(result.json().error.code).toBe('INVALID_EXPLORATION_RESULT');
    expect(await truth()).toEqual(before);
    expect(await revision()).toBe(mapRevision);
    expect(
      (await settlements.get(gameId, hostId, quarterId)).publishedAt,
    ).toBeNull();
    expect(
      (
        await database.query(
          "SELECT id FROM map_history WHERE game_id=$1 AND kind='PublishStateChanges'",
          [gameId],
        )
      ).rowCount,
    ).toBe(0);
    expect(await world.getTile(gameId, playerId, tiles[1]!)).toEqual(
      perceivedBefore,
    );
  });
});
