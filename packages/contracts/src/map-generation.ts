export type GeneratedTerrain =
  'plains' | 'hills' | 'mountains' | 'forest' | 'water';
export interface MapGenerationOptions {
  mapType: 'Pangaea' | 'Continents' | 'Archipelago' | 'InlandSea';
  seed: string;
  seaLevel: 'Low' | 'Normal' | 'High';
  rainfall: 'Dry' | 'Normal' | 'Wet';
  worldAge: 'Young' | 'Normal' | 'Old';
  countryIds: string[];
}
export interface CreateMapInput {
  name: string;
  width: number;
  height: number;
  generation?: MapGenerationOptions;
}
export interface GeneratedMapTile {
  q: number;
  r: number;
  terrain: GeneratedTerrain;
  countryId: string | null;
}
export const generationDefaults: MapGenerationOptions = {
  mapType: 'Continents',
  seed: 'srilanka',
  seaLevel: 'Normal',
  rainfall: 'Normal',
  worldAge: 'Normal',
  countryIds: [],
};
export const generatedTerrainColors: Record<GeneratedTerrain, string> = {
  plains: '#b9c98f',
  hills: '#a68b5b',
  mountains: '#a6a3a0',
  forest: '#5f8a62',
  water: '#5a8fb8',
};

function hash(seed: string) {
  let value = 2166136261;
  for (let i = 0; i < seed.length; i++)
    value = Math.imul(value ^ seed.charCodeAt(i), 16777619);
  return value >>> 0;
}
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function noise(x: number, y: number, seed: number): number {
  const sample = (a: number, b: number) =>
    random((seed ^ Math.imul(a, 374761393) ^ Math.imul(b, 668265263)) >>> 0)();
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const dx = smooth(x - ix),
    dy = smooth(y - iy);
  const a = sample(ix, iy) * (1 - dx) + sample(ix + 1, iy) * dx;
  const b = sample(ix, iy + 1) * (1 - dx) + sample(ix + 1, iy + 1) * dx;
  return a * (1 - dy) + b * dy;
}

