import { isDeepStrictEqual } from 'node:util';
import { provinceStatFields, toStateChangeInput } from '@srilanka/contracts';

import type {
  SettlementStateChange,
  SettlementStateChangeInput,
  SettlementStateOptions,
  ProvinceStats,
} from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { lockMap, recordMapChange } from '../world/map-mutations.js';
import { readTradeZones } from '../trade/trade-data.js';
import { validTradePower } from '../trade/trade-service.js';

import { tagBaseline, applyTileTag } from '../world/tile-tags.js';

type Baseline = { id: string; values: Record<string, unknown> };
export interface StoredStateChange {
  change: SettlementStateChange;
  before: Baseline[];
}

/** Confirm only the political fields explicitly changed by this publication. */
export async function publishTerritoryKnowledge(
  db: DatabaseClient,
  gameId: string,
  changes: StoredStateChange[],
) {
  for (const { change, before } of changes) {
    if (change.kind !== 'Territory') continue;
    const previous = before.map((tile) => ({
      tileId: tile.id,
      controllerCountryId: tile.values.controllerCountryId ?? null,
      legalOwnerCountryId: tile.values.legalOwnerCountryId ?? null,
    }));
    await db.query(
      `UPDATE country_tile_knowledge k SET
      snapshot=COALESCE(k.snapshot,'{}'::jsonb)||jsonb_build_object('dynamicKnown',true)
        || CASE WHEN $3::boolean THEN jsonb_build_object('controllerCountryId',t.controller_country_id,'controllerCountryName',c.name,'controllerColor',c.map_color) ELSE '{}'::jsonb END
        || CASE WHEN $4::boolean THEN jsonb_build_object('legalOwnerCountryId',t.legal_owner_country_id,'legalOwnerCountryName',l.name,'legalOwnerColor',l.map_color) ELSE '{}'::jsonb END,
      discovery_state=CASE WHEN k.discovery_state='Mapped' THEN 'Mapped' ELSE k.discovery_state END,
      updated_at=NOW()
      FROM hex_tiles t
      LEFT JOIN countries c ON c.game_id=t.game_id AND c.id=t.controller_country_id
      LEFT JOIN countries l ON l.game_id=t.game_id AND l.id=t.legal_owner_country_id
      JOIN jsonb_to_recordset($5::jsonb) p("tileId" uuid,"controllerCountryId" uuid,"legalOwnerCountryId" uuid) ON p."tileId"=t.id
      WHERE k.game_id=$1 AND t.game_id=k.game_id AND k.tile_id=t.id AND t.id=ANY($2::uuid[])
        AND k.discovery_state IN ('Mapped','Observed')
        AND k.country_id IN (t.controller_country_id,t.legal_owner_country_id,p."controllerCountryId",p."legalOwnerCountryId")`,
      [
        gameId,
        change.tileIds,
        change.controllerCountryId !== undefined,
        change.legalOwnerCountryId !== undefined,
        JSON.stringify(previous),
      ],
    );
  }
}

function invalid(message: string) {
  return new ApiFault(400, 'INVALID_STATE_CHANGE', message);
}

function target(change: SettlementStateChangeInput) {
  if (change.kind === 'TileTag')
    return `TileTag:${change.tag.name.trim()}:${[...change.tileIds].sort().join(',')}`;
  if (change.kind === 'TradeInfluence')
    return `TradeInfluence:${change.zoneId}:${change.countryId}`;
  if (change.kind === 'Province')
    return `Province:${change.provinceId}:${provinceStatFields.filter((key) => change.values[key] !== undefined).join(',')}`;
  return change.kind === 'Territory'
    ? `${change.kind}:${[...change.tileIds].sort().join(',')}:${change.controllerCountryId !== undefined}:${change.legalOwnerCountryId !== undefined}`
    : `${change.kind}:${change.armyId}`;
}

function keys(change: SettlementStateChangeInput) {
  if (change.kind === 'TileTag')
    return change.tileIds.map((id) => `tag:${id}:${change.tag.name.trim()}`);
  if (change.kind === 'Province')
    return provinceStatFields
      .filter((key) => change.values[key] !== undefined)
      .map((key) => `province:${change.provinceId}:${key}`);
  if (change.kind !== 'Territory') return [target(change)];
  return change.tileIds.flatMap((id) => [
    ...(change.controllerCountryId === undefined ? [] : [`control:${id}`]),
    ...(change.legalOwnerCountryId === undefined ? [] : [`owner:${id}`]),
  ]);
}

