import type { DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { hashSecret } from './credentials.js';
type Operation =
  'Login' | 'Register' | 'Reset' | 'Reauthenticate' | 'IssueCode';
const policies: Record<
  Operation,
  { ip: number; pair: number; seconds: number }
> = {
  Login: { ip: 60, pair: 10, seconds: 900 },
  Register: { ip: 12, pair: 6, seconds: 3600 },
  Reset: { ip: 20, pair: 6, seconds: 900 },
  Reauthenticate: { ip: 30, pair: 8, seconds: 900 },
  IssueCode: { ip: 40, pair: 15, seconds: 3600 },
};
export async function limitAuth(
  database: DatabasePool,
  operation: Operation,
  address: string,
  identifier = '',
) {
  const policy = policies[operation];
  await database.query(
    "DELETE FROM auth_rate_limits WHERE expires_at<NOW()-INTERVAL '1 day'",
  );
  for (const [scope, limit] of [
    ['ip', policy.ip],
    ['pair', policy.pair],
  ] as const) {
    const bucket = hashSecret(
      JSON.stringify([
        operation,
        scope,
        address,
        scope === 'pair' ? identifier.trim().toLowerCase() : '',
      ]),
    );
    const result = await database.query<{ attempts: number; expires_at: Date }>(
      `INSERT INTO auth_rate_limits (bucket,attempts,expires_at) VALUES ($1,1,NOW()+$2*INTERVAL '1 second')
      ON CONFLICT (bucket) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at<=NOW() THEN 1 ELSE auth_rate_limits.attempts+1 END,
      expires_at=CASE WHEN auth_rate_limits.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END RETURNING attempts,expires_at`,
      [bucket, policy.seconds],
    );
    if (result.rows[0]!.attempts > limit)
      throw new ApiFault(
        429,
        'AUTH_RATE_LIMITED',
        '尝试过于频繁，请稍后再试。',
        {
          retryAfter: Math.max(
            1,
            Math.ceil(
              (result.rows[0]!.expires_at.getTime() - Date.now()) / 1000,
            ),
          ),
        },
      );
  }
}
