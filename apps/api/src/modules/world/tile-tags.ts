import { z } from 'zod';
import type { TileTagChange } from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';

export const tagChangeFields = {
  tileIds: z
    .array(z.string().uuid())
    .min(1)
    .max(2500)
    .refine((ids) => new Set(ids).size === ids.length),
  operation: z.enum(['Set', 'Remove']),
  tag: z.object({
    name: z.string().trim().min(1).max(60),
    description: z.string().trim().max(2000),
    taxPercent: z.number().int().min(-100).max(300),
    productionPercent: z.number().int().min(-100).max(300),
    blocksObservation: z.boolean(),
    duration: z.number().int().min(1).max(40).nullable(),
  }),
};
export async function tagBaseline(
  db: DatabaseClient,
  gameId: string,
  input: TileTagChange,
) {
  if (!z.object(tagChangeFields).safeParse(input).success)
    throw new ApiFault(400, 'INVALID_TILE_TAG', '地块状态参数无效。');
  const result = await db.query<{
    id: string;
    values: Record<string, unknown>;
  }>(
    `SELECT t.id,jsonb_build_object('tag',COALESCE((SELECT to_jsonb(s) FROM tile_tags s WHERE s.game_id=t.game_id AND s.tile_id=t.id AND s.name=$3),'null'::jsonb)) AS values FROM hex_tiles t WHERE t.game_id=$1 AND t.id=ANY($2::uuid[]) ORDER BY t.id`,
    [gameId, input.tileIds, input.tag.name.trim()],
  );
  if (result.rows.length !== input.tileIds.length)
    throw new ApiFault(
      400,
      'INVALID_MAP_SELECTION',
      '选区含有其他游戏或无效地块。',
    );
  return result.rows;
}
export async function applyTileTag(
  db: DatabaseClient,
  gameId: string,
  sequence: number,
  input: TileTagChange,
) {
  const name = input.tag.name.trim();
  if (input.operation === 'Remove') {
    await db.query(
      'DELETE FROM tile_tags WHERE game_id=$1 AND tile_id=ANY($2::uuid[]) AND name=$3',
      [gameId, input.tileIds, name],
    );
    return;
  }
  const tag = input.tag,
    ends = tag.duration === null ? null : sequence + tag.duration - 1;
  await db.query(
    `INSERT INTO tile_tags(id,game_id,tile_id,name,description,tax_percent,production_percent,blocks_observation,starts_sequence,ends_sequence)
    SELECT gen_random_uuid(),$1,x.tile,$3,$4,$5,$6,$7,$8,$9 FROM unnest($2::uuid[]) AS x(tile)
    ON CONFLICT(game_id,tile_id,name) DO UPDATE SET description=EXCLUDED.description,tax_percent=EXCLUDED.tax_percent,production_percent=EXCLUDED.production_percent,blocks_observation=EXCLUDED.blocks_observation,starts_sequence=EXCLUDED.starts_sequence,ends_sequence=EXCLUDED.ends_sequence`,
    [
      gameId,
      input.tileIds,
      name,
      tag.description.trim(),
      tag.taxPercent,
      tag.productionPercent,
      tag.blocksObservation,
      sequence,
      ends,
    ],
  );
}
