import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GameDetails, GamePreparation } from '@srilanka/contracts';
import { createGame, fetchPreparation, openFirstQuarter } from '../api.js';
import { GamePreparationPanel } from './GamePreparationPanel.js';
import { NewGameForm } from './NewGameForm.js';
vi.mock('../api.js', () => ({
  createGame: vi.fn(),
  fetchPreparation: vi.fn(),
  openFirstQuarter: vi.fn(),
}));
const quarter = {
  id: 'quarter',
  gameYear: 1,
  season: 'Spring' as const,
  sequenceNumber: 1,
  state: 'Preparing' as const,
  actionDeadline: null,
  currentWorldVersion: 0,
};
const prepared: GamePreparation = {
  quarter,
  revision: 'old',
  canOpen: true,
  countryCount: 3,
  playerCount: 1,
  assignedPlayerCount: 1,
  unassignedPlayers: [],
  rulesSaved: false,
  map: null,
  resourceCountryCount: 0,
  automaticEconomy: false,
  governmentCountryCount: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchPreparation).mockResolvedValue(prepared);
});
afterEach(() => cleanup());
function form() {
  const onCreated = vi.fn();
  render(<NewGameForm onCreated={onCreated} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('游戏名称'), {
    target: { value: '  诸国时代  ' },
  });
  return onCreated;
}
it('validates the country list before sending a creation request', async () => {
  form();
  fireEvent.change(screen.getByLabelText('国家名单（每行一个）'), {
    target: { value: ' 北国\n北国 ' },
  });
  fireEvent.click(screen.getByRole('button', { name: '创建游戏' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '国家名称不能重复',
  );
  expect(createGame).not.toHaveBeenCalled();
});
it('keeps form values and the request identity on retry after a lost response', async () => {
  const onCreated = form();
  vi.mocked(createGame)
    .mockRejectedValueOnce(new Error('连接中断'))
    .mockResolvedValueOnce({ id: 'game' } as GameDetails);
  fireEvent.change(screen.getByLabelText('国家名单（每行一个）'), {
    target: { value: ' 北国\n\n南国\n海国 ' },
  });
  fireEvent.click(screen.getByRole('button', { name: '创建游戏' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
  expect(screen.getByLabelText('游戏名称')).toHaveValue('  诸国时代  ');
  fireEvent.click(screen.getByRole('button', { name: '创建游戏' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'game' }));
  expect(vi.mocked(createGame).mock.calls[0]![0]).toEqual(
    vi.mocked(createGame).mock.calls[1]![0],
  );
  expect(createGame).toHaveBeenCalledWith({
    name: '诸国时代',
    countryNames: ['北国', '南国', '海国'],
    creationId: expect.any(String),
  });
});
it('blocks opening only for unassigned players and links to their assignment', async () => {
  vi.mocked(fetchPreparation).mockResolvedValue({
    ...prepared,
    canOpen: false,
    assignedPlayerCount: 0,
    unassignedPlayers: [{ id: 'p', displayName: '阿南' }],
  });
  const onNavigate = vi.fn();
  render(
    <GamePreparationPanel
      gameId="game"
      active
      onNavigate={onNavigate}
      onOpened={vi.fn()}
    />,
  );
  expect(await screen.findByText('未分配：阿南')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开放第一回合' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '分配' }));
  expect(onNavigate).toHaveBeenCalledWith('members');
});
it('reviews freshly saved settings and allows blank optional settings', async () => {
  const onOpened = vi.fn();
  render(
    <GamePreparationPanel
      gameId="game"
      active
      onNavigate={vi.fn()}
      onOpened={onOpened}
    />,
  );
  expect(await screen.findByText('尚未创建')).toBeInTheDocument();
  vi.mocked(fetchPreparation).mockResolvedValue({
    ...prepared,
    revision: 'fresh',
  });
  vi.mocked(openFirstQuarter).mockResolvedValue({
    ...quarter,
    state: 'ActionSubmission',
  });
  fireEvent.click(screen.getByRole('button', { name: '开放第一回合' }));
  expect(
    await screen.findByRole('group', { name: '确认开局' }),
  ).toBeInTheDocument();
  expect(openFirstQuarter).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认开放' }));
  await waitFor(() =>
    expect(onOpened).toHaveBeenCalledWith({
      ...quarter,
      state: 'ActionSubmission',
    }),
  );
  expect(openFirstQuarter).toHaveBeenCalledWith('game', {
    quarterId: 'quarter',
    expectedRevision: 'fresh',
  });
});
it('keeps the reviewed revision on failure and permits an explicit refresh', async () => {
  render(
    <GamePreparationPanel
      gameId="game"
      active
      onNavigate={vi.fn()}
      onOpened={vi.fn()}
    />,
  );
  await screen.findByText('尚未创建');
  fireEvent.click(screen.getByRole('button', { name: '开放第一回合' }));
  await screen.findByRole('group', { name: '确认开局' });
  vi.mocked(openFirstQuarter).mockRejectedValue(
    new Error('准备内容已变化，请重新读取并确认。'),
  );
  fireEvent.click(screen.getByRole('button', { name: '确认开放' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('准备内容已变化');
  expect(screen.getByRole('group', { name: '确认开局' })).toBeInTheDocument();
  const calls = vi.mocked(fetchPreparation).mock.calls.length;
  vi.mocked(fetchPreparation).mockResolvedValue({
    ...prepared,
    revision: 'new',
  });
  fireEvent.click(screen.getByRole('button', { name: '返回准备' }));
  await waitFor(() =>
    expect(fetchPreparation).toHaveBeenCalledTimes(calls + 1),
  );
  await waitFor(() =>
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
  );
});
it('does not fetch private preparation while inactive', () => {
  render(
    <GamePreparationPanel
      gameId="game"
      active={false}
      onNavigate={vi.fn()}
      onOpened={vi.fn()}
    />,
  );
  expect(fetchPreparation).not.toHaveBeenCalled();
});
