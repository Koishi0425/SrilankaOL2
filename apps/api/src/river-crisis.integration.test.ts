import { afterAll, beforeEach, expect, it } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { runRiverCrisis } from './playtest/river-crisis.js';
const config = loadServiceConfig({ ...process.env, NODE_ENV: 'test' });
const database = createDatabasePool(config.databaseUrl);
beforeEach(async () => {
  await database.query(
    'TRUNCATE auth_sessions,game_members,quarters,countries,games,users CASCADE',
  );
});
afterAll(async () => {
  await database.end();
});
it('replays the river crisis with policy supplementation, economy, diplomacy, occupation, private feedback and next season reform', async () => {
  const report = await runRiverCrisis(database, 'trial-test-2026');
  expect(report.accounts).toHaveLength(4);
  expect(report.checks).toHaveLength(9);
  expect(report.riverProduction).toEqual({
    firstQuarter: 54,
    secondQuarter: 79.2,
  });
  expect(await runRiverCrisis(database, 'unused-on-replay')).toEqual(report);
  expect((await database.query('SELECT id FROM games')).rowCount).toBe(1);
}, 30000);
