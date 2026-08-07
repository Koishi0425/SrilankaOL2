import '@testing-library/jest-dom/vitest';

import { vi } from 'vitest';

const canvasContext = {
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  closePath: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  fillText: vi.fn(),
  setTransform: vi.fn(),
};

Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
  configurable: true,
  value: vi.fn(() => canvasContext),
});
