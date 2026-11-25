import { describe, it, expect } from "vitest";
import {
  toPage, toScreen, normRect, quadToRect, unionRects, simplifyStroke, placeStrokes, strokesBounds, nextZoom, translateQuad, inRect, markLine, quadPoints,
  type Point, type Quad,
} from "../src/core/geometry";
import { clickPage, emptySelection, moveOrder, movedSelection, afterDelete, parseRange, formatRange } from "../src/core/pages";

describe("geometry", () => {
  const v = { scale: 2, originX: 10, originY: 20 };
  it("converts between screen and page space", () => {
    expect(toScreen(v, 10, 20)).toEqual([0, 0]);
    expect(toPage(v, 100, 50)).toEqual([60, 45]);
    const [x, y] = toScreen(v, ...toPage(v, 33, 77));
    expect(x).toBeCloseTo(33);
    expect(y).toBeCloseTo(77);
  });
  it("normalises rects and quads", () => {
    expect(normRect(5, 9, 1, 2)).toEqual([1, 2, 5, 9]);
    const q: Quad = [0, 0, 10, 0, 0, 5, 10, 5];
    expect(quadToRect(q)).toEqual([0, 0, 10, 5]);
    expect(translateQuad(q, 1, 2)).toEqual([1, 2, 11, 2, 1, 7, 11, 7]);
    expect(unionRects([[0, 0, 1, 1], [5, -2, 6, 3]])).toEqual([0, -2, 6, 3]);
    expect(unionRects([])).toBeNull();
    expect(inRect([0, 0, 10, 10], 11, 5, 2)).toBe(true);
    expect(inRect([0, 0, 10, 10], 13, 5, 2)).toBe(false);
  });
  it("simplifies strokes but keeps their shape", () => {
    const line: Point[] = Array.from({ length: 50 }, (_, i) => [i, i * 0.5]);
    expect(simplifyStroke(line)).toEqual([[0, 0], [49, 24.5]]);
    const corner: Point[] = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
    expect(simplifyStroke(corner)).toEqual([[0, 0], [10, 0], [10, 10]]);
    expect(simplifyStroke([[1, 1]])).toEqual([[1, 1]]);
  });
  it("places a signature centred with the requested width", () => {
    const sig: Point[][] = [[[0, 0], [100, 50]], [[20, 10], [80, 40]]];
    const placed = placeStrokes(sig, 300, 400, 150);
    const b = strokesBounds(placed)!;
    expect(b[2] - b[0]).toBeCloseTo(150);
    expect(b[3] - b[1]).toBeCloseTo(75);
    expect((b[0] + b[2]) / 2).toBeCloseTo(300);
    expect((b[1] + b[3]) / 2).toBeCloseTo(400);
  });
  it("steps through zoom levels", () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
    expect(nextZoom(1.17, 1)).toBe(1.25);
    expect(nextZoom(5, 1)).toBe(5);
    expect(nextZoom(0.25, -1)).toBe(0.25);
  });
});

describe("page selection and ordering", () => {
  it("handles click, ctrl-click and shift-click", () => {
    let s = clickPage(emptySelection(), 2, {});
    expect(s.selected).toEqual([2]);
    s = clickPage(s, 5, { toggle: true });
    expect(s.selected).toEqual([2, 5]);
    s = clickPage(s, 5, { toggle: true });
    expect(s.selected).toEqual([2]);
    s = clickPage(clickPage(emptySelection(), 3, {}), 1, { shift: true });
    expect(s.selected).toEqual([1, 2, 3]);
  });
  it("moves pages to a target position", () => {
    expect(moveOrder(5, [4], 0)).toEqual([4, 0, 1, 2, 3]);
    expect(moveOrder(5, [0], 5)).toEqual([1, 2, 3, 4, 0]);
    expect(moveOrder(5, [1, 3], 0)).toEqual([1, 3, 0, 2, 4]);
    expect(moveOrder(5, [0, 1], 3)).toEqual([2, 0, 1, 3, 4]);
    expect(moveOrder(5, [2], 2)).toEqual([0, 1, 2, 3, 4]);
    expect(moveOrder(5, [2], 3)).toEqual([0, 1, 2, 3, 4]);
    const order = moveOrder(5, [1, 3], 0);
    expect(movedSelection(order, [1, 3])).toEqual([0, 1]);
  });
  it("picks the page to show after deleting", () => {
    expect(afterDelete(5, [1, 2])).toBe(1);
    expect(afterDelete(5, [4])).toBe(3);
    expect(afterDelete(2, [0, 1])).toBe(-1);
  });
  it("parses and formats page ranges", () => {
    expect(parseRange("1-3, 5", 6)).toEqual([0, 1, 2, 4]);
    expect(parseRange("4-", 6)).toEqual([3, 4, 5]);
    expect(parseRange("2", 6)).toEqual([1]);
    expect(parseRange("0", 6)).toBeNull();
    expect(parseRange("3-2", 6)).toBeNull();
    expect(parseRange("abc", 6)).toBeNull();
    expect(parseRange("", 6)).toBeNull();
    expect(formatRange([0, 1, 2, 4, 6, 7])).toBe("1-3, 5, 7-8");
  });
});

describe("underline / strike-out lines follow the text", () => {
  it("upright text: a horizontal line near the bottom", () => {
    const q: Quad = [10, 0, 50, 0, 10, 10, 50, 10]; // ul, ur, ll, lr
    const u = markLine(q, "Underline");
    expect(u.a[1]).toBeCloseTo(9.2);
    expect(u.b).toEqual([50, u.a[1]]);
    expect(u.a[0]).toBe(10);
  });
  it("on a page turned by 90°: a vertical line, beside the letters' baseline", () => {
    // text running downwards; the letters' bottom is towards smaller x
    const q: Quad = [20, 10, 20, 50, 10, 10, 10, 50];
    const u = markLine(q, "Underline");
    expect(u.a[0]).toBeCloseTo(10.8);
    expect(u.b[0]).toBeCloseTo(10.8);
    expect([u.a[1], u.b[1]]).toEqual([10, 50]);
    expect(u.width).toBeCloseTo(0.7);
  });
  it("on a page turned by 180°: the strike-out stays inside the letters", () => {
    const q: Quad = [50, 10, 10, 10, 50, 0, 10, 0];
    const s = markLine(q, "StrikeOut");
    expect(s.a[1]).toBeCloseTo(4.5);
    expect(quadPoints(q)).toBe("50,10 10,10 10,0 50,0");
  });
});
