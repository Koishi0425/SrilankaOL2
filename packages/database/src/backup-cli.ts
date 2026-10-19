import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { loadServiceConfig } from '@srilanka/config';

import {
  createBackup,
  pruneScheduledBackups,
  restoreBackup,
  verifyBackup,
} from './backup.js';
import { redact, toolsFromEnvironment } from './postgres-tools.js';

const config = loadServiceConfig();
const root = resolve(
  process.env.BACKUP_SOURCE_ROOT ||
    resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
);
const tools = toolsFromEnvironment();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    backup: { type: 'string' },
    'target-name': { type: 'string' },
    directory: { type: 'string' },
    'interval-minutes': { type: 'string' },
    keep: { type: 'string' },
  },
});
const directory = resolve(
  values.directory || process.env.BACKUP_DIRECTORY || resolve(root, 'backups'),
);
const command = positionals[0] || 'create';
function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`缺少 ${name}。`);
  return value;
}
function positive(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${name} 必须是正整数。`);
  return number;
}
const log = (event: string, detail: unknown) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), event, detail }),
  );

try {
  if (command === 'create') {
    const result = await createBackup({
      databaseUrl: config.databaseUrl,
      sourceRoot: root,
      directory,
      tools,
    });
    log('backup-complete', {
      path: result.path,
      database: result.manifest.database.name,
      tables: result.manifest.tables.length,
      migrations: result.manifest.migrations.length,
    });
  } else if (command === 'verify') {
    const manifest = await verifyBackup(
      resolve(required(values.backup, '--backup')),
      tools,
      config.databaseUrl,
    );
    log('backup-verified', {
      id: manifest.id,
      database: manifest.database.name,
      createdAt: manifest.createdAt,
    });
  } else if (command === 'restore') {
    const name = required(values['target-name'], '--target-name');
    const manifest = await restoreBackup({
      path: resolve(required(values.backup, '--backup')),
      name,
      databaseUrl: config.databaseUrl,
      tools,
    });
    log('restore-verified', {
      database: name,
      backup: manifest.id,
      tables: manifest.tables.length,
      rows: manifest.tables.reduce((count, table) => count + table.rows, 0),
    });
  } else if (command === 'watch') {
    const interval = positive(
      values['interval-minutes'] || process.env.BACKUP_INTERVAL_MINUTES || '60',
      '备份间隔',
    );
    const keep = positive(
      values.keep || process.env.BACKUP_KEEP || '48',
      '保留数量',
    );
    const controller = new AbortController();
    process.on('SIGINT', () => controller.abort());
    process.on('SIGTERM', () => controller.abort());
    log('backup-watch-started', { intervalMinutes: interval, keep, directory });
    while (!controller.signal.aborted) {
      try {
        const result = await createBackup({
          databaseUrl: config.databaseUrl,
          sourceRoot: root,
          directory,
          tools,
          reason: 'scheduled',
        });
        const removed = await pruneScheduledBackups(
          directory,
          config.databaseUrl,
          keep,
        );
        log('backup-complete', { path: result.path, removed });
      } catch (error) {
        log(
          'backup-failed',
          redact(
            error instanceof Error ? error.message : '未知错误',
            config.databaseUrl,
          ),
        );
      }
      await delay(interval * 60_000, undefined, {
        signal: controller.signal,
      }).catch(() => undefined);
    }
  } else
    throw new Error(
      '命令：create | verify --backup 路径 | restore --backup 路径 --target-name 新库名 | watch',
    );
} catch (error) {
  log(
    'failed',
    redact(
      error instanceof Error ? error.message : '未知错误',
      config.databaseUrl,
    ),
  );
  process.exitCode = 1;
}
