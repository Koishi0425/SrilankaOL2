import { randomUUID } from 'node:crypto';

const safeRequestId = /^[A-Za-z0-9_-]{1,128}$/;

export function resolveRequestId(value: string | undefined): string {
  return value && safeRequestId.test(value) ? value : `req_${randomUUID()}`;
}
