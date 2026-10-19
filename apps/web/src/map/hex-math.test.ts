import { describe, expect, it } from 'vitest';

import {
  axialToPixel,
  fitMap,
  fitTiles,
  pixelToAxial,
  splitViewport,
  visibleBounds,
  zoomAt,
} from './hex-math.js';

describe('hex map math', () => {
  it('fits a remote irregular province into the available map pane', () => {
    const tiles = [
      { q: 70, r: 50 },
      { q: 74, r: 53 },
      { q: 72, r: 51 },
    ];
    const view = fitTiles(tiles, 390, 280, 27, 3);
    for (const tile of tiles) {
      const point = axialToPixel(tile.q, tile.r, 27);
      for (let edge = 0; edge < 6; edge++) {
        const angle = ((edge * 60 - 30) * Math.PI) / 180;
        const x = view.offsetX + (point.x + 27 * Math.cos(angle)) * view.scale;
        const y = view.offsetY + (point.y + 27 * Math.sin(angle)) * view.scale;
        expect(x).toBeGreaterThanOrEqual(39.99);
        expect(x).toBeLessThanOrEqual(350.01);
        expect(y).toBeGreaterThanOrEqual(39.99);
        expect(y).toBeLessThanOrEqual(240.01);
      }
    }
  });
  it('round-trips offset coordinates through pixels', () => {
    for (const point of [
      { q: 0, r: 0 },
      { q: 4, r: 3 },
      { q: -2, r: 5 },
    ]) {
      const pixel = axialToPixel(point.q, point.r, 24);
      expect(pixelToAxial(pixel.x, pixel.y, 24)).toEqual(point);
    }
  });

  it('keeps even rows aligned and offsets odd rows by half a hex', () => {
    const size = 24;
    const row0 = axialToPixel(0, 0, size);
    const row1 = axialToPixel(0, 1, size);
    const row2 = axialToPixel(0, 2, size);

    expect(row1.x - row0.x).toBeCloseTo((Math.sqrt(3) * size) / 2);
    expect(row2.x).toBeCloseTo(row0.x);
  });

  it('returns a padded visible coordinate range', () => {
    const bounds = visibleBounds(
      800,
      500,
      { offsetX: 60, offsetY: 60, scale: 1 },
      24,
    );
    expect(bounds.minQ).toBeLessThanOrEqual(-2);
    expect(bounds.maxQ).toBeGreaterThan(10);
    expect(bounds.minR).toBeLessThanOrEqual(-2);
    expect(bounds.maxR).toBeGreaterThan(10);
  });

  it('anchors zoom to the same world point, including clamped zoom', () => {
    const view = { offsetX: -130, offsetY: 80, scale: 1.2 };
    const point = { x: 377, y: 219 };
    for (const factor of [0.001, 0.8, 1.25, 100]) {
      const next = zoomAt(view, point, factor, 0.3, 3);
      expect((point.x - next.offsetX) / next.scale).toBeCloseTo(
        (point.x - view.offsetX) / view.scale,
      );
      expect((point.y - next.offsetY) / next.scale).toBeCloseTo(
        (point.y - view.offsetY) / view.scale,
      );
      expect(next.scale).toBeGreaterThanOrEqual(0.3);
      expect(next.scale).toBeLessThanOrEqual(3);
    }
  });

  it.each([
    [1, 1],
    [24, 16],
    [100, 100],
    [100, 1],
    [1, 100],
  ])(
    'fits every outer hex of a %i by %i map in a narrow viewport',
    (columns, rows) => {
      const view = fitMap(columns, rows, 390, 280, 27, 3);
      for (let r = 0; r < rows; r++) {
        for (const q of [0, columns - 1]) {
          const point = axialToPixel(q, r, 27);
          for (let edge = 0; edge < 6; edge++) {
            const angle = ((edge * 60 - 30) * Math.PI) / 180;
            const x =
              view.offsetX + (point.x + 27 * Math.cos(angle)) * view.scale;
            const y =
              view.offsetY + (point.y + 27 * Math.sin(angle)) * view.scale;
            expect(x).toBeGreaterThanOrEqual(31.99);
            expect(x).toBeLessThanOrEqual(358.01);
            expect(y).toBeGreaterThanOrEqual(31.99);
            expect(y).toBeLessThanOrEqual(248.01);
          }
        }
      }
    },
  );

  it('covers a large viewport without gaps, duplicate tiles or oversized requests', () => {
    const parts = splitViewport({ minQ: 7, maxQ: 99, minR: 3, maxR: 99 });
    const coordinates: string[] = [];
    for (const part of parts) {
      expect(
        (part.maxQ - part.minQ + 1) * (part.maxR - part.minR + 1),
      ).toBeLessThanOrEqual(2500);
      for (let q = part.minQ; q <= part.maxQ; q++) {
        for (let r = part.minR; r <= part.maxR; r++)
          coordinates.push(`${q},${r}`);
      }
    }
    expect(coordinates).toHaveLength(93 * 97);
    expect(new Set(coordinates).size).toBe(coordinates.length);
    expect(coordinates).toContain('99,99');
  });
});
