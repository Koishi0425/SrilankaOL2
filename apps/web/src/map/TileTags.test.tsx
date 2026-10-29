import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TileDetails, GameSummary } from '@srilanka/contracts';
import { TileTags } from './TileTags.js';
import { MapSetupPanel } from './MapSetupPanel.js';
import * as api from '../api.js';
vi.mock('../api.js', () => ({
  fetchMapSetup: vi.fn(),
  changeTileTags: vi.fn(),
  createMap: vi.fn(),
  generateMapTerrain: vi.fn(),
  batchMapTiles: vi.fn(),
  fetchMapReveal: vi.fn(),
  initializeMapKnowledge: vi.fn(),
  removeMapReveal: vi.fn(),
  revealMapKnowledge: vi.fn(),
}));
afterEach(cleanup);
const tile = {
  discoveryState: 'Mapped',
  dynamicKnown: true,
  tags: [
    {
      id: 'tag',
      name: '丰收',
      description: '上次侦察记录',
      taxPercent: 0,
      productionPercent: 25,
      blocksObservation: false,
      startsSequence: 1,
      endsSequence: 1,
    },
  ],
} as TileDetails;
const setup = {
  map: {
    id: 'map',
    name: '地图',
    width: 8,
    height: 6,
    orientation: 'Pointy' as const,
    minZoom: 0.5,
    maxZoom: 3,
    revision: 2,
    currentWorldVersion: 1,
    availableLayers: [],
  },
  terrains: [],
  regions: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.fetchMapSetup).mockResolvedValue(setup);
  vi.mocked(api.changeTileTags).mockResolvedValue(setup);
});
it('shows dated historical tags without expiring them locally, but hides tags in unknown tiles', () => {
  const page = render(<TileTags tile={tile} />);
  expect(screen.getByText('丰收')).toBeInTheDocument();
  expect(screen.getByText(/不代表当前仍然生效/)).toBeInTheDocument();
  page.rerender(<TileTags tile={{ ...tile, discoveryState: 'Unknown' }} />);
  expect(screen.queryByText('丰收')).not.toBeInTheDocument();
});
it('offers two reveal choices and saves tile effects only on explicit host action', async () => {
  const game = {
    id: 'game',
    status: 'Preparing',
    role: 'Host',
    currentQuarter: { id: 'q', sequenceNumber: 1, state: 'Preparing' },
  } as GameSummary;
  render(
    <MapSetupPanel
      game={game}
      countries={[]}
      selectedIds={['tile']}
      onSelection={vi.fn()}
      onRectangle={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '揭示信息' }));
  expect(
    Array.from(
      (screen.getByLabelText('揭示内容') as HTMLSelectElement).options,
    ).map((o) => o.text),
  ).toEqual(['地理信息', '侦察情报']);
  fireEvent.click(screen.getByRole('button', { name: '地块状态' }));
  fireEvent.change(screen.getByLabelText('状态预设'), {
    target: { value: 'harvest' },
  });
  expect(api.changeTileTags).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '设置所选地块状态' }));
  await waitFor(() =>
    expect(api.changeTileTags).toHaveBeenCalledWith(
      'game',
      expect.objectContaining({
        tileIds: ['tile'],
        operation: 'Set',
        expectedRevision: 2,
        tag: expect.objectContaining({
          name: '丰收',
          productionPercent: 25,
          duration: 1,
        }),
      }),
    ),
  );
});

it('keeps clearing behind confirmation and returns subsequent reveals to geography', async () => {
  vi.mocked(api.revealMapKnowledge).mockResolvedValue(setup);
  const game = {
    id: 'game',
    status: 'Preparing',
    role: 'Host',
    currentQuarter: { id: 'q', sequenceNumber: 1, state: 'Preparing' },
  } as GameSummary;
  render(
    <MapSetupPanel
      game={game}
      countries={[{ id: 'a', name: '北国', mapColor: '#abc' }]}
      selectedIds={['tile']}
      onSelection={vi.fn()}
      onRectangle={vi.fn()}
      onChanged={vi.fn()}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '揭示信息' }));
  fireEvent.click(screen.getByText('高级操作'));
  fireEvent.click(screen.getByRole('button', { name: '清除所选地块已知记录' }));
  expect(api.revealMapKnowledge).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
  await waitFor(() =>
    expect(api.revealMapKnowledge).toHaveBeenCalledWith(
      'game',
      expect.objectContaining({ state: 'Unknown' }),
    ),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '发布所选信息' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '发布所选信息' }));
  fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
  await waitFor(() =>
    expect(api.revealMapKnowledge).toHaveBeenLastCalledWith(
      'game',
      expect.objectContaining({ state: 'Mapped' }),
    ),
  );
});
