import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EconomicSetupPreview } from '@srilanka/contracts';
import { previewEconomicSetup, saveOpeningEconomy } from '../api.js';
import { OpeningBalancePanel } from './OpeningBalancePanel.js';
import { openingUnitRules } from './opening-economy.js';

vi.mock('../api.js', () => ({
  previewEconomicSetup: vi.fn(),
  saveOpeningEconomy: vi.fn(),
}));
const data: EconomicSetupPreview = {
  quarterId: 'q',
  preparationRevision: 'initial-revision',
  rules: { ...openingUnitRules, enabled: false },
  rulesVersion: 0,
  worldVersion: 1,
  unconfiguredProvinceCount: 0,
  countries: ['北国', '南国'].map((name, index) => ({
    id: `country-${index}`,
    name,
    treasury: 100,
    manpower: 500,
    resourceRevision: 0,
    armyStrength: 1000,
    lines: [],
  })),
};
const options = () => ({
  gameId: 'game',
  active: true,
  disabled: false,
  onDirtyChange: vi.fn(),
  onSaved: vi.fn(),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(previewEconomicSetup).mockImplementation(async (_game, rules) => ({
    ...structuredClone(data),
    rules: rules ?? data.rules,
  }));
  vi.mocked(saveOpeningEconomy).mockImplementation(async (_game, input) => ({
    ...structuredClone(data),
    preparationRevision: 'saved',
    rules: input.rules,
    countries: data.countries.map((country) => ({
      ...country,
      ...input.countries.find((next) => next.id === country.id),
    })),
  }));
});
afterEach(cleanup);
async function open() {
  fireEvent.click(screen.getByRole('button', { name: '开局资源与平衡试算' }));
  await screen.findByLabelText('北国 初始国库');
}

it('loads only when opened and treats server rule field ordering as unchanged', async () => {
  render(<OpeningBalancePanel {...options()} />);
  expect(previewEconomicSetup).not.toHaveBeenCalled();
  await open();
  expect(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  ).toBeDisabled();
  expect(saveOpeningEconomy).not.toHaveBeenCalled();
});

it('fills a shared budget as a draft and saves all countries in one explicit request', async () => {
  const props = options();
  render(<OpeningBalancePanel {...props} />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: '填入各国资源草稿' }));
  expect(screen.getByLabelText('北国 初始国库')).toHaveValue(400);
  expect(screen.getByLabelText('南国 初始人力')).toHaveValue(1000);
  expect(saveOpeningEconomy).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('南国 初始国库'), {
    target: { value: '450' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  );
  await screen.findByText('已一次保存各国初始资源和经济规则。');
  expect(saveOpeningEconomy).toHaveBeenCalledTimes(1);
  expect(saveOpeningEconomy).toHaveBeenCalledWith(
    'game',
    expect.objectContaining({
      expectedPreparationRevision: 'initial-revision',
      countries: [
        { id: 'country-0', treasury: 400, manpower: 1000 },
        { id: 'country-1', treasury: 450, manpower: 1000 },
      ],
    }),
  );
  expect(props.onSaved).toHaveBeenCalledTimes(1);
});

it('requires a new preview after coefficient edits, and never saves the generated reference automatically', async () => {
  render(<OpeningBalancePanel {...options()} />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: '生成参考经济方案' }));
  await screen.findByText(/已将参考经济系数放入草稿/);
  expect(screen.getByLabelText('启用每季自动经济')).toBeChecked();
  expect(saveOpeningEconomy).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('税收系数'), {
    target: { value: '2' },
  });
  expect(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '更新收支试算' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '保存各国资源与经济规则' }),
    ).toBeEnabled(),
  );
});

it('preserves unsaved budgets across workspace navigation and a failed save', async () => {
  const props = options();
  const page = render(<OpeningBalancePanel {...props} />);
  await open();
  fireEvent.change(screen.getByLabelText('北国 初始国库'), {
    target: { value: '321' },
  });
  page.rerender(<OpeningBalancePanel {...props} active={false} />);
  page.rerender(<OpeningBalancePanel {...props} />);
  expect(screen.getByLabelText('北国 初始国库')).toHaveValue(321);
  expect(previewEconomicSetup).toHaveBeenCalledTimes(1);
  vi.mocked(saveOpeningEconomy).mockRejectedValueOnce(
    new Error('准备内容已变化'),
  );
  fireEvent.click(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  );
  await screen.findByRole('alert');
  expect(screen.getByLabelText('北国 初始国库')).toHaveValue(321);
  expect(props.onDirtyChange).toHaveBeenLastCalledWith(true);
});

it('does not attach a newly read revision to an older dirty budget', async () => {
  render(<OpeningBalancePanel {...options()} />);
  await open();
  fireEvent.change(screen.getByLabelText('北国 初始国库'), {
    target: { value: '321' },
  });
  vi.mocked(previewEconomicSetup).mockResolvedValueOnce({
    ...data,
    preparationRevision: 'changed-by-another-window',
  });
  fireEvent.click(screen.getByRole('button', { name: '更新收支试算' }));
  await screen.findByText(/不会用新版本号覆盖旧草稿/);
  expect(screen.getByLabelText('北国 初始国库')).toHaveValue(321);
  expect(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  ).toBeDisabled();
  expect(saveOpeningEconomy).not.toHaveBeenCalled();
});

it('previews blank-province reference values and includes them only in an explicit save', async () => {
  vi.mocked(previewEconomicSetup).mockImplementation(async (_game, rules) => ({
    ...structuredClone(data),
    rules: rules ?? data.rules,
    unconfiguredProvinceCount: 3,
  }));
  render(<OpeningBalancePanel {...options()} />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: '生成参考经济方案' }));
  await screen.findByText(/已将参考经济系数放入草稿/);
  expect(screen.getByLabelText(/为空白省份采用参考产出/)).toBeChecked();
  expect(screen.getByText(/保存时将补齐 3 个/)).toBeInTheDocument();
  expect(vi.mocked(previewEconomicSetup).mock.calls.at(-1)![3]).toBe(true);
  expect(saveOpeningEconomy).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  );
  await waitFor(() => expect(saveOpeningEconomy).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(saveOpeningEconomy).mock.calls[0]![1].seedBlankProvinces,
  ).toBe(true);
});

it('allows opting out of reference province values and requires recalculation', async () => {
  render(<OpeningBalancePanel {...options()} />);
  await open();
  fireEvent.click(screen.getByRole('button', { name: '生成参考经济方案' }));
  await screen.findByText(/已将参考经济系数放入草稿/);
  fireEvent.click(screen.getByLabelText(/为空白省份采用参考产出/));
  expect(
    screen.getByRole('button', { name: '保存各国资源与经济规则' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '更新收支试算' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '保存各国资源与经济规则' }),
    ).toBeEnabled(),
  );
  expect(vi.mocked(previewEconomicSetup).mock.calls.at(-1)![3]).toBe(false);
});
