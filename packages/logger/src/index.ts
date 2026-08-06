import pino, { type Logger } from 'pino';

const sensitivePaths = [
  'password',
  'token',
  'authorization',
  'req.headers.authorization',
  'databaseUrl',
  'redisUrl',
  'objectStorage.secretKey',
  '*.password',
  '*.token',
];

export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: sensitivePaths,
      censor: '[REDACTED]',
    },
  });
}
