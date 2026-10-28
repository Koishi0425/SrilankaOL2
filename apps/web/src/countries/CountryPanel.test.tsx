import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GameSummary, NationalStatus } from '@srilanka/contracts';
import {
  fetchCountryLedger,
  fetchNationalStatus,
  setCountryBalances,
  fetchDiplomacy,
} from '../api.js';
import { CountryPanel } from './CountryPanel.js';
vi.mock('../api.js', () => ({
  fetchCountryLedger: vi.fn(),
  fetchNationalStatus: vi.fn(),
  setCountryBalances: vi.fn(),
  fetchDiplomacy: vi.fn(),
}));
const game: GameSummary = {
  id: 'game',
  name: '国家',
  status: 'Preparing',
  role: 'Host',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'Preparing',
    actionDeadline: null,
    currentWorldVersion: 0,
  },
};
const status: NationalStatus = {
  canSetBalances: true,
  countries: [
    {
      id: 'north',
      name: '北国',
      mapColor: '#000000',
      treasury: 100,
      manpower: 1000,
      resourceRevision: 3,
      controlledTileCount: 2,
      legalTileCount: 2,
      cities: [{ id: 'city', name: '都城', q: 0, r: 0 }],
      armies: [{ id: 'army', name: '第一军', q: 0, r: 0, strength: 200 }],
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchNationalStatus).mockResolvedValue(structuredClone(status));
});
afterEach(cleanup);

it('replaces initial placeholders with data and retains the data during a refresh', async () => {
  let resolve!: (data: NationalStatus) => void;
  vi.mocked(fetchNationalStatus).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<CountryPanel game={game} active />);
  expect(
    screen.getByRole('status', { name: '正在读取国家资料…' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('尚未分配国家。')).not.toBeInTheDocument();
  resolve(structuredClone(status));
  await screen.findByRole('heading', { name: '北国' });
  vi.mocked(fetchNationalStatus).mockReturnValueOnce(new Promise(() => {}));
  fireEvent.click(screen.getByRole('button', { name: '刷新' }));
  expect(screen.getByRole('heading', { name: '北国' })).toBeInTheDocument();
  expect(
    screen.queryByRole('status', { name: '正在读取国家资料…' }),
  ).not.toBeInTheDocument();
});

it('stops showing a placeholder when the initial national request fails', async () => {
  vi.mocked(fetchNationalStatus).mockRejectedValue(
    new Error('国家资料连接失败'),
  );
  render(<CountryPanel game={game} active />);
  await screen.findByText('国家资料连接失败');
  expect(
    screen.queryByRole('status', { name: '正在读取国家资料…' }),
  ).not.toBeInTheDocument();
});

it('lets observers open public diplomacy while no private national controls or balances are present', async () => {
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    countries: [],
    canSetBalances: false,
  });
  vi.mocked(fetchDiplomacy).mockResolvedValue({
    revision: 0,
    canEdit: false,
    quarter: { gameYear: 1, season: 'Spring', sequenceNumber: 1 },
    relations: [
      {
        countryIds: ['north', 'south'],
        countryNames: ['北国', '南国'],
        state: 'War',
        effectiveQuarter: { gameYear: 1, season: 'Spring', sequenceNumber: 1 },
        reason: '公开宣战',
      },
    ],
    treaties: [],
  });
  render(<CountryPanel game={{ ...game, role: 'Observer' }} active />);
  await waitFor(() =>
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument(),
  );
  expect(screen.queryByText('国库')).not.toBeInTheDocument();
  expect(screen.queryByText('人力')).not.toBeInTheDocument();
  expect(screen.queryByText('尚未分配国家。')).not.toBeInTheDocument();
  fireEvent.click(screen.getByText('外交', { exact: true }));
  expect(await screen.findByText('公开宣战')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '设置外交状态' }),
  ).not.toBeInTheDocument();
  expect(fetchCountryLedger).not.toHaveBeenCalled();
});
it('retains a failed balance form and its revision across tab switches until saved', async () => {
  vi.mocked(setCountryBalances)
    .mockRejectedValueOnce(new Error('余额已变化'))
    .mockResolvedValueOnce({
      ...status,
      countries: [
        { ...status.countries[0]!, treasury: 500, resourceRevision: 4 },
      ],
    });
  const view = render(<CountryPanel game={game} active />);
  fireEvent.click(await screen.findByRole('button', { name: '设置余额' }));
  fireEvent.change(screen.getByLabelText('国库余额'), {
    target: { value: '500' },
  });
  fireEvent.change(screen.getByLabelText('设置原因'), {
    target: { value: '开场设置' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存余额' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('余额已变化');
  view.rerender(<CountryPanel game={game} active={false} />);
  view.rerender(<CountryPanel game={game} active />);
  expect(screen.getByLabelText('国库余额')).toHaveValue(500);
  expect(fetchNationalStatus).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: '保存余额' }));
  await waitFor(() =>
    expect(screen.queryByLabelText('国库余额')).not.toBeInTheDocument(),
  );
  expect(setCountryBalances).toHaveBeenLastCalledWith('game', 'north', {
    expectedRevision: 3,
    treasury: 500,
    manpower: 1000,
    reason: '开场设置',
  });
});
it('shows own military truth and paginates private ledger without exposing setup controls', async () => {
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    ...status,
    canSetBalances: false,
  });
  const entry = {
    id: '10',
    kind: 'Settlement' as const,
    quarterId: 'quarter',
    gameYear: 1,
    season: 'Spring' as const,
    resource: 'Treasury' as const,
    amount: -20,
    before: 120,
    after: 100,
    reason: '本国建设',
    createdAt: '2026-10-12T00:00:00Z',
  };
  vi.mocked(fetchCountryLedger)
    .mockResolvedValueOnce({ entries: [entry], nextCursor: '10' })
    .mockResolvedValueOnce({
      entries: [
        {
          ...entry,
          id: '9',
          reason: '本国税收',
          amount: 20,
          before: 100,
          after: 120,
        },
      ],
      nextCursor: null,
    });
  render(<CountryPanel game={{ ...game, role: 'Player' }} active />);
  await screen.findByText('第一军');
  expect(screen.getByText('都城（0，0）')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '设置余额' }),
  ).not.toBeInTheDocument();
  expect(fetchCountryLedger).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('资源账目'));
  await screen.findByText('本国建设');
  fireEvent.click(screen.getByRole('button', { name: '更早账目' }));
  await screen.findByText('本国税收');
  expect(fetchCountryLedger).toHaveBeenLastCalledWith('game', 'north', '10');
  expect(screen.getByText('本国建设')).toBeInTheDocument();
});
