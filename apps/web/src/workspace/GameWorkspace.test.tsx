import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import type {
  GameSummary,
  GameRulesData,
  ActionDetails,
  TileDetails,
} from '@srilanka/contracts';
import type * as ApiModule from '../api.js';
import {
  fetchCountries,
  fetchGameRules,
  fetchMembers,
  fetchNationalStatus,
  fetchActions,
  fetchGame,
  fetchGovernment,
  fetchAction,
  fetchActionVersions,
  openPolicyConversation,
  locateMapReference,
  assignCountry,
  fetchProvinces,
  fetchRoundPolicies,
  fetchMyRoundPolicy,
  fetchRoundPolicy,
  fetchRoundPolicyForAction,
} from '../api.js';
import { GameWorkspace } from './GameWorkspace.js';
vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  fetchCountries: vi.fn(),
  fetchGameRules: vi.fn(),
  fetchMembers: vi.fn(),
  fetchNationalStatus: vi.fn(),
  fetchActions: vi.fn(),
  fetchGame: vi.fn(),
  fetchGovernment: vi.fn(),
  setupGovernment: vi.fn(),
  fetchAction: vi.fn(),
  fetchActionVersions: vi.fn(),
  openPolicyConversation: vi.fn(),
  locateMapReference: vi.fn(),
  assignCountry: vi.fn(),
  fetchProvinces: vi.fn(),
  fetchRoundPolicies: vi.fn(),
  fetchMyRoundPolicy: vi.fn(),
  fetchRoundPolicy: vi.fn(),
  fetchRoundPolicyForAction: vi.fn(),
}));
vi.mock('../map/HexMap.js', () => ({
  HexMap: ({
    onCreateAction,
    onInspectTile,
    tileFocus,
    returnTarget,
  }: {
    onCreateAction?: (tile: TileDetails) => void;
    onInspectTile?: () => void;
    tileFocus?: { id: string; q: number; r: number };
    returnTarget?: { label: string; onReturn: () => void };
  }) => {
    const [selected, setSelected] = useState(false);
    return (
      <div>
        <p>{selected ? '地图保留东岸堡选中状态' : '地图可见'}</p>
        {tileFocus && (
          <p>
            已定位 {tileFocus.id}（{tileFocus.q},{tileFocus.r}）
          </p>
        )}
        {returnTarget && (
          <button onClick={returnTarget.onReturn}>{returnTarget.label}</button>
        )}
        {onCreateAction && (
          <button
            onClick={() => {
              setSelected(true);
              onCreateAction({
                id: 'tile',
                q: 1,
                r: 2,
                regionName: '东岸堡',
                terrainName: '平原',
                controllerCountryName: '北国',
              } as TileDetails);
            }}
          >
            将测试地块加入政策
          </button>
        )}
        <button
          onClick={() => {
            setSelected(true);
            onInspectTile?.();
          }}
        >
          查看地图地块
        </button>
      </div>
    );
  },
}));
vi.mock('../messages/MessageCenter.js', () => ({
  MessageCenter: ({
    onUnreadChange,
    onOpenPolicy,
    target,
  }: {
    onUnreadChange?: (count: number) => void;
    onOpenPolicy?: (id: string) => void;
    target?: { conversation: { id: string } };
  }) => {
    const [text, setText] = useState('');
    useEffect(() => {
      onUnreadChange?.(2);
    }, [onUnreadChange]);
    return (
      <div>
        {target && <p>已打开关联讨论：{target.conversation.id}</p>}
        <label>
          测试消息草稿
          <textarea value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <button onClick={() => onOpenPolicy?.('action')}>返回测试政策</button>
      </div>
    );
  },
}));
const game: GameSummary = {
  id: 'game',
  name: '诸国战略',
  status: 'Running',
  role: 'Player',
  currentQuarter: {
    id: 'quarter',
    gameYear: 3,
    season: 'Autumn',
    sequenceNumber: 11,
    state: 'HostReview',
    actionDeadline: null,
    currentWorldVersion: 8,
  },
};
const country = {
  id: 'north',
  name: '北国',
  mapColor: '#557',
  treasury: 1538.8,
  manpower: 6750,
  resourceRevision: 3,
  controlledTileCount: 32,
  legalTileCount: 30,
  cities: [],
  armies: [{ id: 'army', name: '北军', strength: 1100, q: 9, r: 6 }],
};
const rules: GameRulesData = {
  quarterId: 'quarter',
  version: 1,
  scenario: {
    title: '诸国',
    playerPerspective: 'CountryWill',
    premise: '',
    commonRules: '',
  },
  quarter: { briefing: '', actionGuidelines: '', suggestedLimits: [] },
};
const action: ActionDetails = {
  id: 'action',
  quarterId: 'quarter',
  countryId: 'north',
  countryName: '北国',
  createdByMemberId: 'member',
  title: '北境探索',
  category: 'Exploration',
  secrecy: 'OwnerOnly',
  status: 'NeedPlayerInput',
  version: 1,
  submittedAt: null,
  updatedAt: '2026-10-13T00:00:00Z',
  currentText: '指定探索路线',
  refs: [],
  latestInterpretation: null,
  submittedOriginalText: '探索北境',
  pendingInputRequest: '说明路线',
  history: [],
  submissions: [],
};
const roundPolicy = (a = action) => ({
  quarterId: a.quarterId,
  memberId: a.createdByMemberId,
  countryId: a.countryId,
  countryName: a.countryName,
  playerName: '玩家甲',
  status: a.status,
  sectionCount: 1,
  submittedAt: a.submittedAt,
  revision: 'a'.repeat(64),
  quarter: game.currentQuarter,
  canEdit: true,
  canSubmit: true,
  sections: [
    {
      id: a.id,
      title: a.title,
      text: a.submittedOriginalText ?? '',
      category: a.category,
      secrecy: a.secrecy,
      refs: a.refs,
      status: a.status,
      reviewReason: '',
    },
  ],
  draftSections: [
    {
      id: a.id,
      title: a.title,
      text: a.currentText,
      category: a.category,
      secrecy: a.secrecy,
      refs: a.refs,
    },
  ],
  pendingInputRequest: a.pendingInputRequest,
  interpretation: '',
  history: [],
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchRoundPolicies).mockResolvedValue([roundPolicy()]);
  vi.mocked(fetchMyRoundPolicy).mockResolvedValue(roundPolicy());
  vi.mocked(fetchRoundPolicy).mockResolvedValue(roundPolicy());
  vi.mocked(fetchRoundPolicyForAction).mockResolvedValue(roundPolicy());
  vi.mocked(fetchCountries).mockResolvedValue([country]);
  vi.mocked(fetchProvinces).mockResolvedValue({
    canEdit: false,
    mapRevision: 8,
    provinces: [],
  });
  vi.mocked(fetchGameRules).mockResolvedValue(structuredClone(rules));
  vi.mocked(fetchMembers).mockResolvedValue([
    {
      id: 'player-member',
      userId: 'player',
      username: 'player',
      displayName: '玩家甲',
      role: 'Player',
      status: 'Active',
      controlledCountryId: 'north',
      controlledCountryName: '北国',
    },
  ]);
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    canSetBalances: false,
    countries: [country],
  });
  vi.mocked(fetchActions).mockResolvedValue([
    action,
    { ...action, id: 'old', title: '旧回合探索', quarterId: 'old-quarter' },
  ]);
  vi.mocked(fetchGame).mockResolvedValue({
    ...game,
    allowNewPlayers: false,
    aiEnabled: false,
    createdAt: '2026-10-13T00:00:00Z',
  });
  vi.mocked(fetchAction).mockResolvedValue(structuredClone(action));
  vi.mocked(fetchActionVersions).mockResolvedValue([]);
  vi.mocked(locateMapReference).mockResolvedValue({
    id: 'located-tile',
    q: 9,
    r: 6,
    scope: [{ id: 'located-tile', q: 9, r: 6 }],
  });
  vi.mocked(fetchGovernment).mockResolvedValue({
    revision: 3,
    quarter: { gameYear: 3, season: 'Autumn', sequenceNumber: 11 },
    canEdit: true,
    countries: [country],
    profiles: [
      {
        countryId: 'north',
        countryName: '北国',
        regime: '君主制',
        authority: '国王',
        description: '',
      },
    ],
    policies: [],
    lastBill: null,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('sends an explicit null when the host selects unassigned country', async () => {
  render(<GameWorkspace game={{ ...game, role: 'Host' }} />);
  fireEvent.click(await screen.findByRole('button', { name: '本局管理' }));
  fireEvent.change(
    await screen.findByRole('combobox', { name: '为 玩家甲 分配国家' }),
    { target: { value: '' } },
  );
  await waitFor(() =>
    expect(assignCountry).toHaveBeenCalledWith('game', 'player-member', null),
  );
});
const nav = () =>
  within(screen.getByRole('navigation', { name: '游戏工作区' }));
it('retains the chosen panel width across menus and restores it after expanded reading', async () => {
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  await nav().findByRole('button', { name: '政策' });
  fireEvent.click(nav().getByRole('button', { name: '政策' }));
  const splitter = screen.getByRole('separator', {
    name: '调整面板与地图宽度',
  });
  fireEvent.keyDown(splitter, { key: 'ArrowRight', shiftKey: true });
  expect(splitter).toHaveAttribute('aria-valuenow', '57');
  expect(splitter.closest('.strategy-main')).toHaveStyle(
    '--workspace-panel-width: 57%',
  );
  fireEvent.click(screen.getByRole('button', { name: '展开面板' }));
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '还原面板' }));
  fireEvent.click(nav().getByRole('button', { name: /^消息/ }));
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '57');
  fireEvent.keyDown(screen.getByRole('separator'), { key: 'Home' });
  expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '52');
});
it('returns from a province on the map to the same economy section and province selection', async () => {
  vi.mocked(fetchProvinces).mockResolvedValue({
    canEdit: false,
    mapRevision: 8,
    provinces: [
      {
        id: 'province',
        name: '北境',
        partial: false,
        tileCount: 1,
        values: null,
        legalOwners: [
          { countryId: 'north', countryName: '北国', tileCount: 1 },
        ],
        controllers: [
          { countryId: 'north', countryName: '北国', tileCount: 1 },
        ],
        tiles: [{ id: 'north-bank', q: 9, r: 6, regionName: '北岸' }],
      },
    ],
  });
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  fireEvent.click(nav().getByRole('button', { name: '经济' }));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看省份：北境' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '在地图查看地区：北岸' }));
  expect(await screen.findByText('已定位 north-bank（9,6）')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '返回经济' }));
  expect(nav().getByRole('button', { name: '经济' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    screen.getByRole('button', { name: '在地图查看地区：北岸' }),
  ).toBeVisible();
});
it('locates a province from a reviewed policy and returns to the same policy without refilling its form', async () => {
  const ref = {
    id: 'ref',
    refKind: 'Target' as const,
    objectType: 'Province' as const,
    objectId: 'province',
    label: '省份：北境',
  };
  vi.mocked(fetchAction).mockResolvedValue({ ...action, refs: [ref] });
  vi.mocked(fetchMyRoundPolicy).mockResolvedValue(
    roundPolicy({ ...action, refs: [ref] }),
  );
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  fireEvent.click(nav().getByRole('button', { name: '政策' }));
  fireEvent.click(await screen.findByRole('button', { name: '省份：北境' }));
  expect(await screen.findByText('已定位 located-tile（9,6）')).toBeVisible();
  expect(locateMapReference).toHaveBeenCalledWith(
    'game',
    'Province',
    'province',
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  fireEvent.click(screen.getByRole('button', { name: '返回政策' }));
  expect(screen.getByLabelText('具体政策')).toHaveValue('指定探索路线');
  expect(screen.getByLabelText('分项标题（可自拟）')).toHaveValue('北境探索');
});
it('keeps map selection and uncreated policy text through menus and Escape; map objects reopen their detail view', async () => {
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  await nav().findByRole('button', { name: '政策' });
  fireEvent.click(screen.getByRole('button', { name: '将测试地块加入政策' }));
  // Wait for the map target to append its own section after the policy loads.
  // The pre-existing section can render first, so a global label query races it.
  const title = await screen.findByDisplayValue('关于东岸堡的政策 / 行动');
  const mapSection = within(title.closest('article')!);
  expect(screen.getAllByLabelText('具体政策')).toHaveLength(2);
  expect(screen.getByDisplayValue('指定探索路线')).toBeInTheDocument();
  fireEvent.change(mapSection.getByLabelText('具体政策'), {
    target: { value: '携带补给，自由探索东岸堡' },
  });
  fireEvent.click(nav().getByRole('button', { name: /^消息/ }));
  fireEvent.change(screen.getByLabelText('测试消息草稿'), {
    target: { value: '向主持人说明意图' },
  });
  fireEvent.click(nav().getByRole('button', { name: '政策' }));
  expect(mapSection.getByLabelText('具体政策')).toHaveValue(
    '携带补给，自由探索东岸堡',
  );
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(
    screen.queryByRole('button', { name: '关闭面板' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText('地图保留东岸堡选中状态')).toBeVisible();
  expect(nav().getByRole('button', { name: '政策' })).toHaveFocus();
  fireEvent.click(nav().getByRole('button', { name: '政策' }));
  expect(mapSection.getByLabelText('具体政策')).toHaveValue(
    '携带补给，自由探索东岸堡',
  );
  fireEvent.click(screen.getByRole('button', { name: '查看地图地块' }));
  expect(
    screen.queryByRole('button', { name: '关闭面板' }),
  ).not.toBeInTheDocument();
});
it('routes a current pending action into review, its policy conversation and back to the original action', async () => {
  vi.mocked(openPolicyConversation).mockResolvedValue({
    id: 'policy-discussion',
  } as Awaited<ReturnType<typeof openPolicyConversation>>);
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  fireEvent.click(nav().getByRole('button', { name: '回合事务' }));
  const tasks = await screen.findByRole('complementary', { name: '回合事务' });
  await within(tasks).findByText('本回合政策');
  expect(screen.queryByText('旧回合探索')).not.toBeInTheDocument();
  fireEvent.click(within(tasks).getByRole('button', { name: /本回合政策/ }));
  await screen.findByDisplayValue('指定探索路线');
  fireEvent.click(screen.getByRole('button', { name: '讨论整份政策' }));
  expect(
    await screen.findByText('已打开关联讨论：policy-discussion'),
  ).toBeVisible();
  expect(openPolicyConversation).toHaveBeenCalledWith('game', 'action');
  fireEvent.click(screen.getByRole('button', { name: '返回测试政策' }));
  expect(await screen.findByDisplayValue('指定探索路线')).toBeVisible();
});
it('hides resources, tasks and host editors in player perspective preview and restores the original panel draft', async () => {
  const hostGame = { ...game, role: 'Host' as const };
  render(<GameWorkspace game={hostGame} />);
  await screen.findByLabelText('当前查看国家');
  expect(screen.getByText('1,538.8')).toBeVisible();
  fireEvent.click(nav().getByRole('button', { name: '政府' }));
  fireEvent.click(
    await screen.findByRole('button', { name: '设置政府与开场政策' }),
  );
  fireEvent.change(screen.getByLabelText('政体'), {
    target: { value: '议会制' },
  });
  expect(screen.getByLabelText('当前查看国家')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('玩家视角预览'), {
    target: { value: 'player-member' },
  });
  expect(screen.getByText('只读预览')).toBeVisible();
  expect(screen.queryByText('1,538.8')).not.toBeVisible();
  expect(
    screen.queryByRole('complementary', { name: '回合事务' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('政体')).not.toBeVisible();
  fireEvent.change(screen.getByLabelText('玩家视角预览'), {
    target: { value: '' },
  });
  fireEvent.click(nav().getByRole('button', { name: '政府' }));
  expect(screen.getByLabelText('政体')).toHaveValue('议会制');
});
it('shows observers only public menus and does not request private national data or action queues', async () => {
  vi.mocked(fetchGame).mockResolvedValue({
    ...game,
    role: 'Observer',
    allowNewPlayers: false,
    aiEnabled: false,
    createdAt: '2026-10-13T00:00:00Z',
  });
  render(<GameWorkspace game={{ ...game, role: 'Observer' }} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  await nav().findByRole('button', { name: '外交' });
  expect(nav().queryByRole('button', { name: '政府' })).not.toBeInTheDocument();
  expect(nav().queryByRole('button', { name: '政策' })).not.toBeInTheDocument();
  expect(fetchNationalStatus).not.toHaveBeenCalled();
  expect(fetchActions).not.toHaveBeenCalled();
  expect(screen.queryByText('1,538.8')).not.toBeInTheDocument();
  fireEvent.click(nav().getByRole('button', { name: '国家' }));
  await screen.findByRole('region', { name: '国家概况' });
  expect(fetchNationalStatus).not.toHaveBeenCalled();
});
it('updates remote quarter changes and clears previous quarter tasks without reloading the page', async () => {
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  fireEvent.click(nav().getByRole('button', { name: '回合事务' }));
  await screen.findByText('本回合政策');
  vi.mocked(fetchGame).mockResolvedValue({
    ...game,
    currentQuarter: {
      ...game.currentQuarter,
      id: 'new-quarter',
      season: 'Winter',
      sequenceNumber: 12,
      state: 'Preparing',
    },
    allowNewPlayers: false,
    aiEnabled: false,
    createdAt: '2026-10-13T00:00:00Z',
  });
  fireEvent(document, new Event('visibilitychange'));
  expect(await screen.findByText('第 3 年 · 冬季')).toBeVisible();
  await waitFor(() =>
    expect(screen.queryByText('本回合政策')).not.toBeInTheDocument(),
  );
  expect(screen.getByText('暂无待处理政策。')).toBeVisible();
});

it('expands a policy for writing and restores the map without losing its draft', async () => {
  render(<GameWorkspace game={game} />);
  await screen.findByRole('navigation', { name: '游戏工作区' });
  expect(
    screen.queryByRole('complementary', { name: '回合事务' }),
  ).not.toBeInTheDocument();
  fireEvent.click(nav().getByRole('button', { name: '政策' }));
  fireEvent.change(await screen.findByLabelText('具体政策'), {
    target: { value: '先与邻国交涉，再决定探索路线。' },
  });
  fireEvent.click(screen.getByRole('button', { name: '展开面板' }));
  expect(screen.getByRole('button', { name: '还原面板' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: '关闭面板' }));
  fireEvent.click(nav().getByRole('button', { name: '政策' }));
  expect(screen.getByLabelText('具体政策')).toHaveValue(
    '先与邻国交涉，再决定探索路线。',
  );
  expect(screen.getByRole('button', { name: '展开面板' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

it.each(['Host', 'Player', 'Observer'] as const)(
  'provides the complete phone navigation for %s without desktop tabs',
  async (role) => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    try {
      const page = render(<GameWorkspace game={{ ...game, role }} />);
      const navigation = await screen.findByRole('navigation', {
        name: '手机游戏导航',
      });
      expect(
        screen.queryByRole('navigation', { name: '游戏工作区' }),
      ).not.toBeInTheDocument();
      expect(within(navigation).getAllByRole('button')).toHaveLength(
        role === 'Observer' ? 4 : 5,
      );
      fireEvent.click(
        within(navigation).getByRole('button', { name: '全部功能' }),
      );
      const directory = screen.getByRole('region', { name: '全部功能' });
      expect(
        within(directory).getByRole('button', { name: /国家概况/ }),
      ).toBeInTheDocument();
      expect(
        within(directory).getByRole('button', { name: /外交/ }),
      ).toBeInTheDocument();
      expect(
        within(directory).queryByRole('button', { name: /军事/ }) !== null,
      ).toBe(role !== 'Observer');
      expect(
        within(directory).queryByRole('button', { name: /本局管理/ }) !== null,
      ).toBe(role === 'Host');
      fireEvent.click(
        within(directory).getByRole('button', { name: /剧本与规则/ }),
      );
      expect(
        await screen.findByRole('region', { name: '剧本与规则' }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('region', { name: '全部功能' }),
      ).not.toBeInTheDocument();
      fireEvent.click(within(navigation).getByRole('button', { name: /消息/ }));
      fireEvent.change(screen.getByLabelText('测试消息草稿'), {
        target: { value: '手机未发送内容' },
      });
      fireEvent.click(within(navigation).getByRole('button', { name: '地图' }));
      fireEvent.click(within(navigation).getByRole('button', { name: /消息/ }));
      expect(screen.getByLabelText('测试消息草稿')).toHaveValue(
        '手机未发送内容',
      );
      page.unmount();
    } finally {
      window.matchMedia = original;
    }
  },
);
