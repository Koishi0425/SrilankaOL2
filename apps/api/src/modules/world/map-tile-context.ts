import { tileTagWeight, type TileTag } from '@srilanka/contracts';
import { nationalPolicyStatus, treatyStatus } from '@srilanka/contracts';
import type {
  MapTileContext,
  ProvinceValues,
  TileDetails,
  EconomicRules,
} from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  readDiplomacy,
  canReadTreaty,
} from '../diplomacy/diplomacy-service.js';
import { readGovernmentState } from '../government/government-service.js';
import { calculateEconomy } from '../settlements/economy.js';
import {
  knownAdministrationSql,
  type ViewContext,
} from './perception-service.js';

export async function readMapTileContext(
  db: DatabaseClient,
  gameId: string,
  tile: TileDetails,
  view: ViewContext,
  referenceCountryId?: string,
): Promise<MapTileContext> {
  const result: MapTileContext = {
    tileId: tile.id,
    province: null,
    economy: null,
    tradeZones: null,
    government: null,
    diplomacy: null,
  };
  const host = view.access === 'Truth';
  // Preview uses the same country as the player, regardless of the host's selector.
  const reference = host ? (referenceCountryId ?? null) : view.countryId;
  const diplomacy = await readDiplomacy(db, gameId);
  const countries = diplomacy.countries ?? [];
  if (host && reference && !countries.some((c) => c.id === reference))
    throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该国家。');
  const owner = countries.find((c) =>
    tile.legalOwnerCountryId
      ? c.id === tile.legalOwnerCountryId
      : c.name === tile.legalOwnerCountryName,
  );
  const related = new Set(
    [owner?.id, tile.controllerCountryId].filter((id): id is string => !!id),
  );
  if (related.size) {
    result.diplomacy = {
      referenceCountryId: reference,
      referenceCountryName:
        countries.find((c) => c.id === reference)?.name ?? null,
      relations: diplomacy.relations.filter(
        (r) =>
          r.countryIds.some((id) => related.has(id)) &&
          (!reference || r.countryIds.includes(reference)),
      ),
      treaties: diplomacy.treaties.filter(
        (t) =>
          treatyStatus(t, diplomacy.quarter.sequenceNumber) === 'Active' &&
          (host || canReadTreaty(t, view.countryId)) &&
          t.countryIds.some((id) => related.has(id)) &&
          (!reference || t.countryIds.includes(reference)),
      ),
    };
  }
  if (!tile.provinceName) return result;
  const geography =
    host || view.access === 'Public'
      ? (
          await db.query<{ id: string; q: number; r: number }>(
            `SELECT t.id,t.q,t.r FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id JOIN provinces p ON p.game_id=r.game_id AND p.id=r.province_id WHERE t.game_id=$1 AND p.name=$2 ORDER BY t.r,t.q`,
            [gameId, tile.provinceName],
          )
        ).rows
      : (
          await db.query<{ id: string; q: number; r: number }>(
            `SELECT t.id,t.q,t.r FROM country_tile_knowledge k JOIN hex_tiles t ON t.game_id=k.game_id AND t.id=k.tile_id WHERE k.game_id=$1 AND k.country_id=$2 AND k.discovery_state IN ('Mapped','Observed') AND ${knownAdministrationSql} AND k.snapshot->>'provinceName'=$3 ORDER BY t.r,t.q`,
            [gameId, view.countryId, tile.provinceName],
          )
        ).rows;
  result.province = {
    id: null,
    name: tile.provinceName,
    tiles: geography,
    knownOnly: !host && view.access !== 'Public',
    values: null,
  };
  // Geography never grants access to a foreign province's economy or government.
  const profiles = await db.query<{
    id: string;
    name: string;
    description: string;
    tax_base: number;
    production_base: number;
    manpower_base: number;
    autonomy: string;
    unrest: string;
    tile_count: string;
    own_count: string;
  }>(
    `SELECT p.*,count(t.id) AS tile_count,count(t.id) FILTER (WHERE t.legal_owner_country_id=$3) AS own_count
      FROM provinces p JOIN regions r ON r.game_id=p.game_id AND r.province_id=p.id JOIN hex_tiles t ON t.game_id=r.game_id AND t.region_id=r.id
      WHERE p.game_id=$1 AND p.name=$2 GROUP BY p.id`,
    [gameId, tile.provinceName, view.countryId],
  );
  const province = profiles.rows[0];
  if (province) result.province.id = province.id;
  const own =
    view.access === 'Player' &&
    owner?.id === view.countryId &&
    province &&
    Number(province.own_count) === Number(province.tile_count);
  if (!province || (!host && !own)) return result;
  const values: ProvinceValues = {
    description: province.description,
    taxBase: province.tax_base,
    productionBase: province.production_base,
    manpowerBase: province.manpower_base,
    autonomy: Number(province.autonomy),
    unrest: Number(province.unrest),
  };
  result.province.values = values;
  const government = await readGovernmentState(db, gameId);
  if (owner && (host || owner.id === view.countryId)) {
    const profile = government.profiles.find((p) => p.countryId === owner.id);
    const policies = government.policies.filter(
      (p) =>
        p.countryId === owner.id &&
        nationalPolicyStatus(p, government.quarter.sequenceNumber) === 'Active',
    );
    if (profile) result.government = { profile, policies };
    const { economic_rules: rules } = (
      await db.query<{ economic_rules: EconomicRules }>(
        'SELECT economic_rules FROM games WHERE id=$1',
        [gameId],
      )
    ).rows[0]!;
    const eligible = Number(
      (
        await db.query<{ count: string }>(
          `SELECT count(*) FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id WHERE t.game_id=$1 AND r.province_id=$2 AND t.legal_owner_country_id=$3 AND t.controller_country_id=$3`,
          [gameId, province.id, owner.id],
        )
      ).rows[0]!.count,
    );
    const knownTags = (
      await db.query<{ tags: TileTag[] }>(
        `SELECT CASE WHEN $4::boolean THEN map_tile_tags(t.id) ELSE COALESCE(k.snapshot->'tags','[]'::jsonb) END AS tags FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id LEFT JOIN country_tile_knowledge k ON k.game_id=t.game_id AND k.tile_id=t.id AND k.country_id=$3 WHERE t.game_id=$1 AND r.province_id=$2 AND t.legal_owner_country_id=$3 AND t.controller_country_id=$3`,
        [gameId, province.id, owner.id, host],
      )
    ).rows;
    const lines = calculateEconomy({
      capturedAt: '',
      worldVersion: 0,
      rules,
      rulesRevision: 0,
      countries: [owner],
      provinces: [
        {
          id: province.id,
          name: province.name,
          ...values,
          tileCount: Number(province.tile_count),
          eligible: [
            {
              countryId: owner.id,
              tileCount: eligible,
              taxWeight: knownTags.reduce(
                (sum, t) => sum + tileTagWeight(t.tags, 'Tax'),
                0,
              ),
              productionWeight: knownTags.reduce(
                (sum, t) => sum + tileTagWeight(t.tags, 'Production'),
                0,
              ),
            },
          ],
        },
      ],
      armies: [],
      policies,
    });
    result.economy = {
      enabled: rules.enabled,
      countryName: owner.name,
      tax: lines.find((l) => l.kind === 'Tax')?.calculatedAmount ?? 0,
      production:
        lines.find((l) => l.kind === 'Production')?.calculatedAmount ?? 0,
      manpower:
        lines.find((l) => l.kind === 'ManpowerGrowth')?.calculatedAmount ?? 0,
    };
  }
  result.tradeZones = (
    await db.query<{ id: string; name: string }>(
      `SELECT z.id,z.name FROM trade_zones z JOIN trade_zone_provinces zp ON zp.game_id=z.game_id AND zp.zone_id=z.id WHERE z.game_id=$1 AND zp.province_id=$2 AND ($3::boolean OR EXISTS(SELECT 1 FROM trade_influences i WHERE i.game_id=z.game_id AND i.zone_id=z.id AND i.country_id=$4 AND i.power>0)) ORDER BY z.name,z.id`,
      [gameId, province.id, host, view.countryId],
    )
  ).rows;
  return result;
}
