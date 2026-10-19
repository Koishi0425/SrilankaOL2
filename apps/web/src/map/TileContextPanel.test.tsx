import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MapTileContext, TileDetails } from '@srilanka/contracts';
import { fetchTileContext } from '../api.js';
import { TileContextPanel } from './TileContextPanel.js';
import { mapActionSeed } from './map-actions.js';
vi.mock('../api.js', () => ({ fetchTileContext: vi.fn() }));
const tile = {
  id: 'tile',
  q: 2,
  r: 3,
  regionName: '河口',
  terrainName: '平原',
} as TileDetails;
const data: MapTileContext = {
  tileId: tile.id,
  province: {
    id: 'province',
    name: '北省',
    tiles: [
      { id: 'tile', q: 2, r: 3 },
      { id: 'other', q: 3, r: 3 },
    ],
    knownOnly: true,
    values: {
      description: '沿河地区',
      taxBase: 8,
      productionBase: 7,
      manpowerBase: 5,
      autonomy: 15,
      unrest: 2,
    },
  },
  economy: {
    enabled: true,
    countryName: '北国',
    tax: 8.5,
    production: 9,
    manpower: 5,
  },
  tradeZones: [{ id: 'trade', name: '北海贸易区' }],
  government: {
    profile: {
      countryId: 'north',
      countryName: '北国',
      regime: '君主制',
      authority: '议会',
      description: '',
    },
    policies: [],
  },
  diplomacy: {
    referenceCountryId: 'north',
    referenceCountryName: '北国',
    relations: [],
    treaties: [],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchTileContext).mockResolvedValue(data);
});
afterEach(cleanup);
it('highlights known province tiles, expands actual system data and can hide its outline', async () => {
  const onScopeChange = vi.fn();
  render(
    <TileContextPanel
      gameId="game"
      tile={tile}
      refreshKey="1"
      active
      onScopeChange={onScopeChange}
    />,
  );
  fireEvent.click(await screen.findByText('经济与贸易'));
  expect(screen.getByText('北海贸易区')).toBeVisible();
  expect(screen.getByText('8.5')).toBeVisible();
  expect(screen.queryByText('君主制')).not.toBeVisible();
  fireEvent.click(screen.getByText('行政与长期政策'));
  expect(screen.getByText('君主制')).toBeVisible();
  await waitFor(() =>
    expect(onScopeChange).toHaveBeenLastCalledWith(data.province!.tiles),
  );
  fireEvent.click(screen.getByRole('button', { name: '已知范围 · 2 格' }));
  expect(onScopeChange).toHaveBeenLastCalledWith([]);
});
it('starts a province construction policy, switches to a tile target, and links the correct object', async () => {
  const onCreateAction = vi.fn();
  render(
    <TileContextPanel
      gameId="game"
      tile={tile}
      refreshKey="1"
      active
      onScopeChange={vi.fn()}
      onCreateAction={onCreateAction}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: '针对北省编写建设' }),
  );
  expect(onCreateAction).toHaveBeenLastCalledWith(tile, {
    category: 'Construction',
    province: { id: 'province', name: '北省' },
  });
  const seed = mapActionSeed(tile, 1, onCreateAction.mock.calls[0]![1]);
  expect(seed).toMatchObject({
    category: 'Construction',
    ref: { objectType: 'Province', objectId: 'province', label: '省份：北省' },
  });
  fireEvent.change(screen.getByLabelText('地图行动目标'), {
    target: { value: 'tile' },
  });
  fireEvent.click(screen.getByRole('button', { name: '针对河口编写军事' }));
  expect(onCreateAction).toHaveBeenLastCalledWith(tile, {
    category: 'Military',
    province: undefined,
  });
  expect(
    mapActionSeed(tile, 2, onCreateAction.mock.calls[1]![1]).ref,
  ).toMatchObject({ objectType: 'Tile', objectId: 'tile' });
});
it('discards a host response after changing preview and only highlights the preview scope', async () => {
  let resolveHost!: (value: MapTileContext) => void;
  vi.mocked(fetchTileContext).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveHost = resolve;
    }),
  );
  const scope = vi.fn();
  const props = {
    gameId: 'game',
    tile,
    refreshKey: '1',
    active: true,
    onScopeChange: scope,
  };
  const { rerender } = render(<TileContextPanel {...props} />);
  const preview = {
    ...data,
    province: {
      ...data.province!,
      values: null,
      tiles: [data.province!.tiles[0]!],
    },
    economy: null,
    government: null,
  };
  vi.mocked(fetchTileContext).mockResolvedValue(preview);
  rerender(<TileContextPanel {...props} previewMemberId="player" />);
  await screen.findByRole('button', { name: '已知范围 · 1 格' });
  resolveHost(data);
  await waitFor(() =>
    expect(scope).toHaveBeenLastCalledWith(preview.province.tiles),
  );
  fireEvent.click(screen.getByText('经济与贸易'));
  expect(screen.queryByText('8.5')).not.toBeInTheDocument();
});
