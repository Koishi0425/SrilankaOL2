import { createHash } from 'node:crypto';
import type { GamePreparation, QuarterSummary } from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';

// One statement gives the checklist and its revision the same database snapshot.
export async function readPreparation(
  db: DatabaseClient | DatabasePool,
  gameId: string,
  quarter: QuarterSummary,
): Promise<GamePreparation> {
  const { rows } = await db.query<{
    saved: {
      config: Record<string, unknown>;
      worldVersion: string;
      economicRevision: number;
      governmentRevision: number;
      automaticEconomy: boolean;
      countries: Array<{
        id: string;
        resourceRevision: number;
        resourcesSet: boolean;
      }>;
      players: Array<{
        id: string;
        displayName: string;
        countryId: string | null;
      }>;
      rulesSaved: boolean;
      map: (GamePreparation['map'] & { revision: string }) | null;
      governmentCountryCount: number;
    };
  }>(
    `SELECT jsonb_build_object(
       'config', g.config, 'worldVersion', g.current_world_version::text,
       'economicRevision', g.economic_rules_revision,
       'governmentRevision', g.government_revision,
       'automaticEconomy', COALESCE((g.economic_rules->>'enabled')::boolean, false),
       'countries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'id', c.id, 'resourceRevision', c.resource_revision,
         'resourcesSet', EXISTS(SELECT 1 FROM country_resource_ledger l
           WHERE l.game_id=g.id AND l.country_id=c.id AND l.kind='Setup')
       ) ORDER BY c.id) FROM countries c WHERE c.game_id=g.id AND c.status='Active'), '[]'::jsonb),
       'players', COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'id', gm.id, 'displayName', u.display_name, 'countryId', c.id
       ) ORDER BY gm.id) FROM game_members gm JOIN users u ON u.id=gm.user_id
         LEFT JOIN countries c ON c.game_id=g.id AND c.id=gm.controlled_country_id AND c.status='Active'
         WHERE gm.game_id=g.id AND gm.role='Player' AND gm.status='Active'), '[]'::jsonb),
       'rulesSaved', EXISTS(SELECT 1 FROM game_rule_history h WHERE h.game_id=g.id),
       'map', (SELECT jsonb_build_object('name', m.name, 'revision', m.asset_version::text,
         'tileCount', (SELECT COUNT(*)::integer FROM hex_tiles t WHERE t.game_id=g.id),
         'controlledTileCount', (SELECT COUNT(*)::integer FROM hex_tiles t WHERE t.game_id=g.id AND t.controller_country_id IS NOT NULL)
       ) FROM world_maps m WHERE m.game_id=g.id),
       'governmentCountryCount', (SELECT COUNT(*)::integer FROM country_governments cg
         JOIN countries c ON c.game_id=cg.game_id AND c.id=cg.country_id AND c.status='Active'
         WHERE cg.game_id=g.id)
     ) AS saved FROM games g WHERE g.id=$1`,
    [gameId],
  );
  const saved = rows[0]?.saved;
  if (!saved) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
  const unassignedPlayers = saved.players
    .filter((player) => !player.countryId)
    .map(({ id, displayName }) => ({ id, displayName }));
  return {
    quarter,
    revision: createHash('sha256')
      .update(JSON.stringify({ quarterId: quarter.id, saved }))
      .digest('hex'),
    canOpen:
      quarter.sequenceNumber === 1 &&
      quarter.state === 'Preparing' &&
      saved.countries.length > 0 &&
      saved.players.length > 0 &&
      unassignedPlayers.length === 0,
    countryCount: saved.countries.length,
    playerCount: saved.players.length,
    assignedPlayerCount: saved.players.length - unassignedPlayers.length,
    unassignedPlayers,
    rulesSaved: saved.rulesSaved,
    map: saved.map
      ? {
          name: saved.map.name,
          tileCount: saved.map.tileCount,
          controlledTileCount: saved.map.controlledTileCount,
        }
      : null,
    resourceCountryCount: saved.countries.filter(
      (country) => country.resourcesSet,
    ).length,
    automaticEconomy: saved.automaticEconomy,
    governmentCountryCount: saved.governmentCountryCount,
  };
}
