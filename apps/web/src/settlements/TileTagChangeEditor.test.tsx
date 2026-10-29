import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TileTagChangeEditor } from './TileTagChangeEditor.js';
import { fetchSettlementStateOptions } from '../api.js';
vi.mock('../api.js', () => ({ fetchSettlementStateOptions: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('stages a status against policy tile targets and keeps its duration explicit', async () => {
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    mapRevision: 3,
    countries: [],
    armies: [],
    tiles: [{ id: 'tile', q: 1, r: 1, passable: true }],
  });
  const change = vi.fn(),
    revision = vi.fn();
  render(
    <TileTagChangeEditor
      gameId="game"
      quarterId="q"
      actionId="action"
      changes={[]}
      busy={false}
      onChange={change}
      onRevision={revision}
      refs={[
        {
          objectId: 'tile',
          objectType: 'Tile',
          refKind: 'Target',
          label: '地块',
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByText('地块状态'));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '添加地块状态计划' }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('状态预设'), {
    target: { value: 'damage' },
  });
  fireEvent.change(screen.getByLabelText('持续回合'), {
    target: { value: '3' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加地块状态计划' }));
  expect(change).toHaveBeenCalledWith([
    expect.objectContaining({
      kind: 'TileTag',
      operation: 'Set',
      tileIds: ['tile'],
      tag: expect.objectContaining({
        name: '遭到破坏',
        productionPercent: -50,
        duration: 3,
      }),
    }),
  ]);
  expect(revision).toHaveBeenCalledWith(3);
});
