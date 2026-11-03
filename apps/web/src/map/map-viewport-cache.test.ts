import { afterEach, expect, it, vi } from 'vitest';
import type { MapTileSummary, MapViewportData } from '@srilanka/contracts';
import {
  MapViewportCache,
  MapViewportChangedError,
} from './map-viewport-cache.js';

const map = { id: 'map', width: 100, height: 100, currentWorldVersion: 1 };
const full = { minQ: 0, maxQ: 99, minR: 0, maxR: 99 };
const close = { minQ: 10, maxQ: 30, minR: 12, maxR: 28 };
const tile = (q: number, r: number) =>
  ({ id: `${q},${r}`, q, r }) as MapTileSummary;
function viewport(bounds: MapViewportData['bounds']): MapViewportData {
  const tiles = [];
  for (let q = bounds.minQ; q <= bounds.maxQ; q++) {
    for (let r = bounds.minR; r <= bounds.maxR; r++) tiles.push(tile(q, r));
  }
  return {
    mapId: 'map',
    worldVersion: 1,
    viewMode: 'Truth',
    viewCountryId: null,
    bounds,
    tiles,
  };
}

afterEach(() => vi.useRealTimers());

it('shows fast chunks at 80ms while a 900ms chunk is still pending', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    (bounds: MapViewportData['bounds']) =>
      new Promise<MapViewportData>((resolve) =>
        setTimeout(
          () => resolve(viewport(bounds)),
          bounds.minQ === 50 && bounds.minR === 50 ? 900 : 80,
        ),
      ),
  );
  const cache = new MapViewportCache(map, fetch);
  const changed = vi.fn();
  cache.subscribe(changed);
  const loading = cache.load(full);
  expect(cache.read(full)).toBeNull();
  await vi.advanceTimersByTimeAsync(80);
  expect(cache.read(full)?.tiles).toHaveLength(7500);
  expect(changed).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(820);
  await loading;
  const tiles = cache.read(full)!.tiles;
  expect(tiles).toHaveLength(10_000);
  expect(new Set(tiles.map((item) => item.id)).size).toBe(10_000);
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('reuses pending and completed chunks across eight overlapping zooms', async () => {
  let resolve!: (data: MapViewportData) => void;
  const fetch = vi.fn(
    (_bounds: MapViewportData['bounds'], _signal: AbortSignal) =>
      new Promise<MapViewportData>((done) => (resolve = done)),
  );
  const cache = new MapViewportCache(map, fetch);
  const first = cache.load(close);
  const zooms = Array.from({ length: 8 }, (_, step) => ({
    minQ: 10 + step,
    maxQ: 30 - step,
    minR: 12 + step,
    maxR: 28 - step,
  }));
  const pending = zooms.map((bounds) => cache.load(bounds));
  expect(fetch).toHaveBeenCalledTimes(1);
  const signal = fetch.mock.calls[0]![1] as AbortSignal;
  expect(signal.aborted).toBe(false);
  resolve(viewport({ minQ: 0, maxQ: 49, minR: 0, maxR: 49 }));
  await Promise.all([first, ...pending]);
  for (const bounds of zooms) {
    await cache.load(bounds);
    expect(
      cache
        .read(bounds)!
        .tiles.every(
          (item) =>
            item.q >= bounds.minQ &&
            item.q <= bounds.maxQ &&
            item.r >= bounds.minR &&
            item.r <= bounds.maxR,
        ),
    ).toBe(true);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('requests only a missing neighboring chunk and keeps cached data immediately visible', async () => {
  const fetch = vi.fn(async (bounds: MapViewportData['bounds']) =>
    viewport(bounds),
  );
  const cache = new MapViewportCache(map, fetch);
  await cache.load(close);
  const crossed = { ...close, maxQ: 55 };
  expect(cache.read(crossed)!.tiles).toHaveLength(40 * 17);
  await cache.load(crossed);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]![0]).toEqual({
    minQ: 50,
    maxQ: 99,
    minR: 0,
    maxR: 49,
  });
  expect(cache.read(crossed)!.tiles).toHaveLength(46 * 17);
});

it('clamps edge chunks and never requests more than 2500 coordinates', async () => {
  const fetch = vi.fn(async (bounds: MapViewportData['bounds']) =>
    viewport(bounds),
  );
  const cache = new MapViewportCache({ ...map, width: 73, height: 62 }, fetch);
  await cache.load(full);
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const [bounds] of fetch.mock.calls) {
    expect(bounds.maxQ).toBeLessThan(73);
    expect(bounds.maxR).toBeLessThan(62);
    expect(
      (bounds.maxQ - bounds.minQ + 1) * (bounds.maxR - bounds.minR + 1),
    ).toBeLessThanOrEqual(2500);
  }
  expect(cache.read(full)!.tiles).toHaveLength(73 * 62);
  await cache.load({ minQ: 10, maxQ: 5, minR: 0, maxR: 5 });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('cancels on context invalidation and ignores late responses even if abort is ignored', async () => {
  let resolve!: (data: MapViewportData) => void;
  const fetch = vi.fn(
    (_bounds: MapViewportData['bounds'], _signal: AbortSignal) =>
      new Promise<MapViewportData>((done) => (resolve = done)),
  );
  const cache = new MapViewportCache(map, fetch);
  const loading = cache.load(close);
  const changed = vi.fn();
  cache.subscribe(changed);
  cache.clear();
  expect(fetch.mock.calls[0]![1].aborted).toBe(true);
  resolve(viewport(close));
  await loading;
  expect(cache.read(close)).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it('refreshes expired chunks and allows failed requests to be retried', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async (bounds: MapViewportData['bounds']) =>
    viewport(bounds),
  );
  const cache = new MapViewportCache(map, fetch);
  await cache.load(close);
  await vi.advanceTimersByTimeAsync(30_000);
  fetch.mockRejectedValueOnce(new Error('network'));
  await expect(cache.load(close)).rejects.toThrow('network');
  expect(cache.read(close)).not.toBeNull();
  await cache.load(close);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not combine different world versions or viewing countries', async () => {
  const fetch = vi.fn(async (bounds: MapViewportData['bounds']) =>
    viewport(bounds),
  );
  const cache = new MapViewportCache(map, fetch);
  await cache.load(close);
  fetch.mockImplementationOnce(async (bounds: MapViewportData['bounds']) => ({
    ...viewport(bounds),
    viewMode: 'Preview',
    viewCountryId: 'other-country',
  }));
  await expect(
    cache.load({ ...close, minQ: 55, maxQ: 65 }),
  ).rejects.toBeInstanceOf(MapViewportChangedError);
  expect(cache.read(full)!.tiles).toHaveLength(2500);
  cache.clear();
  fetch.mockImplementationOnce(async (bounds: MapViewportData['bounds']) => ({
    ...viewport(bounds),
    worldVersion: 2,
  }));
  await expect(cache.load(close)).rejects.toBeInstanceOf(
    MapViewportChangedError,
  );
  expect(cache.read(close)).toBeNull();
});

it('bounds memory with least recently used eviction', async () => {
  const fetch = vi.fn(async (bounds: MapViewportData['bounds']) =>
    viewport(bounds),
  );
  const cache = new MapViewportCache(map, fetch, 30_000, 2);
  await cache.load(close);
  await cache.load({ minQ: 50, maxQ: 70, minR: 0, maxR: 20 });
  await cache.load(close);
  await cache.load({ minQ: 0, maxQ: 20, minR: 50, maxR: 70 });
  expect(cache.read(close)).not.toBeNull();
  expect(cache.read({ minQ: 50, maxQ: 70, minR: 0, maxR: 20 })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(3);
});
