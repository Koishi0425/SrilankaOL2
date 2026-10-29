import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest';
import type { DatabasePool, DatabaseClient } from '@srilanka/database';
import type {
  TileTagSpec,
  SettlementStateChangeInput,
} from '@srilanka/contracts';
import { tileTagWeight } from '@srilanka/contracts';
import { WorldService } from './world-service.js';
import { refreshCountryVision } from './map-vision.js';
import {
  captureEconomicSnapshot,
  calculateEconomy,
  type EconomicSnapshot,
} from '../settlements/economy.js';
import {
  prepareStateChanges,
  publishStateChanges,
} from '../settlements/state-changes.js';
const pg = new PGlite();
const client = {
  async query(sql: string, params?: unknown[]) {
    const r = await pg.query(sql, params);
    return { rows: r.rows, rowCount: r.rows.length || r.affectedRows };
  },
  release() {},
};
const pool = {
  ...client,
  connect: async () => client,
} as unknown as DatabasePool;
const db = client as unknown as DatabaseClient;
const world = new WorldService(pool),
  host = randomUUID(),
  player = randomUUID(),
  observer = randomUUID(),
  game = randomUUID(),
  quarter = randomUUID(),
  country = randomUUID();
let revision = 2,
  tile: string;
const harvest: TileTagSpec = {
  name: '丰收',
  description: '粮食增产',
  taxPercent: 0,
  productionPercent: 25,
  blocksObservation: false,
  duration: 2,
};
beforeAll(async () => {
  const dir = new URL(
    '../../../../../packages/database/migrations/',
    import.meta.url,
  );
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort())
    await pg.exec(await readFile(new URL(f, dir), 'utf8'));
}, 30000);
beforeEach(async () => {
  await pg.exec('TRUNCATE users,games CASCADE');
  for (const id of [host, player, observer])
    await pg.query(
      "INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$2,'unused')",
      [id, id],
    );
  await pg.query(
    "INSERT INTO games(id,name,host_user_id,status) VALUES($1,'标签测试',$2,'Preparing')",
    [game, host],
  );
  await pg.query('INSERT INTO countries(id,game_id,name) VALUES($1,$2,$3)', [
    country,
    game,
    '北国',
  ]);
  await pg.query(
    "INSERT INTO quarters(id,game_id,game_year,season,sequence_number,state,is_current) VALUES($1,$2,1,'Spring',1,'Preparing',TRUE)",
    [quarter, game],
  );
  for (const [id, role] of [
    [host, 'Host'],
    [player, 'Player'],
    [observer, 'Observer'],
  ])
    await pg.query(
      "INSERT INTO game_members(id,game_id,user_id,role,status,controlled_country_id) VALUES($1,$2,$3,$4,'Active',$5)",
      [randomUUID(), game, id, role, role === 'Player' ? country : null],
    );
  await world.setup.create(game, host, {
    name: '标签地图',
    width: 8,
    height: 6,
  });
  tile = (
    await pg.query<{ id: string }>(
      'SELECT id FROM hex_tiles WHERE game_id=$1 AND q=0 AND r=0',
      [game],
    )
  ).rows[0]!.id;
  revision = 2;
});
afterAll(async () => {
  await pg.close();
});
async function tag(
  value: TileTagSpec = harvest,
  operation: 'Set' | 'Remove' = 'Set',
) {
  const data = await world.setup.tags(game, host, {
    tileIds: [tile],
    expectedRevision: revision,
    operation,
    tag: value,
  });
  revision = data.map!.revision!;
}
async function reveal(state: 'Unknown' | 'Mapped' | 'Observed') {
  const data = await world.setup.knowledge(game, host, {
    tileIds: [tile],
    expectedRevision: revision,
    countryId: country,
    state,
    note: '',
  });
  revision = data.map!.revision!;
}
const known = () => world.getTile(game, player, tile);

