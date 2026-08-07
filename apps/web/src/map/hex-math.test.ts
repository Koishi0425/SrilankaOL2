import { describe, expect, it } from 'vitest';

import { axialToPixel, pixelToAxial, visibleBounds } from './hex-math.js';

describe('hex map math', () => {
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
});
