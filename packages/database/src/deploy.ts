import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadServiceConfig } from '@srilanka/config';

import { createBackup } from './backup.js';
import { createDatabasePool } from './index.js';
import { redact, toolsFromEnvironment } from './postgres-tools.js';

const config = loadServiceConfig();
const sourceRoot = resolve(
  process.env.BACKUP_SOURCE_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
);

try {
  const database = createDatabasePool(config.databaseUrl);
  let initialized = false;
  try {
    const table = await database.query<{ name: string | null }>(
      "SELECT to_regclass('public.schema_migrations') AS name",
    );
    if (table.rows[0]?.name) {
      const applied = await database.query(
        'SELECT 1 FROM public.schema_migrations LIMIT 1',
      );
      initialized = Boolean(applied.rowCount);
    }
  } finally {
    await database.end();
  }
  // A fresh installation has nothing to preserve. Existing deployments must
  // finish a verified checkpoint before the new image can run any migrations.
  if (initialized && process.env.BACKUP_ENABLED !== 'false') {
    const backup = await createBackup({
      databaseUrl: config.databaseUrl,
      sourceRoot,
      directory: resolve(
        process.env.BACKUP_DIRECTORY || resolve(sourceRoot, 'backups'),
      ),
      tools: toolsFromEnvironment(),
    });
    console.log(
      JSON.stringify({
        event: 'deployment-backup-complete',
        path: backup.path,
      }),
    );
  }
  await import('./migrate.js');
  console.log(JSON.stringify({ event: 'deployment-migrated' }));
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'deployment-failed',
      detail: redact(
        error instanceof Error ? error.message : '未知错误',
        config.databaseUrl,
      ),
    }),
  );
  process.exitCode = 1;
}
