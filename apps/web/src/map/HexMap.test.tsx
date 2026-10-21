import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  GameSummary,
  MapMetadata,
  MapSearchResult,
  MapViewportData,
  TileDetails,
} from '@srilanka/contracts';
import {
  fetchMap,
  fetchMapViewport,
  fetchTile,
  fetchTileContext,
  moveArmy,
  searchMap,
} from '../api.js';
import { HexMap } from './HexMap.js';
import { axialToPixel, fitMap, zoomAt } from './hex-math.js';

vi.mock('../api.js', () => ({
  ApiRequestError: class extends Error {},
  fetchMap: vi.fn(),
  fetchMapViewport: vi.fn(),
  fetchTile: vi.fn(),
  fetchTileContext: vi.fn(),
  moveArmy: vi.fn(),
  searchMap: vi.fn(),
  createArmy: vi.fn(),
  createCity: vi.fn(),
  updateTileControl: vi.fn(),
}));
vi.mock('./MapHistory.js', () => ({ MapHistory: () => null }));
vi.mock('./MapSetupPanel.js', () => ({ MapSetupPanel: () => null }));

const game: GameSummary = {
  id: 'game',
  name: '地图测试',
  role: 'Host',
  status: 'Running',
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
const map: MapMetadata = {
  id: 'map',
  name: '诸国',
  width: 12,
  height: 8,
  orientation: 'Pointy',
  minZoom: 0.5,
  maxZoom: 3,
  revision: 1,
  currentWorldVersion: 1,
  availableLayers: [],
};
const origin: TileDetails = {
  id: 'origin',
  q: 1,
  r: 1,
  discoveryState: 'Observed',
  confidence: 1,
  observedWorldVersion: 1,
  terrainKey: 'plain',
  terrainName: '平原',
  terrainColor: '#abc',
  regionId: null,
  regionName: '北境',
  controllerCountryId: 'north',
  controllerCountryName: '北国',
  controllerColor: '#789',
  passable: true,
  movementCost: 1,
  cities: [],
  armies: [
    {
      id: 'army',
      name: '北军',
      strength: { kind: 'Exact', value: 1000 },
      status: 'Active',
      countryId: 'north',
      confidence: 1,
      observedWorldVersion: 1,
      outdated: false,
    },
  ],
  provinceName: '北省',
  legalOwnerCountryName: '北国',
  occupierCountryName: null,
  elevation: 0,
  roadLevel: 0,
};
const destination: TileDetails = {
  ...origin,
  id: 'destination',
  q: 2,
  r: 1,
  regionName: '河岸',
  armies: [],
};
const viewport: MapViewportData = {
  mapId: 'map',
  worldVersion: 1,
  bounds: { minQ: 0, maxQ: 11, minR: 0, maxR: 7 },
  viewMode: 'Truth',
  viewCountryId: null,
  tiles: [origin, destination],
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId = 1;
      isPrimary = true;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(
    900,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'clientHeight', 'get').mockReturnValue(
    520,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
  HTMLCanvasElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLCanvasElement.prototype.releasePointerCapture = vi.fn();
  vi.mocked(fetchMap).mockResolvedValue(map);
  vi.mocked(fetchTileContext).mockResolvedValue({
    tileId: 'origin',
    province: null,
    economy: null,
    tradeZones: null,
    government: null,
    diplomacy: null,
  });
  vi.mocked(fetchMapViewport).mockResolvedValue(viewport);
  vi.mocked(fetchTile).mockImplementation(async (_, id) =>
    id === origin.id ? origin : destination,
  );
  vi.mocked(searchMap).mockResolvedValue([]);
  vi.mocked(moveArmy).mockResolvedValue({
    ...destination,
    armies: origin.armies,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function ready() {
  await waitFor(() => expect(fetchMapViewport).toHaveBeenCalled());
  return screen.getByLabelText('交互地图：方向键平移，加减号缩放，0 查看全图');
}

it('keeps the whole map fitted during resize until the player zooms, then preserves the viewed location', async () => {
  let resize!: () => void;
  let width = 900;
  let height = 520;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(
    HTMLCanvasElement.prototype,
    'clientWidth',
    'get',
  ).mockImplementation(() => width);
  vi.spyOn(
    HTMLCanvasElement.prototype,
    'clientHeight',
    'get',
  ).mockImplementation(() => height);
  render(<HexMap game={game} countries={[]} overlay showDetails={false} />);
  const canvas = await ready();
  width = 650;
  height = 320;
  act(() => resize());
  let view = fitMap(12, 8, width, height, 27, 3);
  const clickAtView = () => {
    const p = axialToPixel(origin.q, origin.r, 27);
    const point = {
      clientX: view.offsetX + p.x * view.scale,
      clientY: view.offsetY + p.y * view.scale,
      button: 0,
    };
    fireEvent.pointerDown(canvas, point);
    fireEvent.pointerUp(canvas, point);
  };
  clickAtView();
  await waitFor(() =>
    expect(fetchTile).toHaveBeenCalledWith('game', 'origin', undefined),
  );
  vi.mocked(fetchTile).mockClear();
  fireEvent.keyDown(canvas, { key: '+' });
  view = zoomAt(view, { x: width / 2, y: height / 2 }, 1.25, 0.5, 3);
  width += 100;
  height += 60;
  act(() => resize());
  view.offsetX += 50;
  view.offsetY += 30;
  clickAtView();
  await waitFor(() =>
    expect(fetchTile).toHaveBeenCalledWith('game', 'origin', undefined),
  );
});
function point(tile: TileDetails) {
  const view = fitMap(12, 8, 900, 520, 27, 3);
  const p = axialToPixel(tile.q, tile.r, 27);
  return {
    clientX: view.offsetX + p.x * view.scale,
    clientY: view.offsetY + p.y * view.scale,
    button: 0,
  };
}
function clickTile(canvas: HTMLElement, tile: TileDetails) {
  fireEvent.pointerDown(canvas, point(tile));
  fireEvent.pointerUp(canvas, point(tile));
}

it('previews a move, cancels without mutation, and sends a confirmed destination only once', async () => {
  render(<HexMap game={game} countries={[]} overlay />);
  const canvas = await ready();
  clickTile(canvas, origin);
  await screen.findByRole('heading', { name: '北境' });
  expect(
    screen.queryByRole('button', { name: '移动' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '即时更正' }));
  fireEvent.change(screen.getByLabelText('即时更正原因'), {
    target: { value: '修正误标的位置' },
  });
  fireEvent.click(await screen.findByRole('button', { name: '移动' }));
  expect(screen.getByRole('button', { name: '确认移动' })).toBeDisabled();
  clickTile(canvas, destination);
  expect(await screen.findByText(/移至 河岸/)).toBeVisible();
  expect(moveArmy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  expect(moveArmy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '移动' }));
  clickTile(canvas, destination);
  fireEvent.click(screen.getByRole('button', { name: '确认移动' }));
  await waitFor(() =>
    expect(moveArmy).toHaveBeenCalledExactlyOnceWith(
      'game',
      'army',
      'destination',
      { correctionReason: '修正误标的位置', expectedRevision: 1 },
    ),
  );
  expect(await screen.findByRole('heading', { name: '河岸' })).toBeVisible();
});

it('does not select a tile after a drag, pointer cancellation or secondary-button release', async () => {
  render(<HexMap game={game} countries={[]} overlay />);
  const canvas = await ready();
  const p = point(origin);
  fireEvent.pointerDown(canvas, p);
  fireEvent.pointerMove(canvas, { ...p, clientX: p.clientX + 15 });
  fireEvent.pointerUp(canvas, { ...p, clientX: p.clientX + 15 });
  fireEvent.pointerDown(canvas, p);
  fireEvent.pointerCancel(canvas, p);
  fireEvent.pointerUp(canvas, p);
  fireEvent.pointerDown(canvas, { ...p, button: 2 });
  fireEvent.pointerUp(canvas, { ...p, button: 2 });
  expect(fetchTile).not.toHaveBeenCalled();
});

it('uses a searched destination in a pending move without immediately moving the army', async () => {
  vi.mocked(searchMap).mockResolvedValue([
    {
      id: 'city',
      name: '河港',
      type: 'City',
      tileId: destination.id,
      q: destination.q,
      r: destination.r,
    },
  ]);
  render(<HexMap game={game} countries={[]} overlay />);
  const canvas = await ready();
  clickTile(canvas, origin);
  fireEvent.click(screen.getByRole('button', { name: '即时更正' }));
  fireEvent.change(screen.getByLabelText('即时更正原因'), {
    target: { value: '更正位置' },
  });
  fireEvent.click(await screen.findByRole('button', { name: '移动' }));
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: '河港' },
  });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  fireEvent.click(await screen.findByRole('button', { name: '城市 · 河港' }));
  expect(await screen.findByText(/移至 河岸/)).toBeVisible();
  expect(screen.getByRole('button', { name: '确认移动' })).toBeEnabled();
  expect(moveArmy).not.toHaveBeenCalled();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(
    screen.queryByRole('button', { name: '确认移动' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: '北境' })).toBeVisible();
});

it('ignores a host search that finishes after switching to player preview', async () => {
  let resolveSearch!: (value: MapSearchResult[]) => void;
  vi.mocked(searchMap).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveSearch = resolve;
      }),
  );
  const { rerender } = render(<HexMap game={game} countries={[]} overlay />);
  await ready();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: '秘密' },
  });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  rerender(
    <HexMap game={game} countries={[]} previewMemberId="player" overlay />,
  );
  await act(async () =>
    resolveSearch([
      {
        id: 'secret',
        type: 'Army',
        name: '秘密军队',
        tileId: origin.id,
        q: 1,
        r: 1,
      },
    ]),
  );
  expect(screen.queryByText(/秘密军队/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '地图工具' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('searchbox')).toHaveValue('');
});

