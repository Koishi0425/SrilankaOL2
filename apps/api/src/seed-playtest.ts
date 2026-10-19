import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { runRiverCrisis } from './playtest/river-crisis.js';
const config = loadServiceConfig();
const destination = new URL(config.databaseUrl);
if (
  !['localhost', '127.0.0.1'].includes(destination.hostname) ||
  !/^\/srilanka_playtest_[a-z0-9_]+$/.test(destination.pathname)
)
  throw new Error(
    '试局种子只允许写入本机 srilanka_playtest_ 开头的独立数据库。',
  );
const database = createDatabasePool(config.databaseUrl);
try {
  console.log(
    JSON.stringify(
      await runRiverCrisis(database, process.env.PLAYTEST_PASSWORD ?? ''),
      null,
      2,
    ),
  );
} finally {
  await database.end();
}
