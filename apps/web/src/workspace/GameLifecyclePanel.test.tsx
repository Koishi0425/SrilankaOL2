import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { GameDetails } from '@srilanka/contracts';
import { GameLifecyclePanel } from './GameLifecyclePanel.js';
import { endGame } from '../api.js';

vi.mock('../api.js', () => ({ endGame: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const game: GameDetails = {
  id: 'game',
  name: '剧本',
  status: 'Running',
  role: 'Host',
  allowNewPlayers: true,
  aiEnabled: false,
  createdAt: '2026-10-18T00:00:00Z',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'Published',
    actionDeadline: null,
    currentWorldVersion: 3,
  },
};

it('requires an ending reason and explicit confirmation, then reports the archived game', async () => {
  const onEnded = vi.fn();
  vi.mocked(endGame).mockResolvedValue({
    ...game,
    status: 'Archived',
    endingReason: '剧本完成',
  });
  render(<GameLifecyclePanel game={game} onEnded={onEnded} />);
  fireEvent.click(screen.getByRole('button', { name: '结束本局' }));
  expect(endGame).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '确认结束并归档' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('结束说明'), {
    target: { value: '  剧本完成  ' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认结束并归档' }));
  await waitFor(() =>
    expect(onEnded).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'Archived' }),
    ),
  );
  expect(endGame).toHaveBeenCalledWith('game', {
    expectedQuarterId: 'quarter',
    expectedQuarterState: 'Published',
    reason: '剧本完成',
  });
});

it('preserves the reason after a failed request and allows retry or cancellation', async () => {
  const onEnded = vi.fn();
  vi.mocked(endGame).mockRejectedValue(new Error('本局正在保存，请稍后重试。'));
  render(<GameLifecyclePanel game={game} onEnded={onEnded} />);
  fireEvent.click(screen.getByRole('button', { name: '结束本局' }));
  fireEvent.change(screen.getByLabelText('结束说明'), {
    target: { value: '保留记录' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认结束并归档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('本局正在保存');
  expect(screen.getByLabelText('结束说明')).toHaveValue('保留记录');
  expect(onEnded).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(screen.queryByLabelText('结束说明')).not.toBeInTheDocument();
});

it('shows the recorded ending without an editing or reopening control', () => {
  render(
    <GameLifecyclePanel
      game={{
        ...game,
        status: 'Archived',
        endedAt: '2026-10-18T00:00:00Z',
        endingReason: '保留记录',
      }}
      onEnded={vi.fn()}
    />,
  );
  expect(
    screen.getByRole('heading', { name: '本局已结束' }),
  ).toBeInTheDocument();
  expect(screen.getByText('保留记录')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
