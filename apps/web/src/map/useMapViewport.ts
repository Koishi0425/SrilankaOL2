import { useEffect, useMemo, useState } from 'react';
import type {
  GameSummary,
  MapMetadata,
  MapViewportData,
} from '@srilanka/contracts';
import { fetchMapViewport } from '../api.js';
import {
  MapViewportCache,
  MapViewportChangedError,
} from './map-viewport-cache.js';

export function useMapViewport({
  active,
  game,
  metadata,
  bounds,
  previewMemberId,
  countryId,
  revision,
  onError,
  onStale,
}: {
  active: boolean;
  game: GameSummary;
  metadata: MapMetadata | null;
  bounds: MapViewportData['bounds'];
  previewMemberId?: string;
  countryId?: string;
  revision: number;
  onError: (message: string) => void;
  onStale: () => void;
}) {
  const [generation, setGeneration] = useState(0);
  const cache = useMemo(
    () =>
      metadata
        ? new MapViewportCache(metadata, (part, signal) =>
            fetchMapViewport(game.id, part, signal, previewMemberId),
          )
        : null,
    // Never reuse truth/knowledge data across games, members, countries or versions.
    [
      game.id,
      game.role,
      game.currentQuarter.id,
      game.currentQuarter.currentWorldVersion,
      metadata?.id,
      metadata?.width,
      metadata?.height,
      metadata?.revision,
      metadata?.currentWorldVersion,
      metadata?.viewCountryId,
      previewMemberId,
      countryId,
      revision,
    ],
  );

  useEffect(() => {
    if (!active || !cache) return;
    const unsubscribe = cache.subscribe(() =>
      setGeneration((value) => value + 1),
    );
    return () => {
      unsubscribe();
      cache.clear();
    };
  }, [active, cache]);

  useEffect(() => {
    if (!active || !cache) return;
    let live = true;
    void cache.load(bounds).catch((reason: unknown) => {
      if (
        !live ||
        (reason instanceof DOMException && reason.name === 'AbortError')
      )
        return;
      if (reason instanceof MapViewportChangedError) {
        cache.clear();
        setGeneration((value) => value + 1);
        onStale();
      } else {
        onError(reason instanceof Error ? reason.message : '地图加载失败');
      }
    });
    // Moving the view detaches this consumer, but keeps shared requests running.
    return () => {
      live = false;
    };
  }, [
    active,
    cache,
    bounds.minQ,
    bounds.maxQ,
    bounds.minR,
    bounds.maxR,
    onError,
    onStale,
  ]);

  return useMemo(
    () => (active ? (cache?.read(bounds) ?? null) : null),
    [active, cache, generation, bounds],
  );
}
