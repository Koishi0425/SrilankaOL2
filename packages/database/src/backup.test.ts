import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { restoreTarget } from './backup.js';
import { connectionEnvironment, redact } from './postgres-tools.js';
import { inside, snapshotSource, verifySource } from './source-snapshot.js';

const folders: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'srilanka-backup-unit-'));
  folders.push(root);
  const source = join(root, 'project');
  await mkdir(join(source, 'apps/web'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{}');
  await writeFile(join(source, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  return { root, source };
}
afterEach(async () => {
  for (const path of folders.splice(0)) {
    inside(tmpdir(), path);
    if (!path.includes('srilanka-backup-unit-'))
      throw new Error('Unexpected fixture path');
    await rm(path, { recursive: true });
  }
});

describe('backup safety', () => {
  it('requires a fresh, explicitly named restore database', () => {
    const url = 'postgresql://user:private@localhost:5432/live';
    for (const name of [
      'live',
      'postgres',
      'srilanka_restore_bad;DROP DATABASE live',
      '../live',
      'srilanka_restore_' + 'a'.repeat(47),
    ])
      expect(() => restoreTarget(url, name)).toThrow();
    expect(new URL(restoreTarget(url, 'srilanka_restore_drill')).pathname).toBe(
      '/srilanka_restore_drill',
    );
    expect(() =>
      restoreTarget(
        url.replace('/live', '/srilanka_restore_drill'),
        'srilanka_restore_drill',
      ),
    ).toThrow();
  });

  it('captures uncommitted source and excludes environment, generated files and personal root documents', async () => {
    const { root, source } = await fixture();
    await mkdir(join(source, 'apps/web/node_modules'), { recursive: true });
    await writeFile(join(source, 'apps/web/new.ts'), 'export const draft = 1;');
    await writeFile(join(source, 'apps/web/.env.production'), 'SECRET=private');
    await writeFile(
      join(source, 'apps/web/node_modules/generated.js'),
      'generated',
    );
    await writeFile(join(source, '成绩单.pdf'), 'personal');
    await writeFile(join(source, '.env'), 'DATABASE_URL=private');
    await writeFile(join(source, '.env.example'), 'DATABASE_URL=example');
    await writeFile(join(source, '.env.docker'), 'POSTGRES_PASSWORD=private');
    await writeFile(
      join(source, '.env.docker.example'),
      'POSTGRES_PASSWORD=example',
    );
    await writeFile(join(source, 'compose.yaml'), 'services: {}');
    const destination = join(root, 'snapshot');
    const files = await snapshotSource(source, destination);
    expect(files.map((file) => file.path)).toEqual([
      '.env.docker.example',
      '.env.example',
      'apps/web/new.ts',
      'compose.yaml',
      'package.json',
      'pnpm-lock.yaml',
    ]);
    expect(
      await readFile(join(destination, 'apps/web/new.ts'), 'utf8'),
    ).toContain('draft');
    await writeFile(join(destination, 'apps/web/new.ts'), 'changed');
    await expect(verifySource(destination, files)).rejects.toThrow(
      '源码校验失败',
    );
  });

  it('rejects paths escaping the snapshot and duplicate manifest entries', async () => {
    const { root, source } = await fixture();
    const destination = join(root, 'snapshot');
    const files = await snapshotSource(source, destination);
    await expect(
      verifySource(destination, [
        { path: '../secret', sha256: 'a'.repeat(64) },
      ]),
    ).rejects.toThrow();
    await expect(
      verifySource(destination, [files[0]!, files[0]!]),
    ).rejects.toThrow();
    expect(() => inside(root, root)).toThrow();
    expect(() => inside(root, join(root, '..', 'outside'))).toThrow();
  });

  it('redacts encoded and decoded passwords from tool failures', () => {
    const url = 'postgresql://user:secret%40value@localhost/game';
    expect(
      redact(`failed ${url} secret@value secret%40value`, url),
    ).not.toMatch(/secret|postgresql/);
  });

  it('passes host, port, database and TLS settings separately to libpq', () => {
    const env = connectionEnvironment(
      'postgresql://user:secret%40value@127.0.0.1:15432/game?sslmode=require',
    );
    expect(env).toMatchObject({
      PGHOST: '127.0.0.1',
      PGPORT: '15432',
      PGUSER: 'user',
      PGPASSWORD: 'secret@value',
      PGDATABASE: 'game',
      PGSSLMODE: 'require',
    });
    expect(() =>
      connectionEnvironment(
        'postgresql://user:secret@localhost/game?unknown=1',
      ),
    ).toThrow('不支持');
  });
});
