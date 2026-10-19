import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AccountAccessCode,
  AccountSecurityEvent,
  CurrentUser,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  assertNewPassword,
  hashPassword,
  hashSecret,
  verifyPassword,
} from './credentials.js';
import { authTransaction } from './auth-transaction.js';

interface CodeRow {
  id: string;
  target_user_id: string;
  issuer_user_id: string | null;
  source_game_id: string | null;
}
interface Invitation {
  id: string;
  issuer_user_id: string;
  source_game_id: string;
}
interface Member {
  id: string;
  user_id: string;
  role: string;
  status: string;
}
interface User {
  id: string;
  password_hash: string;
  system_role: string;
  status: string;
  username: string;
  display_name: string;
}
function invalidCode(): never {
  throw new ApiFault(
    400,
    'INVALID_ACCESS_CODE',
    '重置码或邀请码无效、已使用或已过期，请重新向主持人申请。',
  );
}

export class AccountSecurityService {
  constructor(private readonly database: DatabasePool) {}
  async record(
    client: DatabaseClient,
    kind: AccountSecurityEvent['kind'],
    actor: string | null,
    target: string | null,
    game: string | null,
    reason = '',
  ) {
    await client.query(
      'INSERT INTO account_security_events (kind,actor_user_id,target_user_id,source_game_id,reason) VALUES ($1,$2,$3,$4,$5)',
      [kind, actor, target, game, reason],
    );
  }
  private async gameMembers(
    client: DatabaseClient,
    gameId: string,
    active = true,
  ): Promise<Member[]> {
    const game = await client.query<{ status: string }>(
      'SELECT status FROM games WHERE id=$1 FOR SHARE',
      [gameId],
    );
    if (!game.rows[0])
      throw new ApiFault(404, 'GAME_NOT_FOUND', '找不到该游戏。');
    if (active && ['Completed', 'Archived'].includes(game.rows[0].status))
      throw new ApiFault(
        409,
        'GAME_READ_ONLY',
        '本局已结束，无法生成或使用账号协助码。',
      );
    return (
      await client.query<Member>(
        'SELECT id,user_id,role,status FROM game_members WHERE game_id=$1 ORDER BY id FOR SHARE',
        [gameId],
      )
    ).rows;
  }
  private async users(client: DatabaseClient, ids: string[]): Promise<User[]> {
    return (
      await client.query<User>(
        'SELECT id,password_hash,system_role,status,username,display_name FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ids],
      )
    ).rows;
  }
  private assertHost(members: Member[], userId: string) {
    if (
      !members.some(
        (m) =>
          m.user_id === userId &&
          m.status === 'Active' &&
          ['Host', 'Administrator'].includes(m.role),
      )
    )
      throw new ApiFault(
        403,
        'HOST_REQUIRED',
        '仅本局主持人可以协助账号管理。',
      );
  }
  private async reauthenticate(
    client: DatabaseClient,
    user: User | undefined,
    token: string,
    password: string,
  ) {
    const session = await client.query(
      'SELECT 1 FROM auth_sessions WHERE user_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>NOW()',
      [user?.id, hashSecret(token)],
    );
    if (!user || user.status !== 'Active' || !session.rowCount)
      throw new ApiFault(401, 'UNAUTHENTICATED', '登录已失效，请重新登录。');
    if (!(await verifyPassword(password, user.password_hash)))
      throw new ApiFault(401, 'INCORRECT_PASSWORD', '当前密码不正确。');
  }
  private async replacePassword(
    client: DatabaseClient,
    userId: string,
    password: string,
  ) {
    await client.query(
      'UPDATE users SET password_hash=$2,password_changed_at=NOW(),updated_at=NOW() WHERE id=$1',
      [userId, await hashPassword(password)],
    );
    await client.query(
      'UPDATE auth_sessions SET revoked_at=NOW() WHERE user_id=$1 AND revoked_at IS NULL',
      [userId],
    );
    await client.query(
      'UPDATE account_reset_codes SET revoked_at=NOW() WHERE (target_user_id=$1 OR issuer_user_id=$1) AND used_at IS NULL AND revoked_at IS NULL',
      [userId],
    );
    await client.query(
      'UPDATE registration_invitations SET revoked_at=NOW() WHERE issuer_user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
      [userId],
    );
  }
  async changePassword(
    user: CurrentUser,
    token: string,
    currentPassword: string,
    newPassword: string,
  ) {
    assertNewPassword(newPassword);
    if (currentPassword === newPassword)
      throw new ApiFault(
        400,
        'PASSWORD_UNCHANGED',
        '请使用与当前密码不同的新密码。',
      );
    await authTransaction(this.database, async (client) => {
      const [row] = await this.users(client, [user.id]);
      await this.reauthenticate(client, row, token, currentPassword);
      await this.replacePassword(client, user.id, newPassword);
      await this.record(client, 'PasswordChanged', user.id, user.id, null);
    });
  }
  async issueReset(
    gameId: string,
    memberId: string,
    actor: CurrentUser,
    token: string,
    currentPassword: string,
    reason: string,
  ): Promise<AccountAccessCode> {
    return authTransaction(this.database, async (client) => {
      const members = await this.gameMembers(client, gameId);
      this.assertHost(members, actor.id);
      const target = members.find(
        (m) => m.id === memberId && m.status === 'Active',
      );
      if (!target)
        throw new ApiFault(404, 'MEMBER_NOT_FOUND', '找不到该成员。');
      const users = await this.users(client, [actor.id, target.user_id]);
      await this.reauthenticate(
        client,
        users.find((u) => u.id === actor.id),
        token,
        currentPassword,
      );
      const targetUser = users.find((u) => u.id === target.user_id);
      if (
        actor.id === target.user_id ||
        !['Player', 'Observer'].includes(target.role) ||
        targetUser?.system_role !== 'User' ||
        targetUser.status !== 'Active'
      )
        throw new ApiFault(
          403,
          'RESET_NOT_ALLOWED',
          '只能协助本局普通玩家或观察者；主持人账号请联系维护者恢复。',
        );
      await client.query(
        'UPDATE account_reset_codes SET revoked_at=NOW() WHERE target_user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
        [target.user_id],
      );
      const code = randomBytes(32).toString('base64url'),
        expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await client.query(
        'INSERT INTO account_reset_codes (id,target_user_id,issuer_user_id,source_game_id,code_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [
          randomUUID(),
          target.user_id,
          actor.id,
          gameId,
          hashSecret(code),
          expiresAt,
        ],
      );
      await this.record(
        client,
        'ResetIssued',
        actor.id,
        target.user_id,
        gameId,
        reason,
      );
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        username: targetUser.username,
        displayName: targetUser.display_name,
      };
    });
  }
  async redeemReset(username: string, code: string, newPassword: string) {
    assertNewPassword(newPassword);
    await authTransaction(this.database, async (client) => {
      const initial = (
        await client.query<CodeRow>(
          `SELECT c.id,c.target_user_id,c.issuer_user_id,c.source_game_id FROM account_reset_codes c JOIN users u ON u.id=c.target_user_id WHERE c.code_hash=$1 AND LOWER(u.username)=LOWER($2)`,
          [hashSecret(code), username],
        )
      ).rows[0];
      if (!initial) invalidCode();
      if (initial.source_game_id) {
        let members: Member[];
        try {
          members = await this.gameMembers(client, initial.source_game_id);
        } catch {
          invalidCode();
        }
        const host = members.find(
          (m) =>
            m.user_id === initial.issuer_user_id &&
            m.status === 'Active' &&
            ['Host', 'Administrator'].includes(m.role),
        );
        const target = members.find(
          (m) =>
            m.user_id === initial.target_user_id &&
            m.status === 'Active' &&
            ['Player', 'Observer'].includes(m.role),
        );
        if (!host || !target) invalidCode();
      }
      const users = await this.users(client, [
        initial.target_user_id,
        ...(initial.issuer_user_id ? [initial.issuer_user_id] : []),
      ]);
      const target = users.find((u) => u.id === initial.target_user_id);
      if (
        !target ||
        target.status !== 'Active' ||
        (initial.issuer_user_id &&
          (target.system_role !== 'User' ||
            users.find((u) => u.id === initial.issuer_user_id)?.status !==
              'Active'))
      )
        invalidCode();
      const valid = await client.query(
        `SELECT id FROM account_reset_codes WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE`,
        [initial.id],
      );
      if (!valid.rowCount) invalidCode();
      await client.query(
        'UPDATE account_reset_codes SET used_at=NOW() WHERE id=$1',
        [initial.id],
      );
      await this.replacePassword(client, initial.target_user_id, newPassword);
      await this.record(
        client,
        'PasswordReset',
        initial.target_user_id,
        initial.target_user_id,
        initial.source_game_id,
      );
    });
  }
  async issueInvitation(
    gameId: string,
    actor: CurrentUser,
    token: string,
    currentPassword: string,
  ): Promise<AccountAccessCode> {
    return authTransaction(this.database, async (client) => {
      const members = await this.gameMembers(client, gameId);
      this.assertHost(members, actor.id);
      const [user] = await this.users(client, [actor.id]);
      await this.reauthenticate(client, user, token, currentPassword);
      const code = randomBytes(32).toString('base64url'),
        expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await client.query(
        'INSERT INTO registration_invitations (id,source_game_id,issuer_user_id,code_hash,expires_at) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), gameId, actor.id, hashSecret(code), expiresAt],
      );
      await this.record(client, 'InviteIssued', actor.id, null, gameId);
      return { code, expiresAt: expiresAt.toISOString() };
    });
  }
  async lockInvitation(
    client: DatabaseClient,
    code: string,
  ): Promise<Invitation> {
    const initial = (
      await client.query<Invitation>(
        'SELECT id,source_game_id,issuer_user_id FROM registration_invitations WHERE code_hash=$1',
        [hashSecret(code)],
      )
    ).rows[0];
    if (!initial) invalidCode();
    try {
      const members = await this.gameMembers(client, initial.source_game_id);
      this.assertHost(members, initial.issuer_user_id);
    } catch {
      invalidCode();
    }
    const [issuer] = await this.users(client, [initial.issuer_user_id]);
    if (issuer?.status !== 'Active') invalidCode();
    const valid = await client.query(
      'SELECT id FROM registration_invitations WHERE id=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at>NOW() FOR UPDATE',
      [initial.id],
    );
    if (!valid.rowCount) invalidCode();
    return initial;
  }
  async history(
    gameId: string,
    actor: CurrentUser,
  ): Promise<AccountSecurityEvent[]> {
    return authTransaction(this.database, async (client) => {
      this.assertHost(await this.gameMembers(client, gameId, false), actor.id);
      const rows = await client.query<{
        id: string;
        kind: AccountSecurityEvent['kind'];
        actor_name: string | null;
        target_name: string | null;
        reason: string;
        created_at: Date;
      }>(
        `SELECT e.id::text,e.kind,a.display_name AS actor_name,t.display_name AS target_name,e.reason,e.created_at
        FROM account_security_events e LEFT JOIN users a ON a.id=e.actor_user_id LEFT JOIN users t ON t.id=e.target_user_id WHERE e.source_game_id=$1 ORDER BY e.id DESC LIMIT 50`,
        [gameId],
      );
      return rows.rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        actorName: r.actor_name,
        targetName: r.target_name,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }
  async issueOperatorReset(
    username: string,
    reason: string,
  ): Promise<AccountAccessCode> {
    return authTransaction(this.database, async (client) => {
      const row = (
        await client.query<User>(
          `SELECT id,username,display_name FROM users WHERE LOWER(username)=LOWER($1) AND status='Active' FOR UPDATE`,
          [username],
        )
      ).rows[0];
      if (!row) throw new Error('找不到活动账号。');
      const code = randomBytes(32).toString('base64url'),
        expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      await client.query(
        'UPDATE account_reset_codes SET revoked_at=NOW() WHERE target_user_id=$1 AND used_at IS NULL AND revoked_at IS NULL',
        [row.id],
      );
      await client.query(
        'INSERT INTO account_reset_codes (id,target_user_id,code_hash,expires_at) VALUES ($1,$2,$3,$4)',
        [randomUUID(), row.id, hashSecret(code), expiresAt],
      );
      await this.record(
        client,
        'OperatorResetIssued',
        null,
        row.id,
        null,
        reason,
      );
      return {
        code,
        expiresAt: expiresAt.toISOString(),
        username: row.username,
        displayName: row.display_name,
      };
    });
  }
}
