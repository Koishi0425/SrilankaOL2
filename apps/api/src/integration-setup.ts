import { afterAll, beforeEach } from 'vitest';
import { createDatabasePool } from '@srilanka/database';
const url = process.env.DATABASE_URL ?? '';
if (!url || new URL(url).pathname !== '/srilanka_test')
  throw new Error('集成测试只能使用显式指定的 srilanka_test 数据库。');
const database = createDatabasePool(url);
beforeEach(async () => {
  await database.query('TRUNCATE auth_rate_limits');
});
afterAll(async () => {
  await database.end();
});
