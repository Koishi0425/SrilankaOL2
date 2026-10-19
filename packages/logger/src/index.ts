import pino, { type Logger, type DestinationStream } from 'pino';

const sensitivePaths = [
  'password',
  'token',
  'authorization',
  'apiKey',
  '*.apiKey',
  'LLM_API_KEY',
  'req.headers.authorization',
  'databaseUrl',
  'redisUrl',
  'objectStorage.secretKey',
  '*.password',
  '*.token',
  'currentPassword',
  'newPassword',
  'code',
  'inviteCode',
  'resetCode',
  '*.currentPassword',
  '*.newPassword',
  '*.code',
  '*.inviteCode',
  '*.resetCode',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'req.body.code',
  'req.body.inviteCode',
  'req.body.resetCode',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
];

export function createLogger(
  level = 'info',
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level,
      redact: {
        paths: sensitivePaths,
        censor: '[REDACTED]',
      },
    },
    destination,
  );
}
