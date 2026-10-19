import { randomUUID } from 'node:crypto';

import type { DatabaseClient, DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { refreshCountryVision } from './map-vision.js';

export async function requireMapHost(
  db: DatabaseClient | DatabasePool,
  gameId: string,
  userId: string,
) {
  const member = await db.query<{ role: string }>(
    "SELECT role FROM game_members WHERE game_id = $1 AND user_id = $2 AND status = 'Active'",
    [gameId, userId],
  );
  if (!member.rows[0])
    throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
  if (!['Host', 'Administrator'].includes(member.rows[0].role))
    throw new ApiFault(
      403,
      'HOST_PERMISSION_REQUIRED',
      '该操作需要主持人权限。',
    );
}

export async function lockMap(
  db: DatabaseClient,
  gameId: string,
  expectedRevision?: number,
) {
  // Quarter first: publishing exploration uses the same order as ordinary map edits.
  const quarter = await db.query<{
    id: string;
    state: string;
    sequence_number: number;
  }>(
    'SELECT id, state, sequence_number FROM quarters WHERE game_id = $1 AND is_current FOR SHARE',
    [gameId],
  );
  const map = await db.query<{ id: string; asset_version: string }>(
    'SELECT id, asset_version FROM world_maps WHERE game_id = $1 FOR UPDATE',
    [gameId],
  );
  if (!map.rows[0])
    throw new ApiFault(404, 'MAP_NOT_FOUND', '该游戏尚未初始化地图。');
  if (
    expectedRevision !== undefined &&
    Number(map.rows[0].asset_version) !== expectedRevision
  )
    throw new ApiFault(
      409,
      'MAP_VERSION_CONFLICT',
      '地图已变化，请刷新后重新检查选区。',
    );
  const game = await db.query<{
    current_world_version: string;
    status: string;
  }>(
    'SELECT current_world_version,status FROM games WHERE id = $1 FOR UPDATE',
    [gameId],
  );
  return {
    revision: Number(map.rows[0].asset_version),
    worldVersion: Number(game.rows[0]!.current_world_version),
    gameStatus: game.rows[0]!.status,
    quarter: quarter.rows[0]!,
  };
}

export async function captureTiles(
  db: DatabaseClient,
  gameId: string,
  tileIds: string[],
  missingStatus = 400,
) {
  const result = await db.query<{
    tileId: string;
    snapshot: Record<string, unknown>;
  }>(
    'SELECT id AS "tileId", map_tile_snapshot(id) AS snapshot FROM hex_tiles WHERE game_id = $1 AND id = ANY($2::uuid[]) ORDER BY r,q',
    [gameId, tileIds],
  );
  if (!tileIds.length || result.rows.length !== new Set(tileIds).size)
    throw new ApiFault(
      missingStatus,
      missingStatus === 404 ? 'OBJECT_NOT_FOUND' : 'INVALID_MAP_SELECTION',
      '选区中包含无效地块。',
    );
  return result.rows;
}

export function requireInstantCorrection(
  map: { quarter: { state: string }; gameStatus: string },
  input: { correctionReason?: string; expectedRevision?: number },
) {
  if (['Completed', 'Archived'].includes(map.gameStatus))
    throw new ApiFault(409, 'GAME_READ_ONLY', '本局已结束，只能查阅历史。');
  if (map.quarter.state === 'Preparing' && map.gameStatus === 'Preparing')
    return;
  if (
    !input.correctionReason?.trim() ||
    input.correctionReason.length > 2000 ||
    input.expectedRevision === undefined
  )
    throw new ApiFault(
      409,
      'INSTANT_CORRECTION_REQUIRED',
      '运行中的地图修改会立即生效。普通裁决请在回合结算中发布；修正错误请进入“即时更正”并填写原因。',
    );
}

export async function recordMapChange(
  db: DatabaseClient,
  input: {
    gameId: string;
    userId: string;
    kind: string;
    worldVersion: number;
    tileIds: string[];
    countryId?: string;
    sourceActionId?: string;
    note?: string;
    details: unknown;
    truth?: boolean;
  },
) {
  await db.query(
    'UPDATE world_maps SET asset_version = asset_version + 1 WHERE game_id = $1',
    [input.gameId],
  );
  const version = input.worldVersion + (input.truth ? 1 : 0);
  if (input.truth) {
    await db.query(
      'UPDATE games SET current_world_version = $2 WHERE id = $1',
      [input.gameId, version],
    );
  }
  await refreshCountryVision(db, input.gameId);
  await db.query(
    `INSERT INTO map_history (id, game_id, kind, country_id, source_action_id, actor_user_id, world_version, note, tile_count, details)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
    [
      randomUUID(),
      input.gameId,
      input.kind,
      input.countryId ?? null,
      input.sourceActionId ?? null,
      input.userId,
      version,
      input.note ?? '',
      input.tileIds.length,
      JSON.stringify(input.details),
    ],
  );
}

export async function mapTransaction<T>(
  database: DatabasePool,
  operation: (client: DatabaseClient) => Promise<T>,
) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
