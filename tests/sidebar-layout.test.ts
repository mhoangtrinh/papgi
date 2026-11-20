import { describe, expect, it } from "vitest";
import { thumbLayout } from "../src/ui/sidebar";

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
