import type { DiscoveryState, MapRevealPlan } from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { captureTiles, recordMapChange } from './map-mutations.js';

export interface TileObservation {
  tileId: string;
  snapshot: Record<string, unknown>;
}
export interface ArmyReport {
  id: string;
  tileId: string;
  name: string;
  countryId: string;
  min: number;
  max: number;
}

export async function captureArmyReports(
  db: DatabaseClient,
  gameId: string,
  countryId: string,
  tileIds: string[],
  errorPercent: number,
): Promise<ArmyReport[]> {
  const armies = await db.query<{
    id: string;
    tile_id: string;
    country_id: string;
    name: string;
    strength: number;
  }>(
    'SELECT * FROM armies WHERE game_id=$1 AND tile_id=ANY($2::uuid[]) AND country_id<>$3 ORDER BY id',
    [gameId, tileIds, countryId],
  );
  return armies.rows.map((army) => ({
    id: army.id,
    tileId: army.tile_id,
    countryId: army.country_id,
    name: army.name,
    min: Math.floor(army.strength * (1 - errorPercent / 100)),
    max: Math.min(
      2_147_483_647,
      Math.ceil(army.strength * (1 + errorPercent / 100)),
    ),
  }));
}
export interface RevealRow {
  action_id: string;
  country_id: string;
  state: DiscoveryState;
  note: string;
  tile_snapshots: TileObservation[];
  army_reports: ArmyReport[] | null;
  army_error_percent: number | null;
  observed_world_version: string;
  updated_at: Date;
  published_at: Date | null;
}

export function revealSummary(row: RevealRow): MapRevealPlan {
  return {
    actionId: row.action_id,
    countryId: row.country_id,
    tileIds: row.tile_snapshots.map((tile) => tile.tileId),
    state: row.state,
    note: row.note,
    ...(row.army_error_percent === null
      ? {}
      : { armyErrorPercent: row.army_error_percent }),
    publishedAt: row.published_at?.toISOString() ?? null,
  };
}

export async function applyObservation(
  db: DatabaseClient,
  input: {
    gameId: string;
    countryId: string;
    state: DiscoveryState;
    note: string;
    tiles: TileObservation[];
    reports: ArmyReport[] | null;
    worldVersion: number;
    observedAt: Date;
  },
) {
  await db.query(
    `INSERT INTO country_tile_knowledge (id, game_id, country_id, tile_id, discovery_state, confidence, observed_world_version, snapshot, public_note, observed_at)
    SELECT gen_random_uuid(),$1,$2,x."tileId",CASE WHEN $3='Unknown' THEN 'Unknown' ELSE 'Mapped' END,
      CASE WHEN $3='Unknown' THEN NULL ELSE 100 END,$4,
      CASE WHEN $3='Unknown' THEN '{}'::jsonb
        WHEN $3='Observed' THEN x.snapshot||jsonb_build_object('dynamicKnown',true)
        ELSE COALESCE(k.snapshot,'{}'::jsonb)||(x.snapshot-ARRAY['tags','controllerCountryId','controllerCountryName','controllerColor','legalOwnerCountryId','legalOwnerCountryName','legalOwnerColor','occupierCountryName','automaticObservation','dynamicKnown','observationSequence'])
          ||jsonb_build_object('dynamicKnown',COALESCE((k.snapshot->>'dynamicKnown')::boolean,false),'tags',COALESCE(k.snapshot->'tags','[]'::jsonb)) END,
      $5,CASE WHEN $3='Observed' THEN $6::timestamptz WHEN $3='Unknown' THEN NULL ELSE k.observed_at END
    FROM jsonb_to_recordset($7::jsonb) AS x("tileId" uuid,snapshot jsonb)
    LEFT JOIN country_tile_knowledge k ON k.game_id=$1 AND k.country_id=$2 AND k.tile_id=x."tileId"
    ON CONFLICT(game_id,country_id,tile_id) DO UPDATE SET discovery_state=EXCLUDED.discovery_state,confidence=EXCLUDED.confidence,
      observed_world_version=EXCLUDED.observed_world_version,snapshot=EXCLUDED.snapshot,public_note=EXCLUDED.public_note,
      observed_at=EXCLUDED.observed_at,updated_at=NOW()`,
    [
      input.gameId,
      input.countryId,
      input.state,
      input.worldVersion,
      input.note,
      input.observedAt,
      JSON.stringify(
        input.tiles.map((tile) => ({
          ...tile,
          snapshot: {
            ...tile.snapshot,
            administrationKnown:
              tile.snapshot.administrationKnown ??
              ['Mapped', 'Observed'].includes(input.state),
          },
        })),
      ),
    ],
  );
  const ids = input.tiles.map((tile) => tile.tileId);
  if (input.state === 'Unknown' || input.reports !== null) {
    await db.query(
      'DELETE FROM country_army_intelligence WHERE game_id = $1 AND country_id = $2 AND observed_tile_id = ANY($3::uuid[])',
      [input.gameId, input.countryId, ids],
    );
  }
  if (input.reports?.length) {
    await db.query(
      `INSERT INTO country_army_intelligence (id, game_id, country_id, army_id, perceived_name, perceived_country_id, strength_min, strength_max, confidence, observed_world_version, observed_tile_id, is_outdated)
      SELECT gen_random_uuid(), $1, $2, x.id, x.name, x."countryId", x.min, x.max, 65, $3, x."tileId",
        ($3 <> (SELECT current_world_version FROM games WHERE id = $1))
      FROM jsonb_to_recordset($4::jsonb) AS x(id uuid, name text, "countryId" uuid, min integer, max integer, "tileId" uuid)
      ON CONFLICT (game_id, country_id, army_id) DO UPDATE SET perceived_name = EXCLUDED.perceived_name, perceived_country_id = EXCLUDED.perceived_country_id,
        strength_min = EXCLUDED.strength_min, strength_max = EXCLUDED.strength_max, confidence = EXCLUDED.confidence,
        observed_world_version = EXCLUDED.observed_world_version, observed_tile_id = EXCLUDED.observed_tile_id, is_outdated = EXCLUDED.is_outdated, updated_at = NOW()`,
      [
        input.gameId,
        input.countryId,
        input.worldVersion,
        JSON.stringify(input.reports),
      ],
    );
  }
}

