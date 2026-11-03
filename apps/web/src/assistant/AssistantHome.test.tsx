import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AssistantStatus, GameSummary } from '@srilanka/contracts';
import { fetchAssistantStatus } from '../api.js';
import { AssistantHome } from './AssistantHome.js';

vi.mock('../api.js', () => ({ fetchAssistantStatus: vi.fn() }));

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
    state: 'HostReview',
    actionDeadline: null,
    currentWorldVersion: 1,
  },
};
const enabled: AssistantStatus = {
  configured: true,
  enabled: true,
  canManage: false,
  provider: 'compatible',
  scope: 'Global',
  model: 'shared-model',
};
const props = () => ({ game, onOpenSettlement: vi.fn(), onOpenRules: vi.fn() });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchAssistantStatus).mockResolvedValue(enabled);
});
afterEach(cleanup);

it('explains both host entry points and opens the existing settlement flow only when requested', async () => {
  const options = props();
  render(<AssistantHome {...options} />);
  await screen.findByText('全站 AI 服务已启用，无需逐局开启。');
  expect(screen.getByText(/当前尚未进入结算阶段/)).toBeInTheDocument();
  expect(screen.getByText(/本回合尚未发布/)).toBeInTheDocument();
  expect(
    screen.getByRole('region', { name: '主持人反馈起草入口' }),
  ).toBeInTheDocument();
  expect(options.onOpenSettlement).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '前往回合结算' }));
  fireEvent.click(screen.getByRole('button', { name: '前往回合结果' }));
  expect(options.onOpenSettlement).toHaveBeenCalledTimes(2);
  expect(fetchAssistantStatus).toHaveBeenCalledTimes(1);
});

it.each(['Player', 'Observer'] as const)(
  'shows result guidance without host controls to a %s',
  async (role) => {
    render(<AssistantHome {...props()} game={{ ...game, role }} />);
    await screen.findByText('全站 AI 服务已启用，无需逐局开启。');
    expect(screen.getByRole('button', { name: '前往回合结果' })).toBeEnabled();
    expect(
      screen.queryByRole('region', { name: '主持人反馈起草入口' }),
    ).not.toBeInTheDocument();
  },
);

it.each([
  [
    { ...enabled, configured: false },
    'AI 服务尚未配置完整或保存的密钥无法读取。',
  ],
  [{ ...enabled, enabled: false }, '全站 AI 服务已停用。'],
  [
    { ...enabled, enabled: false, scope: undefined, canManage: true },
    '本局尚未开启 AI 辅助。',
  ],
] as const)(
  'distinguishes incomplete settings, global disablement and the legacy per-game switch',
  async (status, text) => {
    vi.mocked(fetchAssistantStatus).mockResolvedValue(status);
    const options = props();
    render(<AssistantHome {...options} />);
    await screen.findByText(text);
    if (status.canManage) {
      fireEvent.click(
        screen.getByRole('button', { name: '前往本局模型辅助设置' }),
      );
      expect(options.onOpenRules).toHaveBeenCalledTimes(1);
    } else {
      expect(
        screen.queryByRole('button', { name: '前往本局模型辅助设置' }),
      ).not.toBeInTheDocument();
    }
  },
);

it('updates saved global status and aborts pending reads when leaving the page', async () => {
  const options = props();
  const page = render(<AssistantHome {...options} />);
  await screen.findByText('全站 AI 服务已启用，无需逐局开启。');
  vi.mocked(fetchAssistantStatus).mockResolvedValueOnce({
    ...enabled,
    enabled: false,
  });
  fireEvent(window, new Event('srilanka-assistant-settings-changed'));
  await screen.findByText('全站 AI 服务已停用。');
  let resolve!: (value: AssistantStatus) => void;
  vi.mocked(fetchAssistantStatus).mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  fireEvent.click(screen.getByRole('button', { name: '重新读取 AI 状态' }));
  const signal = vi.mocked(fetchAssistantStatus).mock.calls.at(-1)![1]!;
  page.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(enabled));
});

it('offers a retry when status loading fails while keeping usage instructions visible', async () => {
  vi.mocked(fetchAssistantStatus).mockRejectedValueOnce(new Error('连接中断'));
  render(<AssistantHome {...props()} />);
  await screen.findByRole('alert');
  expect(screen.getByRole('button', { name: '前往回合结果' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '重新读取 AI 状态' }));
  await screen.findByText('全站 AI 服务已启用，无需逐局开启。');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('shows the current settlement phase and limits ended games to published results', async () => {
  const options = props();
  const page = render(
    <AssistantHome
      {...options}
      game={{
        ...game,
        currentQuarter: { ...game.currentQuarter, state: 'Resolving' },
      }}
    />,
  );
  await screen.findByText('当前已进入结算阶段，可选择政策起草反馈。');
  page.rerender(
    <AssistantHome
      {...options}
      game={{
        ...game,
        status: 'Archived',
        currentQuarter: { ...game.currentQuarter, state: 'Published' },
      }}
    />,
  );
  expect(
    screen.queryByRole('button', { name: '前往回合结算' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '前往回合结果' })).toBeEnabled();
});