it('shows an empty search result and dismisses it with Escape', async () => {
  render(<HexMap game={game} countries={[]} overlay />);
  await ready();
  fireEvent.change(screen.getByRole('searchbox'), {
    target: { value: '不存在' },
  });
  fireEvent.click(screen.getByRole('button', { name: '搜索' }));
  expect(await screen.findByText('没有找到匹配的地点或军队。')).toBeVisible();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(
    screen.queryByText('没有找到匹配的地点或军队。'),
  ).not.toBeInTheDocument();
});

it('switches map modes directly while retaining the inspected tile', async () => {
  render(<HexMap game={game} countries={[]} overlay />);
  clickTile(await ready(), origin);
  await screen.findByRole('heading', { name: '北境' });
  const loads = vi.mocked(fetchTile).mock.calls.length;
  for (const mode of ['地形', '情报认知', '政治地图']) {
    fireEvent.click(screen.getByRole('button', { name: mode }));
    expect(screen.getByRole('button', { name: mode })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('heading', { name: '北境' })).toBeVisible();
  }
  expect(fetchTile).toHaveBeenCalledTimes(loads);
});

it('navigates map search results by keyboard and returns focus to the map after selection', async () => {
  vi.mocked(searchMap).mockResolvedValue([
    { id: 'city', type: 'City', name: '河港', tileId: origin.id, q: 1, r: 1 },
    {
      id: 'army',
      type: 'Army',
      name: '北军',
      tileId: destination.id,
      q: 2,
      r: 1,
    },
  ]);
  render(<HexMap game={game} countries={[]} overlay />);
  const canvas = await ready();
  const search = screen.getByRole('searchbox');
  fireEvent.change(search, { target: { value: '河' } });
  fireEvent.submit(search.closest('form')!);
  const first = await screen.findByRole('button', { name: '城市 · 河港' });
  fireEvent.keyDown(search, { key: 'ArrowDown' });
  expect(first).toHaveFocus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(screen.getByRole('button', { name: '军队 · 北军' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('button', { name: '军队 · 北军' }), {
    key: 'Escape',
  });
  expect(search).toHaveFocus();
  expect(
    screen.queryByRole('region', { name: '地图搜索结果' }),
  ).not.toBeInTheDocument();
  fireEvent.submit(search.closest('form')!);
  fireEvent.click(await screen.findByRole('button', { name: '城市 · 河港' }));
  await screen.findByRole('heading', { name: '北境' });
  expect(canvas).toHaveFocus();
});
