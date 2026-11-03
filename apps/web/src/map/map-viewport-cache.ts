import type { MapViewportData } from '@srilanka/contracts';
import { splitViewport } from './hex-math.js';

type Bounds = MapViewportData['bounds'];
type FetchViewport = (
  bounds: Bounds,
  signal: AbortSignal,
) => Promise<MapViewportData>;

export class MapViewportChangedError extends Error {}

/** One instance belongs to one map revision and permission context. */
export class MapViewportCache {
  private readonly entries = new Map<
    string,
    { data: MapViewportData; loadedAt: number }
  >();
  private readonly pending = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly listeners = new Set<() => void>();
  private identity: string | null = null;

  constructor(
    private readonly map: {
      id: string;
      width: number;
      height: number;
      currentWorldVersion: number;
    },
    private readonly fetchViewport: FetchViewport,
    private readonly maxAge = 30_000,
    private readonly maxEntries = 16,
  ) {}

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  clear() {
    for (const { controller } of this.pending.values()) controller.abort();
    this.pending.clear();
    this.entries.clear();
    this.identity = null;
  }

  private chunks(bounds: Bounds) {
    if (bounds.minQ > bounds.maxQ || bounds.minR > bounds.maxR) return [];
    // Fixed grid keys let overlapping views share both data and pending requests.
    return splitViewport({
      minQ: Math.max(0, Math.floor(bounds.minQ / 50) * 50),
      maxQ: Math.min(
        this.map.width - 1,
        Math.floor(bounds.maxQ / 50) * 50 + 49,
      ),
      minR: Math.max(0, Math.floor(bounds.minR / 50) * 50),
      maxR: Math.min(
        this.map.height - 1,
        Math.floor(bounds.maxR / 50) * 50 + 49,
      ),
    });
  }

  private key(bounds: Bounds) {
    return `${bounds.minQ},${bounds.minR}`;
  }

  read(bounds: Bounds): MapViewportData | null {
    let first: MapViewportData | undefined;
    const tiles: MapViewportData['tiles'] = [];
    for (const part of this.chunks(bounds)) {
      const entry = this.entries.get(this.key(part));
      if (!entry) continue;
      first ??= entry.data;
      tiles.push(
        ...entry.data.tiles.filter(
          (tile) =>
            tile.q >= bounds.minQ &&
            tile.q <= bounds.maxQ &&
            tile.r >= bounds.minR &&
            tile.r <= bounds.maxR,
        ),
      );
    }
    return first ? { ...first, bounds, tiles } : null;
  }

  async load(bounds: Bounds) {
    await Promise.all(this.chunks(bounds).map((part) => this.loadChunk(part)));
  }

  private loadChunk(bounds: Bounds): Promise<void> {
    const key = this.key(bounds);
    const entry = this.entries.get(key);
    if (entry && Date.now() - entry.loadedAt < this.maxAge) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      return Promise.resolve();
    }
    const pending = this.pending.get(key);
    if (pending) return pending.promise;
    const controller = new AbortController();
    const request = {
      controller,
      promise: Promise.resolve(),
    };
    this.pending.set(key, request);
    request.promise = this.fetchViewport(bounds, controller.signal)
      .then((data) => {
        // A cancelled request may still resolve (for example from an HTTP cache).
        if (this.pending.get(key) !== request || controller.signal.aborted)
          return;
        const identity = JSON.stringify([
          data.mapId,
          data.worldVersion,
          data.viewMode,
          data.viewCountryId,
        ]);
        if (
          data.mapId !== this.map.id ||
          data.worldVersion !== this.map.currentWorldVersion ||
          (this.identity !== null && identity !== this.identity)
        ) {
          throw new MapViewportChangedError();
        }
        this.identity = identity;
        this.entries.delete(key);
        this.entries.set(key, { data, loadedAt: Date.now() });
        while (this.entries.size > this.maxEntries) {
          this.entries.delete(this.entries.keys().next().value!);
        }
        // Publish each completed chunk immediately; slow neighbors keep loading.
        for (const listener of this.listeners) listener();
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    return request.promise;
  }
}
