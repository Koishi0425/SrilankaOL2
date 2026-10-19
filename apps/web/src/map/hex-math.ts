export interface ViewTransform {
  offsetX: number;
  offsetY: number;
  scale: number;
}

/** Keep the world point under the cursor fixed, including at zoom limits. */
export function zoomAt(
  view: ViewTransform,
  point: { x: number; y: number },
  factor: number,
  min: number,
  max: number,
): ViewTransform {
  const scale = Math.min(max, Math.max(min, view.scale * factor));
  const ratio = scale / view.scale;
  return {
    scale,
    offsetX: point.x - (point.x - view.offsetX) * ratio,
    offsetY: point.y - (point.y - view.offsetY) * ratio,
  };
}

export function fitMap(
  columns: number,
  rows: number,
  width: number,
  height: number,
  size: number,
  maxZoom: number,
): ViewTransform {
  const halfWidth = (Math.sqrt(3) * size) / 2;
  const minX = -halfWidth;
  const maxX =
    (columns - 1) * halfWidth * 2 + (rows > 1 ? halfWidth : 0) + halfWidth;
  const minY = -size;
  const maxY = (rows - 1) * size * 1.5 + size;
  const scale = Math.max(
    0.01,
    Math.min(
      maxZoom,
      (width - 64) / (maxX - minX),
      (height - 64) / (maxY - minY),
    ),
  );
  return {
    scale,
    offsetX: width / 2 - ((minX + maxX) * scale) / 2,
    offsetY: height / 2 - ((minY + maxY) * scale) / 2,
  };
}

export function fitTiles(
  tiles: Array<{ q: number; r: number }>,
  width: number,
  height: number,
  size: number,
  maxZoom: number,
): ViewTransform {
  const points = tiles.map((tile) => axialToPixel(tile.q, tile.r, size));
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const minX = Math.min(...xs) - (Math.sqrt(3) * size) / 2;
  const maxX = Math.max(...xs) + (Math.sqrt(3) * size) / 2;
  const minY = Math.min(...ys) - size,
    maxY = Math.max(...ys) + size;
  const scale = Math.max(
    0.01,
    Math.min(
      maxZoom,
      (width - 80) / (maxX - minX),
      (height - 80) / (maxY - minY),
    ),
  );
  return {
    scale,
    offsetX: width / 2 - ((minX + maxX) * scale) / 2,
    offsetY: height / 2 - ((minY + maxY) * scale) / 2,
  };
}

/** The server caps each viewport request at 2,500 coordinates. */
export function splitViewport(bounds: {
  minQ: number;
  maxQ: number;
  minR: number;
  maxR: number;
}) {
  const parts: (typeof bounds)[] = [];
  for (let q = bounds.minQ; q <= bounds.maxQ; q += 50) {
    for (let r = bounds.minR; r <= bounds.maxR; r += 50) {
      parts.push({
        minQ: q,
        maxQ: Math.min(q + 49, bounds.maxQ),
        minR: r,
        maxR: Math.min(r + 49, bounds.maxR),
      });
    }
  }
  return parts;
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
