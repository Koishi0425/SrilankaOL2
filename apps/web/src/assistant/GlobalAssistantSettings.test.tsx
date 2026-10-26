import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GlobalAssistantSettings as Settings } from '@srilanka/contracts';
import {
  fetchGlobalAssistantSettings,
  saveGlobalAssistantSettings,
  testGlobalAssistantConnection,
} from '../api.js';
import { GlobalAssistantSettings } from './GlobalAssistantSettings.js';

vi.mock('../api.js', () => ({
  fetchGlobalAssistantSettings: vi.fn(),
  saveGlobalAssistantSettings: vi.fn(),
  testGlobalAssistantConnection: vi.fn(),
}));
const saved: Settings = {
  revision: 1,
  enabled: true,
  configured: true,
  provider: 'compatible',
  baseUrl: 'https://example.test/v1',
  model: 'shared-model',
  hasApiKey: true,
  jsonMode: true,
  disableThinking: false,
  timeoutMs: 60000,
  source: 'Database',
  updatedAt: '2026-10-26T00:00:00Z',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchGlobalAssistantSettings).mockResolvedValue({ ...saved });
  vi.mocked(saveGlobalAssistantSettings).mockResolvedValue({
    ...saved,
    revision: 2,
  });
  vi.mocked(testGlobalAssistantConnection).mockResolvedValue({
    provider: '兼容服务',
    model: 'shared-model',
    latencyMs: 250,
  });
});
afterEach(cleanup);

it('never pre-fills a stored key and preserves it when changing only the model', async () => {
  render(<GlobalAssistantSettings onClose={vi.fn()} />);
  const key = await screen.findByLabelText('API Key');
  expect(key).toHaveValue('');
  fireEvent.change(screen.getByLabelText('模型名称'), {
    target: { value: 'new-model' },
  });
  expect(
    screen.getByRole('button', { name: '测试已保存的连接' }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '保存全局设置' }));
  await screen.findByRole('status');
  expect(saveGlobalAssistantSettings).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRevision: 1, model: 'new-model' }),
  );
  expect(
    vi.mocked(saveGlobalAssistantSettings).mock.calls[0]![0],
  ).not.toHaveProperty('apiKey');
});

it('clears a newly supplied key after saving and explicitly tests saved settings', async () => {
  render(<GlobalAssistantSettings onClose={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('API Key'), {
    target: { value: 'new-private-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存全局设置' }));
  await screen.findByText(/全站玩家立即共用/);
  expect(screen.getByLabelText('API Key')).toHaveValue('');
  expect(saveGlobalAssistantSettings).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: 'new-private-key' }),
  );
  expect(testGlobalAssistantConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '测试已保存的连接' }));
  await screen.findByText(/连接成功/);
  expect(testGlobalAssistantConnection).toHaveBeenCalledTimes(1);
});

it('keeps unsaved values and does not retry automatically after a conflict', async () => {
  vi.mocked(saveGlobalAssistantSettings).mockRejectedValue(
    new Error('配置已被更新，请重新读取。'),
  );
  render(<GlobalAssistantSettings onClose={vi.fn()} />);
  fireEvent.change(await screen.findByLabelText('API Key'), {
    target: { value: 'private-new-key' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存全局设置' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('重新读取');
  expect(screen.getByLabelText('API Key')).toHaveValue('private-new-key');
  await waitFor(() =>
    expect(saveGlobalAssistantSettings).toHaveBeenCalledTimes(1),
  );
});
