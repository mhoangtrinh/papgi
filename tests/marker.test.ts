import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const reopen = (e: PdfEngine) => mupdf.Document.openDocument(e.save(false), "application/pdf") as mupdf.PDFDocument;
/** The blend modes in an annotation's look. */
const blends = (a: mupdf.PDFAnnotation) => {
  const out: string[] = [];
  const gs = a.getObject().get("AP", "N", "Resources", "ExtGState");
  if (gs.isDictionary()) gs.forEach((g) => g.get("BM").isName() && out.push(g.get("BM").asName()));
  return out;
};

describe("the freehand highlighter", () => {
  it("a wide see-through stroke that multiplies (text under it stays dark), also after the eraser cuts it", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    // over the line of text at the top of page 1
    const line = e.info().pages[0];
    const y = line.y + 125;
    e.addMarker(0, [[line.x + 60, y], [line.x + 400, y]], [1, 0.85, 0], 14);
    let a = reopen(e).loadPage(0).getAnnotations()[0];
    expect(a.getType()).toBe("Ink");
    expect(a.getOpacity()).toBeCloseTo(0.5);
    expect(blends(a)).toContain("Multiply");
    e.erase(0, [[line.x + 200, y - 10], [line.x + 200, y + 10]], 3, false);
    a = reopen(e).loadPage(0).getAnnotations()[0];
    expect(a.getInkList().length).toBe(2);
    expect(blends(a)).toContain("Multiply");
    // recoloured: still a marker
    e.setAnnotColor(0, e.listAnnots(0)[0].index, [0.5, 1, 0.5]);
    expect(blends(reopen(e).loadPage(0).getAnnotations()[0])).toContain("Multiply");
  });
});
