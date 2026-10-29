import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { registerWorldRoutes } from './world-routes.js';
import { WorldService } from './world-service.js';
import { ApiFault } from '../../errors.js';
import type { AuthService } from '../auth/auth-service.js';
import { PGlite } from '@electric-sql/pglite';
import type { DatabasePool } from '@srilanka/database';
import { generateMap, generationDefaults } from '@srilanka/contracts';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import { MapSetupService } from './map-setup-service.js';

it('reproduces geography with unique in-bounds coordinates and changes it with the seed', () => {
  const first = generateMap(40, 28, generationDefaults);
  expect(generateMap(40, 28, generationDefaults)).toEqual(first);
  expect(
    generateMap(40, 28, { ...generationDefaults, seed: 'another' }),
  ).not.toEqual(first);
  expect(new Set(first.map((t) => `${t.q}:${t.r}`)).size).toBe(1120);
  expect(new Set(first.map((t) => t.terrain)).size).toBe(5);
});
it('makes sea level, wetness and age change their advertised terrain proportions', () => {
  const count = (
    options: Partial<typeof generationDefaults>,
    types: string[],
  ) =>
    generateMap(40, 28, { ...generationDefaults, ...options }).filter((t) =>
      types.includes(t.terrain),
    ).length;
  expect(count({ seaLevel: 'High' }, ['water'])).toBeGreaterThan(
    count({ seaLevel: 'Low' }, ['water']),
  );
  expect(count({ rainfall: 'Wet' }, ['forest'])).toBeGreaterThan(
    count({ rainfall: 'Dry' }, ['forest']),
  );
  expect(count({ worldAge: 'Young' }, ['mountains', 'hills'])).toBeGreaterThan(
    count({ worldAge: 'Old' }, ['mountains', 'hills']),
  );
});
it.each(['Pangaea', 'Continents', 'Archipelago', 'InlandSea'] as const)(
  '%s allocates every land tile and no water to valid countries',
  (mapType) => {
    const tiles = generateMap(40, 28, {
      ...generationDefaults,
      mapType,
      countryIds: ['a', 'b', 'c', 'd'],
    });
    expect(
      new Set(tiles.filter((t) => t.countryId).map((t) => t.countryId)).size,
    ).toBe(4);
    expect(
      tiles.every((t) =>
        t.terrain === 'water' ? t.countryId === null : !!t.countryId,
      ),
    ).toBe(true);
    expect(generateMap(1, 1, { ...generationDefaults, mapType })).toHaveLength(
      1,
    );
  },
);
it('rejects invalid dimensions and an impossible country allocation', () => {
  expect(() => generateMap(101, 20, generationDefaults)).toThrow();
  expect(() => generateMap(10.5, 20, generationDefaults)).toThrow();
  expect(() =>
    generateMap(1, 1, { ...generationDefaults, countryIds: ['a', 'b'] }),
  ).toThrow('陆地不足');
});

// Real migrations and PostgreSQL SQL, in a disposable local engine.
const pg = new PGlite();
const client = {
  async query(sql: string, params?: unknown[]) {
    const result = await pg.query(sql, params);
    return { rows: result.rows, rowCount: result.affectedRows };
  },
  release() {},
};
const pool = {
  ...client,
  connect: async () => client,
} as unknown as DatabasePool;
const setup = new MapSetupService(pool);
const gameId = randomUUID(),
  hostId = randomUUID(),
  playerId = randomUUID(),
  quarterId = randomUUID(),
  countryId = randomUUID(),
  otherCountryId = randomUUID();
beforeAll(async () => {
  const dir = new URL(
    '../../../../../packages/database/migrations/',
    import.meta.url,
  );
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith('.sql'))
    .sort())
    await pg.exec(await readFile(new URL(file, dir), 'utf8'));
}, 30000);
beforeEach(async () => {
  await pg.exec('TRUNCATE users,games CASCADE');
  for (const id of [hostId, playerId])
    await pg.query(
      "INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$2,'unused')",
      [id, id],
    );
  await pg.query(
    "INSERT INTO games(id,name,host_user_id,status) VALUES($1,'地图生成测试',$2,'Preparing')",
    [gameId, hostId],
  );
  await pg.query(
    "INSERT INTO quarters(id,game_id,game_year,season,sequence_number,state,is_current) VALUES($1,$2,1,'Spring',1,'Preparing',TRUE)",
    [quarterId, gameId],
  );
  for (const id of [countryId, otherCountryId])
    await pg.query('INSERT INTO countries(id,game_id,name) VALUES($1,$2,$3)', [
      id,
      gameId,
      id,
    ]);
  for (const [id, role] of [
    [hostId, 'Host'],
    [playerId, 'Player'],
  ])
    await pg.query(
      "INSERT INTO game_members(id,game_id,user_id,role,status) VALUES($1,$2,$3,$4,'Active')",
      [randomUUID(), gameId, id, role],
    );
});
afterAll(async () => {
  await pg.close();
});
const tiles = async () =>
  (
    await pg.query<{
      id: string;
      q: number;
      r: number;
      terrain: string;
      countryId: string | null;
      passable: boolean;
    }>(
      `SELECT t.id,t.q,t.r,tt.key AS terrain,t.controller_country_id AS "countryId",t.passable FROM hex_tiles t JOIN terrain_types tt ON tt.id=t.terrain_type_id WHERE t.game_id=$1 ORDER BY r,q`,
      [gameId],
    )
  ).rows;

