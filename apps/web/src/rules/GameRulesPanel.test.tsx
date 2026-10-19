import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GameRulesData } from '@srilanka/contracts';

import { fetchGameRules, saveGameRules } from '../api.js';
import { GameRulesPanel } from './GameRulesPanel.js';

vi.mock('../api.js', () => ({
  fetchGameRules: vi.fn(),
  saveGameRules: vi.fn(),
}));

const rules: GameRulesData = {
  quarterId: '00000000-0000-4000-8000-000000000001',
  version: 1,
  scenario: {
    title: '',
    playerPerspective: 'Flexible',
    premise: '',
    commonRules: '',
  },
  quarter: { briefing: '', actionGuidelines: '', suggestedLimits: [] },
};

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('scenario and round rules', () => {
  it('lets the host review the national scenario and optional allowances before saving', async () => {
    const onSaved = vi.fn();
    vi.mocked(saveGameRules).mockImplementation(async (_id, input) => ({
      ...input,
      version: 2,
    }));
    render(
      <GameRulesPanel
        gameId="game"
        rules={rules}
        canManage
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '使用国家战略模板' }));
    expect(screen.getByLabelText('玩家扮演主体')).toHaveValue('CountryWill');
    expect(saveGameRules).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('添加建议额度'), {
      target: { value: 'Exploration' },
    });
    fireEvent.change(screen.getByLabelText('探索建议额度'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('剧本名称'), {
      target: { value: '群岛争霸' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saveGameRules).toHaveBeenCalledWith(
      'game',
      expect.objectContaining({
        version: 1,
        quarterId: rules.quarterId,
        scenario: expect.objectContaining({
          title: '群岛争霸',
          playerPerspective: 'CountryWill',
        }),
        quarter: expect.objectContaining({
          suggestedLimits: [{ category: 'Exploration', limit: 2 }],
        }),
      }),
    );
  });

  it('shows shared rules to players without editor controls', () => {
    render(
      <GameRulesPanel
        gameId="game"
        rules={{
          ...rules,
          scenario: {
            ...rules.scenario,
            title: '群岛争霸',
            commonRules: '主持人统一结算。',
          },
        }}
        canManage={false}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getByText('主持人统一结算。')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存' }),
    ).not.toBeInTheDocument();
  });

  it('preserves unsaved writing after a conflict and lets the host explicitly reload', async () => {
    vi.mocked(saveGameRules).mockRejectedValue(
      new Error('规则已被其他窗口修改'),
    );
    vi.mocked(fetchGameRules).mockResolvedValue({
      ...rules,
      version: 2,
      scenario: { ...rules.scenario, title: '已保存标题' },
    });
    render(
      <GameRulesPanel
        gameId="game"
        rules={rules}
        canManage
        onSaved={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('剧本名称'), {
      target: { value: '保留我的修改' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '规则已被其他窗口修改',
    );
    expect(screen.getByLabelText('剧本名称')).toHaveValue('保留我的修改');
    fireEvent.click(screen.getByRole('button', { name: '放弃修改并刷新' }));
    await waitFor(() =>
      expect(screen.getByLabelText('剧本名称')).toHaveValue('已保存标题'),
    );
  });
});