export async function stateOptions(
  db: DatabaseClient,
  gameId: string,
): Promise<SettlementStateOptions> {
  const map = await db.query<{ asset_version: string }>(
    'SELECT asset_version FROM world_maps WHERE game_id=$1',
    [gameId],
  );
  const countries = await db.query<{ id: string; name: string }>(
    "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active' ORDER BY name,id",
    [gameId],
  );
  const tiles = await db.query<SettlementStateOptions['tiles'][number]>(
    'SELECT t.id,t.q,t.r,t.passable,r.province_id AS "provinceId" FROM hex_tiles t LEFT JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id WHERE t.game_id=$1 ORDER BY t.r,t.q',
    [gameId],
  );
  const armies = await db.query<SettlementStateOptions['armies'][number]>(
    `SELECT a.id,a.name,a.country_id AS "countryId",c.name AS "countryName",
      a.tile_id AS "tileId",a.strength,t.q,t.r FROM armies a
      JOIN countries c ON c.game_id=a.game_id AND c.id=a.country_id
      JOIN hex_tiles t ON t.game_id=a.game_id AND t.id=a.tile_id
      WHERE a.game_id=$1 ORDER BY c.name,a.name,a.id`,
    [gameId],
  );
  const provinces = await db.query<ProvinceRow>(
    'SELECT id,name,tax_base,production_base,manpower_base,autonomy,unrest,profile_revision FROM provinces WHERE game_id=$1 ORDER BY name,id',
    [gameId],
  );
  return {
    mapRevision: Number(map.rows[0]?.asset_version ?? 0),
    countries: countries.rows,
    tiles: tiles.rows,
    armies: armies.rows,
    provinces: provinces.rows.map((p) => ({
      id: p.id,
      name: p.name,
      revision: p.profile_revision,
      values: provinceStats(p),
    })),
    tradeZones: (await readTradeZones(db, gameId)).map(
      ({ id, name, revision, influences }) => ({
        id,
        name,
        revision,
        influences,
      }),
    ),
  };
}

type ProvinceRow = {
  id: string;
  name: string;
  tax_base: number;
  production_base: number;
  manpower_base: number;
  autonomy: string;
  unrest: string;
  profile_revision: number;
};
function provinceStats(p: ProvinceRow): ProvinceStats {
  return {
    taxBase: p.tax_base,
    productionBase: p.production_base,
    manpowerBase: p.manpower_base,
    autonomy: Number(p.autonomy),
    unrest: Number(p.unrest),
  };
}
const provinceLabels: Record<keyof ProvinceStats, string> = {
  taxBase: '税收基础',
  productionBase: '生产基础',
  manpowerBase: '人力基础',
  autonomy: '自治',
  unrest: '不满',
};
function validProvinceValue(key: keyof ProvinceStats, value: number) {
  return (
    Number.isFinite(value) &&
    (key === 'autonomy' || key === 'unrest'
      ? value >= (key === 'unrest' ? -100 : 0) &&
        value <= 100 &&
        Math.abs(value * 100 - Math.round(value * 100)) < 0.0001
      : Number.isInteger(value) && value >= 0 && value <= 1000000)
  );
}

