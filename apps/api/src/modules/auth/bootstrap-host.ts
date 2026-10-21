import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '@srilanka/database';
import { z } from 'zod';
import { assertNewPassword, hashPassword } from './credentials.js';

export async function bootstrapHost(database: DatabasePool, input: unknown) {
  const parsed = z
    .object({
      username: z.string().trim().min(1).max(64).regex(/^\S+$/u),
      displayName: z.string().trim().min(1).max(120),
      password: z.string().min(15).max(256),
    })
    .safeParse(input);
  if (!parsed.success)
    throw new Error('请填写有效用户名、显示名称和15至256字符的密码。');
  const user = parsed.data;
  assertNewPassword(user.password);
  const passwordHash = await hashPassword(user.password);
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Serialize bootstraps and ordinary registration; never overwrite an account.
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    if ((await client.query('SELECT 1 FROM users LIMIT 1')).rowCount) {
      throw new Error(
        '数据库已有账号，拒绝再次初始化。请使用网页登录或账号恢复命令。',
      );
    }
    const id = randomUUID();
    await client.query(
      'INSERT INTO users (id,username,display_name,password_hash) VALUES ($1,LOWER($2),$3,$4)',
      [id, user.username, user.displayName, passwordHash],
    );
    await client.query('COMMIT');
    return { id, username: user.username.toLowerCase() };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
