import { describe, it, expect, beforeEach } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";
import { brushRects, eraseStroke, brushTouchesOutline } from "../src/core/erase";
import type { Point, Rect } from "../src/core/geometry";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));

/** Text of a page in a saved file (what other apps will see). */
function savedText(bytes: Uint8Array, page: number): string {
  const d = new mupdf.PDFDocument(bytes);
  const p = d.loadPage(page);
  const t = p.toStructuredText("").asText();
  const annots = p.getAnnotations().map((a) => a.getType());
  d.destroy();
  return t + (annots.length ? `\n[annots: ${annots.join(",")}]` : "");
}

/** Is anything (not white) drawn in this part of the rendered page? */
function inked(e: PdfEngine, index: number, r: Rect): boolean {
  const img = e.render(index, 1);
  for (let y = Math.floor(r[1]); y < r[3]; y++)
    for (let x = Math.floor(r[0]); x < r[2]; x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] + img.data[i + 1] + img.data[i + 2] < 600) return true;
    }
  return false;
}

/** Is this part of the rendered page one plain colour (nothing drawn on it)? */
function plain(e: PdfEngine, index: number, r: Rect): boolean {
  const img = e.render(index, 1);
  const i0 = (Math.floor(r[1]) * img.width + Math.floor(r[0])) * 4;
  const c0 = [img.data[i0], img.data[i0 + 1], img.data[i0 + 2]];
  for (let y = Math.floor(r[1]); y < r[3]; y++)
    for (let x = Math.floor(r[0]); x < r[2]; x++) {
      const i = (y * img.width + x) * 4;
      if (Math.abs(img.data[i] - c0[0]) + Math.abs(img.data[i + 1] - c0[1]) + Math.abs(img.data[i + 2] - c0[2]) > 12) return false;
    }
  return true;
}

// pages.pdf: "Page N" heading at about (50,42)-(178,97), a sentence at y 157-173
const HEADING: Rect = [45, 40, 185, 100];

describe("copy and paste parts of a page", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
  });

  it("copies an area as vector content and pastes it on another page", () => {
    const info = e.copyArea(0, HEADING)!;
    expect(info.label).toBe("part of the page");
    expect(info.w).toBeGreaterThan(120);
    const res = e.paste(2, [300, 500]);
    const a = res.annots[res.index];
    expect(a.area).toBe(true);
    expect(a.rect[0]).toBeCloseTo(300, 0);
    expect(a.rect[1]).toBeCloseTo(500, 0);
    expect(inked(e, 2, [300, 500, 420, 550])).toBe(true);
    // the source is untouched
    expect(e.pageText(0)).toContain("Page 1");
    // saved: the pasted part is page content, with real text
    const out = e.save();
    const t = savedText(out, 2);
    expect(t).toContain("Page 1");
    expect(t).toContain("Page 3");
    expect(t).not.toContain("annots");
    // and still only the copied part: the sentence of page 1 didn't come along
    expect(t).not.toContain("page 1 of 5");
  });

  it("returns null for an empty area", () => {
    expect(e.copyArea(0, [400, 600, 500, 700])).toBeNull();
  });

  it("cut removes exactly the text inside and leaves the rest", () => {
    const r = e.cutArea(0, HEADING)!;
    expect(r).not.toBeNull();
    const text = e.pageText(0);
    expect(text).not.toContain("Page 1");
    expect(text).toContain("This is page 1 of 5");
    expect(plain(e, 0, [50, 45, 175, 95])).toBe(true);
    expect(e.state().undoName).toBe("Cut");
    e.undo();
    expect(e.pageText(0)).toContain("Page 1");
  });

  it("fills a cut in a coloured band with the band's colour, and with white on paper", () => {
    e.cutArea(0, [60, 50, 120, 90]); // inside the red band at the top
    const img = e.render(0, 1);
    const at = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    at(90, 70).forEach((v, k) => expect(Math.abs(v - at(30, 70)[k])).toBeLessThan(4));
    expect(at(90, 70)[0]).toBeGreaterThan(200);
    expect(at(90, 70)[1]).toBeLessThan(120);
    e.cutArea(0, [40, 150, 450, 180]); // the sentence on white paper
    const img2 = e.render(0, 1);
    const i = (165 * img2.width + 200) * 4;
    expect(Array.from(img2.data.slice(i, i + 3))).toEqual([255, 255, 255]);
  });

  it("moves an area in one undo step, and the moved part can move again", () => {
    const m = e.moveArea(0, HEADING, 0, [300, 600])!;
    expect(m.index).toBeGreaterThanOrEqual(0);
    expect(plain(e, 0, [50, 45, 175, 95])).toBe(true);
    expect(inked(e, 0, [300, 600, 430, 660])).toBe(true);
    // moving the pasted part again doesn't redraw it as a "Draft" stamp
    e.moveAnnot(0, m.index, 0, 50);
    expect(inked(e, 0, [300, 650, 430, 710])).toBe(true);
    const t = savedText(e.save(), 0);
    expect(t).toContain("Page 1");
    expect(t).not.toContain("Draft");
    e.undo();
    e.undo();
    expect(e.state().canUndo).toBe(false);
    expect(plain(e, 0, [50, 45, 175, 95])).toBe(false);
  });

  it("pastes into another document (the clipboard survives opening a file)", () => {
    e.copyArea(0, HEADING);
    e.open(sample("report.pdf"));
    expect(e.clipInfo()).not.toBeNull();
    const res = e.paste(0, null);
    expect(res.annots[res.index].area).toBe(true);
    expect(savedText(e.save(), 0)).toContain("Page 1");
  });

  it("keeps letters whole at the edge: they go where their middle is", () => {
    // a box ending in the middle of the heading's last character
    const r: Rect = [45, 40, 160, 100];
    const before = e.pageText(0);
    e.cutArea(0, r);
    const after = e.pageText(0);
    expect(before).toContain("Page 1");
    // "1" (centre right of 160) stays, the rest goes
    expect(after).toMatch(/^\s*1/m);
    expect(after).not.toContain("Page");
  });
});

