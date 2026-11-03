import { StrictMode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  GameSummary,
  MapMetadata,
  MapViewportData,
} from '@srilanka/contracts';
import { fetchMapViewport } from '../api.js';
import { useMapViewport } from './useMapViewport.js';

vi.mock('../api.js', () => ({ fetchMapViewport: vi.fn() }));

const game: GameSummary = {
  id: 'game',
  name: 'test',
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
const metadata: MapMetadata = {
  id: 'map',
  width: 100,
  height: 100,
  name: 'test',
  orientation: 'Pointy',
  minZoom: 0.1,
  maxZoom: 3,
  revision: 1,
  currentWorldVersion: 1,
  availableLayers: [],
};
const bounds = { minQ: 5, maxQ: 20, minR: 5, maxR: 20 };
const data: MapViewportData = {
  mapId: 'map',
  worldVersion: 1,
  bounds: { minQ: 0, maxQ: 49, minR: 0, maxR: 49 },
  viewMode: 'Truth',
  viewCountryId: null,
  tiles: [],
};
function options() {
  return {
    active: true,
    game,
    metadata,
    bounds,
    revision: 0,
    previewMemberId: undefined as string | undefined,
    countryId: undefined as string | undefined,
    onError: vi.fn(),
    onStale: vi.fn(),
  };
}

beforeEach(() => {
  vi.mocked(fetchMapViewport).mockReset();
  vi.mocked(fetchMapViewport).mockResolvedValue(data);
});
afterEach(cleanup);

it('keeps overlapping requests alive and uses the latest bounds when they finish', async () => {
  let resolve!: (value: MapViewportData) => void;
  vi.mocked(fetchMapViewport).mockImplementationOnce(
    () => new Promise((done) => (resolve = done)),
  );
  const props = options();
  const { result, rerender } = renderHook(useMapViewport, {
    initialProps: props,
  });
  const signal = vi.mocked(fetchMapViewport).mock.calls[0]![2]!;
  const closer = { ...bounds, minQ: 10, maxQ: 15 };
  rerender({ ...props, bounds: closer });
  expect(signal.aborted).toBe(false);
  expect(fetchMapViewport).toHaveBeenCalledTimes(1);
  await act(async () => resolve(data));
  expect(result.current?.bounds).toEqual(closer);
  for (let step = 0; step < 8; step++) {
    rerender({ ...props, bounds: { ...closer, minR: 5 + step } });
    expect(result.current).not.toBeNull();
  }
  expect(fetchMapViewport).toHaveBeenCalledTimes(1);
  expect(props.onError).not.toHaveBeenCalled();
});

it.each([
  [
    'preview member',
    (props: ReturnType<typeof options>) => ({
      ...props,
      previewMemberId: 'player',
    }),
  ],
  [
    'game',
    (props: ReturnType<typeof options>) => ({
      ...props,
      game: { ...game, id: 'other-game' },
    }),
  ],
  [
    'role',
    (props: ReturnType<typeof options>) => ({
      ...props,
      game: { ...game, role: 'Player' as const },
    }),
  ],
  [
    'country',
    (props: ReturnType<typeof options>) => ({ ...props, countryId: 'country' }),
  ],
  [
    'local mutation',
    (props: ReturnType<typeof options>) => ({ ...props, revision: 1 }),
  ],
  [
    'map revision',
    (props: ReturnType<typeof options>) => ({
      ...props,
      metadata: { ...metadata, revision: 2 },
    }),
  ],
  [
    'world version',
    (props: ReturnType<typeof options>) => ({
      ...props,
      metadata: { ...metadata, currentWorldVersion: 2 },
    }),
  ],
  [
    'viewing country',
    (props: ReturnType<typeof options>) => ({
      ...props,
      metadata: { ...metadata, viewCountryId: 'country' },
    }),
  ],
  [
    'quarter',
    (props: ReturnType<typeof options>) => ({
      ...props,
      game: { ...game, currentQuarter: { ...game.currentQuarter, id: 'next' } },
    }),
  ],
] as const)(
  'invalidates cached truth immediately on a change of %s',
  async (_name, change) => {
    const props = options();
    const { result, rerender } = renderHook(useMapViewport, {
      initialProps: props,
    });
    await waitFor(() => expect(result.current?.viewMode).toBe('Truth'));
    const oldSignal = vi.mocked(fetchMapViewport).mock.calls[0]![2]!;
    vi.mocked(fetchMapViewport).mockImplementationOnce(
      () => new Promise(() => {}),
    );
    rerender(change(props));
    expect(result.current).toBeNull();
    expect(oldSignal.aborted).toBe(false); // Completed requests need no cancellation.
    expect(fetchMapViewport).toHaveBeenCalledTimes(2);
  },
);

it('ignores late truth after switching preview, even when the old fetch ignores abort', async () => {
  let resolveOld!: (value: MapViewportData) => void;
  let resolveNew!: (value: MapViewportData) => void;
  vi.mocked(fetchMapViewport)
    .mockImplementationOnce(() => new Promise((done) => (resolveOld = done)))
    .mockImplementationOnce(() => new Promise((done) => (resolveNew = done)));
  const props = options();
  const { result, rerender } = renderHook(useMapViewport, {
    initialProps: props,
  });
  const signal = vi.mocked(fetchMapViewport).mock.calls[0]![2]!;
  rerender({ ...props, previewMemberId: 'player' });
  expect(signal.aborted).toBe(true);
  expect(vi.mocked(fetchMapViewport).mock.calls[1]![3]).toBe('player');
  await act(async () => resolveOld(data));
  expect(result.current).toBeNull();
  await act(async () =>
    resolveNew({ ...data, viewMode: 'Preview', viewCountryId: 'country' }),
  );
  expect(result.current?.viewMode).toBe('Preview');
  expect(props.onError).not.toHaveBeenCalled();
});

it('does not reload for unchanged metadata objects or numerically unchanged bounds', async () => {
  const props = options();
  const { result, rerender } = renderHook(useMapViewport, {
    initialProps: props,
  });
  await waitFor(() => expect(result.current).not.toBeNull());
  rerender({ ...props, metadata: { ...metadata }, bounds: { ...bounds } });
  expect(fetchMapViewport).toHaveBeenCalledTimes(1);
});

it('clears data and cancels pending requests while inactive, then resumes loading', async () => {
  vi.mocked(fetchMapViewport).mockImplementationOnce(
    () => new Promise(() => {}),
  );
  const props = options();
  const { result, rerender, unmount } = renderHook(useMapViewport, {
    initialProps: props,
  });
  const signal = vi.mocked(fetchMapViewport).mock.calls[0]![2]!;
  rerender({ ...props, active: false });
  expect(signal.aborted).toBe(true);
  expect(result.current).toBeNull();
  rerender(props);
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(fetchMapViewport).toHaveBeenCalledTimes(2);
  unmount();
});

it('requests fresh metadata if the server advances the world version mid-load', async () => {
  const props = options();
  vi.mocked(fetchMapViewport).mockResolvedValueOnce({
    ...data,
    worldVersion: 2,
  });
  const { result } = renderHook(useMapViewport, { initialProps: props });
  await waitFor(() => expect(props.onStale).toHaveBeenCalledTimes(1));
  expect(result.current).toBeNull();
  expect(props.onError).not.toHaveBeenCalled();
});

it('reports load failures and retries when the viewed bounds change', async () => {
  const props = options();
  vi.mocked(fetchMapViewport).mockRejectedValueOnce(new Error('network'));
  const { result, rerender } = renderHook(useMapViewport, {
    initialProps: props,
  });
  await waitFor(() => expect(props.onError).toHaveBeenCalledWith('network'));
  rerender({ ...props, bounds: { ...bounds, minQ: 6 } });
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(fetchMapViewport).toHaveBeenCalledTimes(2);
});

it('can restart after StrictMode effect cleanup', async () => {
  const props = options();
  const { result } = renderHook(useMapViewport, {
    initialProps: props,
    wrapper: StrictMode,
  });
  await waitFor(() => expect(result.current).not.toBeNull());
  expect(props.onError).not.toHaveBeenCalled();
});
