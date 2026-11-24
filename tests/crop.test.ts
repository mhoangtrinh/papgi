import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));

describe("crop", () => {
  it("cuts margins off pages as seen; one undo step; saved as a CropBox", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const before = e.info().pages[0];
    const info = e.cropPages([0, 1], { margins: [50, 100, 50, 200] });
    expect(info.pages[0].w).toBeCloseTo(before.w - 100, 0);
    expect(info.pages[0].h).toBeCloseTo(before.h - 300, 0);
    expect(info.pages[2].h).toBeCloseTo(before.h, 0);
    expect(e.pageBoxes(0).cropped).toBe(true);
    expect(e.state().undoName).toBe("Crop");
    // the heading (top band) is cut off, the sentence stays
    const saved = mupdf.Document.openDocument(e.save(), "application/pdf") as mupdf.PDFDocument;
    const p = saved.loadPage(0);
    expect(p.getBounds()[3]).toBeCloseTo(before.h - 300, 0);
    expect(p.getObject().get("CropBox").isArray()).toBe(true);
    e.undo();
    expect(e.info().pages[0].h).toBeCloseTo(before.h, 0);
  });

  it("works as seen on a turned page", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.rotatePages([0], 90);
    const b = e.info().pages[0]; // wide
    const info = e.cropPages([0], { margins: [100, 0, 0, 0] }); // cut the left 100 as seen
    expect(info.pages[0].w).toBeCloseTo(b.w - 100, 0);
    expect(info.pages[0].h).toBeCloseTo(b.h, 0);
  });

  it("trims white margins to what's printed, and can be removed again", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const full = e.info().pages[1];
    const c = e.contentBox(1)!;
    expect(c[0]).toBeGreaterThanOrEqual(0);
    const info = e.cropPages([1], { trim: 10 });
    const p = info.pages[1];
    expect(p.w).toBeLessThanOrEqual(full.w);
    expect(p.h).toBeLessThan(full.h * 0.5);
    expect(e.pageText(1)).toContain("page 2 of 5");
    const back = e.cropPages([1], { reset: true });
    expect(back.pages[1].h).toBeCloseTo(full.h, 0);
    expect(e.pageBoxes(1).cropped).toBe(false);
  });

  it("refuses a crop that leaves almost nothing; no step when nothing changes", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const b = e.info().pages[0];
    expect(() => e.cropPages([0], { margins: [b.w / 2, 0, b.w / 2 - 10, 0] })).toThrow(/too small/);
    e.cropPages([0], { margins: [0, 0, 0, 0] });
    expect(e.state().canUndo).toBe(false);
  });
});