async function describeChange(
  db: DatabaseClient,
  gameId: string,
  input: SettlementStateChangeInput,
): Promise<StoredStateChange> {
  if (input.kind === 'TileTag') {
    const before = await tagBaseline(db, gameId, input);
    return {
      change: {
        ...toStateChangeInput(input),
        kind: 'TileTag',
        tileIds: input.tileIds,
        operation: input.operation,
        tag: { ...input.tag, name: input.tag.name.trim() },
        summary: `${input.tileIds.length} 格：${input.operation === 'Remove' ? '移除' : '设置'} ${input.tag.name.trim()}${input.operation === 'Set' ? '（下回合生效）' : ''}`,
      },
      before,
    };
  }
  if (input.kind === 'TradeInfluence') {
    if (
      !validTradePower(input.power) ||
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      !Number.isInteger(input.expectedZoneRevision) ||
      input.expectedZoneRevision < 0
    )
      throw invalid('请填写有效的贸易影响力和原因。');
    const z = (
      await db.query<{
        id: string;
        name: string;
        revision: number;
        country_name: string;
        power: string;
      }>(
        `SELECT z.id,z.name,z.revision,c.name AS country_name,COALESCE(i.power,0) AS power FROM trade_zones z JOIN countries c ON c.game_id=z.game_id AND c.id=$3 AND c.status='Active' LEFT JOIN trade_influences i ON i.game_id=z.game_id AND i.zone_id=z.id AND i.country_id=c.id WHERE z.game_id=$1 AND z.id=$2`,
        [gameId, input.zoneId, input.countryId],
      )
    ).rows[0];
    if (!z) throw invalid('贸易区或国家不属于当前游戏。');
    if (z.revision !== input.expectedZoneRevision)
      throw new ApiFault(
        409,
        'STATE_CHANGE_CONFLICT',
        '贸易区已变化，请移除原变化，刷新后重新添加。',
      );
    const power = Number(z.power);
    return {
      change: {
        id: input.id,
        actionId: input.actionId,
        kind: input.kind,
        zoneId: input.zoneId,
        countryId: input.countryId,
        power: input.power,
        expectedZoneRevision: input.expectedZoneRevision,
        reason: input.reason.trim(),
        zoneName: z.name,
        countryName: z.country_name,
        beforePower: power,
        summary: `${z.name} · ${z.country_name}：贸易影响力 ${power} → ${input.power}`,
      },
      before: [
        {
          id: z.id,
          values: {
            name: z.name,
            revision: z.revision,
            countryId: input.countryId,
            countryName: z.country_name,
            power,
          },
        },
      ],
    };
  }
  if (input.kind === 'Province') {
    if (
      !input.values ||
      Array.isArray(input.values) ||
      !Object.keys(input.values).length ||
      Object.keys(input.values).some(
        (key) => !provinceStatFields.includes(key as keyof ProvinceStats),
      ) ||
      provinceStatFields.some(
        (key) =>
          input.values[key] !== undefined &&
          !validProvinceValue(key, input.values[key]!),
      ) ||
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      !Number.isInteger(input.expectedProfileRevision) ||
      input.expectedProfileRevision < 0
    )
      throw invalid('请填写有效的省份调整数值和原因。');
    const p = (
      await db.query<ProvinceRow>(
        'SELECT id,name,tax_base,production_base,manpower_base,autonomy,unrest,profile_revision FROM provinces WHERE game_id=$1 AND id=$2',
        [gameId, input.provinceId],
      )
    ).rows[0];
    if (!p) throw invalid('省份不属于当前游戏或已不存在。');
    if (p.profile_revision !== input.expectedProfileRevision)
      throw new ApiFault(
        409,
        'STATE_CHANGE_CONFLICT',
        '省份资料已变化，请移除原变化，刷新后重新添加。',
        { changeId: input.id },
      );
    const original = provinceStats(p),
      fields = provinceStatFields.filter(
        (key) => input.values[key] !== undefined,
      );
    const beforeValues = Object.fromEntries(
      fields.map((key) => [key, original[key]]),
    );
    return {
      change: {
        ...toStateChangeInput(input),
        kind: 'Province',
        provinceId: input.provinceId,
        expectedProfileRevision: input.expectedProfileRevision,
        values: { ...input.values },
        reason: input.reason.trim(),
        provinceName: p.name,
        beforeValues,
        summary: `${p.name}：${fields.map((key) => `${provinceLabels[key]} ${original[key]}${key === 'autonomy' ? '%' : ''} → ${input.values[key]}${key === 'autonomy' ? '%' : ''}`).join('，')}`,
      },
      before: [
        {
          id: p.id,
          values: { name: p.name, revision: p.profile_revision, ...original },
        },
      ],
    };
  }
  if (input.kind !== 'Territory') {
    const result = await db.query<{
      id: string;
      name: string;
      country_id: string;
      tile_id: string;
      strength: number;
      q: number;
      r: number;
    }>(
      `SELECT a.*,t.q,t.r FROM armies a JOIN hex_tiles t ON t.game_id=a.game_id AND t.id=a.tile_id
       WHERE a.game_id=$1 AND a.id=$2`,
      [gameId, input.armyId],
    );
    const army = result.rows[0];
    if (!army) throw invalid('军队不属于当前游戏或已不存在。');
    if (input.kind === 'ArmyStrength') {
      return {
        change: {
          ...input,
          summary: `${army.name}：兵力 ${army.strength} → ${input.strength}`,
        },
        before: [
          {
            id: army.id,
            values: { countryId: army.country_id, strength: army.strength },
          },
        ],
      };
    }
    const destination = await db.query<{
      q: number;
      r: number;
      passable: boolean;
    }>('SELECT q,r,passable FROM hex_tiles WHERE game_id=$1 AND id=$2', [
      gameId,
      input.destinationTileId,
    ]);
    const tile = destination.rows[0];
    if (!tile || !tile.passable)
      throw invalid('目的地必须是当前游戏的可通行地块。');
    return {
      change: {
        ...input,
        summary: `${army.name}：(${army.q}, ${army.r}) → (${tile.q}, ${tile.r})`,
      },
      before: [
        {
          id: army.id,
          values: { countryId: army.country_id, tileId: army.tile_id },
        },
      ],
    };
  }
  if (
    !input.tileIds.length ||
    new Set(input.tileIds).size !== input.tileIds.length
  )
    throw invalid('领土选区为空或包含重复地块。');
  if (
    input.controllerCountryId === undefined &&
    input.legalOwnerCountryId === undefined
  )
    throw invalid('请指定控制国或法定归属。');
  const countries = await db.query<{ id: string; name: string }>(
    "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active'",
    [gameId],
  );
  const names = new Map(countries.rows.map((row) => [row.id, row.name]));
  for (const countryId of [
    input.controllerCountryId,
    input.legalOwnerCountryId,
  ])
    if (countryId && !names.has(countryId))
      throw invalid('国家不属于当前游戏。');
  const tiles = await db.query<{
    id: string;
    q: number;
    r: number;
    controller_country_id: string | null;
    legal_owner_country_id: string | null;
    cities: Array<{ id: string; controllerCountryId: string | null }>;
  }>(
    `SELECT t.id,t.q,t.r,t.controller_country_id,t.legal_owner_country_id,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'controllerCountryId',c.controller_country_id) ORDER BY c.id)
      FROM cities c WHERE c.game_id=t.game_id AND c.tile_id=t.id),'[]'::jsonb) AS cities
      FROM hex_tiles t WHERE t.game_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.id`,
    [gameId, input.tileIds],
  );
  if (tiles.rows.length !== input.tileIds.length)
    throw invalid('选区中包含不属于当前游戏的地块。');
  const name = (id: string | null) => (id === null ? '无' : names.get(id)!);
  const description = [
    ...(input.controllerCountryId === undefined
      ? []
      : [`控制 → ${name(input.controllerCountryId)}`]),
    ...(input.legalOwnerCountryId === undefined
      ? []
      : [`法定归属 → ${name(input.legalOwnerCountryId)}`]),
  ];
  return {
    change: {
      ...input,
      summary: `${input.tileIds.length} 个地块（列 ${Math.min(...tiles.rows.map((tile) => tile.q))}–${Math.max(...tiles.rows.map((tile) => tile.q))}，行 ${Math.min(...tiles.rows.map((tile) => tile.r))}–${Math.max(...tiles.rows.map((tile) => tile.r))}）：${description.join('，')}`,
    },
    before: tiles.rows.map((tile) => ({
      id: tile.id,
      values: {
        ...(input.controllerCountryId === undefined
          ? {}
          : {
              controllerCountryId: tile.controller_country_id,
              cities: tile.cities,
            }),
        ...(input.legalOwnerCountryId === undefined
          ? {}
          : { legalOwnerCountryId: tile.legal_owner_country_id }),
      },
    })),
  };
}

