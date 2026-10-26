import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';
import { fetchMe } from './api.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('App', () => {
  it('keeps the current page mounted on session expiry and offers an explicit return to login', async () => {
    let expired = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/me') && !expired)
        return jsonResponse({
          data: {
            id: 'player',
            username: 'player',
            displayName: '当前玩家',
            systemRole: 'User',
            games: [],
            canCreateGame: false,
            unreadNotificationCount: 0,
          },
        });
      return jsonResponse(
        { error: { code: 'UNAUTHENTICATED', message: '请先登录。' } },
        401,
      );
    });
    render(<App />);
    expect(await screen.findByText('当前玩家')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '全局 AI 设置' })).toBeNull();
    expired = true;
    await act(async () => {
      await expect(fetchMe()).rejects.toThrow();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('未保存的文字仍在本页');
    expect(screen.getByText('当前玩家')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重新登录' }));
    expect(
      await screen.findByRole('heading', { name: '登录', level: 2 }),
    ).toBeInTheDocument();
  });
  it('reports a logout failure without pretending that the session has been cleared', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/me'))
        return jsonResponse({
          data: {
            id: 'player',
            username: 'player',
            displayName: '当前玩家',
            systemRole: 'User',
            games: [],
            canCreateGame: false,
            unreadNotificationCount: 0,
          },
        });
      throw new Error('网络中断，退出失败');
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('退出失败');
    expect(screen.getByText('当前玩家')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeEnabled();
  });
  it('does not offer a new game when another active game exists outside this account history', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/me'))
        return jsonResponse({
          data: {
            id: 'player',
            username: 'player',
            displayName: '玩家',
            systemRole: 'User',
            unreadNotificationCount: 0,
            canCreateGame: false,
            games: [
              {
                id: 'history',
                name: '旧剧本',
                status: 'Archived',
                role: 'Player',
                currentQuarter: {
                  id: 'quarter',
                  gameYear: 1,
                  season: 'Autumn',
                  sequenceNumber: 3,
                  state: 'Published',
                  actionDeadline: null,
                  currentWorldVersion: 2,
                },
              },
            ],
          },
        });
      return jsonResponse(
        { error: { code: 'OBJECT_NOT_FOUND', message: '测试占位' } },
        404,
      );
    });
    render(<App />);
    expect(
      await screen.findByRole('heading', { name: '旧剧本' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '新建一局' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('已结束 · 只读')).toBeInTheDocument();
  });

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
      if (url.endsWith('/rules')) {
        return jsonResponse({
          data: {
            quarterId: '00000000-0000-4000-8000-000000000003',
            version: 1,
            scenario: {
              title: '',
              playerPerspective: 'Flexible',
              premise: '',
              commonRules: '',
            },
            quarter: {
              briefing: '',
              actionGuidelines: '',
              suggestedLimits: [],
            },
          },
          meta: { requestId: 'req_rules' },
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
            {
              id: '00000000-0000-4000-8000-000000000006',
              userId: '00000000-0000-4000-8000-000000000007',
              username: 'player',
              displayName: 'Player',
              role: 'Player',
              status: 'Active',
              controlledCountryId: '00000000-0000-4000-8000-000000000004',
              controlledCountryName: 'Kandy',
            },
          ],
          meta: { requestId: 'req_members' },
        });
      }
      if (url.endsWith('/preparation'))
        return jsonResponse({
          data: {
            quarter: {
              id: '00000000-0000-4000-8000-000000000003',
              gameYear: 1,
              season: 'Spring',
              sequenceNumber: 1,
              state: 'Preparing',
              actionDeadline: null,
              currentWorldVersion: 0,
            },
            revision: 'saved',
            canOpen: true,
            countryCount: 1,
            playerCount: 1,
            assignedPlayerCount: 1,
            unassignedPlayers: [],
            rulesSaved: false,
            map: null,
            resourceCountryCount: 0,
            automaticEconomy: false,
            governmentCountryCount: 0,
          },
          meta: { requestId: 'prep' },
        });
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
    expect(
      screen.getByText('Host', { selector: '.current-user' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '创建游戏' }),
    ).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '本局管理' }));
    expect(
      await screen.findByRole('heading', { name: '本局管理' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveClass('app-shell--wide');
    fireEvent.change(screen.getByLabelText('玩家视角预览'), {
      target: { value: '00000000-0000-4000-8000-000000000006' },
    });
    expect(screen.getByText('只读预览')).toBeInTheDocument();
  });

  it('registers a new user from the login panel', async () => {
    let authenticated = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/auth/options'))
        return jsonResponse({
          data: { registrationMode: 'Open', minimumPasswordLength: 6 },
        });
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
    fireEvent.click(await screen.findByRole('button', { name: '注册账号' }));
    fireEvent.change(screen.getByLabelText('显示名称'), {
      target: { value: 'New Player' },
    });
    fireEvent.change(screen.getByLabelText('用户名'), {
      target: { value: 'new-player' },
    });
    fireEvent.change(screen.getByLabelText('新密码（至少6个字符）'), {
      target: { value: 'new-player-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '注册' }));

    expect(
      await screen.findByText('New Player', { selector: '.current-user' }),
    ).toBeInTheDocument();
    expect(screen.getByText('尚未加入游戏')).toBeInTheDocument();
  });

  it('creates a game from an empty account and enters its opening preparation', async () => {
    const quarter = {
      id: '00000000-0000-4000-8000-000000000003',
      gameYear: 1,
      season: 'Spring',
      sequenceNumber: 1,
      state: 'Preparing',
      actionDeadline: null,
      currentWorldVersion: 0,
    };
    const game = {
      id: '00000000-0000-4000-8000-000000000002',
      name: '诸国时代',
      role: 'Host',
      status: 'Preparing',
      currentQuarter: quarter,
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/me'))
        return jsonResponse({
          data: {
            id: 'user',
            displayName: '主持人',
            games: [],
            unreadNotificationCount: 0,
          },
        });
      if (url.endsWith('/games') && init?.method === 'POST')
        return jsonResponse({ data: game }, 201);
      if (
        url.endsWith('/countries') ||
        url.endsWith('/members') ||
        url.endsWith('/actions') ||
        url.endsWith('/host-queue')
      )
        return jsonResponse({ data: [] });
      if (url.endsWith('/rules'))
        return jsonResponse({
          data: {
            quarterId: quarter.id,
            version: 1,
            scenario: {
              title: '',
              playerPerspective: 'Flexible',
              premise: '',
              commonRules: '',
            },
            quarter: {
              briefing: '',
              actionGuidelines: '',
              suggestedLimits: [],
            },
          },
        });
      if (url.endsWith('/preparation'))
        return jsonResponse({
          data: {
            quarter,
            revision: 'saved',
            canOpen: false,
            countryCount: 3,
            playerCount: 0,
            assignedPlayerCount: 0,
            unassignedPlayers: [],
            rulesSaved: false,
            map: null,
            resourceCountryCount: 0,
            automaticEconomy: false,
            governmentCountryCount: 0,
          },
        });
      if (url.endsWith(`/${game.id}`)) return jsonResponse({ data: game });
      if (url.endsWith('/national-status'))
        return jsonResponse({ data: { countries: [], canEdit: true } });
      return jsonResponse(
        {
          error: {
            code: 'MAP_NOT_FOUND',
            message: '尚未设置',
            details: {},
            retryable: false,
          },
        },
        404,
      );
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '新建一局' }));
    fireEvent.change(screen.getByLabelText('游戏名称'), {
      target: { value: '诸国时代' },
    });
    fireEvent.change(screen.getByLabelText('国家名单（每行一个）'), {
      target: { value: '北国\n南国\n海国' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建游戏' }));
    expect(
      await screen.findByRole('heading', { name: '诸国时代', level: 2 }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: '开局准备' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('至少添加一位玩家。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开放第一回合' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: '新建一局' }),
    ).not.toBeInTheDocument();
  });
});
