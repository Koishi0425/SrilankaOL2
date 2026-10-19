import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiRequestError,
  beginSession,
  onSessionExpired,
  fetchMe,
  login,
  changePassword,
} from './api.js';
const response = (code = 'UNAUTHENTICATED') =>
  new Response(JSON.stringify({ error: { code, message: '登录已失效。' } }), {
    status: 401,
  });
afterEach(() => vi.restoreAllMocks());
describe('session expiry handling', () => {
  it('notifies for expired protected requests but not incorrect login or password', async () => {
    const listener = vi.fn(),
      unsubscribe = onSessionExpired(listener);
    try {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(response())
        .mockResolvedValueOnce(response('INCORRECT_PASSWORD'));
      await expect(fetchMe()).rejects.toBeInstanceOf(ApiRequestError);
      expect(listener).toHaveBeenCalledTimes(1);
      await expect(login('player', 'wrong-password')).rejects.toBeInstanceOf(
        ApiRequestError,
      );
      await expect(
        changePassword('wrong-password', 'a sufficiently long new password'),
      ).rejects.toBeInstanceOf(ApiRequestError);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });
  it('ignores an old pending response after a new session starts', async () => {
    const listener = vi.fn(),
      unsubscribe = onSessionExpired(listener);
    let resolve!: (value: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    try {
      const pending = fetchMe();
      beginSession();
      resolve(response());
      await expect(pending).rejects.toBeInstanceOf(ApiRequestError);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