function assertBaseline(saved: StoredStateChange, current: StoredStateChange) {
  if (!isDeepStrictEqual(saved.before, current.before))
    throw new ApiFault(
      409,
      'STATE_CHANGE_CONFLICT',
      `“${saved.change.summary}”的原始状态已变化，请移除该项，刷新后重新添加。`,
      { changeId: saved.change.id },
    );
}

function hasEffect({ change, before }: StoredStateChange) {
  if (change.kind === 'TileTag')
    return (
      change.operation === 'Set' ||
      before.some((item) => item.values.tag !== null)
    );
  if (change.kind === 'TradeInfluence')
    return before[0]!.values.power !== change.power;
  if (change.kind === 'Province')
    return provinceStatFields.some(
      (key) =>
        change.values[key] !== undefined &&
        change.values[key] !== before[0]!.values[key],
    );
  if (change.kind === 'ArmyMove')
    return before[0]!.values.tileId !== change.destinationTileId;
  if (change.kind === 'ArmyStrength')
    return before[0]!.values.strength !== change.strength;
  return before.some(
    ({ values }) =>
      (change.controllerCountryId !== undefined &&
        (values.controllerCountryId !== change.controllerCountryId ||
          (values.cities as Array<{ controllerCountryId: string | null }>).some(
            (city) => city.controllerCountryId !== change.controllerCountryId,
          ))) ||
      (change.legalOwnerCountryId !== undefined &&
        values.legalOwnerCountryId !== change.legalOwnerCountryId),
  );
}

