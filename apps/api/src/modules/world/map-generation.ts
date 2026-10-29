import { generateMap, type MapGenerationOptions } from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';

export async function generationBlocked(
  db: DatabaseClient | DatabasePool,
  gameId: string,
) {
  const result = await db.query<{ blocked: boolean }>(
    `WITH generated_territory AS (
      SELECT 1 FROM map_history h WHERE h.game_id=$1
        AND jsonb_array_length(COALESCE(
          CASE WHEN h.kind='CreateMap' THEN h.details#>'{generation,countryIds}'
            WHEN h.kind='GenerateMap' THEN h.details#>'{options,countryIds}' END,'[]'::jsonb))>0
        AND NOT EXISTS(SELECT 1 FROM map_history edits WHERE edits.game_id=$1 AND edits.kind NOT IN ('CreateMap','GenerateMap'))
      ORDER BY h.created_at DESC,h.id DESC LIMIT 1
    ) SELECT
    EXISTS(SELECT 1 FROM hex_tiles WHERE game_id=$1 AND (occupier_country_id IS NOT NULL OR region_id IS NOT NULL OR road_level>0 OR notes<>''))
    OR EXISTS(SELECT 1 FROM tile_tags WHERE game_id=$1)
    OR EXISTS(SELECT 1 FROM cities WHERE game_id=$1)
    OR EXISTS(SELECT 1 FROM armies WHERE game_id=$1)
    OR EXISTS(SELECT 1 FROM country_army_intelligence WHERE game_id=$1)
    OR EXISTS(SELECT 1 FROM country_tile_knowledge WHERE game_id=$1 AND snapshot->>'automaticObservation' IS DISTINCT FROM 'true')
    OR (NOT EXISTS(SELECT 1 FROM generated_territory) AND (
      EXISTS(SELECT 1 FROM hex_tiles WHERE game_id=$1 AND (controller_country_id IS NOT NULL OR legal_owner_country_id IS NOT NULL))
      OR EXISTS(SELECT 1 FROM country_tile_knowledge WHERE game_id=$1)
    )) AS blocked`,
    [gameId],
  );
  return result.rows[0]!.blocked;
}

export async function applyGeneration(
  db: DatabaseClient,
  gameId: string,
  width: number,
  height: number,
  options: MapGenerationOptions,
) {
  const active = await db.query<{ id: string }>(
    "SELECT id FROM countries WHERE game_id=$1 AND status='Active'",
    [gameId],
  );
  if (
    new Set(options.countryIds).size !== options.countryIds.length ||
    options.countryIds.some((id) => !active.rows.some((c) => c.id === id))
  )
    throw new ApiFault(
      400,
      'INVALID_MAP_COUNTRY',
      '生成范围中的国家不属于当前游戏或已失效。',
    );
  let tiles;
  try {
    tiles = generateMap(width, height, options);
  } catch (error) {
    throw new ApiFault(
      400,
      'INVALID_MAP_GENERATION',
      error instanceof Error ? error.message : '地图参数无效。',
    );
  }
  const terrain = await db.query<{ key: string }>(
    'SELECT key FROM terrain_types WHERE game_id=$1',
    [gameId],
  );
  if (tiles.some((t) => !terrain.rows.some((v) => v.key === t.terrain)))
    throw new ApiFault(
      409,
      'MAP_TERRAIN_MISSING',
      '地图缺少标准地形，无法自动生成。',
    );
  await db.query(
    `UPDATE hex_tiles t SET terrain_type_id=tt.id, passable=tt.passable, movement_cost=tt.movement_cost,
    legal_owner_country_id=v.country_id, controller_country_id=v.country_id, updated_at=NOW()
    FROM jsonb_to_recordset($2::jsonb) AS v(q int,r int,terrain text,country_id uuid), terrain_types tt
    WHERE t.game_id=$1 AND t.q=v.q AND t.r=v.r AND tt.game_id=$1 AND tt.key=v.terrain`,
    [
      gameId,
      JSON.stringify(
        tiles.map((t) => ({
          q: t.q,
          r: t.r,
          terrain: t.terrain,
          country_id: t.countryId,
        })),
      ),
    ],
  );
}
