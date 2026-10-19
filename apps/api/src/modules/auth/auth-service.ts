import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AuthOptions,
  CurrentUser,
  RegistrationMode,
  SystemRole,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  hashPassword,
  hashSecret,
  verifyPassword,
  dummyPasswordHash,
  needsPasswordUpgrade,
  assertNewPassword,
  MINIMUM_PASSWORD_LENGTH,
} from './credentials.js';
import { authTransaction } from './auth-transaction.js';
import { limitAuth } from './auth-protection.js';
import { AccountSecurityService } from './account-security.js';
export { hashPassword } from './credentials.js';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  system_role: SystemRole;
}
function toCurrentUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    systemRole: row.system_role,
  };
}
export interface LoginResult {
  token: string;
  expiresAt: Date;
  user: CurrentUser;
}

export class AuthService {
  readonly security: AccountSecurityService;
  readonly options: AuthOptions;
  constructor(
    private readonly database: DatabasePool,
    registrationMode: RegistrationMode = 'Open',
  ) {
    this.options = {
      registrationMode,
      minimumPasswordLength: MINIMUM_PASSWORD_LENGTH,
    };
    this.security = new AccountSecurityService(database);
  }
  limit(
    operation: Parameters<typeof limitAuth>[1],
    address: string,
    identifier = '',
  ) {
    return limitAuth(this.database, operation, address, identifier);
  }
  private async createSession(
    database: DatabaseClient,
    row: UserRow,
  ): Promise<LoginResult> {
    const token = randomBytes(32).toString('base64url'),
      expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await database.query(
      'INSERT INTO auth_sessions (id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,$4)',
      [randomUUID(), row.id, hashSecret(token), expiresAt],
    );
    return { token, expiresAt, user: toCurrentUser(row) };
  }
  async register(input: {
    username: string;
    displayName: string;
    password: string;
    inviteCode?: string;
  }): Promise<LoginResult | null> {
    if (this.options.registrationMode === 'Closed')
      throw new ApiFault(
        403,
        'REGISTRATION_CLOSED',
        '当前未开放注册，请联系主持人。',
      );
    assertNewPassword(input.password);
    return authTransaction(this.database, async (client) => {
      const invitation =
        this.options.registrationMode === 'InviteOnly'
          ? await this.security.lockInvitation(client, input.inviteCode ?? '')
          : null;
      const result = await client.query<UserRow>(
        `INSERT INTO users (id,username,display_name,password_hash) VALUES ($1,LOWER($2),$3,$4)
        ON CONFLICT ((LOWER(username))) DO NOTHING RETURNING id,username,display_name,password_hash,system_role`,
        [
          randomUUID(),
          input.username.trim(),
          input.displayName.trim(),
          await hashPassword(input.password),
        ],
      );
      const row = result.rows[0];
      if (!row) return null;
      if (invitation) {
        await client.query(
          'UPDATE registration_invitations SET used_at=NOW(),used_by_user_id=$2 WHERE id=$1',
          [invitation.id, row.id],
        );
        await this.security.record(
          client,
          'InviteUsed',
          invitation.issuer_user_id,
          row.id,
          invitation.source_game_id,
        );
      }
      return this.createSession(client, row);
    });
  }
  async login(username: string, password: string): Promise<LoginResult | null> {
    return authTransaction(this.database, async (client) => {
      const result = await client.query<UserRow>(
        `SELECT id,username,display_name,password_hash,system_role FROM users WHERE LOWER(username)=LOWER($1) AND status='Active' FOR UPDATE`,
        [username.trim()],
      );
      const row = result.rows[0];
      if (
        !(await verifyPassword(
          password,
          row?.password_hash ?? (await dummyPasswordHash),
        )) ||
        !row
      )
        return null;
      if (needsPasswordUpgrade(row.password_hash))
        await client.query(
          'UPDATE users SET password_hash=$2,updated_at=NOW() WHERE id=$1',
          [row.id, await hashPassword(password)],
        );
      return this.createSession(client, row);
    });
  }
  async authenticate(token: string | undefined): Promise<CurrentUser | null> {
    if (!token) return null;
    const result = await this.database.query<UserRow>(
      `SELECT u.id,u.username,u.display_name,u.password_hash,u.system_role FROM auth_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>NOW() AND u.status='Active'`,
      [hashSecret(token)],
    );
    return result.rows[0] ? toCurrentUser(result.rows[0]) : null;
  }
  async logout(token: string | undefined): Promise<void> {
    if (token)
      await this.database.query(
        'UPDATE auth_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL',
        [hashSecret(token)],
      );
  }
  async createDevelopmentUser(input: {
    username: string;
    displayName: string;
    password: string;
    systemRole?: SystemRole;
  }): Promise<CurrentUser> {
    const result = await this.database.query<UserRow>(
      `INSERT INTO users (id,username,display_name,password_hash,system_role) VALUES ($1,LOWER($2),$3,$4,$5)
      ON CONFLICT ((LOWER(username))) DO UPDATE SET display_name=EXCLUDED.display_name,password_hash=EXCLUDED.password_hash,system_role=EXCLUDED.system_role,status='Active',updated_at=NOW()
      RETURNING id,username,display_name,password_hash,system_role`,
      [
        randomUUID(),
        input.username.trim(),
        input.displayName.trim(),
        await hashPassword(input.password),
        input.systemRole ?? 'User',
      ],
    );
    if (!result.rows[0]) throw new Error('Failed to create development user');
    return toCurrentUser(result.rows[0]);
  }
}
