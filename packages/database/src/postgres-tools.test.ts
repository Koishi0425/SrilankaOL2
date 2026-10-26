import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { runPostgresTool } from './postgres-tools.js';
import { inside } from './source-snapshot.js';

const folders: string[] = [];
const databaseUrl = 'postgresql://user:fixture-password@localhost/game';

async function archive() {
  const folder = await mkdtemp(join(tmpdir(), 'srilanka-postgres-tools-'));
  folders.push(folder);
  const path = join(folder, 'archive.dump');
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024, 65));
  return path;
}

afterEach(async () => {
  for (const folder of folders.splice(0)) {
    inside(tmpdir(), folder);
    if (!folder.includes('srilanka-postgres-tools-'))
      throw new Error('Unexpected fixture path');
    await rm(folder, { recursive: true });
  }
});

it('accepts a successful archive listing that reads only the header of a large input', async () => {
  const input = await archive();
  const output = await runPostgresTool(
    'pg_restore',
    ['--list'],
    databaseUrl,
    {
      commandPrefix: [
        process.execPath,
        '-e',
        "require('node:fs').readSync(0, Buffer.alloc(16), 0, 16, null); process.stdout.write('archive directory');",
      ],
    },
    { input },
  );
  expect(output).toBe('archive directory');
});

it('preserves a tool failure and redacts its password when it exits before reading the archive', async () => {
  const input = await archive();
  await expect(
    runPostgresTool(
      'pg_restore',
      ['--list'],
      databaseUrl,
      {
        commandPrefix: [
          process.execPath,
          '-e',
          "process.stderr.write('invalid archive fixture-password'); process.exitCode = 1;",
        ],
      },
      { input },
    ),
  ).rejects.toThrow('pg_restore 失败：invalid archive [已隐藏]');
});

it('provides the complete archive to a tool that reads all of standard input', async () => {
  const input = await archive();
  const output = await runPostgresTool(
    'pg_restore',
    [],
    databaseUrl,
    {
      commandPrefix: [
        process.execPath,
        '-e',
        "process.stdout.write(String(require('node:fs').readFileSync(0).length));",
      ],
    },
    { input },
  );
  expect(output).toBe(String(8 * 1024 * 1024));
});
