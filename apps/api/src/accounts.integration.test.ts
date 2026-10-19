import { randomUUID, scryptSync } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabasePool } from '@srilanka/database';
import type {
  CurrentUser,
  GameDetails,
  GameMemberSummary,
} from '@srilanka/contracts';
import { buildApp } from './app.js';
import { AuthService } from './modules/auth/auth-service.js';
import { GameService } from './modules/games/game-service.js';
import { hashSecret } from './modules/auth/credentials.js';
const db = createDatabasePool(process.env.DATABASE_URL!);
const auth = new AuthService(db, 'InviteOnly'),
  games = new GameService(db);
const app = await buildApp({
  logLevel: 'silent',
  auth,
  games,
  webOrigin: 'http://localhost:15173',
  health: { checkDatabase: async () => {}, checkRedis: async () => {} },
});
const password = 'account-test-password-123',
  newPassword = '全新的密码是一段足够长的中文短句123';
let host: CurrentUser,
  player: CurrentUser,
  other: CurrentUser,
  member: GameMemberSummary,
  game: GameDetails;
let hostCookie: string, playerCookie: string, otherCookie: string;
const post = (url: string, payload: Record<string, unknown>, cookie?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    payload,
    headers: cookie ? { cookie } : {},
  });
async function logIn(username: string, value = password) {
  const result = await post('/auth/login', { username, password: value });
  expect(result.statusCode).toBe(200);
  return String(result.headers['set-cookie']).split(';')[0]!;
}
const token = (cookie: string) => cookie.slice(cookie.indexOf('=') + 1);
const issue = (
  cookie = hostCookie,
  target = member.id,
  currentPassword = password,
) =>
  post(
    `/games/${game.id}/members/${target}/password-reset`,
    { currentPassword, reason: '本人请求恢复登录' },
    cookie,
  );
const invite = () =>
  post(
    `/games/${game.id}/registration-invitations`,
    { currentPassword: password },
    hostCookie,
  );
const redeem = (code: string, username = 'account-player') =>
  post('/auth/password-reset', { username, code, newPassword });