it('saves the exact preview, ownership and water movement rules in one creation', async () => {
  const options = {
    ...generationDefaults,
    countryIds: [countryId, otherCountryId],
  };
  const result = await setup.create(gameId, hostId, {
    name: '自动地图',
    width: 24,
    height: 16,
    generation: options,
  });
  const saved = await tiles();
  expect(
    saved.map(({ q, r, terrain, countryId }) => ({ q, r, terrain, countryId })),
  ).toEqual(generateMap(24, 16, options));
  expect(saved.every((t) => t.passable === (t.terrain !== 'water'))).toBe(true);
  expect(result.generationBlockedReason).toBeTruthy();
  expect(result.map!.revision).toBe(2);
});
it('regenerates only unconfigured opening geography, retains tile IDs and stores before/after history', async () => {
  const initial = await setup.create(gameId, hostId, {
    name: '空白',
    width: 16,
    height: 12,
  });
  const ids = (await tiles()).map((t) => t.id);
  const next = await setup.generate(gameId, hostId, {
    ...generationDefaults,
    expectedRevision: initial.map!.revision!,
  });
  expect((await tiles()).map((t) => t.id)).toEqual(ids);
  expect(next.map!.revision).toBe(3);
  expect(
    (
      await pg.query<{ details: { before: unknown[]; after: unknown[] } }>(
        "SELECT details FROM map_history WHERE kind='GenerateMap'",
      )
    ).rows[0]!.details.before,
  ).toHaveLength(192);
  await expect(
    setup.generate(gameId, hostId, {
      ...generationDefaults,
      expectedRevision: 2,
    }),
  ).rejects.toMatchObject({ code: 'MAP_VERSION_CONFLICT' });
});
it.each(['country', 'region', 'city', 'army', 'knowledge', 'road'] as const)(
  'protects an existing %s from regeneration',
  async (kind) => {
    const initial = await setup.create(gameId, hostId, {
      name: '已布置',
      width: 8,
      height: 6,
    });
    const id = (await tiles())[0]!.id;
    if (kind === 'country')
      await pg.query(
        'UPDATE hex_tiles SET legal_owner_country_id=$2 WHERE id=$1',
        [id, countryId],
      );
    if (kind === 'region') {
      const regionId = randomUUID();
      await pg.query(
        "INSERT INTO regions(id,game_id,map_id,name) VALUES($1,$2,$3,'已有地区')",
        [regionId, gameId, initial.map!.id],
      );
      await pg.query('UPDATE hex_tiles SET region_id=$2 WHERE id=$1', [
        id,
        regionId,
      ]);
    }
    if (kind === 'city')
      await pg.query(
        "INSERT INTO cities(id,game_id,tile_id,name) VALUES($1,$2,$3,'已有城市')",
        [randomUUID(), gameId, id],
      );
    if (kind === 'army')
      await pg.query(
        "INSERT INTO armies(id,game_id,tile_id,country_id,name,strength) VALUES($1,$2,$3,$4,'已有军队',100)",
        [randomUUID(), gameId, id, countryId],
      );
    if (kind === 'knowledge')
      await pg.query(
        "INSERT INTO country_tile_knowledge(id,game_id,country_id,tile_id,discovery_state) VALUES($1,$2,$3,$4,'Mapped')",
        [randomUUID(), gameId, countryId, id],
      );
    if (kind === 'road')
      await pg.query('UPDATE hex_tiles SET road_level=1 WHERE id=$1', [id]);
    const before = await tiles();
    await expect(
      setup.generate(gameId, hostId, {
        ...generationDefaults,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'MAP_GENERATION_HAS_CONTENT' });
    expect(await tiles()).toEqual(before);
  },
);
it('rejects foreign countries atomically and prevents players and running games from generating', async () => {
  await expect(
    setup.create(gameId, hostId, {
      name: '错误',
      width: 8,
      height: 6,
      generation: { ...generationDefaults, countryIds: [randomUUID()] },
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MAP_COUNTRY' });
  expect((await setup.get(gameId, hostId)).map).toBeNull();
  await setup.create(gameId, hostId, { name: '空白', width: 8, height: 6 });
  await expect(
    setup.generate(gameId, playerId, {
      ...generationDefaults,
      expectedRevision: 2,
    }),
  ).rejects.toMatchObject({ code: 'HOST_PERMISSION_REQUIRED' });
  await pg.query("UPDATE games SET status='Running' WHERE id=$1", [gameId]);
  await expect(
    setup.generate(gameId, hostId, {
      ...generationDefaults,
      expectedRevision: 2,
    }),
  ).rejects.toMatchObject({ code: 'MAP_GENERATION_LOCKED' });
});

it('validates map-generation requests and authentication through the real HTTP routes', async () => {
  const app = Fastify();
  await app.register(cookie);
  const auth = {
    authenticate: async (token?: string) => (token ? { id: token } : null),
  } as unknown as AuthService;
  await registerWorldRoutes(app, auth, new WorldService(pool));
  app.setErrorHandler((error, _request, reply) =>
    reply
      .code(error instanceof ApiFault ? error.statusCode : 500)
      .send({ message: error instanceof Error ? error.message : 'failed' }),
  );
  try {
    const url = `/api/v1/games/${gameId}/map`,
      headers = { cookie: `srilanka_session=${hostId}` };
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          payload: {
            name: 'test',
            width: 20,
            height: 16,
            generation: generationDefaults,
          },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            name: 'test',
            width: 20,
            height: 16,
            generation: { ...generationDefaults, mapType: 'invalid' },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            name: 'test',
            width: 20,
            height: 16,
            generation: { ...generationDefaults, seed: ' ' },
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url,
          headers,
          payload: {
            name: 'test',
            width: 20,
            height: 16,
            generation: generationDefaults,
          },
        })
      ).statusCode,
    ).toBe(201);
    const result = await app.inject({
      method: 'POST',
      url: `${url}/generate`,
      headers,
      payload: { ...generationDefaults, expectedRevision: 2, seed: 'new' },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().data.map.revision).toBe(3);
  } finally {
    await app.close();
  }
});
