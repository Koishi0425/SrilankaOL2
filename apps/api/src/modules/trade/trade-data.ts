import type { TradeZoneSnapshot } from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
export async function readTradeZones(
  db: DatabaseClient,
  gameId: string,
): Promise<TradeZoneSnapshot[]> {
  const zones = (
    await db.query<{ id: string; name: string; revision: number }>(
      'SELECT id,name,revision FROM trade_zones WHERE game_id=$1 ORDER BY name,id',
      [gameId],
    )
  ).rows;
  const provinces = (
    await db.query<{
      zone_id: string;
      id: string;
      name: string;
      productionBase: number;
      tileCount: string;
    }>(
      `SELECT zp.zone_id,p.id,p.name,p.production_base AS "productionBase",(SELECT count(*) FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id WHERE t.game_id=p.game_id AND r.province_id=p.id) AS "tileCount" FROM trade_zone_provinces zp JOIN provinces p ON p.game_id=zp.game_id AND p.id=zp.province_id WHERE zp.game_id=$1 ORDER BY p.name,p.id`,
      [gameId],
    )
  ).rows;
  const influences = (
    await db.query<{ zone_id: string; countryId: string; power: string }>(
      `SELECT i.zone_id,i.country_id AS "countryId",i.power FROM trade_influences i JOIN countries c ON c.game_id=i.game_id AND c.id=i.country_id AND c.status='Active' WHERE i.game_id=$1 ORDER BY i.country_id`,
      [gameId],
    )
  ).rows;
  return zones.map((z) => ({
    ...z,
    provinces: provinces
      .filter((p) => p.zone_id === z.id)
      .map((p) => ({
        id: p.id,
        name: p.name,
        productionBase: p.productionBase,
        tileCount: Number(p.tileCount),
      })),
    influences: influences
      .filter((i) => i.zone_id === z.id)
      .map((i) => ({ countryId: i.countryId, power: Number(i.power) })),
  }));
}
