import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { GameSummary, DiplomacyData } from '@srilanka/contracts';
import { fetchDiplomacy, setupDiplomacy } from '../api.js';
import { DiplomacyPanel } from './DiplomacyPanel.js';
vi.mock('../api.js', () => ({
  fetchDiplomacy: vi.fn(),
  setupDiplomacy: vi.fn(),
}));
const game: GameSummary = {
  id: 'game',
  name: '诸国',
  status: 'Running',
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
const data: DiplomacyData = {
  revision: 3,
  quarter: { gameYear: 1, season: 'Spring', sequenceNumber: 1 },
  canEdit: true,
  countries: [
    { id: 'north', name: '北国' },
    { id: 'south', name: '南国' },
  ],
  relations: [],
  treaties: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchDiplomacy).mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);
it('loads only when opened and retains failed setup plans and their revision across tabs', async () => {
  vi.mocked(setupDiplomacy).mockRejectedValue(new Error('外交资料已变化'));
  const view = render(<DiplomacyPanel game={game} active />);
  expect(fetchDiplomacy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('外交', { exact: true }));
  fireEvent.click(await screen.findByRole('button', { name: '设置外交状态' }));
  fireEvent.change(screen.getByLabelText('国家一'), {
    target: { value: 'north' },
  });
  fireEvent.change(screen.getByLabelText('国家二'), {
    target: { value: 'south' },
  });
  fireEvent.change(screen.getByLabelText('外交变化原因'), {
    target: { value: '边境争端' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  fireEvent.click(screen.getByRole('button', { name: '保存外交设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('外交资料已变化');
  const request = vi.mocked(setupDiplomacy).mock.calls[0]![1][0]!;
  expect(request).toMatchObject({
    expectedRevision: 3,
    kind: 'WarStatus',
    reason: '边境争端',
  });
  expect(request).not.toHaveProperty('summary');
  expect(request).not.toHaveProperty('after');
  view.rerender(<DiplomacyPanel game={game} active={false} />);
  view.rerender(<DiplomacyPanel game={game} active />);
  expect(screen.getByText('北国 ↔ 南国：和平 → 交战')).toBeInTheDocument();
  expect(fetchDiplomacy).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '取消外交设置' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '保存外交设置' }),
    ).not.toBeInTheDocument(),
  );
});
it('shows public diplomacy for observers without setup controls, with expired treaties clearly marked', async () => {
  vi.mocked(fetchDiplomacy).mockResolvedValue({
    ...data,
    canEdit: false,
    countries: undefined,
    treaties: [
      {
        id: 't',
        title: '独立保障协议',
        type: 'Guarantee',
        countryIds: ['north', 'south'],
        countryNames: ['北国', '南国'],
        terms: '北国保障南国独立',
        visibility: 'Public',
        grantorCountryId: 'north',
        startQuarter: data.quarter,
        updatedQuarter: data.quarter,
        expiresAt: data.quarter,
        endedAt: null,
      },
    ],
  });
  render(<DiplomacyPanel game={{ ...game, role: 'Observer' }} active />);
  fireEvent.click(screen.getByText('外交', { exact: true }));
  fireEvent.click(
    await screen.findByText('独立保障协议 · 独立保障 · 已到期 · 公开'),
  );
  expect(screen.getByText('保障方向：北国 → 南国')).toBeInTheDocument();
  expect(screen.getByText('北国保障南国独立')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '设置外交状态' }),
  ).not.toBeInTheDocument();
});