export async function listRevealPlans(
  db: DatabasePool | DatabaseClient,
  gameId: string,
  quarterId: string,
) {
  const rows = await db.query<RevealRow>(
    'SELECT * FROM map_reveal_plans WHERE game_id = $1 AND quarter_id = $2 ORDER BY updated_at, id',
    [gameId, quarterId],
  );
  return rows.rows.map(revealSummary);
}

export async function publishMapReveals(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  expectedRevision?: number,
  statePublication?: {
    previousWorldVersion: number;
    worldVersion: number;
    tileIds: string[];
    mapRevisionDelta?: number;
  },
) {
  const result = await db.query<RevealRow & { status: string }>(
    'SELECT p.*, a.status FROM map_reveal_plans p JOIN actions a ON a.game_id = p.game_id AND a.id = p.action_id WHERE p.game_id = $1 AND p.quarter_id = $2 AND p.published_at IS NULL ORDER BY p.updated_at, p.id',
    [gameId, quarterId],
  );
  const map = await db.query<{ asset_version: string }>(
    'SELECT asset_version FROM world_maps WHERE game_id = $1 FOR UPDATE',
    [gameId],
  );
  if (
    (result.rows.length && expectedRevision === undefined) ||
    (expectedRevision !== undefined &&
      expectedRevision +
        (statePublication ? (statePublication.mapRevisionDelta ?? 1) : 0) !==
        Number(map.rows[0]?.asset_version ?? 0))
  )
    throw new ApiFault(
      409,
      'MAP_VERSION_CONFLICT',
      '地图或探索结果已变化，请刷新结算并重新检查。',
    );
  if (!result.rows.length) return;
  if (result.rows.some((row) => row.status !== 'Approved'))
    throw new ApiFault(
      409,
      'INVALID_EXPLORATION_RESULT',
      '探索揭示对应的政策尚未批准，请修改或移除揭示计划。',
    );
  const game = await db.query<{ current_world_version: string }>(
    'SELECT current_world_version FROM games WHERE id = $1 FOR UPDATE',
    [gameId],
  );
  for (const row of result.rows) {
    // Only fold this transaction's world changes into a still-current observation.
    // Older observations keep their saved snapshot and remain stale.
    if (
      statePublication &&
      Number(row.observed_world_version) ===
        statePublication.previousWorldVersion
    ) {
      const ids = row.tile_snapshots.map((tile) => tile.tileId);
      if (ids.some((id) => statePublication.tileIds.includes(id))) {
        row.tile_snapshots = await captureTiles(db, gameId, ids);
        if (row.army_error_percent !== null)
          row.army_reports = await captureArmyReports(
            db,
            gameId,
            row.country_id,
            ids,
            row.army_error_percent,
          );
      }
      row.observed_world_version = String(statePublication.worldVersion);
      await db.query(
        'UPDATE map_reveal_plans SET tile_snapshots=$3::jsonb,army_reports=$4::jsonb,observed_world_version=$5 WHERE game_id=$1 AND action_id=$2',
        [
          gameId,
          row.action_id,
          JSON.stringify(row.tile_snapshots),
          row.army_reports === null ? null : JSON.stringify(row.army_reports),
          statePublication.worldVersion,
        ],
      );
    }
    const before = await db.query(
      'SELECT tile_id, discovery_state, snapshot, public_note FROM country_tile_knowledge WHERE game_id = $1 AND country_id = $2 AND tile_id = ANY($3::uuid[])',
      [gameId, row.country_id, row.tile_snapshots.map((tile) => tile.tileId)],
    );
    await applyObservation(db, {
      gameId,
      countryId: row.country_id,
      state: row.state,
      note: row.note,
      tiles: row.tile_snapshots,
      reports: row.army_reports,
      worldVersion: Number(row.observed_world_version),
      observedAt: row.updated_at,
    });
    await recordMapChange(db, {
      gameId,
      userId,
      kind: 'PublishExploration',
      worldVersion: Number(game.rows[0]!.current_world_version),
      tileIds: row.tile_snapshots.map((tile) => tile.tileId),
      countryId: row.country_id,
      sourceActionId: row.action_id,
      note: row.note,
      details: {
        before: before.rows,
        after: row.tile_snapshots,
        state: row.state,
        reports: row.army_reports,
      },
    });
  }
  await db.query(
    'UPDATE map_reveal_plans SET published_at = NOW() WHERE game_id = $1 AND quarter_id = $2 AND published_at IS NULL',
    [gameId, quarterId],
  );
}
