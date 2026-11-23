// Shapes: kinds, styles and their geometry (pure).
import type { Point, Rect } from "./geometry";

export type ShapeKind = "Square" | "Circle" | "Triangle" | "Diamond" | "Line" | "Arrow" | "DoubleArrow";
export type LineStyle = "solid" | "dashed" | "dotted" | "cloudy";

export const SHAPE_KINDS: ShapeKind[] = ["Square", "Circle", "Triangle", "Diamond", "Line", "Arrow", "DoubleArrow"];

/** How a shape is drawn. Colours are RGB 0..1; null = none. */
export interface ShapeStyle {
  color: number[] | null; // outline
  fill: number[] | null;
  width: number;
  line: LineStyle;
  opacity: number; // 0.1..1
}

export const isLineKind = (k: ShapeKind) => k === "Line" || k === "Arrow" || k === "DoubleArrow";

/**
 * The drag from a to b as a shape: its box, or its points (polygons and lines).
 * With `square`, boxes become squares/circles and lines snap to 45° steps.
 */
export function shapeGeometry(kind: ShapeKind, a: Point, b: Point, square = false): { rect: Rect; points: Point[] } {
  let [bx, by] = b;
  if (square) {
    if (isLineKind(kind)) {
      const ang = Math.round(Math.atan2(by - a[1], bx - a[0]) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(bx - a[0], by - a[1]);
      bx = a[0] + Math.cos(ang) * len;
      by = a[1] + Math.sin(ang) * len;
    } else {
      const s = Math.max(Math.abs(bx - a[0]), Math.abs(by - a[1]));
      bx = a[0] + Math.sign(bx - a[0] || 1) * s;
      by = a[1] + Math.sign(by - a[1] || 1) * s;
    }
  }
  const rect: Rect = [Math.min(a[0], bx), Math.min(a[1], by), Math.max(a[0], bx), Math.max(a[1], by)];
  const [x0, y0, x1, y1] = rect;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let points: Point[];
  switch (kind) {
    case "Triangle":
      points = [[cx, y0], [x1, y1], [x0, y1]];
      break;
    case "Diamond":
      points = [[cx, y0], [x1, cy], [cx, y1], [x0, cy]];
      break;
    case "Line":
    case "Arrow":
    case "DoubleArrow":
      points = [a, [bx, by]];
      break;
    default:
      points = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  }
  return { rect, points };
}

/** Dash pattern for a line style at a line width (points), or null for a solid line. */
export function dashPattern(line: LineStyle, width: number): number[] | null {
  const w = Math.max(width, 0.5);
  if (line === "dashed") return [Math.max(3, w * 3), Math.max(2, w * 2)];
  if (line === "dotted") return [w, Math.max(1.5, w * 1.5)];
  return null;
}

/** Big enough to keep (not a slip of the pointer)? Sizes in screen pixels. */
export function shapeBigEnough(kind: ShapeKind, rect: Rect, zoom: number): boolean {
  const w = (rect[2] - rect[0]) * zoom;
  const h = (rect[3] - rect[1]) * zoom;
  return isLineKind(kind) ? Math.hypot(w, h) >= 6 : w >= 4 && h >= 4 && Math.hypot(w, h) >= 6;
}