describe("copy, cut and duplicate added items", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
  });

  it("copies a drawing and pastes it where it was, a little lower each time", () => {
    const annots = e.addInk(0, [[[100, 300], [200, 320]]], [0, 0, 1], 2);
    const ink = annots[annots.length - 1];
    e.copyAnnot(0, ink.index);
    const p1 = e.paste(0);
    const p2 = e.paste(0);
    expect(p2.annots.length).toBe(3);
    const r1 = p1.annots[p1.index].rect;
    const r2 = p2.annots[p2.index].rect;
    expect(r1[1] - ink.rect[1]).toBeCloseTo(12, 0);
    expect(r2[1] - ink.rect[1]).toBeCloseTo(24, 0);
    // on another page: same place
    const p3 = e.paste(1);
    expect(p3.annots[p3.index].rect[0]).toBeCloseTo(ink.rect[0], 0);
  });

  it("cut takes the item away and paste brings it back", () => {
    const annots = e.addFreeText(0, [100, 400], "Hello there", 14, [0, 0, 0]);
    const r = e.cutAnnot(0, annots[0].index);
    expect(r.annots.length).toBe(0);
    expect(r.clip.label).toBe("text box");
    const p = e.paste(3, [50, 50]);
    expect(p.annots[p.index].kind).toBe("FreeText");
    expect(p.annots[p.index].contents).toBe("Hello there");
  });

  it("duplicates an image stamp without touching the clipboard, keeping its picture", () => {
    const png = fs.readFileSync(new URL("../public/pwa-192.png", import.meta.url));
    const a = e.addImageStamp(0, [100, 100, 160, 160], new Uint8Array(png));
    expect(e.clipInfo()).toBeNull();
    const d = e.duplicateAnnot(0, a[0].index);
    expect(e.clipInfo()).toBeNull();
    expect(d.annots.length).toBe(2);
    expect(d.annots[d.index].rect[0]).toBeCloseTo(112, 0);
    // still the picture, not a "Draft" stamp
    expect(savedText(e.save(), 0)).not.toContain("Draft");
  });

  it("pastes a picture", () => {
    const png = fs.readFileSync(new URL("../public/pwa-192.png", import.meta.url));
    const r = e.addPicture(0, new Uint8Array(png), [200, 200, 296, 296]);
    expect(r.annots[r.index].kind).toBe("Stamp");
    expect(r.annots[r.index].rect[2]).toBeCloseTo(296, 0);
  });
});

