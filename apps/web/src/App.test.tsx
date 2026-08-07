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
            username: 'host',
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
            username: 'host',
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
      if (url.endsWith('/countries')) {
        return jsonResponse({
          data: [{ id: '00000000-0000-4000-8000-000000000004', name: 'Kandy' }],
          meta: { requestId: 'req_countries' },
        });
      }
      if (url.endsWith('/members')) {
        return jsonResponse({
          data: [
            {
              id: '00000000-0000-4000-8000-000000000005',
              userId: '00000000-0000-4000-8000-000000000001',
              username: 'host',
              displayName: 'Host',
              role: 'Host',
              status: 'Active',
              controlledCountryId: null,
              controlledCountryName: null,
            },
          ],
          meta: { requestId: 'req_members' },
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

    fireEvent.change(await screen.findByLabelText('用户名'), {
      target: { value: 'host' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'host-password-123' },
    });
    fireEvent.click(screen.getByRole('button', { name: '登录' }));

    expect(
      await screen.findByRole('heading', {
        name: 'Northern Passage',
        level: 2,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('欢迎回来，Host')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '创建游戏' }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText('成员管理')).toBeInTheDocument();
  });

  it('registers a new user from the login panel', async () => {
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
      if (url.endsWith('/auth/register') && init?.method === 'POST') {
        authenticated = true;
        return jsonResponse(
          {
            data: {
              id: '00000000-0000-4000-8000-000000000010',
              username: 'new-player',
              displayName: 'New Player',
              systemRole: 'User',
            },
            meta: { requestId: 'req_register' },
          },
          201,
        );
      }
      if (url.endsWith('/me') && authenticated) {
        return jsonResponse({
          data: {
            id: '00000000-0000-4000-8000-000000000010',
            username: 'new-player',
            displayName: 'New Player',
            systemRole: 'User',
            unreadNotificationCount: 0,
            games: [],
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
    fireEvent.click(
      await screen.findByRole('button', { name: '没有账号？立即注册' }),
    );
    fireEvent.change(screen.getByLabelText('显示名称'), {
      target: { value: 'New Player' },
    });
    fireEvent.change(screen.getByLabelText('用户名'), {
      target: { value: 'new-player' },
    });
    fireEvent.change(screen.getByLabelText('密码'), {
      target: { value: 'new-player-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(await screen.findByText('欢迎回来，New Player')).toBeInTheDocument();
    expect(screen.getByText('尚未加入游戏')).toBeInTheDocument();
  });
});
