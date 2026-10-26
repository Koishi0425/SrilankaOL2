import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface SourceFile {
  path: string;
  sha256: string;
}

const directories = ['apps', 'packages', 'infrastructure', 'docs', '.github'];
const rootFiles = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.dockerignore',
  '.env.example',
  '.env.docker.example',
  'compose.yaml',
  'compose.ghcr.yaml',
  'README.md',
  'LICENSE',
  'LICENSE.md',
];
const excluded = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.codex',
  '.vite',
  'backups',
  'test-results',
  'playwright-report',
]);

export function inside(root: string, path: string): string {
  const result = relative(resolve(root), resolve(path));
  if (
    !result ||
    result === '..' ||
    result.startsWith(`..${sep}`) ||
    isAbsolute(result)
  )
    throw new Error('路径必须位于指定目录内。');
  return result;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function sourcePaths(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(path: string) {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink())
      throw new Error(`源码快照不接受符号链接：${path}`);
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) {
        if (
          excluded.has(name) ||
          (name.startsWith('.env') && name !== '.env.example') ||
          /\.(log|tsbuildinfo|dump|pem|key|p12|pfx|db|sqlite|pdf)$/i.test(name)
        )
          continue;
        await visit(join(path, name));
      }
    } else if (info.isFile()) files.push(path.split(sep).join('/'));
  }
  for (const path of [...rootFiles, ...directories]) {
    try {
      await visit(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return files.sort();
}

export async function snapshotSource(
  root: string,
  destination: string,
): Promise<SourceFile[]> {
  const paths = await sourcePaths(root);
  const result: SourceFile[] = [];
  for (const path of paths) {
    const source = join(root, path);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    result.push({ path, sha256: await sha256File(target) });
  }
  await verifySource(destination, result);
  // Do not silently label a mixture of files edited during the backup as a version.
  if (JSON.stringify(paths) !== JSON.stringify(await sourcePaths(root)))
    throw new Error('备份期间源码文件列表发生变化，请重试。');
  for (const file of result) {
    if ((await sha256File(join(root, file.path))) !== file.sha256)
      throw new Error(`备份期间源码发生变化，请重试：${file.path}`);
  }
  return result;
}

export async function verifySource(
  root: string,
  files: SourceFile[],
): Promise<void> {
  const actualRoot = await realpath(root);
  const seen = new Set<string>();
  for (const file of files) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      file.path.includes('\\') ||
      file.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      seen.has(file.path)
    )
      throw new Error('备份源码清单无效。');
    seen.add(file.path);
    const path = resolve(root, file.path);
    inside(root, path);
    inside(actualRoot, await realpath(path));
    if ((await sha256File(path)) !== file.sha256)
      throw new Error(`源码校验失败：${file.path}`);
  }
  if (!seen.has('package.json') || !seen.has('pnpm-lock.yaml'))
    throw new Error('备份缺少安装所需的源码文件。');
}

export async function validateMigrations(
  root: string,
  migrations: SourceFile[],
): Promise<void> {
  for (const file of migrations) {
    if (!/^[\w.-]+\.sql$/.test(file.path))
      throw new Error('迁移记录名称无效。');
    const sql = await readFile(
      join(root, 'packages/database/migrations', file.path),
    );
    if (createHash('sha256').update(sql).digest('hex') !== file.sha256)
      throw new Error(`源码与已执行迁移不匹配：${file.path}`);
  }
}
