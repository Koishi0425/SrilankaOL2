import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createDatabasePool, type DatabaseClient } from './index.js';
import { runPostgresTool, type PostgresTools } from './postgres-tools.js';
import {
  inside,
  sha256File,
  snapshotSource,
  validateMigrations,
  verifySource,
  type SourceFile,
} from './source-snapshot.js';

export type BackupReason = 'manual' | 'scheduled' | 'before-publish';
interface TableDigest {
  schema: string;
  table: string;
  rows: number;
  sha256: string;
}
export interface BackupManifest {
  format: 'srilanka-backup-v1';
  id: string;
  createdAt: string;
  reason: BackupReason;
  context?: { gameId: string; quarterId: string; version: number };
  database: { host: string; port: string; name: string; serverVersion: string };
  archive: {
    file: 'database.dump';
    bytes: number;
    sha256: string;
    toolVersion: string;
  };
  migrations: SourceFile[];
  tables: TableDigest[];
  source: SourceFile[];
}
export interface BackupOptions {
  databaseUrl: string;
  directory: string;
  sourceRoot: string;
  tools: PostgresTools;
  reason?: BackupReason;
  context?: BackupManifest['context'];
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^\d{8}T\d{9}Z-[a-f0-9]{12}$/;

function identity(databaseUrl: string) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: url.port || '5432',
    name: decodeURIComponent(url.pathname.slice(1)),
  };
}

async function fingerprints(client: DatabaseClient): Promise<TableDigest[]> {
  await client.query("SET LOCAL timezone = 'UTC'");
  await client.query("SET LOCAL datestyle = 'ISO, YMD'");
  const tables = await client.query<{ schema: string; table: string }>(
    `SELECT n.nspname AS schema, c.relname AS table FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public' ORDER BY n.nspname, c.relname`,
  );
  const result: TableDigest[] = [];
  for (const table of tables.rows) {
    const hash = createHash('sha256');
    let rows = 0;
    await client.query(
      `DECLARE backup_rows NO SCROLL CURSOR FOR SELECT encode(sha256(convert_to(to_jsonb(t)::text, 'UTF8')), 'hex') AS digest FROM ${quote(table.schema)}.${quote(table.table)} t ORDER BY 1`,
    );
    while (true) {
      const batch = await client.query<{ digest: string }>(
        'FETCH 1000 FROM backup_rows',
      );
      for (const row of batch.rows) hash.update(row.digest + '\n');
      rows += batch.rowCount ?? 0;
      if (batch.rows.length < 1000) break;
    }
    await client.query('CLOSE backup_rows');
    result.push({ ...table, rows, sha256: hash.digest('hex') });
  }
  return result;
}

async function clientMajor(
  databaseUrl: string,
  tools: PostgresTools,
  expected: string,
) {
  const version = (
    await runPostgresTool('pg_dump', ['--version'], databaseUrl, tools)
  ).trim();
  const major = /PostgreSQL\)?\s+(\d+)/.exec(version)?.[1];
  if (major !== expected.split('.')[0])
    throw new Error(
      `备份需要与数据库主版本 ${expected.split('.')[0]} 一致的 PostgreSQL 客户端。`,
    );
  return version;
}

