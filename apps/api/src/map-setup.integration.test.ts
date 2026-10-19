import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { ActionService } from './modules/actions/action-service.js';
import { SettlementService } from './modules/settlements/settlement-service.js';
import { WorldService } from './modules/world/world-service.js';
import { economicBillInput } from './modules/settlements/economy.js';

const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database);
const games = new GameService(database);
const world = new WorldService(database);
const actions = new ActionService(database);
const settlements = new SettlementService(database);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  world,
  actions,
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
  previewId: string;
let hostCookie: string, playerCookie: string;
let tiles: string[];
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const knowledge = async (
  input: Partial<Parameters<typeof world.setup.knowledge>[2]> = {},
) =>
  world.setup.knowledge(gameId, hostId, {
    expectedRevision: await revision(),
    countryId,
    tileIds: [tiles[0]!],
    state: 'Observed',
    note: '',
    ...input,
  });
const batch = async (
  input: Partial<Parameters<typeof world.setup.batch>[2]> = {},
) =>
  world.setup.batch(gameId, hostId, {
    expectedRevision: await revision(),
    tileIds: [tiles[0]!],
    ...input,
  });
const viewport = (userId: string) =>
  world.getViewport({ gameId, userId, minQ: 0, maxQ: 3, minR: 0, maxR: 2 });
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'map-host',
    'map-player',
    'map-other',
    'map-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'map-test-password',
      }),
    );
  hostId = users[0]!.id;
  playerId = users[1]!.id;
  otherId = users[2]!.id;
  const game = await games.create({
    userId: hostId,
    name: '地图测试',
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
    if (index === 0) previewId = member.id;
  }
  const login = async (username: string) =>
    String(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { username, password: 'map-test-password' },
        })
      ).headers['set-cookie'],
    ).split(';')[0]!;
  [hostCookie, playerCookie] = await Promise.all([
    login('map-host'),
    login('map-player'),
  ]);
  await world.setup.create(gameId, hostId, {
    name: '诸国地图',
    width: 4,
    height: 3,
  });
  tiles = (await viewport(hostId)).tiles.map((tile) => tile.id);
});
afterAll(async () => {
  await app.close();
  await database.end();
});