// Pure and versioned in source: the preview and server use identical geography.
// No model calls or global Math.random; a seed can be shared and reproduced.
export function generateMap(
  width: number,
  height: number,
  options: MapGenerationOptions,
): GeneratedMapTile[] {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 100 ||
    height > 100
  )
    throw new Error('地图尺寸须为 1–100。');
  const seed = hash(options.seed),
    rand = random(seed);
  const centers =
    options.mapType === 'Archipelago'
      ? Array.from({ length: 12 }, (_, index) => ({
          x: 0.125 + (index % 4) * 0.25 + (rand() - 0.5) * 0.08,
          y: 0.16 + Math.floor(index / 4) * 0.33 + (rand() - 0.5) * 0.09,
          rx: 0.09 + rand() * 0.04,
          ry: 0.11 + rand() * 0.05,
        }))
      : options.mapType === 'Continents'
        ? [
            { x: 0.24, y: 0.45 + rand() * 0.1, rx: 0.24, ry: 0.5 },
            { x: 0.76, y: 0.45 + rand() * 0.1, rx: 0.24, ry: 0.5 },
          ]
        : [{ x: 0.5, y: 0.5, rx: 0.52, ry: 0.53 }];
  const candidates = Array.from({ length: width * height }, (_, index) => {
    const q = index % width,
      r = Math.floor(index / width);
    const x = (q + 0.5) / width,
      y = (r + 0.5) / height;
    const n = noise(x * 7, y * 7, seed);
    let elevation =
      Math.max(
        ...centers.map(
          (c) => 1 - Math.hypot((x - c.x) / c.rx, (y - c.y) / c.ry),
        ),
      ) +
      (n - 0.5) * 0.5;
    if (options.mapType === 'InlandSea')
      elevation = Math.hypot((x - 0.5) * 2, (y - 0.5) * 2) + (n - 0.5) * 0.2;
    // An ocean lane separates the two main continents, even at low sea level.
    if (
      options.mapType === 'Continents' &&
      width > 5 &&
      Math.abs(x - 0.5 - Math.sin(y * 8 + rand()) * 0.015) < 0.045
    )
      elevation = -100;
    return { q, r, elevation };
  });
  const fraction =
    (options.mapType === 'Archipelago'
      ? 0.34
      : options.mapType === 'InlandSea'
        ? 0.76
        : 0.6) + { Low: 0.12, Normal: 0, High: -0.12 }[options.seaLevel];
  const landCount = Math.max(1, Math.round(width * height * fraction));
  const land = new Set(
    [...candidates]
      .filter((t) => t.elevation > -100)
      .sort((a, b) => b.elevation - a.elevation || a.r - b.r || a.q - b.q)
      .slice(0, landCount)
      .map((t) => t.r * width + t.q),
  );
  const relief = [...land].sort((a, b) => {
    const score = (i: number) =>
      noise(
        ((i % width) / width) * 8,
        (Math.floor(i / width) / height) * 8,
        seed ^ 4567,
      );
    return score(b) - score(a) || a - b;
  });
  const mountains = new Set(
    relief.slice(
      0,
      Math.round(
        land.size * { Young: 0.18, Normal: 0.1, Old: 0.04 }[options.worldAge],
      ),
    ),
  );
  const highlands = new Set(
    relief.slice(
      0,
      Math.round(
        land.size * { Young: 0.46, Normal: 0.32, Old: 0.18 }[options.worldAge],
      ),
    ),
  );
  const forest = new Set(
    [...land]
      .filter((i) => !highlands.has(i))
      .sort((a, b) => {
        const score = (i: number) =>
          noise(
            ((i % width) / width) * 9,
            (Math.floor(i / width) / height) * 9,
            seed ^ 9999,
          );
        return score(b) - score(a) || a - b;
      })
      .slice(
        0,
        Math.round(
          land.size * { Dry: 0.1, Normal: 0.24, Wet: 0.4 }[options.rainfall],
        ),
      ),
  );
  const tiles: GeneratedMapTile[] = candidates.map((t, i) => ({
    q: t.q,
    r: t.r,
    countryId: null,
    terrain: !land.has(i)
      ? 'water'
      : mountains.has(i)
        ? 'mountains'
        : highlands.has(i)
          ? 'hills'
          : forest.has(i)
            ? 'forest'
            : 'plains',
  }));
  if (options.countryIds.length) {
    if (land.size < options.countryIds.length)
      throw new Error('陆地不足以分配全部国家，请增大地图或减少国家。');
    const distance = (a: GeneratedMapTile, b: GeneratedMapTile) => {
      const x = a.q - (a.r - (a.r & 1)) / 2 - (b.q - (b.r - (b.r & 1)) / 2),
        y = a.r - b.r;
      return Math.max(Math.abs(x), Math.abs(y), Math.abs(x + y));
    };
    const landTiles = tiles.filter((t) => t.terrain !== 'water');
    const starts = [landTiles[Math.floor(rand() * landTiles.length)]!];
    while (starts.length < options.countryIds.length)
      starts.push(
        landTiles.reduce((best, t) =>
          Math.min(...starts.map((s) => distance(t, s))) >
          Math.min(...starts.map((s) => distance(best, s)))
            ? t
            : best,
        ),
      );
    // Grow across land first; disconnected islands use their nearest starting area.
    const byCoordinate = new Map(tiles.map((t) => [`${t.q}:${t.r}`, t]));
    const queue = starts.map((tile, i) => {
      tile.countryId = options.countryIds[i]!;
      return tile;
    });
    for (let head = 0; head < queue.length; head++) {
      const tile = queue[head]!;
      for (const [dq, dr] of [
        [1, 0],
        [-1, 0],
        [tile.r & 1, 1],
        [(tile.r & 1) - 1, 1],
        [tile.r & 1, -1],
        [(tile.r & 1) - 1, -1],
      ]) {
        const next = byCoordinate.get(`${tile.q + dq!}:${tile.r + dr!}`);
        if (next && next.terrain !== 'water' && next.countryId === null) {
          next.countryId = tile.countryId;
          queue.push(next);
        }
      }
    }
    for (const tile of landTiles)
      if (tile.countryId === null) {
        const closest = starts.reduce((a, b) =>
          distance(tile, a) <= distance(tile, b) ? a : b,
        );
        tile.countryId = closest.countryId;
      }
  }
  return tiles;
}