it('keeps live tags out of geography and unknown tiles, and preserves recon until another observation', async () => {
  await tag();
  expect((await known()).tags).toEqual([]);
  await reveal('Mapped');
  expect(await known()).toMatchObject({
    discoveryState: 'Mapped',
    dynamicKnown: false,
    tags: [],
  });
  await reveal('Observed');
  const old = await known();
  expect(old.discoveryState).toBe('Mapped');
  expect(old.tags?.map((t) => t.name)).toEqual(['丰收']);
  await tag(harvest, 'Remove');
  await tag({ ...harvest, name: '遭到破坏', productionPercent: -50 });
  expect(
    (await world.getTile(game, host, tile)).tags?.map((t) => t.name),
  ).toEqual(['遭到破坏']);
  expect((await known()).tags).toEqual(old.tags);
  await reveal('Mapped');
  expect((await known()).tags).toEqual(old.tags);
  expect((await known()).observedAt).toBe(old.observedAt);
  await reveal('Observed');
  expect((await known()).tags?.map((t) => t.name)).toEqual(['遭到破坏']);
  expect((await world.getTile(game, observer, tile)).tags).toEqual([]);
});
it('caps actual visibility without granting geography and restores it after removal', async () => {
  await tag({
    ...harvest,
    name: '浓雾',
    productionPercent: 0,
    blocksObservation: true,
  });
  const data = await world.setup.batch(game, host, {
    expectedRevision: revision,
    tileIds: [tile],
    controllerCountryId: country,
  });
  revision = data.map!.revision!;
  expect((await known()).discoveryState).toBe('Unknown');
  expect((await known()).tags).toEqual([]);
  await tag(
    { ...harvest, name: '浓雾', productionPercent: 0, blocksObservation: true },
    'Remove',
  );
  expect((await known()).discoveryState).toBe('Observed');
  await tag({
    ...harvest,
    name: '浓雾',
    productionPercent: 0,
    blocksObservation: true,
  });
  expect(await known()).toMatchObject({
    discoveryState: 'Mapped',
    dynamicKnown: true,
    tags: [],
  });
});
it('expires truth by game quarter while preserving an unseen historical tag', async () => {
  await tag({ ...harvest, duration: 1 });
  await reveal('Observed');
  const old = (await known()).tags;
  await pg.query('UPDATE quarters SET sequence_number=2 WHERE id=$1', [
    quarter,
  ]);
  await refreshCountryVision(db, game);
  expect((await world.getTile(game, host, tile)).tags).toEqual([]);
  expect((await known()).tags).toEqual(old);
});
it('updates same-name tags without stacking and rejects players, foreign tiles and unapproved direct corrections', async () => {
  await tag();
  await tag({ ...harvest, productionPercent: 50 });
  expect((await world.getTile(game, host, tile)).tags).toHaveLength(1);
  await expect(
    world.setup.tags(game, player, {
      tileIds: [tile],
      expectedRevision: revision,
      operation: 'Set',
      tag: harvest,
    }),
  ).rejects.toMatchObject({ code: 'HOST_PERMISSION_REQUIRED' });
  await expect(
    world.setup.tags(game, host, {
      tileIds: [randomUUID()],
      expectedRevision: revision,
      operation: 'Set',
      tag: harvest,
    }),
  ).rejects.toMatchObject({ code: 'INVALID_MAP_SELECTION' });
  await pg.query("UPDATE games SET status='Running' WHERE id=$1", [game]);
  await expect(tag()).rejects.toMatchObject({
    code: 'INSTANT_CORRECTION_REQUIRED',
  });
});
it('freezes weighted tile effects with the economic baseline and does not apply one damaged tile to the whole province', async () => {
  const province = randomUUID(),
    region = randomUUID();
  const map = (await world.setup.get(game, host)).map!;
  await pg.query(
    "INSERT INTO provinces(id,game_id,map_id,name,production_base,tax_base) VALUES($1,$2,$3,'四格省',100,100)",
    [province, game, map.id],
  );
  await pg.query(
    "INSERT INTO regions(id,game_id,map_id,province_id,name) VALUES($1,$2,$3,$4,'四格地区')",
    [region, game, map.id, province],
  );
  await pg.query(
    'UPDATE hex_tiles SET region_id=$2,controller_country_id=$3,legal_owner_country_id=$3 WHERE game_id=$1 AND r=0 AND q<4',
    [game, region, country],
  );
  await pg.query('UPDATE games SET economic_rules=$2::jsonb WHERE id=$1', [
    game,
    JSON.stringify({
      enabled: true,
      taxCoefficient: 1,
      productionCoefficient: 1,
      manpowerCoefficient: 0,
      armyMaintenancePer100: 0,
      administrationCost: 0,
    }),
  ]);
  await tag({
    ...harvest,
    name: '破坏',
    productionPercent: -50,
    taxPercent: -20,
  });
  await captureEconomicSnapshot(db, game, quarter);
  const snapshot = (
    await pg.query<{ economic_snapshot: EconomicSnapshot }>(
      'SELECT economic_snapshot FROM quarters WHERE id=$1',
      [quarter],
    )
  ).rows[0]!.economic_snapshot;
  const lines = calculateEconomy(snapshot);
  expect(lines.find((l) => l.kind === 'Production')?.calculatedAmount).toBe(
    87.5,
  );
  expect(lines.find((l) => l.kind === 'Tax')?.calculatedAmount).toBe(95);
  await tag({ ...harvest, name: '破坏' }, 'Remove');
  await captureEconomicSnapshot(db, game, quarter);
  expect(
    (
      await pg.query('SELECT economic_snapshot FROM quarters WHERE id=$1', [
        quarter,
      ])
    ).rows[0],
  ).toEqual({ economic_snapshot: snapshot });
  expect(
    tileTagWeight(
      [
        { taxPercent: -100, productionPercent: 300 },
        { taxPercent: -100, productionPercent: 300 },
      ],
      'Production',
    ),
  ).toBe(40000);
});
it('stages state changes without applying them and publishes a bounded next-quarter effect', async () => {
  const input: SettlementStateChangeInput = {
    id: randomUUID(),
    actionId: null,
    kind: 'TileTag',
    tileIds: [tile],
    operation: 'Set',
    tag: { ...harvest, duration: 1 },
  };
  const prepared = await prepareStateChanges(
    db,
    game,
    [input],
    [],
    new Set(),
    revision,
  );
  expect((await world.getTile(game, host, tile)).tags).toEqual([]);
  await publishStateChanges(db, game, quarter, host, prepared, revision);
  expect((await world.getTile(game, host, tile)).tags).toEqual([]);
  await pg.query('UPDATE quarters SET sequence_number=2 WHERE id=$1', [
    quarter,
  ]);
  await refreshCountryVision(db, game);
  expect((await world.getTile(game, host, tile)).tags?.[0]).toMatchObject({
    name: '丰收',
    startsSequence: 2,
    endsSequence: 2,
  });
  await pg.query('UPDATE quarters SET sequence_number=3 WHERE id=$1', [
    quarter,
  ]);
  await refreshCountryVision(db, game);
  expect((await world.getTile(game, host, tile)).tags).toEqual([]);
});
