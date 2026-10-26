import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import {
  createBackup,
  pruneScheduledBackups,
  restoreBackup,
  verifyBackup,
} from './backup.js';
import { createDatabasePool } from './index.js';
import { toolsFromEnvironment } from './postgres-tools.js';
import { inside } from './source-snapshot.js';

it('restores an exact snapshot into a new database and refuses corruption or an existing target', async () => {
  if (!process.env.DATABASE_URL)
    throw new Error('Integration test requires an explicit DATABASE_URL.');
  const baseUrl = new URL(process.env.DATABASE_URL);
  baseUrl.pathname = '/postgres';
  const admin = createDatabasePool(baseUrl.toString());
  const token = randomUUID().replaceAll('-', '').slice(0, 12);
  const sourceName = `srilanka_backup_test_${token}`;
  const targetName = `srilanka_restore_test_${token}`;
  const corruptName = `srilanka_restore_corrupt_${token}`;
  const sourceUrl = new URL(baseUrl);
  sourceUrl.pathname = '/' + sourceName;
  const targetUrl = new URL(baseUrl);
  targetUrl.pathname = '/' + targetName;
  const directory = await mkdtemp(
    join(tmpdir(), 'srilanka-backup-integration-'),
  );
  const sourceRoot = join(directory, 'project');
  const output = join(directory, 'backups');
  let database: ReturnType<typeof createDatabasePool> | undefined;
  let target: ReturnType<typeof createDatabasePool> | undefined;
  const tools = toolsFromEnvironment();
  try {
    await admin.query(`CREATE DATABASE "${sourceName}"`);
    database = createDatabasePool(sourceUrl.toString());
    await database.query(`CREATE TABLE schema_migrations (name text PRIMARY KEY, checksum text NOT NULL);
      CREATE TABLE policies (id integer PRIMARY KEY, secret text NOT NULL, treasury numeric NOT NULL, payload jsonb NOT NULL);
      INSERT INTO policies VALUES (1, '仅主持人可见：秘密会谈', 1234.56, '{"terrain":"丘陵","strength":980}');`);
    // pg_restore --list stops before the data payload. Keep the archive larger
    // than pipe buffers so verification exercises that early-exit behavior.
    await database.query(`CREATE TABLE backup_payload AS
      SELECT string_agg(md5(i::text), '') AS body FROM generate_series(1, 65536) i`);
    await mkdir(sourceRoot);
    await writeFile(join(sourceRoot, 'package.json'), '{}');
    await writeFile(join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    const options = {
      databaseUrl: sourceUrl.toString(),
      directory: output,
      sourceRoot,
      tools,
    };
    const backup = await createBackup(options);
    expect(backup.manifest.archive.bytes).toBeGreaterThan(256 * 1024);
    expect(
      backup.manifest.tables.find((table) => table.table === 'policies')?.rows,
    ).toBe(1);
    expect(JSON.stringify(backup.manifest)).not.toContain(
      `${baseUrl.username}:${baseUrl.password}@`,
    );
    await database.query(
      "UPDATE policies SET secret='备份后才发生的变化', treasury=0",
    );
    await restoreBackup({
      path: backup.path,
      databaseUrl: sourceUrl.toString(),
      name: targetName,
      tools,
    });
    target = createDatabasePool(targetUrl.toString());
    expect(
      (await target.query('SELECT secret, treasury FROM policies')).rows[0],
    ).toEqual({ secret: '仅主持人可见：秘密会谈', treasury: '1234.56' });
    await expect(
      restoreBackup({
        path: backup.path,
        databaseUrl: sourceUrl.toString(),
        name: targetName,
        tools,
      }),
    ).rejects.toThrow('已存在');
    expect(
      (await target.query('SELECT COUNT(*)::integer AS count FROM policies'))
        .rows[0]!.count,
    ).toBe(1);
    const dump = join(backup.path, 'database.dump');
    const contents = await readFile(dump);
    contents[contents.length - 1] = contents[contents.length - 1]! ^ 255;
    await writeFile(dump, contents);
    await expect(
      verifyBackup(backup.path, tools, sourceUrl.toString()),
    ).rejects.toThrow('损坏');
    await expect(
      restoreBackup({
        path: backup.path,
        databaseUrl: sourceUrl.toString(),
        name: corruptName,
        tools,
      }),
    ).rejects.toThrow('损坏');
    expect(
      (
        await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
          corruptName,
        ])
      ).rowCount,
    ).toBe(0);
    const first = await createBackup({ ...options, reason: 'scheduled' });
    const second = await createBackup({ ...options, reason: 'scheduled' });
    await mkdir(join(output, 'unrelated'));
    await mkdir(join(output, '20261017T000000000Z-aaaaaaaaaaaa.partial'));
    expect(await pruneScheduledBackups(output, sourceUrl.toString(), 1)).toBe(
      1,
    );
    await expect(readFile(join(first.path, 'manifest.json'))).rejects.toThrow();
    expect(
      await verifyBackup(second.path, tools, sourceUrl.toString()),
    ).toHaveProperty('reason', 'scheduled');
    expect(
      await readFile(join(backup.path, 'manifest.json'), 'utf8'),
    ).toContain('manual');
  } finally {
    await target?.end();
    await database?.end();
    // Only databases created by this test's random token are eligible for cleanup.
    for (const name of [targetName, sourceName]) {
      if (
        !name.endsWith(token) ||
        !/^srilanka_(restore_test|backup_test)_/.test(name)
      )
        continue;
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    }
    await admin.end();
    inside(tmpdir(), directory);
    if (directory.includes('srilanka-backup-integration-'))
      await rm(directory, { recursive: true });
  }
});