export async function prepareStateChanges(
  db: DatabaseClient,
  gameId: string,
  inputs: SettlementStateChangeInput[],
  previous: StoredStateChange[],
  approvedActionIds: Set<string>,
  expectedRevision?: number,
) {
  const usedIds = new Set<string>();
  const usedTargets = new Set<string>();
  const existing = new Map(previous.map((item) => [item.change.id, item]));
  if (inputs.length) {
    const modified = inputs.some((input) => {
      const old = existing.get(input.id)?.change;
      if (!old) return true;
      return !isDeepStrictEqual(
        toStateChangeInput(old),
        toStateChangeInput(input),
      );
    });
    if (modified && expectedRevision === undefined)
      throw new ApiFault(
        409,
        'MAP_VERSION_CONFLICT',
        '请先读取当前地图，再保存状态变化。',
      );
    await lockMap(db, gameId, modified ? expectedRevision : undefined);
  }
  const stored: StoredStateChange[] = [];
  for (const input of inputs) {
    if (usedIds.has(input.id)) throw invalid('状态变化标识重复。');
    usedIds.add(input.id);
    if (input.actionId && !approvedActionIds.has(input.actionId))
      throw invalid('状态变化只能关联本回合已批准的政策。');
    for (const key of keys(input)) {
      if (usedTargets.has(key))
        throw invalid(
          '同一军队、地块或省份的同一项状态只能设置一次，请合并后保存。',
        );
      usedTargets.add(key);
    }
    const current = await describeChange(db, gameId, input);
    const old = existing.get(input.id);
    if (old) {
      if (target(old.change) !== target(input))
        throw invalid('修改目标时请先移除原变化，再重新添加。');
      assertBaseline(old, current);
    }
    if (!hasEffect(current))
      throw invalid('该项变化与当前状态相同，请移除后保存。');
    stored.push(current);
  }
  return stored;
}

