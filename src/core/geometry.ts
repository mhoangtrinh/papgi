// Pure geometry helpers. Page space = PDF points, origin top-left, y down
// (MuPDF's "fz" space, page rotation already applied).

export type Point = [number, number];
export type Rect = [number, number, number, number]; // x0, y0, x1, y1
export type Quad = [number, number, number, number, number, number, number, number]; // ul, ur, ll, lr

/** Page placement on screen: page point p maps to (p - origin) * scale. */
export interface View {
  scale: number; // CSS px per point
  originX: number;
  originY: number;
}

export function toPage(v: View, x: number, y: number): Point {
  return [x / v.scale + v.originX, y / v.scale + v.originY];
}

export function toScreen(v: View, x: number, y: number): Point {
  return [(x - v.originX) * v.scale, (y - v.originY) * v.scale];
}

export function rectToScreen(v: View, r: Rect): Rect {
  const [a, b] = toScreen(v, r[0], r[1]);
  const [c, d] = toScreen(v, r[2], r[3]);
  return [a, b, c, d];
}

export function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

export function rectWidth(r: Rect): number {
  return r[2] - r[0];
}

export function rectHeight(r: Rect): number {
  return r[3] - r[1];
}

export function inRect(r: Rect, x: number, y: number, pad = 0): boolean {
  return x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;
}

export function translateRect(r: Rect, dx: number, dy: number): Rect {
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];
}

export function quadToRect(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function translateQuad(q: Quad, dx: number, dy: number): Quad {
  return q.map((v, i) => v + (i % 2 === 0 ? dx : dy)) as Quad;
}

export function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let [x0, y0, x1, y1] = rects[0];
  for (const r of rects) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[2]);
    y1 = Math.max(y1, r[3]);
  }
  return [x0, y0, x1, y1];
}

/** Ramer-Douglas-Peucker simplification for pen strokes (tolerance in points). */
export function simplifyStroke(points: Point[], tolerance = 0.4): Point[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Bounding box of a set of strokes. */
export function strokesBounds(strokes: Point[][]): Rect | null {
  const pts = strokes.flat();
  if (pts.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/**
 * Fit strokes (any coordinate space) into a target box: scaled uniformly to `width`
 * and centred on (cx, cy). Used to place a saved signature on a page.
 */
export function placeStrokes(strokes: Point[][], cx: number, cy: number, width: number): Point[][] {
  const b = strokesBounds(strokes);
  if (!b) return [];
  const w = Math.max(b[2] - b[0], 1e-6);
  const h = b[3] - b[1];
  const s = width / w;
  const ox = cx - (w * s) / 2;
  const oy = cy - (h * s) / 2;
  return strokes.map((st) => st.map(([x, y]) => [ox + (x - b[0]) * s, oy + (y - b[1]) * s] as Point));
}

/** Zoom steps used by the +/- buttons. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current + 1e-3) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 1e-3) return ZOOM_STEPS[i];
  return ZOOM_STEPS[0];
}

export function clampZoom(z: number): number {
  return Math.min(5, Math.max(0.25, z));
}
