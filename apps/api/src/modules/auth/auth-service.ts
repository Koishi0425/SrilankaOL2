import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

import type { CurrentUser, SystemRole } from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';

const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  system_role: SystemRole;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_LENGTH,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) reject(error);
        else resolve(key);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, n, r, p, saltValue, keyValue] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    Number(n) !== SCRYPT_N ||
    Number(r) !== SCRYPT_R ||
    Number(p) !== SCRYPT_P ||
    !saltValue ||
    !keyValue
  ) {
    return false;
  }

  const expected = Buffer.from(keyValue, 'base64url');
  const actual = await deriveKey(password, Buffer.from(saltValue, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toCurrentUser(row: UserRow): CurrentUser {
  return {
    id: row.id,
    email: row.email,
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
  constructor(private readonly database: DatabasePool) {}

  private async createSession(row: UserRow): Promise<LoginResult> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
    await this.database.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [randomUUID(), row.id, hashSessionToken(token), expiresAt],
    );
    return { token, expiresAt, user: toCurrentUser(row) };
  }

  async register(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<LoginResult | null> {
    const result = await this.database.query<UserRow>(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, LOWER($2), $3, $4)
       ON CONFLICT ((LOWER(email))) DO NOTHING
       RETURNING id, email, display_name, password_hash, system_role`,
      [
        randomUUID(),
        input.email.trim(),
        input.displayName.trim(),
        await hashPassword(input.password),
      ],
    );
    return result.rows[0] ? this.createSession(result.rows[0]) : null;
  }

  async login(email: string, password: string): Promise<LoginResult | null> {
    const result = await this.database.query<UserRow>(
      `SELECT id, email, display_name, password_hash, system_role
       FROM users
       WHERE LOWER(email) = LOWER($1) AND status = 'Active'`,
      [email.trim()],
    );
    const row = result.rows[0];
    if (!row || !(await verifyPassword(password, row.password_hash)))
      return null;

    return this.createSession(row);
  }

  async authenticate(token: string | undefined): Promise<CurrentUser | null> {
    if (!token) return null;

    const result = await this.database.query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.password_hash, u.system_role
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
         AND u.status = 'Active'`,
      [hashSessionToken(token)],
    );
    return result.rows[0] ? toCurrentUser(result.rows[0]) : null;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.database.query(
      `UPDATE auth_sessions SET revoked_at = NOW()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashSessionToken(token)],
    );
  }

  async createDevelopmentUser(input: {
    email: string;
    displayName: string;
    password: string;
    systemRole?: SystemRole;
  }): Promise<CurrentUser> {
    const passwordHash = await hashPassword(input.password);
    const result = await this.database.query<UserRow>(
      `INSERT INTO users (id, email, display_name, password_hash, system_role)
       VALUES ($1, LOWER($2), $3, $4, $5)
       ON CONFLICT ((LOWER(email))) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash,
         system_role = EXCLUDED.system_role,
         status = 'Active',
         updated_at = NOW()
       RETURNING id, email, display_name, password_hash, system_role`,
      [
        randomUUID(),
        input.email.trim(),
        input.displayName.trim(),
        passwordHash,
        input.systemRole ?? 'User',
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to create development user');
    return toCurrentUser(row);
  }
}