export async function createBackup(
  options: BackupOptions,
): Promise<{ path: string; manifest: BackupManifest }> {
  const root = resolve(options.sourceRoot);
  const directory = resolve(options.directory);
  // The output must not be copied back into its own source snapshot.
  for (const name of [
    'apps',
    'packages',
    'infrastructure',
    'docs',
    '.github',
  ]) {
    const source = join(root, name);
    if (
      directory === source ||
      directory.startsWith(source + '/') ||
      directory.startsWith(source + '\\')
    )
      throw new Error('备份目录不能放在源码子目录中。');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const createdAt = new Date().toISOString();
  const id =
    createdAt.replace(/[-:.]/g, '') +
    '-' +
    randomUUID().replaceAll('-', '').slice(0, 12);
  const partial = join(directory, id + '.partial');
  const destination = join(directory, id);
  await mkdir(partial, { mode: 0o700 });
  const pool = createDatabasePool(options.databaseUrl);
  const client = await pool.connect().catch(async (error: unknown) => {
    await pool.end();
    const db = identity(options.databaseUrl);
    throw new Error(
      `无法连接备份源 ${db.host}:${db.port}/${db.name}，请检查 DATABASE_URL 和服务状态。`,
      { cause: error },
    );
  });
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const server = await client.query<{ server_version: string }>(
      'SHOW server_version',
    );
    const serverVersion = server.rows[0]!.server_version;
    const toolVersion = await clientMajor(
      options.databaseUrl,
      options.tools,
      serverVersion,
    );
    const source = await snapshotSource(root, join(partial, 'source'));
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM public.schema_migrations ORDER BY name',
    );
    const migrations = applied.rows.map((row) => ({
      path: row.name,
      sha256: row.checksum,
    }));
    await validateMigrations(join(partial, 'source'), migrations);
    const tables = await fingerprints(client);
    const snapshot = await client.query<{ snapshot: string }>(
      'SELECT pg_export_snapshot() AS snapshot',
    );
    const archive = join(partial, 'database.dump');
    await runPostgresTool(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--snapshot=${snapshot.rows[0]!.snapshot}`,
      ],
      options.databaseUrl,
      options.tools,
      { output: archive },
    );
    await client.query('COMMIT');
    const manifest: BackupManifest = {
      format: 'srilanka-backup-v1',
      id,
      createdAt,
      reason: options.reason ?? 'manual',
      context: options.context,
      database: { ...identity(options.databaseUrl), serverVersion },
      archive: {
        file: 'database.dump',
        bytes: (await stat(archive)).size,
        sha256: await sha256File(archive),
        toolVersion,
      },
      migrations,
      tables,
      source,
    };
    await writeFile(
      join(partial, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    await verifyBackup(partial, options.tools, options.databaseUrl);
    await rename(partial, destination);
    return { path: destination, manifest };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Keep the .partial directory for diagnosis; it is never eligible for restore/retention.
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function readManifest(value: unknown): BackupManifest {
  const manifest = value as BackupManifest;
  if (
    !manifest ||
    manifest.format !== 'srilanka-backup-v1' ||
    !idPattern.test(manifest.id) ||
    !['manual', 'scheduled', 'before-publish'].includes(manifest.reason) ||
    !Number.isFinite(Date.parse(manifest.createdAt)) ||
    !manifest.database ||
    typeof manifest.database.serverVersion !== 'string' ||
    !['host', 'port', 'name'].every(
      (key) =>
        typeof manifest.database[key as keyof typeof manifest.database] ===
        'string',
    ) ||
    manifest.archive?.file !== 'database.dump' ||
    !digestPattern.test(manifest.archive.sha256) ||
    !Number.isSafeInteger(manifest.archive.bytes) ||
    manifest.archive.bytes <= 0 ||
    !Array.isArray(manifest.source) ||
    !Array.isArray(manifest.migrations) ||
    !Array.isArray(manifest.tables)
  )
    throw new Error('备份清单无效或版本不受支持。');
  const seen = new Set<string>();
  for (const table of manifest.tables) {
    if (
      !table ||
      table.schema !== 'public' ||
      typeof table.table !== 'string' ||
      !Number.isSafeInteger(table.rows) ||
      table.rows < 0 ||
      !digestPattern.test(table.sha256) ||
      seen.has(table.table)
    )
      throw new Error('数据表校验清单无效。');
    seen.add(table.table);
  }
  if (!seen.has('schema_migrations')) throw new Error('备份缺少迁移表。');
  return manifest;
}

export async function verifyBackup(
  path: string,
  tools: PostgresTools,
  databaseUrl: string,
): Promise<BackupManifest> {
  const manifest = readManifest(
    JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')),
  );
  const archive = join(path, 'database.dump');
  if (
    (await lstat(archive)).isSymbolicLink() ||
    (await stat(archive)).size !== manifest.archive.bytes ||
    (await sha256File(archive)) !== manifest.archive.sha256
  )
    throw new Error('数据库备份文件不完整或已损坏。');
  await verifySource(join(path, 'source'), manifest.source);
  await validateMigrations(join(path, 'source'), manifest.migrations);
  await runPostgresTool('pg_restore', ['--list'], databaseUrl, tools, {
    input: archive,
  });
  return manifest;
}

export function restoreTarget(databaseUrl: string, name: string): string {
  if (!/^srilanka_restore_[a-z0-9_]{1,46}$/.test(name))
    throw new Error(
      '新数据库名必须以 srilanka_restore_ 开头，且仅含小写字母、数字、下划线，最长 63 字符。',
    );
  const target = new URL(databaseUrl);
  if (decodeURIComponent(target.pathname.slice(1)) === name)
    throw new Error('恢复目标不能是当前数据库。');
  target.pathname = '/' + name;
  return target.toString();
}

export async function restoreBackup(options: {
  path: string;
  databaseUrl: string;
  name: string;
  tools: PostgresTools;
}): Promise<BackupManifest> {
  if (options.path.endsWith('.partial'))
    throw new Error('不能恢复未完成的备份。');
  const target = restoreTarget(options.databaseUrl, options.name);
  const manifest = await verifyBackup(
    options.path,
    options.tools,
    options.databaseUrl,
  );
  if (options.name === manifest.database.name)
    throw new Error('恢复目标不能与原存档数据库同名。');
  const adminUrl = new URL(options.databaseUrl);
  adminUrl.pathname = '/postgres';
  const admin = createDatabasePool(adminUrl.toString());
  try {
    const server = await admin.query<{ server_version: string }>(
      'SHOW server_version',
    );
    if (
      server.rows[0]!.server_version.split('.')[0] !==
      manifest.database.serverVersion.split('.')[0]
    )
      throw new Error(
        '本恢复流程要求目标与备份数据库主版本一致；跨版本升级请另行演练。',
      );
    await clientMajor(
      options.databaseUrl,
      options.tools,
      manifest.database.serverVersion,
    );
    // CREATE DATABASE refuses an existing target, including a concurrent creator. No --clean or DROP.
    try {
      await admin.query(
        `CREATE DATABASE ${quote(options.name)} TEMPLATE template0`,
      );
    } catch (error) {
      if ((error as { code?: string }).code === '42P04')
        throw new Error('目标数据库已存在，未执行恢复；请使用新名称。', {
          cause: error,
        });
      throw error;
    }
  } finally {
    await admin.end();
  }
  await runPostgresTool(
    'pg_restore',
    [
      '--dbname=',
      '--single-transaction',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
    ],
    target,
    options.tools,
    { input: join(options.path, 'database.dump') },
  );
  const restored = createDatabasePool(target);
  const client = await restored.connect().catch(async (error: unknown) => {
    await restored.end();
    throw error;
  });
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const actual = await fingerprints(client);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.tables))
      throw new Error('恢复后数据内容与备份校验清单不一致。');
    await client.query('COMMIT');
  } finally {
    client.release();
    await restored.end();
  }
  return manifest;
}

export async function pruneScheduledBackups(
  directory: string,
  databaseUrl: string,
  keep: number,
): Promise<number> {
  if (!Number.isInteger(keep) || keep < 1)
    throw new Error('至少保留一份定时备份。');
  const db = identity(databaseUrl);
  const backups: { path: string; time: string }[] = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (
      !item.isDirectory() ||
      item.isSymbolicLink() ||
      !idPattern.test(item.name)
    )
      continue;
    const path = join(resolve(directory), item.name);
    inside(directory, path);
    try {
      const manifest = readManifest(
        JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8')),
      );
      if (
        manifest.id === item.name &&
        manifest.reason === 'scheduled' &&
        manifest.database.host === db.host &&
        manifest.database.port === db.port &&
        manifest.database.name === db.name
      )
        backups.push({ path, time: manifest.createdAt });
    } catch {
      /* Unknown folders are never deleted. */
    }
  }
  backups.sort((a, b) => b.time.localeCompare(a.time));
  for (const backup of backups.slice(keep))
    await rm(backup.path, { recursive: true });
  return Math.max(0, backups.length - keep);
}
