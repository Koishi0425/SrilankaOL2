import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fetchEconomicRules, saveEconomicRules } from '../api.js';
import { EconomicRulesPanel } from './EconomicRulesPanel.js';
vi.mock('../api.js', () => ({
  fetchEconomicRules: vi.fn(),
  saveEconomicRules: vi.fn(),
}));
const data = {
  version: 2,
  canEdit: true,
  rules: {
    enabled: false,
    taxCoefficient: 0,
    productionCoefficient: 0,
    manpowerCoefficient: 0,
    armyMaintenancePer100: 0,
    administrationCost: 0,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchEconomicRules).mockResolvedValue(data);
});
afterEach(cleanup);
it('reads shared coefficients only when opened and hides editing from players', async () => {
  render(<EconomicRulesPanel gameId="game" active canManage={false} />);
  expect(fetchEconomicRules).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('经济规则'));
  expect(await screen.findByText('每季经济结算：未启用')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '设置经济规则' }),
  ).not.toBeInTheDocument();
});
it('keeps failed edits and their original revision across tabs, then refreshes phase permissions on cancel', async () => {
  vi.mocked(saveEconomicRules).mockRejectedValue(new Error('规则已更新'));
  const view = render(<EconomicRulesPanel gameId="game" active canManage />);
  fireEvent.click(screen.getByText('经济规则'));
  fireEvent.click(await screen.findByRole('button', { name: '设置经济规则' }));
  fireEvent.click(screen.getByLabelText('启用每季经济结算'));
  fireEvent.change(screen.getByLabelText('税收系数'), {
    target: { value: '10' },
  });
  fireEvent.change(screen.getByLabelText('修改原因'), {
    target: { value: '采用简化经济' },
  });
  view.rerender(<EconomicRulesPanel gameId="game" active={false} canManage />);
  view.rerender(<EconomicRulesPanel gameId="game" active canManage />);
  expect(screen.getByLabelText('税收系数')).toHaveValue(10);
  fireEvent.click(screen.getByRole('button', { name: '保存经济规则' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('规则已更新');
  expect(saveEconomicRules).toHaveBeenCalledWith('game', {
    rules: {
      ...data.rules,
      enabled: true,
      taxCoefficient: 10,
      tradeCoefficient: 0,
    },
    expectedVersion: 2,
    reason: '采用简化经济',
  });
  expect(screen.getByLabelText('税收系数')).toHaveValue(10);
  vi.mocked(fetchEconomicRules).mockResolvedValue({
    ...data,
    version: 3,
    canEdit: false,
  });
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '设置经济规则' }),
    ).not.toBeInTheDocument(),
  );
  expect(await screen.findByText(/下回合准备阶段可修改/)).toBeInTheDocument();
});
