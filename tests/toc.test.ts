import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";
import { currentItem, headingsToc, type TextLine } from "../src/core/toc";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));

let blk = 0;
const L = (page: number, y: number, text: string, size = 10, bold = false, lines = 1): TextLine => ({ page, y, size, bold, text, block: blk++, first: true, lines });
const body = (page: number, y: number) => L(page, y, "Body text that goes on for a while, as body text does in any document of some length.", 10, false, 5);

describe("table of contents from headings", () => {
  it("finds sized and numbered headings with levels, skipping front matter and running headers", () => {
    const lines: TextLine[] = [
      L(0, 50, "A Study of Things", 20),
      L(0, 80, "J. Doe", 12),
      L(0, 95, "March 2026", 12),
      L(0, 120, "1 Introduction", 14, true),
      body(0, 140),
      L(1, 20, "Journal of Things 2026", 8),
      L(1, 60, "2 Method", 14, true),
      body(1, 80),
      L(1, 200, "2.1 Setup", 11, true),
      body(1, 220),
      L(2, 20, "Journal of Things 2026", 8),
      L(2, 60, "3 Results", 14, true),
      body(2, 80),
      L(3, 20, "Journal of Things 2026", 8),
      body(3, 80),
    ];
    const toc = headingsToc(lines, 4);
    expect(toc.map((t) => [t.title, t.level])).toEqual([
      ["A Study of Things", 0],
      ["1 Introduction", 0],
      ["2 Method", 0],
      ["2.1 Setup", 1],
      ["3 Results", 0],
    ]);
    expect(toc[3].page).toBe(1);
    expect(toc[3].y).toBe(200);
  });

  it("joins a heading set over two lines, and ignores bold table headers", () => {
    const lines: TextLine[] = [
      L(0, 50, "A Long Title That Wraps", 18),
      L(0, 72, "onto a Second Line", 18),
      L(0, 120, "Name", 10, true),
      L(0, 120, "Amount", 10, true),
      L(0, 120, "Date", 10, true),
      body(0, 140),
      L(0, 300, "Summary", 14),
      body(0, 320),
    ];
    expect(headingsToc(lines, 1).map((t) => t.title)).toEqual(["A Long Title That Wraps onto a Second Line", "Summary"]);
  });

  it("keeps chapters numbered the same way on every page, but not a big running title", () => {
    const lines: TextLine[] = [];
    for (let p = 0; p < 6; p++) {
      lines.push(L(p, 20, "ANNUAL REPORT", 14, true));
      lines.push(L(p, 60, `Chapter ${p + 1}: Results of part ${p + 1}`, 18, true));
      lines.push(body(p, 100), body(p, 200));
      lines.push(L(p, 780, `Page ${p + 1}`, 9));
    }
    const toc = headingsToc(lines, 6);
    expect(toc.map((t) => t.title)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Chapter ${n}: Results of part ${n}`));
  });

  it("finds nothing in plain text", () => {
    expect(headingsToc([body(0, 10), body(0, 100), body(1, 10)], 2)).toEqual([]);
  });

  it("knows which section a page is in", () => {
    const items = [
      { title: "a", page: 0, y: 10, level: 0 },
      { title: "b", page: 2, y: 300, level: 0 },
    ];
    expect(currentItem(items, 0)).toBe(0);
    expect(currentItem(items, 2, 100)).toBe(0);
    expect(currentItem(items, 2)).toBe(1);
    expect(currentItem(items, 5)).toBe(1);
    // two columns: the right column's heading (higher up) isn't reached while reading the left one
    const cols = [
      { title: "Intro", page: 0, y: 100, level: 0 },
      { title: "Method", page: 0, y: 400, level: 0 },
      { title: "Results", page: 0, y: 80, level: 0 },
    ];
    expect(currentItem(cols, 0, 300)).toBe(0);
    expect(currentItem(cols, 1)).toBe(2);
  });

  it("works on a real paper", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const toc = headingsToc(e.textLines([0]), 1);
    expect(toc.map((t) => t.title)).toEqual(["A Low-Power Bandgap Reference with Curvature Correction", "Abstract", "Introduction", "Circuit Design", "Operational Amplifier", "Measurement Results", "Conclusion", "References"]);
    expect(toc.find((t) => t.title === "Operational Amplifier")!.level).toBe(1);
  });

  it("reads the PDF's own bookmarks", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("report.pdf"));
    const o = e.outline()!;
    expect(o.length).toBe(2);
    expect(o[0].page).toBe(0);
    expect(o[0].title).toBeTruthy();
    e.open(sample("pages.pdf"));
    expect(e.outline()).toBeNull();
  });
});
