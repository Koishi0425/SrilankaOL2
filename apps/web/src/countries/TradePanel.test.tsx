import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GameSummary, TradeData } from '@srilanka/contracts';
import { fetchTrade, setTradeZone } from '../api.js';
import { TradePanel } from './TradePanel.js';
vi.mock('../api.js', () => ({ fetchTrade: vi.fn(), setTradeZone: vi.fn() }));
const game: GameSummary = {
  id: 'game',
  name: '海湾',
  role: 'Host',
  status: 'Running',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    state: 'Preparing',
    sequenceNumber: 1,
    actionDeadline: null,
    currentWorldVersion: 0,
  },
};
const data: TradeData = {
  economicEnabled: true,
  coefficient: 10,
  canEdit: true,
  mapRevision: 7,
  zones: [
    {
      id: 'zone',
      name: '海湾',
      ownInfluence: 60,
      setup: {
        id: 'zone',
        name: '海湾',
        revision: 2,
        value: 100,
        provinces: [
          { id: 'p', name: '北方省', productionBase: 10, tileCount: 2 },
        ],
        influences: [
          { countryId: 'north', power: 60 },
          { countryId: 'south', power: 40 },
        ],
        allocations: [
          { countryId: 'north', amount: 60 },
          { countryId: 'south', amount: 40 },
        ],
      },
    },
  ],
  options: {
    provinces: [{ id: 'p', name: '北方省' }],
    countries: [
      { id: 'north', name: '北国' },
      { id: 'south', name: '南国' },
    ],
  },
  lastIncome: null,
};
const own: TradeData = {
  economicEnabled: true,
  coefficient: 10,
  canEdit: false,
  mapRevision: 7,
  zones: [{ id: 'zone', name: '海湾', ownInfluence: 80 }],
  lastIncome: {
    gameYear: 1,
    season: 'Spring',
    calculatedIncome: 60,
    actualIncome: 50,
    adjustmentReason: '临时封锁',
    sources: [{ name: '海湾', amount: 60 }],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchTrade).mockResolvedValue(data);
});
afterEach(cleanup);
it('loads on demand and preserves failed setup edits and their original revision across workspaces', async () => {
  vi.mocked(setTradeZone).mockRejectedValue(new Error('贸易区已变化'));
  const view = render(<TradePanel game={game} countryId="north" active />);
  expect(fetchTrade).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('贸易（全部）'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看贸易区：海湾' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '编辑贸易区' }));
  fireEvent.change(screen.getByLabelText('北国贸易影响力'), {
    target: { value: '80' },
  });
  fireEvent.change(screen.getByLabelText('贸易区修改原因'), {
    target: { value: '新商贸协议' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存贸易区' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('贸易区已变化');
  view.rerender(<TradePanel game={game} countryId="north" active={false} />);
  view.rerender(<TradePanel game={game} countryId="north" active />);
  expect(screen.getByLabelText('北国贸易影响力')).toHaveValue(80);
  expect(fetchTrade).toHaveBeenCalledOnce();
  expect(setTradeZone).toHaveBeenCalledWith('game', 'zone', {
    expectedRevision: 2,
    expectedMapRevision: 7,
    name: '海湾',
    provinceIds: ['p'],
    influences: [
      { countryId: 'north', power: 80 },
      { countryId: 'south', power: 40 },
    ],
    reason: '新商贸协议',
  });
  vi.mocked(fetchTrade).mockResolvedValue({
    ...data,
    canEdit: false,
    mapRevision: 8,
  });
  fireEvent.click(screen.getByRole('button', { name: '取消贸易区编辑' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '编辑贸易区' }),
    ).not.toBeInTheDocument(),
  );
  expect(await screen.findByText(/准备阶段可修改贸易区/)).toBeInTheDocument();
});
it('shows only own influence and published calculation sources, with actual corrections clearly separated', async () => {
  vi.mocked(fetchTrade).mockResolvedValue(own);
  render(
    <TradePanel game={{ ...game, role: 'Player' }} countryId="north" active />,
  );
  fireEvent.click(screen.getByText('贸易', { exact: true }));
  expect(
    await screen.findByText('第 1 年 春季 · 实际收入 50'),
  ).toBeInTheDocument();
  expect(screen.getByText('计算额 60，修正原因：临时封锁')).toBeInTheDocument();
  expect(screen.getByText('计算来源')).toBeInTheDocument();
  expect(screen.queryByText('南国')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '新增贸易区' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /查看贸易区/ }),
  ).not.toBeInTheDocument();
});
it('ignores an old country response arriving after the selected country changes', async () => {
  let resolveOld!: (data: TradeData) => void;
  vi.mocked(fetchTrade)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
    )
    .mockResolvedValueOnce({
      ...own,
      lastIncome: {
        ...own.lastIncome!,
        actualIncome: 40,
        calculatedIncome: 40,
        adjustmentReason: '',
      },
    });
  const view = render(
    <TradePanel game={{ ...game, role: 'Player' }} countryId="north" active />,
  );
  fireEvent.click(screen.getByText('贸易', { exact: true }));
  await waitFor(() => expect(fetchTrade).toHaveBeenCalledOnce());
  view.rerender(
    <TradePanel game={{ ...game, role: 'Player' }} countryId="south" active />,
  );
  expect(
    await screen.findByText('第 1 年 春季 · 实际收入 40'),
  ).toBeInTheDocument();
  await act(async () => resolveOld(own));
  expect(
    screen.queryByText('第 1 年 春季 · 实际收入 50'),
  ).not.toBeInTheDocument();
});
