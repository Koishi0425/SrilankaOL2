import type { CountrySummary, MapTileSummary } from '@srilanka/contracts';

export type MapMode = 'political' | 'terrain' | 'knowledge';
export const mapModes: Record<MapMode, string> = {
  political: '政治地图',
  terrain: '地形',
  knowledge: '情报认知',
};
export const discoveryStyles = {
  Unknown: { label: '未知', color: '#cbd2d4' },
  Mapped: { label: '已知', color: '#96bdd3' },
  Observed: { label: '可见', color: '#7fa890' },
} satisfies Record<
  MapTileSummary['discoveryState'],
  { label: string; color: string }
>;

export const terrainSymbols = {
  hills: { name: '丘陵', path: 'M-14 2Q-9-9-4 2M-4 6Q2-7 8 6M4-3Q9-13 14-3' },
  mountains: {
    name: '山地',
    path: 'M-14 6L-6-8L2 6M-2 6L6-12L15 6M-9-3L-6-1L-3-3M3-6L6-3L9-6',
  },
  forest: {
    name: '森林',
    path: 'M-13 2L-8-8L-3 2ZM-8 2V7M0 4L6-9L12 4ZM6 4V9',
  },
  water: {
    name: '水域',
    path: 'M-14-4Q-10-8-6-4T2-4T10-4M-10 4Q-6 0-2 4T6 4T14 4',
  },
};

export function fogOpacity(
  tile: Pick<MapTileSummary, 'discoveryState'>,
  mode: MapMode,
) {
  if (mode === 'knowledge' || tile.discoveryState === 'Observed') return 0;
  return tile.discoveryState === 'Unknown' ? 0.65 : 0.35;
}

export function terrainSymbol(
  tile: Pick<MapTileSummary, 'terrainKey' | 'discoveryState'>,
) {
  if (tile.discoveryState === 'Unknown') return null;
  const key = tile.terrainKey === 'mountain' ? 'mountains' : tile.terrainKey;
  return key && key in terrainSymbols
    ? terrainSymbols[key as keyof typeof terrainSymbols]
    : null;
}

export function tileAppearance(
  tile: MapTileSummary,
  mode: MapMode,
  countries: CountrySummary[],
) {
  const knownState = tile.discoveryState === 'Observed' || !!tile.dynamicKnown;
  if (mode === 'knowledge')
    return {
      color: discoveryStyles[tile.discoveryState].color,
      group: null,
      occupation: null,
    };
  if (tile.discoveryState === 'Unknown')
    return { color: '#cbd2d4', group: null, occupation: null };
  if (mode === 'terrain')
    return {
      color: tile.terrainColor ?? '#d6dcd6',
      group: null,
      occupation: null,
    };
  const owner = countries.find(
    (country) => country.id === tile.legalOwnerCountryId,
  );
  const group = knownState ? (tile.legalOwnerCountryId ?? null) : null;
  const color = knownState ? (tile.legalOwnerColor ?? owner?.mapColor) : null;
  const controller = countries.find(
    (country) => country.id === tile.controllerCountryId,
  );
  const controllerColor = tile.controllerColor ?? controller?.mapColor;
  // Ownership and control must both be known from the same projected snapshot.
  // Missing ownership is not evidence of occupation.
  const occupation =
    group &&
    tile.controllerCountryId &&
    controllerColor &&
    group !== tile.controllerCountryId &&
    group !== (tile.controllerCountryName ?? controller?.name)
      ? {
          color: controllerColor,
          name: tile.controllerCountryName ?? controller?.name ?? null,
        }
      : null;
  return {
    color: color ?? (tile.terrainKey === 'water' ? '#a5bfca' : '#e0e4d6'),
    group,
    occupation,
  };
}

/** Draw narrow, map-aligned diagonal stripes inside the current hex path. */
export function drawOccupation(
  context: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  radius: number,
  zoom: number,
  phase: number,
) {
  const spacing = Math.max(7, 10 * zoom);
  context.save();
  context.clip();
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = Math.max(1.3, Math.min(3, 1.8 * zoom));
  for (
    let intercept =
      Math.floor((x + y - radius * 2 - phase) / spacing) * spacing + phase;
    intercept <= x + y + radius * 2;
    intercept += spacing
  ) {
    context.moveTo(x - radius, intercept - x + radius);
    context.lineTo(x + radius, intercept - x - radius);
  }
  context.stroke();
  context.restore();
}

const paths = new Map<string, Path2D>();
export function drawTerrain(
  context: CanvasRenderingContext2D,
  tile: MapTileSummary,
  x: number,
  y: number,
  zoom: number,
) {
  const symbol = terrainSymbol(tile);
  if (!symbol || zoom < 0.45) return;
  let path = paths.get(symbol.path);
  if (!path) {
    path = new Path2D(symbol.path);
    paths.set(symbol.path, path);
  }
  context.save();
  context.translate(x, y - 6 * zoom);
  const scale = Math.min(1.6, zoom);
  context.scale(scale, scale);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.strokeStyle = 'rgba(255,255,245,.38)';
  context.lineWidth = 2.8 / scale;
  context.stroke(path);
  context.strokeStyle = 'rgba(38,56,48,.72)';
  context.lineWidth = 1.2 / scale;
  context.stroke(path);
  context.restore();
}
