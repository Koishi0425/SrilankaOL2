import { describe, expect, it } from 'vitest';
import { createLogger } from '@srilanka/logger';
describe('account credential logging', () => {
  it('redacts passwords, codes and session cookies in structured logging', () => {
    let output = '';
    const logger = createLogger('info', {
      write: (line) => {
        output += line;
      },
    });
    logger.info(
      {
        password: 'private-password',
        currentPassword: 'private-current',
        newPassword: 'private-new',
        code: 'private-code',
        inviteCode: 'private-invite',
        resetCode: 'private-reset',
        token: 'private-token',
        req: {
          headers: {
            cookie: 'private-cookie',
            authorization: 'private-bearer',
          },
          body: {
            password: 'private-body-password',
            currentPassword: 'private-body-current',
            newPassword: 'private-body-new',
            code: 'private-body-code',
            inviteCode: 'private-body-invite',
            resetCode: 'private-body-reset',
          },
        },
        res: { headers: { 'set-cookie': 'private-set-cookie' } },
      },
      'Account event',
    );
    expect(output).not.toContain('private-');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('Account event');
  });
});