export async function publishStateChanges(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  stored: StoredStateChange[],
  expectedRevision?: number,
  createdArmies: Array<{
    id: string;
    countryId: string;
    tileId: string;
    name: string;
    strength: number;
  }> = [],
) {
  if (!stored.length && !createdArmies.length) return undefined;
  if (expectedRevision === undefined)
    throw new ApiFault(
      409,
      'MAP_VERSION_CONFLICT',
      '请刷新结算并检查地图状态后发布。',
    );
  const map = await lockMap(db, gameId, expectedRevision);
  const approved = await db.query<{ id: string }>(
    "SELECT id FROM actions WHERE game_id=$1 AND quarter_id=$2 AND status='Approved'",
    [gameId, quarterId],
  );
  await prepareStateChanges(
    db,
    gameId,
    stored.map((item) => toStateChangeInput(item.change)),
    stored,
    new Set(approved.rows.map((row) => row.id)),
  );
  const tiles = new Set<string>();
  for (const army of createdArmies) {
    await db.query(
      'INSERT INTO armies (id,game_id,country_id,tile_id,name,strength) VALUES ($1,$2,$3,$4,$5,$6)',
      [army.id, gameId, army.countryId, army.tileId, army.name, army.strength],
    );
    tiles.add(army.tileId);
  }
  for (const { change, before } of stored) {
    if (change.kind === 'ArmyMove') {
      await db.query(
        'UPDATE armies SET tile_id=$3 WHERE game_id=$1 AND id=$2',
        [gameId, change.armyId, change.destinationTileId],
      );
      tiles.add(before[0]!.values.tileId as string);
      tiles.add(change.destinationTileId);
    } else if (change.kind === 'ArmyStrength') {
      const army = await db.query<{ tile_id: string }>(
        'UPDATE armies SET strength=$3 WHERE game_id=$1 AND id=$2 RETURNING tile_id',
        [gameId, change.armyId, change.strength],
      );
      tiles.add(army.rows[0]!.tile_id);
    } else if (change.kind === 'TileTag') {
      await applyTileTag(db, gameId, map.quarter.sequence_number + 1, change);
      change.tileIds.forEach((id) => tiles.add(id));
    } else if (change.kind === 'TradeInfluence') {
      await db.query(
        'INSERT INTO trade_influences(game_id,zone_id,country_id,power) VALUES($1,$2,$3,$4) ON CONFLICT(game_id,zone_id,country_id) DO UPDATE SET power=EXCLUDED.power',
        [gameId, change.zoneId, change.countryId, change.power],
      );
    } else if (change.kind === 'Province') {
      const columns: Record<keyof ProvinceStats, string> = {
        taxBase: 'tax_base',
        productionBase: 'production_base',
        manpowerBase: 'manpower_base',
        autonomy: 'autonomy',
        unrest: 'unrest',
      };
      const fields = provinceStatFields.filter(
        (key) => change.values[key] !== undefined,
      );
      await db.query(
        `UPDATE provinces SET ${fields.map((key, i) => `${columns[key]}=$${i + 3}`).join(',')} WHERE game_id=$1 AND id=$2`,
        [gameId, change.provinceId, ...fields.map((key) => change.values[key])],
      );
    } else {
      await db.query(
        `UPDATE hex_tiles SET
        controller_country_id=CASE WHEN $3 THEN $4::uuid ELSE controller_country_id END,
        legal_owner_country_id=CASE WHEN $5 THEN $6::uuid ELSE legal_owner_country_id END,
        updated_at=NOW() WHERE game_id=$1 AND id=ANY($2::uuid[])`,
        [
          gameId,
          change.tileIds,
          change.controllerCountryId !== undefined,
          change.controllerCountryId ?? null,
          change.legalOwnerCountryId !== undefined,
          change.legalOwnerCountryId ?? null,
        ],
      );
      if (change.controllerCountryId !== undefined)
        await db.query(
          'UPDATE cities SET controller_country_id=$3 WHERE game_id=$1 AND tile_id=ANY($2::uuid[])',
          [gameId, change.tileIds, change.controllerCountryId],
        );
      change.tileIds.forEach((id) => tiles.add(id));
    }
  }
  const provinceIds = [
    ...new Set(
      stored.flatMap(({ change }) =>
        change.kind === 'Province' ? [change.provinceId] : [],
      ),
    ),
  ];
  const tradeIds = [
    ...new Set(
      stored.flatMap(({ change }) =>
        change.kind === 'TradeInfluence' ? [change.zoneId] : [],
      ),
    ),
  ];
  if (tradeIds.length)
    await db.query(
      'UPDATE trade_zones SET revision=revision+1 WHERE game_id=$1 AND id=ANY($2::uuid[])',
      [gameId, tradeIds],
    );
  if (provinceIds.length)
    await db.query(
      'UPDATE provinces SET profile_revision=profile_revision+1 WHERE game_id=$1 AND id=ANY($2::uuid[])',
      [gameId, provinceIds],
    );
  await recordMapChange(db, {
    gameId,
    userId,
    kind: 'PublishStateChanges',
    truth: true,
    worldVersion: map.worldVersion,
    tileIds: [...tiles],
    details: { quarterId, changes: stored, createdArmies },
  });
  return {
    previousWorldVersion: map.worldVersion,
    worldVersion: map.worldVersion + 1,
    tileIds: [...tiles],
  };
}
