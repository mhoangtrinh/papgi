// Eraser geometry (pure). Page space: PDF points, y down.
import type { Point, Quad, Rect } from "./geometry";

/** Distance from p to the segment a-b. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from p to a brush path (a polyline; a single point is a dab). */
export function distToPath(p: Point, path: Point[]): number {
  if (path.length === 1) return Math.hypot(p[0] - path[0][0], p[1] - path[0][1]);
  let d = Infinity;
  for (let i = 1; i < path.length; i++) d = Math.min(d, distToSegment(p, path[i - 1], path[i]));
  return d;
}

/** Does the brush (path swept with radius r) touch the segment a-b? */
export function brushTouchesSegment(path: Point[], r: number, a: Point, b: Point): boolean {
  // sample the segment finely enough for the brush size
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(r / 2, 0.25)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (distToPath([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], path) <= r) return true;
  }
  return false;
}

/** Does the brush touch the rectangle (anywhere inside it)? */
export function brushTouchesRect(path: Point[], r: number, rect: Rect): boolean {
  const [x0, y0, x1, y1] = rect;
  for (const p of path) {
    const cx = Math.max(x0, Math.min(x1, p[0]));
    const cy = Math.max(y0, Math.min(y1, p[1]));
    if (Math.hypot(p[0] - cx, p[1] - cy) <= r) return true;
  }
  // a fast stroke can jump across a small rectangle between samples
  const corners: Point[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  for (let i = 0; i < 4; i++) if (brushTouchesSegment(path, r, corners[i], corners[(i + 1) % 4])) return true;
  return false;
}

/** Does the brush touch the outline of a rectangle or ellipse inside `rect` (drawn with line width w)? */
export function brushTouchesOutline(path: Point[], r: number, rect: Rect, ellipse: boolean, w = 1): boolean {
  const [x0, y0, x1, y1] = rect;
  const pts: Point[] = [];
  if (ellipse) {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const rx = (x1 - x0) / 2;
    const ry = (y1 - y0) / 2;
    const n = Math.max(16, Math.ceil((Math.PI * (rx + ry)) / Math.max(r / 2, 0.5)));
    for (let i = 0; i <= n; i++) pts.push([cx + rx * Math.cos((2 * Math.PI * i) / n), cy + ry * Math.sin((2 * Math.PI * i) / n)]);
  } else pts.push([x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]);
  for (let i = 1; i < pts.length; i++) if (brushTouchesSegment(path, r + w / 2, pts[i - 1], pts[i])) return true;
  return false;
}

/**
 * Rub a drawn stroke with the brush: the parts within the brush go, the rest is kept as
 * separate pieces (each with at least two points). `w` is the stroke's line width.
 */
export function eraseStroke(stroke: Point[], path: Point[], r: number, w = 1): Point[][] {
  const reach = r + w / 2;
  const step = Math.max(Math.min(r, reach) / 3, 0.2);
  // put extra points along long segments so the cut lands near the brush edge
  const dense: Point[] = [];
  for (let i = 0; i < stroke.length; i++) {
    if (i > 0) {
      const a = stroke[i - 1];
      const b = stroke[i];
      const n = Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
      for (let k = 1; k < n; k++) dense.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    dense.push(stroke[i]);
  }
  const out: Point[][] = [];
  let cur: Point[] = [];
  let touched = false;
  for (const p of dense) {
    if (distToPath(p, path) <= reach) {
      touched = true;
      if (cur.length > 1) out.push(cur);
      cur = [];
    } else cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  // untouched strokes keep their original points (no densifying)
  return touched ? out.map((s) => thin(s, step)) : [stroke];
}

/** Drop the extra points again where the piece is straight enough. */
function thin(s: Point[], step: number): Point[] {
  if (s.length < 3) return s;
  const out: Point[] = [s[0]];
  for (let i = 1; i < s.length - 1; i++) {
    const a = out[out.length - 1];
    const b = s[i + 1];
    if (distToSegment(s[i], a, b) > step * 0.05) out.push(s[i]);
  }
  out.push(s[s.length - 1]);
  return out;
}

/**
 * The area a brush path covers, as a few rectangles: the path is laid on a grid of `cell`
 * points, and covered cells are merged into runs (row by row, then equal runs downwards).
 */
export function brushRects(path: Point[], r: number, cell = Math.max(r / 2.5, 0.75)): Rect[] {
  if (!path.length) return [];
  const xs = path.map((p) => p[0]);
  const ys = path.map((p) => p[1]);
  const gx0 = Math.floor((Math.min(...xs) - r) / cell);
  const gy0 = Math.floor((Math.min(...ys) - r) / cell);
  const gx1 = Math.ceil((Math.max(...xs) + r) / cell);
  const gy1 = Math.ceil((Math.max(...ys) + r) / cell);
  const W = gx1 - gx0 + 1;
  const H = gy1 - gy0 + 1;
  // mark the cells each segment covers (only the cells near that segment are looked at)
  const grid = new Uint8Array(W * H);
  const segs: [Point, Point][] = path.length === 1 ? [[path[0], path[0]]] : path.slice(1).map((p, i) => [path[i], p]);
  for (const [a, b] of segs) {
    const cx0 = Math.max(gx0, Math.floor((Math.min(a[0], b[0]) - r) / cell));
    const cx1 = Math.min(gx1, Math.ceil((Math.max(a[0], b[0]) + r) / cell));
    const cy0 = Math.max(gy0, Math.floor((Math.min(a[1], b[1]) - r) / cell));
    const cy1 = Math.min(gy1, Math.ceil((Math.max(a[1], b[1]) + r) / cell));
    for (let gy = cy0; gy < cy1; gy++)
      for (let gx = cx0; gx < cx1; gx++) {
        const k = (gy - gy0) * W + (gx - gx0);
        if (!grid[k] && distToSegment([(gx + 0.5) * cell, (gy + 0.5) * cell], a, b) <= r) grid[k] = 1;
      }
  }
  // runs per row, then equal runs in consecutive rows merged downwards
  const out: Rect[] = [];
  const open = new Map<string, Rect>();
  for (let gy = gy0; gy <= gy1; gy++) {
    const runs: [number, number][] = [];
    let start: number | null = null;
    for (let gx = gx0; gx <= gx1 + 1; gx++) {
      const covered = gy < gy1 && gx <= gx1 && grid[(gy - gy0) * W + (gx - gx0)] === 1;
      if (covered && start === null) start = gx;
      else if (!covered && start !== null) {
        runs.push([start, gx]);
        start = null;
      }
    }
    const keys = new Set(runs.map(([a, b]) => `${a}:${b}`));
    for (const [k, rect] of open)
      if (!keys.has(k)) {
        out.push(rect);
        open.delete(k);
      }
    for (const [a, b] of runs) {
      const k = `${a}:${b}`;
      const rect = open.get(k);
      if (rect) rect[3] = (gy + 1) * cell;
      else open.set(k, [a * cell, gy * cell, b * cell, (gy + 1) * cell]);
    }
  }
  for (const rect of open.values()) out.push(rect);
  return out;
}

/** Is the point inside any of the rectangles? */
export function inRects(rects: Rect[], x: number, y: number): boolean {
  return rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);
}

/** Centre of a quad. */
export function quadCenter(q: Quad | number[]): Point {
  return [(q[0] + q[2] + q[4] + q[6]) / 4, (q[1] + q[3] + q[5] + q[7]) / 4];
}