describe("eraser", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
  });

  it("rubs out the middle of a drawn line, leaving two pieces", () => {
    const before = e.addInk(0, [[[100, 300], [300, 300]]], [0, 0, 1], 2);
    const after = e.erase(0, [[200, 290], [200, 310]], 6, false);
    expect(after.length).toBe(1);
    expect(after[0].rect[2]).toBeCloseTo(before[0].rect[2], 0);
    expect(inked(e, 0, [195, 297, 205, 303])).toBe(false);
    expect(inked(e, 0, [120, 297, 130, 303])).toBe(true);
    expect(e.state().undoName).toBe("Erase");
  });

  it("removes other items it touches, and does nothing (no undo step) when it misses", () => {
    e.addShape(0, "Square", [100, 400, 200, 500], [1, 0, 0], 2);
    e.erase(0, [[150, 450]], 5, false); // inside the empty box: misses the outline
    expect(e.listAnnots(0).length).toBe(1);
    expect(e.state().undoName).toBe("Shape");
    e.erase(0, [[100, 450]], 5, false);
    expect(e.listAnnots(0).length).toBe(0);
  });

  it("in 'everything' mode also erases what's printed, and keeps added items elsewhere", () => {
    e.addInk(0, [[[300, 600], [400, 600]]], [0, 0, 1], 2);
    const path: Point[] = [[40, 70], [200, 70]];
    e.erase(0, path, 25, true);
    expect(e.pageText(0)).not.toContain("Page 1");
    expect(e.pageText(0)).toContain("This is page 1 of 5");
    expect(e.listAnnots(0).length).toBe(1);
    const t = savedText(e.save(), 0);
    expect(t).not.toContain("Page 1");
  });

  it("erasing on a pasted part of a page rubs out only that part of it", () => {
    e.copyArea(0, HEADING);
    const p = e.paste(1, [100, 500]);
    expect(p.annots[p.index].area).toBe(true);
    e.erase(1, [[100, 510], [100, 560]], 4, true);
    // it became page content; the rest of it is still there
    expect(e.listAnnots(1).filter((a) => a.area).length).toBe(0);
    expect(inked(e, 1, [140, 505, 230, 555])).toBe(true);
  });
});

describe("eraser geometry", () => {
  it("splits a stroke where the brush passes", () => {
    const pieces = eraseStroke([[0, 0], [100, 0]], [[50, -10], [50, 10]], 5);
    expect(pieces.length).toBe(2);
    expect(pieces[0][pieces[0].length - 1][0]).toBeLessThan(46);
    expect(pieces[1][0][0]).toBeGreaterThan(54);
  });

  it("keeps an untouched stroke as it is", () => {
    const s: Point[] = [[0, 0], [100, 0]];
    const out = eraseStroke(s, [[50, 30]], 5);
    expect(out[0]).toBe(s);
  });

  it("covers the brush path with a few rectangles", () => {
    const rects = brushRects([[0, 0], [100, 0]], 5);
    expect(rects.length).toBeLessThan(20);
    const covers = (x: number, y: number) => rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]);
    expect(covers(50, 0)).toBe(true);
    expect(covers(0, 4)).toBe(true);
    expect(covers(50, 8)).toBe(false);
  });

  it("finds the outline of a box but not its inside", () => {
    expect(brushTouchesOutline([[50, 50]], 5, [0, 0, 100, 100], false)).toBe(false);
    expect(brushTouchesOutline([[2, 50]], 5, [0, 0, 100, 100], false)).toBe(true);
    expect(brushTouchesOutline([[50, 50]], 5, [0, 0, 100, 100], true)).toBe(false);
    expect(brushTouchesOutline([[50, 1]], 5, [0, 0, 100, 100], true)).toBe(true);
  });
});
