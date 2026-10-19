import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantInput, AssistantResult } from '@srilanka/contracts';
import {
  configureAssistant,
  fetchAssistantStatus,
  generateAssistantResult,
} from '../api.js';
import { AssistantPanel, AssistantSettings } from './AssistantPanel.js';

vi.mock('../api.js', () => ({
  configureAssistant: vi.fn(),
  fetchAssistantStatus: vi.fn(),
  generateAssistantResult: vi.fn(),
}));
const input: Omit<AssistantInput, 'length' | 'ruling'> = {
  purpose: 'Digest',
  quarterId: 'quarter',
  expectedVersion: 2,
  expectedCorrectionVersion: 0,
};
const result: AssistantResult = {
  purpose: 'Digest',
  answer: {
    overview: '探索未完成。',
    highlights: [{ text: '未发现新资源。', sourceIds: ['report'] }],
    notices: [],
    draft: null,
  },
  sources: [
    { id: 'report', label: '回合公告', text: '探索受阻，没有发现资源。' },
  ],
  resourceTotals: [
    { countryName: '河国', resource: 'Treasury', amount: -20.5 },
  ],
  generatedAt: '2026-10-19T00:00:00Z',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchAssistantStatus).mockResolvedValue({
    configured: true,
    enabled: true,
    canManage: true,
    provider: 'GLM',
  });
  vi.mocked(generateAssistantResult).mockResolvedValue(structuredClone(result));
});
afterEach(cleanup);

describe('compact settlement assistance', () => {
  it('does not load or generate until requested, then shows short results, exact totals and original sources', async () => {
    render(<AssistantPanel gameId="game" input={input} contextKey="v2" />);
    expect(fetchAssistantStatus).not.toHaveBeenCalled();
    expect(generateAssistantResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '结算速览' }));
    await screen.findByRole('button', { name: '生成速览' });
    expect(generateAssistantResult).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('篇幅'), {
      target: { value: 'Brief' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成速览' }));
    await screen.findByText('探索未完成。');
    expect(generateAssistantResult).toHaveBeenCalledWith(
      'game',
      { ...input, length: 'Brief' },
      expect.any(AbortSignal),
    );
    expect(screen.getByText('-20.5')).toBeInTheDocument();
    expect(screen.getByText('核对原文')).toBeInTheDocument();
    expect(screen.getByText('探索受阻，没有发现资源。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '填入反馈' })).toBeNull();
  });
  it('requires a host ruling and an explicit adoption without submitting or publishing', async () => {
    const adopt = vi.fn();
    vi.mocked(generateAssistantResult).mockResolvedValue({
      ...result,
      purpose: 'Feedback',
      answer: { ...result.answer, draft: '山路受阻，探索队返回。' },
    });
    render(
      <AssistantPanel
        gameId="game"
        input={{ ...input, purpose: 'Feedback', actionId: 'policy' }}
        contextKey="original"
        onAdopt={adopt}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '起草反馈' }));
    const generate = await screen.findByRole('button', {
      name: '生成反馈草稿',
    });
    expect(generate).toBeDisabled();
    fireEvent.change(screen.getByLabelText('主持人已定结果'), {
      target: { value: '探索失败，全员返回。' },
    });
    fireEvent.click(generate);
    await screen.findByLabelText('反馈草稿');
    expect(adopt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '填入反馈' }));
    expect(adopt).toHaveBeenCalledExactlyOnceWith('山路受阻，探索队返回。');
    expect(screen.getByRole('status')).toHaveTextContent('尚未保存');
  });
  it('keeps newer edits when generation finishes after the editor changed', async () => {
    let finish!: (value: AssistantResult) => void;
    vi.mocked(generateAssistantResult).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const adopt = vi.fn();
    const props = {
      gameId: 'game',
      input: { ...input, purpose: 'Feedback' as const, actionId: 'policy' },
      onAdopt: adopt,
    };
    const view = render(<AssistantPanel {...props} contextKey="old" />);
    fireEvent.click(screen.getByRole('button', { name: '起草反馈' }));
    await screen.findByLabelText('主持人已定结果');
    fireEvent.change(screen.getByLabelText('主持人已定结果'), {
      target: { value: '探索失败' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));
    view.rerender(<AssistantPanel {...props} contextKey="new edit" />);
    finish({
      ...result,
      purpose: 'Feedback',
      answer: { ...result.answer, draft: '旧草稿' },
    });
    await screen.findByText('资料或输入已变化，请重新生成。此内容仅供核对。');
    expect(screen.getByRole('button', { name: '填入反馈' })).toBeDisabled();
    expect(adopt).not.toHaveBeenCalled();
  });
  it('reports failure, keeps manual input, and does not retry automatically', async () => {
    vi.mocked(generateAssistantResult).mockRejectedValue(
      new Error('模型服务超时'),
    );
    render(
      <AssistantPanel
        gameId="game"
        input={{ ...input, purpose: 'Feedback', actionId: 'policy' }}
        contextKey="old"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '起草反馈' }));
    await screen.findByLabelText('主持人已定结果');
    fireEvent.change(screen.getByLabelText('主持人已定结果'), {
      target: { value: '保留裁定内容' },
    });
    fireEvent.click(screen.getByRole('button', { name: '生成反馈草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('模型服务超时');
    expect(screen.getByLabelText('主持人已定结果')).toHaveValue('保留裁定内容');
    expect(generateAssistantResult).toHaveBeenCalledTimes(1);
  });
  it('blocks generation until changed settlement plans have been saved', async () => {
    render(
      <AssistantPanel
        gameId="game"
        input={{ ...input, purpose: 'Feedback', actionId: 'policy' }}
        contextKey="unsaved"
        disabled
        disabledReason="请先保存结算。"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '起草反馈' }));
    await screen.findByLabelText('主持人已定结果');
    fireEvent.change(screen.getByLabelText('主持人已定结果'), {
      target: { value: '探索完成' },
    });
    expect(screen.getByRole('button', { name: '生成反馈草稿' })).toBeDisabled();
    expect(screen.getByText('请先保存结算。')).toBeInTheDocument();
  });
  it('renders model content as text and cannot execute model markup', async () => {
    vi.mocked(generateAssistantResult).mockResolvedValue({
      ...result,
      answer: { ...result.answer, overview: '<script>publish()</script>' },
    });
    const view = render(
      <AssistantPanel gameId="game" input={input} contextKey="v2" />,
    );
    fireEvent.click(screen.getByRole('button', { name: '结算速览' }));
    fireEvent.click(await screen.findByRole('button', { name: '生成速览' }));
    await screen.findByText('<script>publish()</script>');
    expect(view.container.querySelector('script')).toBeNull();
  });
  it('lets a host enable the game only after inspecting service status', async () => {
    vi.mocked(fetchAssistantStatus).mockResolvedValue({
      configured: true,
      enabled: false,
      canManage: true,
      provider: 'DeepSeek',
    });
    vi.mocked(configureAssistant).mockResolvedValue({
      configured: true,
      enabled: true,
      canManage: true,
      provider: 'DeepSeek',
    });
    render(<AssistantSettings gameId="game" />);
    expect(fetchAssistantStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '模型辅助设置' }));
    fireEvent.click(
      await screen.findByRole('button', { name: '开启本局辅助' }),
    );
    await waitFor(() =>
      expect(configureAssistant).toHaveBeenCalledWith('game', true, false),
    );
    await screen.findByRole('button', { name: '关闭本局辅助' });
  });
});
