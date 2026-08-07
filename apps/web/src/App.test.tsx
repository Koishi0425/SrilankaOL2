import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('App', () => {
  it('logs in and renders the current user games', async () => {
    let authenticated = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/health')) {
        return jsonResponse({
          data: {
            status: 'ok',
            service: 'api',
            version: '0.0.0',
            dependencies: { database: 'up', redis: 'up' },
          },
          meta: { requestId: 'req_health' },
        });
      }
      if (url.endsWith('/auth/login') && init?.method === 'POST') {
        authenticated = true;
        return jsonResponse({
          data: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'host@example.test',
            displayName: 'Host',
            systemRole: 'User',
          },
          meta: { requestId: 'req_login' },
        });
      }
      if (url.endsWith('/me') && authenticated) {
        return jsonResponse({
          data: {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'host@example.test',
            displayName: 'Host',
            systemRole: 'User',
            unreadNotificationCount: 0,
            games: [
              {
                id: '00000000-0000-4000-8000-000000000002',
                name: 'Northern Passage',
                status: 'Preparing',
                role: 'Host',
                currentQuarter: {
                  id: '00000000-0000-4000-8000-000000000003',
                  gameYear: 1,
                  season: 'Spring',
                  sequenceNumber: 1,
                  state: 'Preparing',
                  actionDeadline: null,
                  currentWorldVersion: 0,
                },
              },
            ],
          },
          meta: { requestId: 'req_me' },
        });
      }
      return jsonResponse(
        {
          error: {
            code: 'UNAUTHENTICATED',
            message: 'Authentication required',
            details: {},
            retryable: false,
          },
          meta: { requestId: 'req_guest' },
        },
        401,
      );
    });

    render(<App />);

    fireEvent.change(await screen.findByLabelText('邮箱'), {
      target: { value: 'host@example.test' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'host-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('Northern Passage')).toBeInTheDocument();
    expect(screen.getByText('欢迎回来，Host')).toBeInTheDocument();
  });
});
