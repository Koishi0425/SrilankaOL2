import { useMemo } from 'react';
import type { SettlementStateOptions } from '@srilanka/contracts';
import { axialToPixel } from './hex-math.js';

type Tile = SettlementStateOptions['tiles'][number];

export function TileRangePreview({
  tiles,
  tileIds,
}: {
  tiles: Tile[];
  tileIds: string[];
}) {
  const preview = useMemo(() => {
    const ids = new Set(tileIds);
    const selected = tiles.filter((tile) => ids.has(tile.id));
    if (!selected.length) return null;
    const minQ = Math.min(...selected.map((t) => t.q)),
      maxQ = Math.max(...selected.map((t) => t.q)),
      minR = Math.min(...selected.map((t) => t.r)),
      maxR = Math.max(...selected.map((t) => t.r));
    const context = tiles.filter(
      (t) =>
        t.q >= minQ - 2 &&
        t.q <= maxQ + 2 &&
        t.r >= minR - 2 &&
        t.r <= maxR + 2,
    );
    const points = context.map((t) => axialToPixel(t.q, t.r, 10));
    const minX = Math.min(...points.map((p) => p.x)) - 12,
      maxX = Math.max(...points.map((p) => p.x)) + 12,
      minY = Math.min(...points.map((p) => p.y)) - 12,
      maxY = Math.max(...points.map((p) => p.y)) + 12;
    const hex = (tile: Tile) => {
      const { x, y } = axialToPixel(tile.q, tile.r, 10);
      return (
        Array.from({ length: 6 }, (_, i) => {
          const angle = (Math.PI / 180) * (i * 60 - 30);
          return `${i ? 'L' : 'M'}${x + 10 * Math.cos(angle)},${y + 10 * Math.sin(angle)}`;
        }).join(' ') + ' Z'
      );
    };
    return {
      selected,
      minQ,
      maxQ,
      minR,
      maxR,
      viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      background: context
        .filter((t) => !ids.has(t.id))
        .map(hex)
        .join(' '),
      highlighted: selected.map(hex).join(' '),
    };
  }, [tiles, tileIds]);
  const missing = new Set(tileIds).size - (preview?.selected.length ?? 0);
  return (
    <figure className="tile-range-preview">
      {preview && (
        <>
          <svg
            viewBox={preview.viewBox}
            role="img"
            aria-label={`地块范围预览，高亮 ${preview.selected.length} 格`}
          >
            <path
              d={preview.background}
              fill="#e5e9e3"
              stroke="#fff"
              strokeWidth="0.7"
            />
            <path
              d={preview.highlighted}
              fill="#b77325"
              stroke="#fff"
              strokeWidth="0.7"
            />
          </svg>
          <figcaption>
            高亮 {preview.selected.length} 格，灰色为周边地块。列 {preview.minQ}
            –{preview.maxQ}，行 {preview.minR}–{preview.maxR}
            。预览不会修改地图或发布结算。
          </figcaption>
          <details>
            <summary>查看范围内坐标</summary>
            <p className="rules-text">
              {preview.selected.map((t) => `（${t.q},${t.r}）`).join('、')}
            </p>
          </details>
        </>
      )}
      {missing > 0 && (
        <p role="alert">
          有 {missing} 个目标在当前地图中不存在，请重新核对计划。
        </p>
      )}
    </figure>
  );
}
