import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { bootstrapHost } from './modules/auth/bootstrap-host.js';
import { MINIMUM_PASSWORD_LENGTH } from './modules/auth/credentials.js';

async function readInput(): Promise<unknown> {
  if (process.argv.includes('--stdin')) {
    process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 8192) throw new Error('初始化输入过长。');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(
        '标准输入需要包含 username、displayName、password 的 JSON。',
      );
    }
  }
  if (!process.stdin.isTTY)
    throw new Error('请使用交互终端；自动化可用 --stdin 输入 JSON。');
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const prompt = createInterface({
    input: process.stdin,
    output,
    terminal: true,
  });
  try {
    const username = await prompt.question('主持人用户名：');
    const displayName = await prompt.question('显示名称：');
    process.stdout.write(
      `密码（至少${MINIMUM_PASSWORD_LENGTH}个字符，输入不回显）：`,
    );
    hidden = true;
    const password = await prompt.question('');
    process.stdout.write('\n再次输入密码：');
    const confirmation = await prompt.question('');
    process.stdout.write('\n');
    if (password !== confirmation)
      throw new Error('两次密码不一致，未创建账号。');
    return { username, displayName, password };
  } finally {
    hidden = false;
    prompt.close();
  }
}

try {
  const input = await readInput();
  const database = createDatabasePool(loadServiceConfig().databaseUrl);
  try {
    const user = await bootstrapHost(database, input);
    process.stdout.write(
      `主持人账号已创建：${user.username}。请在网页登录并创建游戏。\n`,
    );
  } finally {
    await database.end();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : '账号初始化失败。'}\n`,
  );
  process.exitCode = 1;
}
