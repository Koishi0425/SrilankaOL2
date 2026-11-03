import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import type {
  EconomicRules,
  SaveOpeningEconomyInput,
} from '@srilanka/contracts';
import { EconomicService } from './economic-service.js';
import { WorldService } from '../world/world-service.js';
import {
  captureEconomicSnapshot,
  calculateEconomy,
  type EconomicSnapshot,
} from '../settlements/economy.js';

const pg = new PGlite();
const client = {
  async query(sql: string, params?: unknown[]) {
    const result = await pg.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rows.length || result.affectedRows,
    };
  },
  release() {},
};
const pool = {
  ...client,
  connect: async () => client,
} as unknown as DatabasePool;
const service = new EconomicService(pool);
const world = new WorldService(pool);
const host = randomUUID(),
  player = randomUUID(),
  game = randomUUID(),
  quarter = randomUUID(),
  north = randomUUID(),
  south = randomUUID();
const rules: EconomicRules = {
  enabled: true,
  taxCoefficient: 1,
  productionCoefficient: 1,
  manpowerCoefficient: 1,
  armyMaintenancePer100: 5,
  administrationCost: 10,
  tradeCoefficient: 0,
};

beforeAll(async () => {
  const directory = new URL(
    '../../../../../packages/database/migrations/',
    import.meta.url,
  );
  for (const file of (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    await pg.exec(await readFile(new URL(file, directory), 'utf8'));
}, 30000);
beforeEach(async () => {
  await pg.exec('TRUNCATE users,games CASCADE');
  for (const id of [host, player])
    await pg.query(
      "INSERT INTO users(id,username,display_name,password_hash) VALUES($1,$2,$2,'unused')",
      [id, id],
    );
  await pg.query(
    "INSERT INTO games(id,name,host_user_id,status) VALUES($1,'预算试跑',$2,'Preparing')",
    [game, host],
  );
  await pg.query(
    "INSERT INTO quarters(id,game_id,game_year,season,sequence_number,state,is_current) VALUES($1,$2,1,'Spring',1,'Preparing',true)",
    [quarter, game],
  );
  for (const [id, name] of [
    [north, '北国'],
    [south, '南国'],
  ])
    await pg.query(
      'INSERT INTO countries(id,game_id,name,treasury,manpower) VALUES($1,$2,$3,100,1000)',
      [id, game, name],
    );
  for (const [user, role] of [
    [host, 'Host'],
    [player, 'Player'],
  ])
    await pg.query(
      "INSERT INTO game_members(id,game_id,user_id,role,status) VALUES($1,$2,$3,$4,'Active')",
      [randomUUID(), game, user, role],
    );
  await world.setup.create(game, host, {
    name: '试跑地图',
    width: 8,
    height: 6,
  });
  const province = randomUUID();
  await pg.query(
    "INSERT INTO provinces(id,game_id,map_id,name,tax_base,production_base,manpower_base,autonomy) SELECT $1,$2,id,'沿海省',100,50,20,0 FROM world_maps WHERE game_id=$2",
    [province, game],
  );
  const region = randomUUID();
  await pg.query(
    "INSERT INTO regions(id,game_id,map_id,province_id,name) SELECT $1,$2,id,$3,'沿海地区' FROM world_maps WHERE game_id=$2",
    [region, game, province],
  );
  await pg.query('UPDATE hex_tiles SET region_id=$2 WHERE game_id=$1', [
    game,
    region,
  ]);
  await pg.query(
    'UPDATE hex_tiles SET legal_owner_country_id=CASE WHEN q<4 THEN $2::uuid ELSE $3::uuid END, controller_country_id=CASE WHEN q<4 THEN $2::uuid ELSE $3::uuid END WHERE game_id=$1',
    [game, north, south],
  );
  await pg.query(
    "INSERT INTO armies(id,game_id,country_id,tile_id,name,strength,status) SELECT $1,$2,$3,id,'北军',200,'Active' FROM hex_tiles WHERE game_id=$2 AND q=0 AND r=0",
    [randomUUID(), game, north],
  );
});
afterAll(async () => pg.close());

async function stored() {
  return {
    game: (
      await pg.query(
        'SELECT economic_rules,economic_rules_revision,current_world_version FROM games WHERE id=$1',
        [game],
      )
    ).rows,
    quarter: (
      await pg.query('SELECT economic_snapshot FROM quarters WHERE id=$1', [
        quarter,
      ])
    ).rows,
    countries: (
      await pg.query(
        'SELECT id,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 ORDER BY id',
        [game],
      )
    ).rows,
    ledger: (
      await pg.query('SELECT * FROM country_resource_ledger WHERE game_id=$1', [
        game,
      ])
    ).rows,
    history: (
      await pg.query('SELECT * FROM economic_rule_history WHERE game_id=$1', [
        game,
      ])
    ).rows,
    profiles: (
      await pg.query(
        'SELECT id,tax_base,production_base,manpower_base,profile_revision FROM provinces WHERE game_id=$1 ORDER BY id',
        [game],
      )
    ).rows,
    maps: (
      await pg.query('SELECT asset_version FROM world_maps WHERE game_id=$1', [
        game,
      ])
    ).rows,
    mapHistory: (
      await pg.query(
        'SELECT id,kind,details FROM map_history WHERE game_id=$1 ORDER BY id',
        [game],
      )
    ).rows,
  };
}
async function draft(): Promise<SaveOpeningEconomyInput> {
  const preview = await service.preview(game, host, rules);
  return {
    quarterId: quarter,
    expectedPreparationRevision: preview.preparationRevision,
    rules,
    countries: [
      { id: north, treasury: 400, manpower: 1500 },
      { id: south, treasury: 500, manpower: 1600 },
    ],
    reason: '内测试跑预算',
  };
}

it('previews proposed coefficients without changing rules, resources, snapshots or ledgers', async () => {
  const before = await stored();
  const preview = await service.preview(game, host, rules);
  const country = preview.countries.find((country) => country.id === north)!;
  expect(
    country.lines.find((line) => line.kind === 'Tax')?.calculatedAmount,
  ).toBe(50);
  expect(
    country.lines.find((line) => line.kind === 'Production')?.calculatedAmount,
  ).toBe(25);
  expect(
    country.lines.find((line) => line.kind === 'ArmyMaintenance')
      ?.calculatedAmount,
  ).toBe(-10);
  expect(country.armyStrength).toBe(200);
  expect(await stored()).toEqual(before);
});

it('preserves real forces in a disabled-economy preview without inventing automatic cash flow', async () => {
  const preview = await service.preview(game, host);
  expect(preview.rules.enabled).toBe(false);
  expect(
    preview.countries.find((country) => country.id === north)?.armyStrength,
  ).toBe(200);
  expect(preview.countries.every((country) => country.lines.length === 0)).toBe(
    true,
  );
});

it('uses exactly the same calculation as the economic snapshot frozen at opening', async () => {
  await service.set(game, host, {
    expectedVersion: 0,
    rules,
    reason: '试跑规则',
  });
  const preview = await service.preview(game, host);
  await pg.exec('BEGIN');
  await captureEconomicSnapshot(
    client as unknown as DatabaseClient,
    game,
    quarter,
  );
  await pg.exec('COMMIT');
  const snapshot = (
    await pg.query<{ economic_snapshot: EconomicSnapshot }>(
      'SELECT economic_snapshot FROM quarters WHERE id=$1',
      [quarter],
    )
  ).rows[0]!.economic_snapshot;
  for (const country of preview.countries)
    expect(country.lines).toEqual(
      calculateEconomy(snapshot)
        .filter((line) => line.countryId === country.id)
        .map(({ kind, calculatedAmount, sources }) => ({
          kind,
          calculatedAmount,
          sources,
        })),
    );
});

it('saves all countries and rules together, with setup ledgers and rule history', async () => {
  const input = await draft();
  const result = await service.saveOpening(game, host, input);
  expect(result.rules).toEqual(rules);
  expect(
    result.countries.find((country) => country.id === north)?.treasury,
  ).toBe(400);
  expect(
    result.countries.find((country) => country.id === south)?.manpower,
  ).toBe(1600);
  const after = await stored();
  expect(after.ledger).toHaveLength(4);
  expect(after.history).toHaveLength(1);
  expect(after.quarter[0]).toEqual({ economic_snapshot: null });
  const beforeRetry = await stored();
  await expect(service.saveOpening(game, host, input)).rejects.toMatchObject({
    code: 'OPENING_SETUP_CHANGED',
  });
  expect(await stored()).toEqual(beforeRetry);
});

it('rejects a stale preparation revision without partially saving rules or balances', async () => {
  const input = await draft();
  await pg.query(
    'UPDATE countries SET treasury=999,resource_revision=resource_revision+1 WHERE id=$1',
    [south],
  );
  const before = await stored();
  await expect(service.saveOpening(game, host, input)).rejects.toMatchObject({
    code: 'OPENING_SETUP_CHANGED',
  });
  expect(await stored()).toEqual(before);
});

it('rolls the whole batch back if a later country update fails', async () => {
  await pg.query(
    "INSERT INTO provinces(id,game_id,map_id,name) SELECT $1,$2,id,'空白省' FROM world_maps WHERE game_id=$2",
    [randomUUID(), game],
  );
  const input = await draft();
  input.seedBlankProvinces = true;
  const lastCountryId = [north, south].sort().at(-1)!;
  input.countries.find((country) => country.id === lastCountryId)!.treasury =
    999;
  const before = await stored();
  await pg.exec(
    "CREATE FUNCTION test_opening_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.treasury=999 THEN RAISE EXCEPTION 'test write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_opening_failure BEFORE UPDATE ON countries FOR EACH ROW EXECUTE FUNCTION test_opening_failure();",
  );
  try {
    await expect(service.saveOpening(game, host, input)).rejects.toThrow(
      'test write failure',
    );
    expect(await stored()).toEqual(before);
  } finally {
    await pg.exec(
      'DROP TRIGGER test_opening_failure ON countries; DROP FUNCTION test_opening_failure();',
    );
  }
});

it('previews reference production for blank provinces and preserves edited or existing profiles on save', async () => {
  const blank = randomUUID(),
    touched = randomUUID(),
    region = randomUUID();
  for (const [id, name, revision] of [
    [blank, '空白省', 0],
    [touched, '已核对为零的省', 1],
  ] as const) {
    await pg.query(
      'INSERT INTO provinces(id,game_id,map_id,name,profile_revision) SELECT $1,$2,id,$3,$4 FROM world_maps WHERE game_id=$2',
      [id, game, name, revision],
    );
  }
  await pg.query(
    "INSERT INTO regions(id,game_id,map_id,province_id,name) SELECT $1,$2,id,$3,'空白地区' FROM world_maps WHERE game_id=$2",
    [region, game, blank],
  );
  await pg.query(
    'UPDATE hex_tiles SET region_id=$2 WHERE game_id=$1 AND q=0 AND r=0',
    [game, region],
  );
  const before = await stored();
  const preview = await service.preview(game, host, rules, true);
  expect(preview.unconfiguredProvinceCount).toBe(1);
  expect(
    preview.countries
      .find((country) => country.id === north)!
      .lines.find((line) => line.kind === 'Tax')!
      .sources.some(
        (source) => source.name === '空白省' && source.amount === 10,
      ),
  ).toBe(true);
  expect(await stored()).toEqual(before);
  const input = await draft();
  input.seedBlankProvinces = true;
  const result = await service.saveOpening(game, host, input);
  expect(result.unconfiguredProvinceCount).toBe(0);
  const profiles = (
    await pg.query<{
      id: string;
      tax_base: number;
      production_base: number;
      manpower_base: number;
    }>(
      'SELECT id,tax_base,production_base,manpower_base FROM provinces WHERE game_id=$1',
      [game],
    )
  ).rows;
  expect(profiles.find((province) => province.id === blank)).toMatchObject({
    tax_base: 10,
    production_base: 10,
    manpower_base: 100,
  });
  expect(profiles.find((province) => province.id === touched)).toMatchObject({
    tax_base: 0,
    production_base: 0,
    manpower_base: 0,
  });
  expect(
    profiles.find(
      (province) => province.id !== blank && province.id !== touched,
    ),
  ).toMatchObject({ tax_base: 100, production_base: 50, manpower_base: 20 });
  expect(
    (
      await pg.query(
        "SELECT id FROM map_history WHERE game_id=$1 AND kind='EditProvince'",
        [game],
      )
    ).rows,
  ).toHaveLength(1);
});

it('requires host permission for both reading private budgets and applying them', async () => {
  const input = await draft();
  const before = await stored();
  await expect(service.preview(game, player, rules)).rejects.toMatchObject({
    code: 'HOST_PERMISSION_REQUIRED',
  });
  await expect(service.saveOpening(game, player, input)).rejects.toMatchObject({
    code: 'HOST_PERMISSION_REQUIRED',
  });
  expect(await stored()).toEqual(before);
});

it('rejects duplicate or foreign countries and invalid balances', async () => {
  const input = await draft();
  const before = await stored();
  await expect(
    service.saveOpening(game, host, {
      ...input,
      countries: [input.countries[0]!, input.countries[0]!],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_OPENING_SETUP' });
  await expect(
    service.saveOpening(game, host, {
      ...input,
      countries: [
        input.countries[0]!,
        { ...input.countries[1]!, id: randomUUID() },
      ],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_OPENING_SETUP' });
  await expect(
    service.saveOpening(game, host, {
      ...input,
      countries: [
        { ...input.countries[0]!, manpower: -1 },
        input.countries[1]!,
      ],
    }),
  ).rejects.toMatchObject({ code: 'INVALID_OPENING_SETUP' });
  expect(await stored()).toEqual(before);
});

it('locks opening setup after submissions begin and on later quarters', async () => {
  const input = await draft();
  await pg.query("UPDATE quarters SET state='ActionSubmission' WHERE id=$1", [
    quarter,
  ]);
  await expect(service.preview(game, host, rules)).rejects.toMatchObject({
    code: 'ECONOMIC_RULES_LOCKED',
  });
  await expect(service.saveOpening(game, host, input)).rejects.toMatchObject({
    code: 'OPENING_SETUP_LOCKED',
  });
  await pg.query(
    "UPDATE quarters SET state='Preparing',sequence_number=2 WHERE id=$1",
    [quarter],
  );
  await expect(service.saveOpening(game, host, input)).rejects.toMatchObject({
    code: 'OPENING_SETUP_LOCKED',
  });
});
