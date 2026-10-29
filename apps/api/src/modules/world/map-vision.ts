import type { DatabaseClient } from '@srilanka/database';

// Convert odd-row coordinates to axial coordinates before applying the
// nineteen offsets in a two-hex radius. This is observation, not movement.
const offsets: string[] = [];
for (let q = -2; q <= 2; q++)
  for (let r = -2; r <= 2; r++)
    if (Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= 2)
      offsets.push(`(${q},${r})`);
const visibility = `WITH origins AS (
  SELECT controller_country_id AS country_id,q-(r-(r&1))/2 AS q,r
  FROM hex_tiles WHERE game_id=$1 AND controller_country_id IS NOT NULL
  UNION
  SELECT a.country_id,t.q-(t.r-(t.r&1))/2,t.r
  FROM armies a JOIN hex_tiles t ON t.game_id=a.game_id AND t.id=a.tile_id
  WHERE a.game_id=$1 AND a.strength>0
), visible AS MATERIALIZED (
  SELECT DISTINCT o.country_id,t.id AS tile_id
  FROM origins o CROSS JOIN (VALUES ${offsets.join(',')}) AS d(q,r)
  JOIN hex_tiles t ON t.game_id=$1 AND t.r=o.r+d.r
    AND t.q=o.q+d.q+(t.r-(t.r&1))/2
  JOIN countries c ON c.game_id=t.game_id AND c.id=o.country_id AND c.status='Active'
  WHERE NOT EXISTS(SELECT 1 FROM tile_tags s JOIN quarters q ON q.game_id=s.game_id AND q.is_current
    WHERE s.game_id=t.game_id AND s.tile_id=t.id AND s.blocks_observation AND s.starts_sequence<=q.sequence_number AND (s.ends_sequence IS NULL OR s.ends_sequence>=q.sequence_number))
)`;

/** Maintain current domestic/border observations while retaining reports lost to fog. */
export async function refreshCountryVision(db: DatabaseClient, gameId: string) {
  await db.query(
    `${visibility}, lost AS (
      UPDATE country_tile_knowledge k SET discovery_state='Mapped',updated_at=NOW()
      WHERE k.game_id=$1 AND k.discovery_state='Observed'
        AND NOT EXISTS(SELECT 1 FROM visible v WHERE v.country_id=k.country_id AND v.tile_id=k.tile_id)
      RETURNING k.id
    )
    INSERT INTO country_tile_knowledge(id,game_id,country_id,tile_id,discovery_state,confidence,observed_world_version,snapshot,observed_at)
    SELECT gen_random_uuid(),$1,v.country_id,v.tile_id,'Observed',100,g.current_world_version,
      map_tile_snapshot(t.id)||jsonb_build_object('automaticObservation',true,'dynamicKnown',true,'observationSequence',(SELECT sequence_number FROM quarters WHERE game_id=$1 AND is_current),'administrationKnown',
        t.legal_owner_country_id IS NOT DISTINCT FROM v.country_id OR COALESCE((k.snapshot->>'administrationKnown')::boolean,k.discovery_state='Observed',false)),NOW()
    FROM visible v JOIN hex_tiles t ON t.game_id=$1 AND t.id=v.tile_id
    JOIN games g ON g.id=t.game_id
    LEFT JOIN country_tile_knowledge k ON k.game_id=t.game_id AND k.country_id=v.country_id AND k.tile_id=t.id
    WHERE k.id IS NULL OR k.discovery_state<>'Observed' OR k.observed_world_version IS DISTINCT FROM g.current_world_version
      OR k.snapshot->>'automaticObservation' IS DISTINCT FROM 'true'
      OR k.snapshot->>'observationSequence' IS DISTINCT FROM (SELECT sequence_number::text FROM quarters WHERE game_id=$1 AND is_current)
    ON CONFLICT(game_id,country_id,tile_id) DO UPDATE SET discovery_state='Observed',confidence=100,
      observed_world_version=EXCLUDED.observed_world_version,snapshot=EXCLUDED.snapshot,
      observed_at=EXCLUDED.observed_at,updated_at=NOW()`,
    [gameId],
  );
  await db.query(
    `${visibility} DELETE FROM country_army_intelligence i
    WHERE i.game_id=$1 AND EXISTS(SELECT 1 FROM visible v WHERE v.country_id=i.country_id AND v.tile_id=i.observed_tile_id)
      AND NOT EXISTS(SELECT 1 FROM armies a WHERE a.game_id=i.game_id AND a.id=i.army_id AND a.tile_id=i.observed_tile_id AND a.strength>0)`,
    [gameId],
  );
  await db.query(
    `${visibility} UPDATE country_army_intelligence i SET is_outdated=TRUE,updated_at=NOW()
    WHERE i.game_id=$1 AND NOT i.is_outdated
      AND NOT EXISTS(SELECT 1 FROM visible v WHERE v.country_id=i.country_id AND v.tile_id=i.observed_tile_id)`,
    [gameId],
  );
  await db.query(
    `${visibility} INSERT INTO country_army_intelligence(id,game_id,country_id,army_id,perceived_name,perceived_country_id,strength_min,strength_max,confidence,observed_world_version,observed_tile_id,is_outdated)
    SELECT gen_random_uuid(),$1,v.country_id,a.id,a.name,a.country_id,
      FLOOR(a.strength*0.8)::integer,CEIL(a.strength*1.2)::integer,50,g.current_world_version,a.tile_id,FALSE
    FROM visible v JOIN armies a ON a.game_id=$1 AND a.tile_id=v.tile_id AND a.country_id<>v.country_id AND a.strength>0
    JOIN games g ON g.id=a.game_id
    ON CONFLICT(game_id,country_id,army_id) DO UPDATE SET perceived_name=EXCLUDED.perceived_name,
      perceived_country_id=EXCLUDED.perceived_country_id,strength_min=EXCLUDED.strength_min,strength_max=EXCLUDED.strength_max,
      confidence=50,observed_world_version=EXCLUDED.observed_world_version,observed_tile_id=EXCLUDED.observed_tile_id,
      is_outdated=FALSE,updated_at=NOW()
    WHERE country_army_intelligence.confidence<=50 OR country_army_intelligence.is_outdated
      OR country_army_intelligence.observed_world_version IS DISTINCT FROM EXCLUDED.observed_world_version`,
    [gameId],
  );
}
