import { describe, expect, it } from "vitest";
import { thumbLayout, thumbsToDrop } from "../src/ui/sidebar";

const A4 = 297 / 210;

describe("thumbLayout (pages panel)", () => {
  it("pages never get smaller when the panel gets wider", () => {
    for (const count of [1, 2, 3, 5, 12, 80]) {
      for (const tile of [100, 200, 320]) {
        let prev = 0;
        for (let w = 100; w <= 1200; w += 7) {
          const { width } = thumbLayout(w, 700, count, A4, tile);
          expect(width, `count ${count}, tile ${tile}, w ${w}`).toBeGreaterThanOrEqual(prev);
          prev = width;
        }
      }
    }
  });

  it("many pages: columns of the chosen size", () => {
    expect(thumbLayout(150, 700, 40, A4, 200)).toEqual({ cols: 1, width: 150 });
    expect(thumbLayout(408, 700, 40, A4, 200)).toEqual({ cols: 2, width: 200 });
    expect(thumbLayout(408, 700, 40, A4, 120).cols).toBe(3);
  });

  it("a few pages grow as big as they fit", () => {
    // 2 pages in a tall wide panel: one column, bigger than the chosen size
    const r = thumbLayout(500, 900, 2, A4, 200);
    expect(r.cols).toBe(1);
    expect(r.width).toBeGreaterThan(280);
    // one page fills the width
    expect(thumbLayout(400, 900, 1, A4, 200).width).toBe(400);
  });
});

describe("thumbsToDrop (long PDFs: page pictures in the panel are kept within a budget)", () => {
  const mb = 1e6;
  it("keeps everything under the budget", () => {
    expect(thumbsToDrop([{ bytes: 10 * mb, near: true }, { bytes: 10 * mb, near: false }], 48 * mb)).toEqual([]);
  });
  it("lets go of the ones farthest from view first, never the ones near it", () => {
    // 100 pages of 1 MB, pages 40-45 in view
    const thumbs = Array.from({ length: 100 }, (_, i) => ({ bytes: mb, near: i >= 40 && i <= 45 }));
    const drop = thumbsToDrop(thumbs, 48 * mb);
    expect(drop.length).toBe(100 - 36);
    expect(drop.some((i) => i >= 40 && i <= 45)).toBe(false);
    expect(drop[0]).toBe(99);
    // what stays is around the view
    const kept = thumbs.map((_, i) => i).filter((i) => !drop.includes(i));
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...kept)).toBeLessThanOrEqual(66);
  });
  it("skips pictures not drawn yet", () => {
    const thumbs = [{ bytes: 0, near: false }, { bytes: 60 * mb, near: false }, { bytes: 0, near: true }];
    expect(thumbsToDrop(thumbs, 48 * mb)).toEqual([1]);
  });
});
