import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { ApiFault } from '../../errors.js';
export const MINIMUM_PASSWORD_LENGTH = 15;
const N = 16384,
  R = 8,
  P = 5,
  LENGTH = 64;
let running = 0;
const waiting: Array<() => void> = [];
async function derive(password: string, salt: Buffer, p: number) {
  if (running >= 2) {
    if (waiting.length >= 32)
      throw new ApiFault(429, 'AUTH_BUSY', '登录服务繁忙，请稍后重试。', {
        retryAfter: 5,
      });
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else running++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        LENGTH,
        { N, r: R, p, maxmem: 64 * 1024 * 1024 },
        (error, key) => (error ? reject(error) : resolve(key)),
      ),
    );
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running--;
  }
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16),
    key = await derive(password, salt, P);
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}
export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, n, r, p, saltValue, keyValue] = encoded.split('$');
  if (
    algorithm !== 'scrypt' ||
    Number(n) !== N ||
    Number(r) !== R ||
    ![1, P].includes(Number(p)) ||
    !saltValue ||
    !keyValue
  )
    return false;
  const expected = Buffer.from(keyValue, 'base64url'),
    salt = Buffer.from(saltValue, 'base64url'),
    actual = await derive(password, salt, Number(p));
  // Legacy failures should not reveal accounts through a cheaper work factor.
  if (Number(p) === 1) await derive(password, salt, P - 1);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function needsPasswordUpgrade(encoded: string) {
  return encoded.split('$')[3] !== String(P);
}
export function hashSecret(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function assertNewPassword(password: string) {
  if (
    password.length < MINIMUM_PASSWORD_LENGTH ||
    password.length > 256 ||
    !password.trim()
  )
    throw new ApiFault(
      400,
      'INVALID_NEW_PASSWORD',
      '新密码需为15至256个字符，可使用短句。',
    );
}
export const dummyPasswordHash = hashPassword(
  randomBytes(32).toString('base64url'),
);