describe('map preparation and exploration', () => {
  it('runs two countries through province policies, host settlement, updated map context and the next quarter', async () => {
    for (const [index, name, owner] of [
      [0, '北省', countryId],
      [1, '南省', otherCountryId],
    ] as const) {
      await batch({
        tileIds: [tiles[index]!],
        regionName: name,
        provinceName: name,
        legalOwnerCountryId: owner,
        controllerCountryId: owner,
      });
      await world.setup.knowledge(gameId, hostId, {
        expectedRevision: await revision(),
        countryId: owner,
        tileIds: [tiles[index]!],
        state: 'Observed',
        note: '',
      });
    }
    const north = (await world.getTileContext(gameId, playerId, tiles[0]!))
      .province!;
    const south = (await world.getTileContext(gameId, otherId, tiles[1]!))
      .province!;
    await games.economics.set(gameId, hostId, {
      expectedVersion: 0,
      rules: {
        enabled: true,
        taxCoefficient: 10,
        productionCoefficient: 10,
        manpowerCoefficient: 100,
        armyMaintenancePer100: 0,
        administrationCost: 0,
        tradeCoefficient: 0,
      },
      reason: '试局基础经济',
    });
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const policies: Awaited<ReturnType<typeof actions.create>>[] = [];
    for (const [userId, province] of [
      [playerId, north],
      [otherId, south],
    ] as const) {
      const policy = await actions.create({
        gameId,
        userId,
        quarterId,
        title: `建设${province.name}`,
        originalText: '组织农户修复水渠。',
        category: 'Construction',
        secrecy: 'OwnerOnly',
        refs: [
          {
            refKind: 'Target',
            objectType: 'Province',
            objectId: province.id!,
            label: province.name,
          },
        ],
      });
      await actions.submit({
        gameId,
        userId,
        actionId: policy.id,
        idempotencyKey: randomUUID(),
      });
      policies.push(policy);
    }
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
    for (const policy of policies)
      await actions.hostTransition({
        gameId,
        userId: hostId,
        actionId: policy.id,
        target: 'Approved',
        reason: '允许修复',
      });
    await database.query(
      "UPDATE action_object_refs SET label='后来修改的草稿目标' WHERE game_id=$1",
      [gameId],
    );
    await settlements.begin(gameId, hostId, quarterId);
    const draft = await settlements.get(gameId, hostId, quarterId);
    expect(
      draft.actions.find((a) => a.actionId === policies[0]!.id)?.refs,
    ).toEqual([
      {
        refKind: 'Target',
        objectType: 'Province',
        objectId: north.id,
        label: north.name,
      },
    ]);
    const saved = await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: draft.version,
      expectedMapRevision: await revision(),
      publicReport: '两国修渠，田地重新通水。',
      results: policies.map((p) => ({
        actionId: p.id,
        feedback: '水渠修复，本省生产基础提高。',
      })),
      stateChanges: [north, south].map((p, i) => ({
        id: randomUUID(),
        actionId: policies[i]!.id,
        kind: 'Province',
        provinceId: p.id!,
        expectedProfileRevision: 0,
        values: { productionBase: 3 },
        reason: '水渠修复',
      })),
      economicBill: economicBillInput(
        await settlements.economicPreview(
          gameId,
          hostId,
          quarterId,
          draft.version,
        ),
      ),
    });
    expect(
      (await world.getTileContext(gameId, playerId, tiles[0]!)).province?.values
        ?.productionBase,
    ).toBe(0);
    await settlements.publish(
      gameId,
      hostId,
      quarterId,
      saved.version,
      saved.mapRevision,
    );
    expect(
      (await world.getTileContext(gameId, playerId, tiles[0]!)).province?.values
        ?.productionBase,
    ).toBe(3);
    expect(
      (await world.getTileContext(gameId, otherId, tiles[1]!)).province?.values
        ?.productionBase,
    ).toBe(3);
    expect(
      (await settlements.get(gameId, playerId, quarterId)).actions,
    ).toHaveLength(1);
    const result = (await settlements.get(gameId, playerId, quarterId))
      .actions[0]!;
    expect(result.refs).toEqual([
      {
        refKind: 'Target',
        objectType: 'Province',
        objectId: north.id,
        label: north.name,
      },
    ]);
    const location = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/map/locate?objectType=Province&objectId=${result.refs![0]!.objectId}`,
      headers: { cookie: playerCookie },
    });
    expect(location.statusCode).toBe(200);
    expect(location.json().data).toMatchObject({
      id: tiles[0],
      scope: [{ id: tiles[0], q: 0, r: 0 }],
    });
    await database.query(
      "UPDATE action_object_refs SET label='已发布后的改动' WHERE game_id=$1",
      [gameId],
    );
    expect(
      (await settlements.get(gameId, playerId, quarterId)).actions[0]!.refs,
    ).toEqual(result.refs);
    await settlements.advance(gameId, hostId, quarterId);
    expect(
      (await world.getTileContext(gameId, playerId, tiles[0]!)).economy
        ?.production,
    ).toBe(30);
    expect(
      (await games.getForUser(gameId, playerId)).currentQuarter.sequenceNumber,
    ).toBe(2);
    expect(
      (await world.getTileContext(gameId, playerId, tiles[0]!)).province?.values
        ?.productionBase,
    ).toBe(3);
  });

  it('links province systems using the same economic rules and enforces the player and preview scopes', async () => {
    await batch({
      tileIds: tiles.slice(0, 3),
      regionName: '北境',
      provinceName: '北省',
      legalOwnerCountryId: countryId,
      controllerCountryId: countryId,
    });
    await batch({ tileIds: [tiles[2]!], controllerCountryId: otherCountryId });
    await batch({
      tileIds: tiles.slice(3, 6),
      regionName: '南境',
      provinceName: '南省',
      legalOwnerCountryId: otherCountryId,
      controllerCountryId: otherCountryId,
    });
    await knowledge({ tileIds: tiles.slice(0, 3) });
    const province = (
      await world.provinces.list(gameId, hostId)
    ).provinces.find((p) => p.name === '北省')!;
    await world.provinces.set(gameId, hostId, province.id, {
      expectedRevision: province.revision!,
      expectedMapRevision: await revision(),
      name: province.name,
      description: '沿河农田',
      taxBase: 8,
      productionBase: 7,
      manpowerBase: 5,
      autonomy: 25,
      unrest: 2,
      reason: '试局资料',
    });
    await database.query(
      `UPDATE games SET economic_rules='{"enabled":true,"taxCoefficient":10,"productionCoefficient":2,"manpowerCoefficient":4,"armyMaintenancePer100":0,"administrationCost":0,"tradeCoefficient":1}'::jsonb WHERE id=$1`,
      [gameId],
    );
    const country = (await games.listCountries(gameId, hostId)).find(
      (c) => c.id === countryId,
    )!;
    const quarter = { sequenceNumber: 1, gameYear: 1, season: 'Spring' };
    const policy = {
      id: randomUUID(),
      countryId,
      countryName: country.name,
      title: '屯田政策',
      type: 'Policy',
      text: '税收提高一成',
      effects: { Tax: 10 },
      startsAt: quarter,
      expiresAt: null,
      endedAt: null,
    };
    await database.query(
      'INSERT INTO national_policies(id,game_id,country_id,record) VALUES($1,$2,$3,$4)',
      [policy.id, gameId, countryId, JSON.stringify(policy)],
    );
    const zone = randomUUID();
    await database.query(
      'INSERT INTO trade_zones(id,game_id,name) VALUES($1,$2,$3)',
      [zone, gameId, '北海贸易区'],
    );
    await database.query(
      'INSERT INTO trade_zone_provinces(game_id,zone_id,province_id) VALUES($1,$2,$3)',
      [gameId, zone, province.id],
    );
    await database.query(
      'INSERT INTO trade_influences(game_id,zone_id,country_id,power) VALUES($1,$2,$3,10)',
      [gameId, zone, countryId],
    );
    const player = await world.getTileContext(gameId, playerId, tiles[0]!);
    expect(player.province).toMatchObject({
      id: province.id,
      name: '北省',
      knownOnly: true,
      values: { taxBase: 8, autonomy: 25 },
    });
    expect(player.province!.tiles.map((t) => t.id)).toEqual(tiles.slice(0, 3));
    expect(player.economy).toMatchObject({
      tax: 44,
      production: 7,
      manpower: 10,
    });
    expect(player.tradeZones).toEqual([{ id: zone, name: '北海贸易区' }]);
    expect(player.government?.policies).toEqual([policy]);
    expect(
      await world.getTileContext(
        gameId,
        hostId,
        tiles[0]!,
        previewId,
        otherCountryId,
      ),
    ).toEqual(player);
    expect(
      await world.getTileContext(
        gameId,
        playerId,
        tiles[0]!,
        undefined,
        otherCountryId,
      ),
    ).toEqual(player);
    const unknown = await world.getTileContext(gameId, playerId, tiles[3]!);
    expect(unknown).toMatchObject({
      province: null,
      economy: null,
      tradeZones: null,
      government: null,
      diplomacy: { relations: [], treaties: [] },
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/games/${gameId}/tiles/${tiles[0]}/context`,
      headers: { cookie: playerCookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(player);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/games/${gameId}/tiles/${tiles[0]}/context?previewMemberId=${previewId}`,
          headers: { cookie: playerCookie },
        })
      ).statusCode,
    ).toBe(403);
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const action = await actions.create({
      gameId,
      userId: playerId,
      quarterId,
      title: '建设北省',
      originalText: '修复沿河灌溉',
      category: 'Construction',
      secrecy: 'OwnerOnly',
      refs: [
        {
          refKind: 'Target',
          objectType: 'Province',
          objectId: province.id,
          label: '省份：北省',
        },
      ],
    });
    expect(action.refs).toMatchObject([
      { objectType: 'Province', objectId: province.id },
    ]);
    const foreignProvince = (
      await world.provinces.list(gameId, hostId)
    ).provinces.find((p) => p.name === '南省')!;
    await expect(
      actions.create({
        gameId,
        userId: playerId,
        quarterId,
        title: '不可见目标',
        originalText: '',
        category: 'Policy',
        secrecy: 'OwnerOnly',
        refs: [
          {
            refKind: 'Target',
            objectType: 'Province',
            objectId: foreignProvince.id,
            label: '南省',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ACTION_REFERENCE' });
  });

  it('keeps foreign boundaries and political facts in their recorded state and hides private systems and treaties', async () => {
    await batch({
      tileIds: tiles.slice(0, 3),
      regionName: '南岸',
      provinceName: '南省',
      legalOwnerCountryId: otherCountryId,
      controllerCountryId: otherCountryId,
    });
    await knowledge({ tileIds: tiles.slice(0, 2) });
    await batch({
      tileIds: [tiles[1]!],
      regionName: '改划地区',
      provinceName: '新省',
      legalOwnerCountryId: otherCountryId,
      controllerCountryId: otherCountryId,
    });
    const quarter = { sequenceNumber: 1, gameYear: 1, season: 'Spring' };
    for (const [visibility, countryIds, title] of [
      ['Public', [countryId, otherCountryId], '公开条约'],
      ['Participants', [otherCountryId], '南国秘密条约'],
      ['Participants', [countryId, otherCountryId], '双方秘密条约'],
    ] as const) {
      const id = randomUUID();
      await database.query(
        'INSERT INTO diplomatic_treaties(id,game_id,record) VALUES($1,$2,$3)',
        [
          id,
          gameId,
          JSON.stringify({
            id,
            title,
            type: 'Custom',
            countryIds,
            countryNames: countryIds.map(String),
            terms: title,
            visibility,
            grantorCountryId: null,
            startQuarter: quarter,
            updatedQuarter: quarter,
            expiresAt: null,
            endedAt: null,
          }),
        ],
      );
    }
    const player = await world.getTileContext(gameId, playerId, tiles[0]!);
    expect(player.province?.tiles.map((t) => t.id)).toEqual(tiles.slice(0, 2));
    const provinceId = player.province!.id!;
    const located = await world.locateReference(
      gameId,
      playerId,
      'Province',
      provinceId,
    );
    expect(located.scope?.map((t) => t.id)).toEqual(tiles.slice(0, 2));
    expect(
      await world.locateReference(
        gameId,
        hostId,
        'Province',
        provinceId,
        previewId,
      ),
    ).toEqual(located);
    expect(
      (
        await world.locateReference(gameId, hostId, 'Province', provinceId)
      ).scope?.map((t) => t.id),
    ).toEqual([tiles[0], tiles[2]]);
    const hiddenProvince = (
      await world.provinces.list(gameId, hostId)
    ).provinces.find((p) => p.name === '新省')!;
    await expect(
      world.locateReference(gameId, playerId, 'Province', hiddenProvince.id),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/games/${gameId}/map/locate?objectType=Province&objectId=${provinceId}&previewMemberId=${previewId}`,
          headers: { cookie: playerCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(player.province?.values).toBeNull();
    expect(player.economy).toBeNull();
    expect(player.tradeZones).toBeNull();
    expect(player.government).toBeNull();
    expect(player.diplomacy?.treaties.map((t) => t.title).sort()).toEqual([
      '公开条约',
      '双方秘密条约',
    ]);
    const truth = await world.getTileContext(gameId, hostId, tiles[0]!);
    expect(truth.province?.tiles.map((t) => t.id)).toEqual([
      tiles[0],
      tiles[2],
    ]);
    expect(truth.diplomacy?.treaties).toHaveLength(3);
    expect(
      await world.getTileContext(gameId, hostId, tiles[0]!, previewId),
    ).toEqual(player);
    const observer = (
      await database.query<{ user_id: string }>(
        "SELECT user_id FROM game_members WHERE game_id=$1 AND role='Observer'",
        [gameId],
      )
    ).rows[0]!;
    const publicView = await world.getTileContext(
      gameId,
      observer.user_id,
      tiles[0]!,
    );
    expect(publicView.province?.tiles.map((t) => t.id)).toEqual([
      tiles[0],
      tiles[2],
    ]);
    expect(publicView.province?.values).toBeNull();
    expect(publicView.diplomacy).toBeNull();
    const outsider = await auth.createDevelopmentUser({
      username: 'outsider',
      displayName: 'outsider',
      password: 'map-test-password',
    });
    await expect(
      world.getTileContext(gameId, outsider.id, tiles[0]!),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
    await expect(
      world.locateReference(gameId, outsider.id, 'Province', provinceId),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
  });

  it('creates a blank map without replacing data, validates batches and initializes each country separately', async () => {
    expect(
      (await viewport(playerId)).tiles.every(
        (tile) =>
          tile.terrainName === null && tile.discoveryState === 'Unknown',
      ),
    ).toBe(true);
    const hostMap = await world.setup.get(gameId, hostId);
    expect(hostMap.map).toMatchObject({ width: 4, height: 3 });
    expect(
      new Set(
        (await games.listCountries(gameId, hostId)).map(
          (country) => country.mapColor,
        ),
      ).size,
    ).toBe(2);
    const createUrl = `/api/v1/games/${gameId}/map`;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: createUrl,
          headers: { cookie: hostCookie },
          payload: { name: '覆盖', width: 4, height: 3 },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: createUrl,
          headers: { cookie: hostCookie },
          payload: { name: '错误', width: 101, height: 3 },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `${createUrl}/setup`,
          headers: { cookie: playerCookie },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${createUrl}/tiles`,
          headers: { cookie: playerCookie },
          payload: {
            expectedRevision: await revision(),
            tileIds: [tiles[0]],
            controllerCountryId: countryId,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `${createUrl}/tiles`,
          headers: { cookie: hostCookie },
          payload: {
            expectedRevision: await revision(),
            tileIds: [tiles[0], tiles[0]],
            controllerCountryId: countryId,
          },
        })
      ).statusCode,
    ).toBe(400);
    const oldRevision = await revision();
    await batch({
      controllerCountryId: countryId,
      legalOwnerCountryId: countryId,
      regionName: '北地',
      provinceName: '北省',
    });
    await expect(
      batch({
        expectedRevision: oldRevision,
        controllerCountryId: otherCountryId,
      }),
    ).rejects.toMatchObject({ code: 'MAP_VERSION_CONFLICT' });
    const before = await revision();
    await expect(
      batch({
        tileIds: [tiles[0]!, randomUUID()],
        controllerCountryId: otherCountryId,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MAP_SELECTION' });
    await expect(
      batch({ regionName: '北地', provinceName: '其他省' }),
    ).rejects.toMatchObject({ code: 'REGION_PROVINCE_CONFLICT' });
    expect(await revision()).toBe(before);
    expect((await world.setup.get(gameId, hostId)).regions).toHaveLength(1);
    const water = hostMap.terrains.find((terrain) => terrain.name === '水域')!;
    await batch({
      tileIds: [tiles[1]!],
      terrainTypeId: water.id,
      controllerCountryId: otherCountryId,
    });
    expect(await world.getTile(gameId, hostId, tiles[1]!)).toMatchObject({
      passable: false,
      movementCost: 3,
    });
    await world.setup.initializeKnowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      mode: 'OwnTerritory',
    });
    await world.setup.initializeKnowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId: otherCountryId,
      mode: 'Geography',
    });
    expect(await world.getTile(gameId, playerId, tiles[0]!)).toMatchObject({
      discoveryState: 'Observed',
      provinceName: '北省',
      controllerCountryId: countryId,
    });
    expect(await world.getTile(gameId, playerId, tiles[1]!)).toMatchObject({
      discoveryState: 'Observed',
      terrainName: '水域',
      provinceName: null,
      controllerCountryId: otherCountryId,
    });
    expect(await world.getTile(gameId, otherId, tiles[0]!)).toMatchObject({
      discoveryState: 'Observed',
      provinceName: null,
      controllerCountryId: countryId,
    });
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    await expect(
      world.setup.initializeKnowledge(gameId, hostId, {
        expectedRevision: await revision(),
        countryId,
        mode: 'Unknown',
      }),
    ).rejects.toMatchObject({ code: 'INITIAL_KNOWLEDGE_LOCKED' });
  });

  it('retains geographic and army snapshots in details, search and host preview until explicitly revealed again', async () => {
    await batch({
      controllerCountryId: otherCountryId,
      regionName: '前线',
      provinceName: '边省',
    });
    await world.createCity({
      gameId,
      userId: hostId,
      tileId: tiles[0]!,
      name: '旧港',
    });
    const tile = await world.createArmy({
      gameId,
      userId: hostId,
      tileId: tiles[0]!,
      countryId: otherCountryId,
      name: '南军',
      strength: 1000,
    });
    const armyId = tile.armies[0]!.id;
    await knowledge({ armyErrorPercent: 25, note: '侦察报告：旧港有部队。' });
    await world.moveArmy({ gameId, userId: hostId, armyId, tileId: tiles[1]! });
    await world.createCity({
      gameId,
      userId: hostId,
      tileId: tiles[0]!,
      name: '秘密新城',
    });
    const forest = (await world.setup.get(gameId, hostId)).terrains.find(
      (terrain) => terrain.name === '森林',
    )!;
    await batch({ terrainTypeId: forest.id, controllerCountryId: null });
    const perceived = await world.getTile(gameId, playerId, tiles[0]!);
    expect(perceived).toMatchObject({
      discoveryState: 'Outdated',
      terrainName: '平原',
      controllerCountryId: otherCountryId,
      provinceName: '边省',
      knowledgeNote: '侦察报告：旧港有部队。',
    });
    expect(perceived.cities.map((city) => city.name)).toEqual(['旧港']);
    expect(perceived.armies[0]).toMatchObject({
      id: armyId,
      outdated: true,
      strength: { kind: 'Range', min: 750, max: 1250 },
    });
    expect((await world.getTile(gameId, playerId, tiles[1]!)).armies).toEqual(
      [],
    );
    expect(
      (await world.getTile(gameId, otherId, tiles[1]!)).armies[0],
    ).toMatchObject({ id: armyId, strength: { kind: 'Exact', value: 1000 } });
    expect(await world.search(gameId, playerId, '秘密')).toEqual([]);
    expect((await world.search(gameId, playerId, '南军'))[0]).toMatchObject({
      tileId: tiles[0],
      q: 0,
      r: 0,
    });
    expect(await world.getTile(gameId, hostId, tiles[0]!, previewId)).toEqual(
      perceived,
    );
    const raw = (await viewport(playerId)).tiles[0]!;
    expect(raw.legalOwnerCountryName).toBe(perceived.legalOwnerCountryName);
    expect(raw).not.toHaveProperty('provinceName');
    await knowledge({ armyErrorPercent: 0 });
    expect((await world.getTile(gameId, playerId, tiles[0]!)).armies).toEqual(
      [],
    );
    expect((await world.search(gameId, playerId, '秘密'))[0]?.name).toBe(
      '秘密新城',
    );
    await knowledge({ state: 'Unknown', note: '' });
    expect(await world.search(gameId, playerId, '旧港')).toEqual([]);
    expect(await world.getTile(gameId, playerId, tiles[0]!)).toMatchObject({
      terrainName: null,
      provinceName: null,
      legalOwnerCountryName: null,
      roadLevel: null,
      cities: [],
      armies: [],
    });
  });

  it('projects political ownership from observed snapshots and keeps it separate from control', async () => {
    await batch({
      legalOwnerCountryId: countryId,
      controllerCountryId: otherCountryId,
    });
    await knowledge();
    const known = (await viewport(playerId)).tiles[0]!;
    expect(known.legalOwnerCountryId).toBe(countryId);
    expect(known.controllerCountryId).toBe(otherCountryId);
    expect(known.legalOwnerColor).toBeTruthy();
    expect(known.legalOwnerCountryName).toBeTruthy();
    await batch({
      legalOwnerCountryId: otherCountryId,
      controllerCountryId: otherCountryId,
    });
    const old = (await viewport(playerId)).tiles[0]!;
    expect(old).toMatchObject({
      discoveryState: 'Outdated',
      legalOwnerCountryId: countryId,
      legalOwnerColor: known.legalOwnerColor,
      controllerCountryId: otherCountryId,
    });
    const host = (await viewport(hostId)).tiles[0]!;
    expect(host).toMatchObject({
      legalOwnerCountryId: otherCountryId,
      controllerCountryId: otherCountryId,
    });
    const preview = await world.getViewport({
      gameId,
      userId: hostId,
      previewMemberId: previewId,
      minQ: 0,
      maxQ: 0,
      minR: 0,
      maxR: 0,
    });
    expect(preview.tiles[0]).toEqual(old);
    for (const state of [
      'Unknown',
      'Rumored',
      'Discovered',
      'Mapped',
    ] as const) {
      await knowledge({ state });
      expect((await viewport(playerId)).tiles[0]).toMatchObject({
        legalOwnerCountryId: null,
        legalOwnerCountryName: null,
        legalOwnerColor: null,
        controllerCountryId: null,
      });
    }
    const mountains = (await world.setup.get(gameId, hostId)).terrains.find(
      (terrain) => terrain.name === '山地',
    );
    expect(mountains).toBeDefined();
  });

  it('publishes staged discoveries with settlement atomically, blocks stale map revisions and preserves history', async () => {
    await world.createCity({
      gameId,
      userId: hostId,
      tileId: tiles[0]!,
      name: '远方港口',
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
      title: '远航',
      originalText: '派船探索远方。',
      category: 'Exploration',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    await actions.submit({
      gameId,
      userId: playerId,
      actionId: action.id,
      idempotencyKey: randomUUID(),
    });
    await expect(
      knowledge({ sourceActionId: action.id }),
    ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: action.id,
      target: 'Approved',
      reason: '可行',
    });
    await expect(
      knowledge({ sourceActionId: action.id, countryId: otherCountryId }),
    ).rejects.toMatchObject({ code: 'INVALID_EXPLORATION_RESULT' });
    await knowledge({
      sourceActionId: action.id,
      note: '发现远方港口。',
      state: 'Observed',
    });
    expect(
      (await world.getTile(gameId, playerId, tiles[0]!)).discoveryState,
    ).toBe('Unknown');
    expect(await world.search(gameId, playerId, '港口')).toEqual([]);
    expect(
      (await settlements.get(gameId, playerId, quarterId)).mapReveals,
    ).toEqual([]);
    expect(await world.setup.history(gameId, playerId)).toEqual([]);
    expect(await world.setup.history(gameId, hostId, previewId)).toEqual([]);
    const historyUrl = `/api/v1/games/${gameId}/map/history?previewMemberId=${previewId}`;
    expect(
      (
        await app.inject({
          method: 'GET',
          url: historyUrl,
          headers: { cookie: playerCookie },
        })
      ).statusCode,
    ).toBe(403);
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
    const saved = await settlements.save(gameId, hostId, quarterId, {
      expectedVersion: 1,
      publicReport: '春季结束',
      results: [{ actionId: action.id, feedback: '水手带回新的地图。' }],
    });
    expect(saved.mapReveals?.[0]).toMatchObject({
      note: '发现远方港口。',
      publishedAt: null,
    });
    await world.createCity({
      gameId,
      userId: hostId,
      tileId: tiles[0]!,
      name: '后来建造的城',
      expectedRevision: await revision(),
      correctionReason: '验收发布冲突：补正城市',
    });
    await expect(
      settlements.publish(
        gameId,
        hostId,
        quarterId,
        saved.version,
        saved.mapRevision,
      ),
    ).rejects.toMatchObject({ code: 'MAP_VERSION_CONFLICT' });
    expect(
      (await settlements.get(gameId, hostId, quarterId)).quarter.state,
    ).toBe('Resolving');
    expect(
      (await world.getTile(gameId, playerId, tiles[0]!)).discoveryState,
    ).toBe('Unknown');
    const checked = await settlements.get(gameId, hostId, quarterId);
    const result = await settlements.publish(
      gameId,
      hostId,
      quarterId,
      checked.version,
      checked.mapRevision,
    );
    expect(result.mapReveals?.[0]?.publishedAt).toBeTruthy();
    expect(
      (await world.getTile(gameId, playerId, tiles[0]!)).discoveryState,
    ).toBe('Outdated');
    expect(
      (await world.getTile(gameId, playerId, tiles[0]!)).cities.map(
        (city) => city.name,
      ),
    ).toEqual(['远方港口']);
    expect(
      (await settlements.get(gameId, playerId, quarterId)).mapReveals,
    ).toHaveLength(1);
    expect(
      (await settlements.get(gameId, otherId, quarterId)).mapReveals,
    ).toEqual([]);
    expect((await world.setup.history(gameId, playerId))[0]).toMatchObject({
      kind: 'PublishExploration',
      sourceActionId: action.id,
      note: '发现远方港口。',
      tileCount: 1,
    });
    await settlements.publish(
      gameId,
      hostId,
      quarterId,
      checked.version,
      checked.mapRevision,
    );
    expect(await world.setup.history(gameId, playerId)).toHaveLength(1);
    await settlements.advance(gameId, hostId, quarterId);
    expect(
      (await settlements.get(gameId, playerId, quarterId)).mapReveals,
    ).toEqual(result.mapReveals);
    await expect(
      world.setup.removePlan(gameId, hostId, action.id, await revision()),
    ).rejects.toMatchObject({ code: 'EXPLORATION_RESULT_LOCKED' });
  });

  it('removes unpublished plans without altering country knowledge', async () => {
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const action = await actions.create({
      gameId,
      userId: playerId,
      quarterId,
      title: '探索',
      originalText: '探索地图',
      category: 'Custom',
      secrecy: 'OwnerOnly',
      refs: [],
    });
    await actions.submit({
      gameId,
      userId: playerId,
      actionId: action.id,
      idempotencyKey: randomUUID(),
    });
    await actions.hostTransition({
      gameId,
      userId: hostId,
      actionId: action.id,
      target: 'Approved',
      reason: '',
    });
    await knowledge({ sourceActionId: action.id, note: '暂定探索结果' });
    await world.setup.removePlan(gameId, hostId, action.id, await revision());
    expect(await world.setup.plan(gameId, hostId, action.id)).toBeNull();
    expect(
      (await viewport(playerId)).tiles.every(
        (tile) => tile.discoveryState === 'Unknown',
      ),
    ).toBe(true);
    expect(await world.setup.history(gameId, playerId)).toEqual([]);
  });
});