beforeEach(async () => {
  await db.query('TRUNCATE users,games CASCADE');
  [host, player, other] = (await Promise.all(
    ['account-host', 'account-player', 'account-other'].map((username) =>
      auth.createDevelopmentUser({ username, displayName: username, password }),
    ),
  )) as [CurrentUser, CurrentUser, CurrentUser];
  [hostCookie, playerCookie, otherCookie] = (await Promise.all(
    [host, player, other].map((user) => logIn(user.username)),
  )) as [string, string, string];
  game = await games.create({
    userId: host.id,
    name: '账号管理验收',
    countryNames: ['甲国', '乙国'],
  });
  member = await games.addMember({
    gameId: game.id,
    actorUserId: host.id,
    username: player.username,
    role: 'Player',
  });
});
afterAll(async () => {
  await app.close();
  await db.end();
});
describe('account management', () => {
  it('changes passwords only after reauthentication and revokes every old session', async () => {
    const second = await logIn(player.username);
    const bad = await post(
      '/auth/password',
      { currentPassword: 'incorrect-password', newPassword },
      playerCookie,
    );
    expect(bad.statusCode).toBe(401);
    expect(await auth.authenticate(token(second))).not.toBeNull();
    expect(
      (
        await post(
          '/auth/password',
          { currentPassword: password, newPassword: 'too-short' },
          playerCookie,
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          '/auth/password',
          { currentPassword: password, newPassword },
          playerCookie,
        )
      ).statusCode,
    ).toBe(200);
    expect(await auth.authenticate(token(playerCookie))).toBeNull();
    expect(await auth.authenticate(token(second))).toBeNull();
    expect(
      (await post('/auth/login', { username: player.username, password }))
        .statusCode,
    ).toBe(401);
    await logIn(player.username, newPassword);
    expect(
      (
        await post(
          '/auth/password',
          { currentPassword: newPassword, newPassword: password },
          playerCookie,
        )
      ).statusCode,
    ).toBe(401);
  });
  it('keeps existing passwords working until one-time reset redemption and records no code', async () => {
    const result = await issue();
    expect(result.statusCode).toBe(201);
    expect(result.headers['cache-control']).toBe('no-store');
    const code = result.json().data.code as string;
    expect(await auth.authenticate(token(playerCookie))).not.toBeNull();
    const stored = (await db.query('SELECT code_hash FROM account_reset_codes'))
      .rows[0];
    expect(stored.code_hash).toBe(hashSecret(code));
    const history = await app.inject({
      url: `/api/v1/games/${game.id}/account-history`,
      headers: { cookie: hostCookie },
    });
    expect(history.json().data[0].kind).toBe('ResetIssued');
    expect(history.body).not.toContain(code);
    expect(history.body).not.toContain(password);
    expect((await redeem(code, 'account-other')).statusCode).toBe(400);
    expect((await redeem(code)).statusCode).toBe(200);
    expect(await auth.authenticate(token(playerCookie))).toBeNull();
    expect((await redeem(code)).statusCode).toBe(400);
    await logIn(player.username, newPassword);
  });
  it('invalidates replaced, expired and revoked reset codes', async () => {
    const first = (await issue()).json().data.code as string;
    const second = (await issue()).json().data.code as string;
    expect((await redeem(first)).statusCode).toBe(400);
    await db.query(
      "UPDATE account_reset_codes SET expires_at=NOW()-INTERVAL '1 minute' WHERE code_hash=$1",
      [hashSecret(second)],
    );
    expect((await redeem(second)).statusCode).toBe(400);
    const third = (await issue()).json().data.code as string;
    await post(
      '/auth/password',
      { currentPassword: password, newPassword },
      playerCookie,
    );
    expect((await redeem(third)).statusCode).toBe(400);
  });
  it('allows exactly one concurrent redemption', async () => {
    const code = (await issue()).json().data.code as string;
    const results = await Promise.all([redeem(code), redeem(code)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(
      (
        await db.query(
          "SELECT COUNT(*)::int count FROM account_security_events WHERE kind='PasswordReset'",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it('does not let ordinary members, outsiders or wrong host passwords issue codes', async () => {
    expect((await issue(playerCookie)).statusCode).toBe(403);
    expect((await issue(otherCookie)).statusCode).toBe(403);
    expect(
      (await issue(hostCookie, member.id, 'incorrect-password')).statusCode,
    ).toBe(401);
    expect((await issue(hostCookie, randomUUID())).statusCode).toBe(404);
    const hidden = await app.inject({
      url: `/api/v1/games/${game.id}/account-history`,
      headers: { cookie: playerCookie },
    });
    expect(hidden.statusCode).toBe(403);
  });
  it('rejects host and system-administrator targets', async () => {
    const hostMember = (await games.listMembers(game.id, host.id)).find(
      (m) => m.role === 'Host',
    )!;
    expect((await issue(hostCookie, hostMember.id)).statusCode).toBe(403);
    await db.query("UPDATE users SET system_role='Administrator' WHERE id=$1", [
      player.id,
    ]);
    expect((await issue()).statusCode).toBe(403);
  });
  it.each([
    'hostRemoved',
    'targetRemoved',
    'targetPromoted',
    'gameEnded',
  ] as const)('rechecks authority when reset is redeemed: %s', async (kind) => {
    const code = (await issue()).json().data.code as string;
    if (kind === 'hostRemoved')
      await db.query(
        "UPDATE game_members SET status='Left' WHERE game_id=$1 AND user_id=$2",
        [game.id, host.id],
      );
    if (kind === 'targetRemoved')
      await db.query("UPDATE game_members SET status='Left' WHERE id=$1", [
        member.id,
      ]);
    if (kind === 'targetPromoted')
      await db.query(
        "UPDATE users SET system_role='Administrator' WHERE id=$1",
        [player.id],
      );
    if (kind === 'gameEnded')
      await games.end(game.id, host.id, {
        expectedQuarterId: game.currentQuarter.id,
        expectedQuarterState: game.currentQuarter.state,
        reason: '验收结束',
      });
    expect((await redeem(code)).statusCode).toBe(400);
    if (kind === 'gameEnded') expect((await issue()).statusCode).toBe(409);
  });
  it('requires a one-use invitation, creates no membership, and ignores a code in closed mode', async () => {
    const registration = {
      username: 'new-player',
      displayName: '新玩家',
      password: newPassword,
    };
    expect((await post('/auth/register', registration)).statusCode).toBe(400);
    const response = await invite();
    expect(response.statusCode).toBe(201);
    const code = response.json().data.code as string;
    const results = await Promise.all(
      ['first', 'second'].map((username) =>
        post('/auth/register', { ...registration, username, inviteCode: code }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 400]);
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::int count FROM game_members WHERE game_id=$1',
          [game.id],
        )
      ).rows[0].count,
    ).toBe(2);
    const closed = new AuthService(db, 'Closed');
    await expect(
      closed.register({ ...registration, inviteCode: code }),
    ).rejects.toMatchObject({ code: 'REGISTRATION_CLOSED' });
  });
  it('revokes outstanding reset codes and invitations when the issuer changes password', async () => {
    const code = (await invite()).json().data.code as string;
    const resetCode = (await issue()).json().data.code as string;
    expect(
      (
        await post(
          '/auth/password',
          { currentPassword: password, newPassword },
          hostCookie,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await post('/auth/register', {
          username: 'new-player',
          displayName: '新玩家',
          password: newPassword,
          inviteCode: code,
        })
      ).statusCode,
    ).toBe(400);
    expect((await redeem(resetCode)).statusCode).toBe(400);
  });

  it('rejects expired invitations and invitations from ended games, while self password changes remain available', async () => {
    const expired = (await invite()).json().data.code as string;
    const payload = {
      username: 'new-player',
      displayName: '新玩家',
      password: newPassword,
    };
    await db.query(
      "UPDATE registration_invitations SET expires_at=NOW()-INTERVAL '1 minute' WHERE code_hash=$1",
      [hashSecret(expired)],
    );
    expect(
      (await post('/auth/register', { ...payload, inviteCode: expired }))
        .statusCode,
    ).toBe(400);
    const ended = (await invite()).json().data.code as string;
    await games.end(game.id, host.id, {
      expectedQuarterId: game.currentQuarter.id,
      expectedQuarterState: game.currentQuarter.state,
      reason: '验收结束',
    });
    expect(
      (await post('/auth/register', { ...payload, inviteCode: ended }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          '/auth/password',
          { currentPassword: password, newPassword },
          playerCookie,
        )
      ).statusCode,
    ).toBe(200);
  });
  it('does not consume an invitation on username conflict', async () => {
    const code = (await invite()).json().data.code as string;
    const payload = {
      username: player.username,
      displayName: '新玩家',
      password: newPassword,
      inviteCode: code,
    };
    expect((await post('/auth/register', payload)).statusCode).toBe(409);
    expect(
      (await post('/auth/register', { ...payload, username: 'new-player' }))
        .statusCode,
    ).toBe(201);
  });
  it('bounds auth request sizes and returns a structured error', async () => {
    const response = await post('/auth/login', {
      username: 'missing',
      password: 'x'.repeat(9000),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('BODY_TOO_LARGE');
    expect(
      (await app.inject({ url: '/api/v1/auth/options' })).json().data
        .registrationMode,
    ).toBe('InviteOnly');
  });
  it('persists login throttles across service instances and ignores forged forwarding headers', async () => {
    for (let index = 0; index < 10; index++)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/login',
            headers: { 'x-forwarded-for': `10.0.0.${index}` },
            payload: { username: 'missing', password },
          })
        ).statusCode,
      ).toBe(401);
    const blocked = await post('/auth/login', {
      username: 'MISSING',
      password,
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.json().error.retryable).toBe(true);
    await expect(
      new AuthService(db).limit('Login', '127.0.0.1', 'missing'),
    ).rejects.toMatchObject({ code: 'AUTH_RATE_LIMITED' });
    await db.query(
      "UPDATE auth_rate_limits SET expires_at=NOW()-INTERVAL '1 minute'",
    );
    expect(
      (await post('/auth/login', { username: 'missing', password })).statusCode,
    ).toBe(401);
  });
  it('rejects cross-origin mutations and keeps legacy passwords login-compatible with a hash upgrade', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: playerCookie, origin: 'https://other.example' },
      payload: { currentPassword: password, newPassword },
    });
    expect(rejected.statusCode).toBe(403);
    const salt = Buffer.alloc(16, 3),
      oldPassword = 'legacy-123';
    const encoded = [
      'scrypt',
      16384,
      8,
      1,
      salt.toString('base64url'),
      scryptSync(oldPassword, salt, 64, { N: 16384, r: 8, p: 1 }).toString(
        'base64url',
      ),
    ].join('$');
    await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
      player.id,
      encoded,
    ]);
    await logIn(player.username, oldPassword);
    expect(
      (
        await db.query('SELECT password_hash FROM users WHERE id=$1', [
          player.id,
        ])
      ).rows[0].password_hash,
    ).toContain('$8$5$');
  });
  it('supports operator-assisted recovery of a host without granting it to players', async () => {
    const code = await auth.security.issueOperatorReset(
      host.username,
      '主持人本人请求维护者恢复',
    );
    expect((await redeem(code.code, host.username)).statusCode).toBe(200);
    await logIn(host.username, newPassword);
    expect(await auth.authenticate(token(hostCookie))).toBeNull();
    expect(
      (
        await db.query(
          "SELECT reason FROM account_security_events WHERE kind='OperatorResetIssued'",
        )
      ).rows[0].reason,
    ).toContain('本人');
  });
  it('orders login against password changes so an old credential cannot leave a surviving session', async () => {
    const results = await Promise.all([
      post('/auth/login', { username: player.username, password }),
      post(
        '/auth/password',
        { currentPassword: password, newPassword },
        playerCookie,
      ),
    ]);
    expect(results[1]!.statusCode).toBe(200);
    if (results[0]!.statusCode === 200) {
      const cookie = String(results[0]!.headers['set-cookie']).split(';')[0]!;
      expect(await auth.authenticate(token(cookie))).toBeNull();
    } else expect(results[0]!.statusCode).toBe(401);
    expect(
      (
        await db.query(
          'SELECT COUNT(*)::int count FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL',
          [player.id],
        )
      ).rows[0].count,
    ).toBe(0);
  });
});
