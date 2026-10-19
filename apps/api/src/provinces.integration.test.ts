import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import type { SetProvinceInput } from '@srilanka/contracts';
import { createDatabasePool } from '@srilanka/database';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { WorldService } from './modules/world/world-service.js';
const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' }),
  database = createDatabasePool(config.databaseUrl);
const auth = new AuthService(database),
  games = new GameService(database),
  world = new WorldService(database);
const app = await buildApp({
  auth,
  games,
  world,
  logLevel: 'silent',
  health: {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
  },
});
let gameId: string,
  hostId: string,
  playerId: string,
  otherId: string,
  observerId: string,
  countryId: string,
  otherCountryId: string,
  provinceId: string,
  hostCookie: string,
  playerCookie: string,
  tiles: string[];
const revision = async () => (await world.getMap(gameId, hostId)).revision!;
const provinces = () => world.provinces.list(gameId, hostId);
const input = async (
  extra: Partial<SetProvinceInput> = {},
): Promise<SetProvinceInput> => ({
  name: '北境',
  description: '农业与边防',
  taxBase: 5,
  productionBase: 3,
  manpowerBase: 4,
  autonomy: 10.25,
  unrest: -1.5,
  expectedRevision: 0,
  expectedMapRevision: await revision(),
  reason: '开场省份资料',
  ...extra,
});
async function put(
  payload: SetProvinceInput,
  id = provinceId,
  cookie = hostCookie,
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/games/${gameId}/provinces/${id}`,
    headers: { cookie },
    payload,
  });
}
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
  const users = [];
  for (const username of [
    'province-host',
    'province-north',
    'province-south',
    'province-observer',
  ])
    users.push(
      await auth.createDevelopmentUser({
        username,
        displayName: username,
        password: 'province-password',
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
    name: '省份基础',
    countryNames: ['北国', '南国'],
  });
  gameId = game.id;
  [countryId, otherCountryId] = (await games.listCountries(gameId, hostId)).map(
    (c) => c.id,
  ) as [string, string];
  for (const [index, user] of users.slice(1).entries()) {
    const member = await games.addMember({
      gameId,
      actorUserId: hostId,
      username: user.username,
      role: index < 2 ? 'Player' : 'Observer',
    });
    if (index < 2)
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
                password: 'province-password',
              },
            })
          ).headers['set-cookie'],
        ).split(';')[0]!,
    ),
  );
  [hostCookie, playerCookie] = cookies as [string, string];
  await world.setup.create(gameId, hostId, {
    name: '本土',
    width: 4,
    height: 2,
  });
  const viewport = (
    await world.getViewport({
      gameId,
      userId: hostId,
      minQ: 0,
      maxQ: 3,
      minR: 0,
      maxR: 1,
    })
  ).tiles;
  tiles = Array.from(
    { length: 8 },
    (_, i) =>
      viewport.find((t) => t.q === i % 4 && t.r === Math.floor(i / 4))!.id,
  );
  for (const [ids, provinceName, regionName, owner] of [
    [tiles.slice(0, 2), '北境', '北岸', countryId],
    [tiles.slice(2, 4), '南岸', '港区', otherCountryId],
    [[tiles[4]!], '边境', '北侧', countryId],
    [[tiles[5]!], '边境', '南侧', otherCountryId],
  ] as const)
    await world.setup.batch(gameId, hostId, {
      expectedRevision: await revision(),
      tileIds: [...ids],
      provinceName,
      regionName,
      legalOwnerCountryId: owner,
      controllerCountryId: owner,
    });
  provinceId = (await provinces()).provinces.find((p) => p.name === '北境')!.id;
  // Old unused province-level control must not override current tile ownership.
  await database.query(
    'UPDATE provinces SET controller_country_id=$2 WHERE id=$1',
    [provinceId, otherCountryId],
  );
});
afterAll(async () => {
  await app.close();
  await database.end();
});
describe('province profiles and territory summaries', () => {
  it('preserves existing grouping and derives ownership from tiles, scopes full and partial national data', async () => {
    const saved = await put(await input());
    expect(saved.statusCode).toBe(200);
    const all = saved.json().data.provinces;
    expect(all).toHaveLength(3);
    expect(all.find((p: { id: string }) => p.id === provinceId)).toMatchObject({
      tileCount: 2,
      legalOwners: [{ countryId, tileCount: 2 }],
      controllers: [{ countryId, tileCount: 2 }],
      values: {
        taxBase: 5,
        productionBase: 3,
        manpowerBase: 4,
        autonomy: 10.25,
        unrest: -1.5,
      },
      revision: 1,
    });
    const own = (
      await app.inject({
        url: `/api/v1/games/${gameId}/provinces`,
        headers: { cookie: playerCookie },
      })
    ).json().data;
    expect(own.canEdit).toBe(false);
    expect(own.provinces).toHaveLength(2);
    expect(
      own.provinces.find((p: { name: string }) => p.name === '北境').values
        .taxBase,
    ).toBe(5);
    const partial = own.provinces.find(
      (p: { name: string }) => p.name === '边境',
    );
    expect(partial).toMatchObject({
      partial: true,
      values: null,
      tileCount: 1,
      tiles: [{ id: tiles[4] }],
    });
    expect(partial).not.toHaveProperty('revision');
    expect(JSON.stringify(own)).not.toContain(tiles[5]);
    expect(JSON.stringify(own)).not.toContain('港区');
    expect((await world.provinces.list(gameId, observerId)).provinces).toEqual(
      [],
    );
    const south = await world.provinces.list(gameId, otherId);
    expect(south.provinces.map((p) => p.name)).toEqual(['南岸', '边境']);
  });
  it('applies preparation edits once, audits before/after and keeps balances, manpower and troops untouched', async () => {
    const mapBefore = await revision(),
      version = (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion;
    const payload = await input();
    const replies = await Promise.all([put(payload), put(payload)]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await revision()).toBe(mapBefore + 1);
    expect(
      (await games.getForUser(gameId, hostId)).currentQuarter
        .currentWorldVersion,
    ).toBe(version + 1);
    expect(
      (
        await database.query(
          'SELECT treasury,manpower FROM countries WHERE id=$1',
          [countryId],
        )
      ).rows[0],
    ).toEqual({ treasury: '0.00', manpower: 0 });
    expect(
      (
        await database.query(
          'SELECT id FROM country_resource_ledger WHERE game_id=$1',
          [gameId],
        )
      ).rowCount,
    ).toBe(0);
    const audit = (
      await database.query(
        "SELECT details,note FROM map_history WHERE game_id=$1 AND kind='EditProvince'",
        [gameId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      note: '开场省份资料',
      details: { provinceId, before: { taxBase: 0 }, after: { taxBase: 5 } },
    });
    expect((await put(await input({ expectedRevision: 1 }))).statusCode).toBe(
      400,
    ); // No-op.
    expect(
      (await put(await input({ taxBase: 6 }), provinceId, playerCookie))
        .statusCode,
    ).toBe(403);
    await games.transitionCurrentQuarter({
      gameId,
      userId: hostId,
      state: 'ActionSubmission',
    });
    const locked = await put(await input({ expectedRevision: 1, taxBase: 6 }));
    expect(locked.json().error.code).toBe('PROVINCE_SETUP_LOCKED');
    expect((await provinces()).canEdit).toBe(false);
  });
  it('rejects malformed values, name collisions, stale revisions and foreign identifiers without modifying the draft', async () => {
    for (const extra of [
      { taxBase: -1 },
      { productionBase: 0.5 },
      { manpowerBase: 1000001 },
      { autonomy: 100.01 },
      { unrest: -100.01 },
      { unrest: 1.001 },
      { reason: '' },
      { name: '' },
    ] as Array<Partial<SetProvinceInput>>)
      expect((await put(await input(extra))).statusCode).toBe(400);
    expect((await put(await input({ name: '南岸' }))).json().error.code).toBe(
      'PROVINCE_NAME_CONFLICT',
    );
    expect(
      (await put(await input({ expectedRevision: 1 }))).json().error.code,
    ).toBe('PROVINCE_VERSION_CONFLICT');
    expect(
      (await put(await input({ expectedMapRevision: 1 }))).json().error.code,
    ).toBe('MAP_VERSION_CONFLICT');
    const outsider = await auth.createDevelopmentUser({
      username: 'province-foreign',
      displayName: 'foreign',
      password: 'province-password',
    });
    await database.query("UPDATE games SET status='Completed' WHERE id=$1", [
      gameId,
    ]);
    const foreign = await games.create({
      userId: outsider.id,
      name: '其他游戏',
      countryNames: ['外邦'],
    });
    await world.setup.create(foreign.id, outsider.id, {
      name: '外地',
      width: 1,
      height: 1,
    });
    const tile = (
      await world.getViewport({
        gameId: foreign.id,
        userId: outsider.id,
        minQ: 0,
        maxQ: 0,
        minR: 0,
        maxR: 0,
      })
    ).tiles[0]!;
    await world.setup.batch(foreign.id, outsider.id, {
      expectedRevision: (await world.getMap(foreign.id, outsider.id)).revision!,
      tileIds: [tile.id],
      provinceName: '外省',
      regionName: '外区',
    });
    const foreignProvince = (
      await world.provinces.list(foreign.id, outsider.id)
    ).provinces[0]!;
    expect((await put(await input(), foreignProvince.id)).statusCode).toBe(404);
    await expect(
      world.provinces.list(gameId, outsider.id),
    ).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
    expect(await world.provinces.list(foreign.id, outsider.id)).toMatchObject({
      provinces: [{ values: { taxBase: 0 } }],
    });
    expect(
      (await provinces()).provinces.find((p) => p.id === provinceId)!.revision,
    ).toBe(0);
  });
  it('updates the name of a visible homeland province immediately without changing borders', async () => {
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[0]!],
      state: 'Observed',
      note: '',
    });
    expect((await put(await input({ name: '北境省' }))).statusCode).toBe(200);
    const old = await world.getTile(gameId, playerId, tiles[0]!);
    expect(old).toMatchObject({
      provinceName: '北境省',
      discoveryState: 'Observed',
    });
    expect(
      (await world.provinces.list(gameId, playerId)).provinces.find(
        (p) => p.id === provinceId,
      )!.name,
    ).toBe('北境省');
    expect(
      (await provinces()).provinces.find((p) => p.id === provinceId)!
        .legalOwners,
    ).toEqual([{ countryId, countryName: '北国', tileCount: 2 }]);
    await world.setup.knowledge(gameId, hostId, {
      expectedRevision: await revision(),
      countryId,
      tileIds: [tiles[0]!],
      state: 'Observed',
      note: '',
    });
    expect(
      (await world.getTile(gameId, playerId, tiles[0]!)).provinceName,
    ).toBe('北境省');
  });
  it('attaches a complete unassigned region to a province and refuses silent reassignment of unselected tiles', async () => {
    const ids = tiles.slice(6, 8);
    await world.setup.batch(gameId, hostId, {
      expectedRevision: await revision(),
      tileIds: ids,
      regionName: '新界',
    });
    const rev = await revision();
    await expect(
      world.setup.batch(gameId, hostId, {
        expectedRevision: rev,
        tileIds: [ids[0]!],
        regionName: '新界',
        provinceName: '新省',
      }),
    ).rejects.toMatchObject({ code: 'REGION_PROVINCE_CONFLICT' });
    expect(await revision()).toBe(rev);
    expect((await provinces()).provinces.map((p) => p.name)).not.toContain(
      '新省',
    );
    await world.setup.batch(gameId, hostId, {
      expectedRevision: rev,
      tileIds: ids,
      regionName: '新界',
      provinceName: '新省',
    });
    const data = await provinces();
    expect(data.provinces.find((p) => p.name === '新省')).toMatchObject({
      tileCount: 2,
      values: { taxBase: 0 },
      legalOwners: [{ countryId: null, tileCount: 2 }],
    });
    expect(
      (await world.setup.get(gameId, hostId)).provinces?.map((p) => p.name),
    ).toContain('新省');
  });
});
