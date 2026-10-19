import { loadServiceConfig } from '@srilanka/config';
import { createDatabasePool } from '@srilanka/database';
import { AccountSecurityService } from './modules/auth/account-security.js';
const args = process.argv.slice(2);
function argument(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1]?.trim() : undefined;
}
const username = argument('--username'),
  reason = argument('--reason');
if (!username || !reason || reason.length > 500)
  throw new Error(
    '用法：account:reset --username 用户名 --reason 恢复原因（1至500字）',
  );
const db = createDatabasePool(loadServiceConfig().databaseUrl);
try {
  const result = await new AccountSecurityService(db).issueOperatorReset(
    username,
    reason,
  );
  process.stdout.write(
    `账号：${result.username}\n重置码（仅本次显示）：${result.code}\n有效至：${result.expiresAt}\n请将重置码交给本人，在登录页选择“使用重置码”。\n`,
  );
} finally {
  await db.end();
}
