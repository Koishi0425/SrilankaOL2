import { describe, expect, it } from 'vitest';

import { axialToPixel, pixelToAxial, visibleBounds } from './hex-math.js';

describe('hex map math', () => {
  it('round-trips axial coordinates through pixels', () => {
    for (const point of [
      { q: 0, r: 0 },
      { q: 4, r: 3 },
      { q: -2, r: 5 },
    ]) {
      const pixel = axialToPixel(point.q, point.r, 24);
      expect(pixelToAxial(pixel.x, pixel.y, 24)).toEqual(point);
    }
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
