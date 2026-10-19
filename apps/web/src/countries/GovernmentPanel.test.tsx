import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { GovernmentData, GameSummary } from '@srilanka/contracts';
import {
  fetchGovernment,
  setupGovernment,
  fetchNationalStatus,
} from '../api.js';
import { GovernmentPanel } from './GovernmentPanel.js';
import { CountryPanel } from './CountryPanel.js';
vi.mock('../api.js', () => ({
  fetchGovernment: vi.fn(),
  setupGovernment: vi.fn(),
  fetchNationalStatus: vi.fn(),
}));
const game: GameSummary = {
  id: 'game',
  name: '诸国',
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
const data: GovernmentData = {
  revision: 3,
  quarter: { gameYear: 1, season: 'Spring', sequenceNumber: 1 },
  canEdit: true,
  countries: [
    { id: 'north', name: '北国' },
    { id: 'south', name: '南国' },
  ],
  profiles: [
    {
      countryId: 'north',
      countryName: '北国',
      regime: '君主制',
      authority: '北王',
      description: '',
    },
    {
      countryId: 'south',
      countryName: '南国',
      regime: '共和制',
      authority: '南国议会',
      description: '',
    },
  ],
  policies: [],
  lastBill: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchGovernment).mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
it('loads on demand, locks the country selector and retains failed opening edits across tabs', async () => {
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    canSetBalances: true,
    countries: ['north', 'south'].map((id) => ({
      id,
      name: id === 'north' ? '北国' : '南国',
      mapColor: '#000',
      treasury: 100,
      manpower: 0,
      resourceRevision: 1,
      controlledTileCount: 0,
      legalTileCount: 0,
      cities: [],
      armies: [],
    })),
  });
  vi.mocked(setupGovernment).mockRejectedValue(new Error('行政资料已变化'));
  const view = render(<CountryPanel game={game} active />);
  await screen.findByText('北国', { selector: 'h4' });
  expect(fetchGovernment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('政府与长期政策', { exact: true }));
  fireEvent.click(
    await screen.findByRole('button', { name: '设置政府与开场政策' }),
  );
  expect(screen.getByLabelText('查看国家')).toBeDisabled();
  change('政体', '共和国');
  change('行政变化原因', '建立议会');
  fireEvent.click(screen.getByRole('button', { name: '添加行政变化' }));
  fireEvent.click(screen.getByRole('button', { name: '保存行政设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('行政资料已变化');
  const input = vi.mocked(setupGovernment).mock.calls[0]![1][0]!;
  expect(input).toMatchObject({
    countryId: 'north',
    expectedRevision: 3,
    regime: '共和国',
  });
  expect(input).not.toHaveProperty('before');
  view.rerender(<CountryPanel game={game} active={false} />);
  view.rerender(<CountryPanel game={game} active />);
  expect(
    screen.getByRole('button', { name: '保存行政设置' }),
  ).toBeInTheDocument();
  expect(fetchGovernment).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '取消行政设置' }));
  await waitFor(() => expect(screen.getByLabelText('查看国家')).toBeEnabled());
});
it('discards a late response from the previously selected country', async () => {
  let resolve!: (value: GovernmentData) => void;
  vi.mocked(fetchGovernment)
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce({ ...data, profiles: [data.profiles[1]!] });
  const view = render(<GovernmentPanel game={game} active countryId="north" />);
  fireEvent.click(screen.getByText('政府与长期政策', { exact: true }));
  await waitFor(() => expect(fetchGovernment).toHaveBeenCalledOnce());
  view.rerender(<GovernmentPanel game={game} active countryId="south" />);
  expect(
    await screen.findByText('统治者或执政机构：南国议会'),
  ).toBeInTheDocument();
  await act(async () => resolve({ ...data, profiles: [data.profiles[0]!] }));
  expect(screen.queryByText('统治者或执政机构：北王')).not.toBeInTheDocument();
});
it('shows player policy status and original versus corrected amounts without setup controls', async () => {
  vi.mocked(fetchGovernment).mockResolvedValue({
    ...data,
    canEdit: false,
    countries: undefined,
    profiles: [data.profiles[0]!],
    policies: [
      {
        id: 'p',
        countryId: 'north',
        countryName: '北国',
        title: '旧减税',
        type: 'Policy',
        text: '税收减少',
        effects: { Tax: -10 },
        startsAt: data.quarter,
        expiresAt: data.quarter,
        endedAt: null,
      },
    ],
    lastBill: {
      quarter: data.quarter,
      capturedAt: '2026-10-13T00:00:00Z',
      lines: [
        {
          kind: 'Tax',
          baseAmount: 68,
          calculatedAmount: 61.2,
          actualAmount: 60,
          adjustmentReason: '灾害',
          policyEffects: [{ policyId: 'p', title: '旧减税', percent: -10 }],
        },
      ],
    },
  });
  render(
    <GovernmentPanel
      game={{ ...game, role: 'Player' }}
      active
      countryId="north"
    />,
  );
  fireEvent.click(screen.getByText('政府与长期政策', { exact: true }));
  expect(await screen.findByText('旧减税 · 已到期')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '设置政府与开场政策' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText(/最近一季政策与经济结果/));
  expect(screen.getByText('+61.2')).toBeInTheDocument();
  expect(screen.getByText('灾害')).toBeInTheDocument();
  expect(screen.getByText('旧减税 -10%')).toBeInTheDocument();
});
