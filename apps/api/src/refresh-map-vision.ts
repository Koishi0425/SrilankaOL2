import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { lockMap, mapTransaction } from './modules/world/map-mutations.js';
import { refreshCountryVision } from './modules/world/map-vision.js';

// One-time refresh for existing saves; ordinary map changes maintain vision.
const database = createDatabasePool(loadServiceConfig().databaseUrl);
try {
  const maps = await database.query<{ game_id: string }>(
    'SELECT game_id FROM world_maps ORDER BY game_id',
  );
  for (const { game_id: gameId } of maps.rows)
    await mapTransaction(database, async (db) => {
      await lockMap(db, gameId);
      await refreshCountryVision(db, gameId);
      await db.query(
        'UPDATE world_maps SET asset_version=asset_version+1 WHERE game_id=$1',
        [gameId],
      );
    });
  console.log(
    `已更新 ${maps.rows.length} 局地图的当前视野，回合与结算历史保留。`,
  );
} finally {
  await database.end();
}
