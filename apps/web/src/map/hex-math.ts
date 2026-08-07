export interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

export function axialToPixel(q: number, r: number, size: number) {
  // Persisted q/r coordinates use an odd-row offset grid so rectangular
  // coordinate ranges also have a rectangular map outline.
  const axialQ = q - (r - (r & 1)) / 2;
  return {
    x: size * Math.sqrt(3) * (axialQ + r / 2),
    y: size * 1.5 * r,
  };
}

export function pixelToAxial(x: number, y: number, size: number) {
  const axialQ = ((Math.sqrt(3) / 3) * x - y / 3) / size;
  const r = ((2 / 3) * y) / size;
  const axial = roundAxial(axialQ, r);
  return {
    q: axial.q + (axial.r - (axial.r & 1)) / 2,
    r: axial.r,
  };
}

function roundAxial(q: number, r: number) {
  let x = Math.round(q);
  let z = Math.round(r);
  const y = Math.round(-q - r);
  const xDiff = Math.abs(x - q);
  const yDiff = Math.abs(y + q + r);
  const zDiff = Math.abs(z - r);
  if (xDiff > yDiff && xDiff > zDiff) x = -y - z;
  else if (zDiff > yDiff) z = -x - y;
  return { q: x, r: z };
}

export function screenToAxial(
  x: number,
  y: number,
  view: ViewTransform,
  baseSize: number,
) {
  return pixelToAxial(
    (x - view.offsetX) / view.scale,
    (y - view.offsetY) / view.scale,
    baseSize,
  );
}

export function visibleBounds(
  width: number,
  height: number,
  view: ViewTransform,
  baseSize: number,
) {
  const points = [
    screenToAxial(0, 0, view, baseSize),
    screenToAxial(width, 0, view, baseSize),
    screenToAxial(0, height, view, baseSize),
    screenToAxial(width, height, view, baseSize),
  ];
  return {
    minQ: Math.min(...points.map((point) => point.q)) - 2,
    maxQ: Math.max(...points.map((point) => point.q)) + 2,
    minR: Math.min(...points.map((point) => point.r)) - 2,
    maxR: Math.max(...points.map((point) => point.r)) + 2,
  };
}
