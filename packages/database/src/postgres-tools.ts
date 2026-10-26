import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export interface PostgresTools {
  binDirectory?: string;
  commandPrefix?: string[];
}

export function toolsFromEnvironment(): PostgresTools {
  const prefix: unknown = JSON.parse(
    process.env.POSTGRES_COMMAND_PREFIX_JSON || '[]',
  );
  if (
    !Array.isArray(prefix) ||
    prefix.some((item) => typeof item !== 'string' || !item)
  )
    throw new Error('POSTGRES_COMMAND_PREFIX_JSON 必须是字符串数组。');
  return { binDirectory: process.env.POSTGRES_BIN_DIR, commandPrefix: prefix };
}

export function redact(text: string, databaseUrl: string): string {
  const url = new URL(databaseUrl);
  let result = text.replaceAll(databaseUrl, '[数据库地址]');
  for (const secret of [
    url.password,
    decodeURIComponent(url.password),
    url.searchParams.get('sslpassword'),
  ]) {
    if (secret) result = result.replaceAll(secret, '[已隐藏]');
  }
  return result;
}

export function connectionEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('需要 PostgreSQL 连接地址。');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PGHOST: url.hostname || 'localhost',
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGCONNECT_TIMEOUT: '10',
  };
  delete env.PGSERVICE;
  delete env.PGHOSTADDR;
  const parameters: Record<string, string> = {
    sslmode: 'PGSSLMODE',
    sslrootcert: 'PGSSLROOTCERT',
    sslcert: 'PGSSLCERT',
    sslkey: 'PGSSLKEY',
    sslpassword: 'PGSSLPASSWORD',
    sslcrl: 'PGSSLCRL',
    application_name: 'PGAPPNAME',
    options: 'PGOPTIONS',
    connect_timeout: 'PGCONNECT_TIMEOUT',
    channel_binding: 'PGCHANNELBINDING',
  };
  for (const [key, value] of url.searchParams) {
    const name = parameters[key];
    if (!name) throw new Error(`备份工具暂不支持连接参数：${key}`);
    env[name] = value;
  }
  return env;
}

export async function runPostgresTool(
  tool: 'pg_dump' | 'pg_restore',
  args: string[],
  databaseUrl: string,
  tools: PostgresTools,
  files: { input?: string; output?: string } = {},
): Promise<string> {
  const binary = tools.binDirectory
    ? `${tools.binDirectory.replace(/[\\/]$/, '')}/${tool}`
    : tool;
  const command = [...(tools.commandPrefix ?? []), binary, ...args];
  const executable = command.shift()!;
  // Credentials travel only through the child environment, never process argv.
  const env = connectionEnvironment(databaseUrl);
  if (/(^|[\\/])wsl(?:\.exe)?$/i.test(executable)) {
    env.WSLENV = [
      process.env.WSLENV,
      ...Object.keys(env)
        .filter((name) => name.startsWith('PG'))
        .map((name) => `${name}/u`),
    ]
      .filter(Boolean)
      .join(':');
  }
  // pg_restore --list can finish after reading just the archive directory.
  // Let the child read the file directly instead of pumping the remaining
  // payload into a closed pipe and mistaking EPIPE for a failed verification.
  const input = files.input ? await open(files.input, 'r') : undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, command, {
        env,
        shell: false,
        windowsHide: true,
        stdio: [input?.fd ?? 'ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16_384);
      });
      const timeout = setTimeout(() => child.kill(), 10 * 60_000);
      const completion = new Promise<void>((done, fail) => {
        child.once('error', () =>
          fail(new Error(`无法启动 ${tool}；请配置 PostgreSQL 客户端路径。`)),
        );
        child.once('close', (code) =>
          code === 0
            ? done()
            : fail(
                new Error(
                  `${tool} 失败：${redact(stderr || `退出状态 ${code}`, databaseUrl).trim()}`,
                ),
              ),
        );
      });
      const output = files.output
        ? pipeline(
            child.stdout!,
            createWriteStream(files.output, { flags: 'wx', mode: 0o600 }),
          )
        : Promise.resolve();
      if (!files.output)
        child.stdout!.on('data', (chunk: Buffer) => {
          stdout = (stdout + chunk.toString()).slice(-64_000);
        });
      Promise.all([completion, output])
        .then(
          () => resolve(stdout),
          (error: unknown) => {
            child.kill();
            reject(
              error instanceof Error
                ? new Error(redact(error.message, databaseUrl))
                : new Error(`${tool} 执行失败。`),
            );
          },
        )
        .finally(() => clearTimeout(timeout));
    });
  } finally {
    await input?.close();
  }
}
