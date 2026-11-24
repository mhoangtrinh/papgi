import { describe, it, expect, beforeEach } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";
import { dashPattern, shapeGeometry, type ShapeStyle } from "../src/core/shapes";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const style = (o: Partial<ShapeStyle> = {}): ShapeStyle => ({ color: [1, 0, 0], fill: null, width: 2, line: "solid", opacity: 1, ...o });
const px = (e: PdfEngine, x: number, y: number) => {
  const img = e.render(0, 1);
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.slice(i, i + 3));
};

describe("shape geometry", () => {
  it("Shift keeps boxes square and snaps lines to 45°", () => {
    expect(shapeGeometry("Square", [0, 0], [100, 40], true).rect).toEqual([0, 0, 100, 100]);
    expect(shapeGeometry("Circle", [100, 100], [60, 90], true).rect).toEqual([60, 60, 100, 100]);
    const l = shapeGeometry("Line", [0, 0], [100, 10], true).points[1];
    expect(l[1]).toBeCloseTo(0, 5);
    const d = shapeGeometry("Arrow", [0, 0], [100, 90], true).points[1];
    expect(d[0]).toBeCloseTo(d[1], 5);
  });

  it("triangles and diamonds fill their box", () => {
    expect(shapeGeometry("Triangle", [0, 0], [100, 50]).points).toEqual([[50, 0], [100, 50], [0, 50]]);
    expect(shapeGeometry("Diamond", [0, 0], [100, 50]).points).toEqual([[50, 0], [100, 25], [50, 50], [0, 25]]);
  });

  it("dashes grow with the line width", () => {
    expect(dashPattern("solid", 2)).toBeNull();
    expect(dashPattern("dashed", 2)).toEqual([6, 4]);
    expect(dashPattern("dotted", 4)![0]).toBe(4);
  });
});

describe("shapes in the PDF", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
  });

  it("draws a filled shape without outline, see-through", () => {
    const a = e.drawShape(0, "Square", [100, 300], [200, 400], style({ color: null, fill: [0, 0, 1], opacity: 0.5 }));
    const s = a[0].shape!;
    expect(s.kind).toBe("Square");
    expect(s.color).toBeNull();
    expect(s.fill).toEqual([0, 0, 1]);
    expect(s.opacity).toBeCloseTo(0.5, 2);
    const c = px(e, 150, 350);
    expect(c[2]).toBeGreaterThan(200);
    expect(c[0]).toBeGreaterThan(100); // half see-through over white
  });

  it("draws triangles, diamonds and double arrows and knows them again", () => {
    e.drawShape(0, "Triangle", [100, 300], [200, 400], style({ fill: [0, 1, 0] }));
    e.drawShape(0, "Diamond", [300, 300], [400, 400], style());
    const a = e.drawShape(0, "DoubleArrow", [100, 500], [300, 500], style());
    expect(a.map((x) => x.shape!.kind)).toEqual(["Triangle", "Diamond", "DoubleArrow"]);
    expect(px(e, 150, 380)[1]).toBeGreaterThan(200);
  });

  it("dashed and dotted outlines are remembered; a cloud is a shape of its own", () => {
    e.drawShape(0, "Circle", [100, 300], [200, 400], style({ line: "dashed" }));
    e.drawShape(0, "Square", [300, 300], [400, 400], style({ line: "dotted", width: 3 }));
    const a = e.drawShape(0, "Cloud", [100, 500], [200, 600], style({ line: "dashed" }));
    expect(a.map((x) => x.shape!.line)).toEqual(["dashed", "dotted", "dashed"]);
    expect(a.map((x) => x.shape!.kind)).toEqual(["Circle", "Square", "Cloud"]);
    // a real cloud: an outline of round puffs (not a box with wavy edges)
    const page = mupdf.Document.openDocument(e.save(false), "application/pdf").loadPage(0) as mupdf.PDFPage;
    const cloud = page.getAnnotations()[2];
    expect(cloud.getType()).toBe("Polygon");
    expect(cloud.getVertices().length).toBeGreaterThan(60);
    // restyled, resized or copied, it stays a cloud
    const b = e.styleAnnot(0, a[2].index, { line: "solid", width: 4 });
    expect(b[2].shape!.kind).toBe("Cloud");
    e.resizeAnnot(0, a[2].index, [100, 500, 260, 640]);
    e.copyAnnot(0, a[2].index);
    const p = e.paste(1, [50, 50]);
    expect(p.annots[p.index].shape!.kind).toBe("Cloud");
  });

  it("restyles a shape: only what's given changes, one undo step", () => {
    const a = e.drawShape(0, "Square", [100, 300], [200, 400], style({ line: "dashed" }));
    const b = e.styleAnnot(0, a[0].index, { fill: [1, 1, 0] });
    expect(b[0].shape!.fill).toEqual([1, 1, 0]);
    expect(b[0].shape!.line).toBe("dashed");
    expect(b[0].shape!.color).toEqual([1, 0, 0]);
    expect(e.state().undoName).toBe("Style");
    const c = e.styleAnnot(0, a[0].index, { width: 6 });
    expect(c[0].shape!.width).toBe(6);
    expect(c[0].shape!.line).toBe("dashed");
    e.undo();
    expect(e.listAnnots(0)[0].shape!.width).toBe(2);
  });

  it("a filled shape is erased when rubbed inside, an empty one only on its outline", () => {
    e.drawShape(0, "Square", [100, 300], [200, 400], style({ fill: [0, 0, 1] }));
    e.drawShape(0, "Triangle", [300, 300], [400, 400], style());
    e.erase(0, [[150, 350]], 5, false);
    expect(e.listAnnots(0).map((x) => x.shape!.kind)).toEqual(["Triangle"]);
    e.erase(0, [[350, 380]], 5, false); // inside the empty triangle
    expect(e.listAnnots(0).length).toBe(1);
    e.erase(0, [[350, 400]], 5, false); // its bottom edge
    expect(e.listAnnots(0).length).toBe(0);
  });

  it("copies and moves keep the style", () => {
    const a = e.drawShape(0, "Diamond", [100, 300], [200, 400], style({ fill: [1, 0, 1], line: "dotted", opacity: 0.6 }));
    e.copyAnnot(0, a[0].index);
    const p = e.paste(1, [50, 50]);
    const s = p.annots[p.index].shape!;
    expect([s.kind, s.line, s.fill, Math.round(s.opacity * 10)]).toEqual(["Diamond", "dotted", [1, 0, 1], 6]);
  });
});

describe("resizing items", () => {
  it("resizes a picture, a shape and a drawing; one undo step each", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const png = new Uint8Array(fs.readFileSync(new URL("../public/pwa-192.png", import.meta.url)));
    let a = e.addPicture(0, png, [100, 300, 196, 396]).annots;
    expect(a[0].resizable).toBe(true);
    a = e.resizeAnnot(0, a[0].index, [100, 300, 292, 492]);
    expect(a[0].rect).toEqual([100, 300, 292, 492].map((v) => expect.closeTo(v, 0)));
    // still the picture (not redrawn as a "Draft" stamp)
    expect(px(e, 120, 396)[2]).toBeGreaterThan(px(e, 120, 396)[0] + 60); // the icon's blue, now this far out
    expect(e.state().undoName).toBe("Resize");
    a = e.drawShape(0, "Circle", [300, 300], [400, 400], style({ fill: [0, 0, 1] }));
    a = e.resizeAnnot(0, a[1].index, [300, 300, 500, 350]);
    const c = a[1].rect;
    expect(Math.abs(c[2] - c[0] - 200)).toBeLessThan(2);
    expect(Math.abs(c[3] - c[1] - 50)).toBeLessThan(2);
    a = e.addInk(0, [[[100, 600], [200, 650]]], [0, 0, 0], 2);
    a = e.resizeAnnot(0, a[2].index, [100, 600, 300, 700]);
    expect(a[2].rect[2]).toBeCloseTo(300, 0);
    e.undo();
    expect(e.listAnnots(0)[2].rect[2]).toBeLessThan(210);
  });
});

describe("arrows", () => {
  it("arrowheads stay a sensible size, also after restyling and moving", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    let a = e.drawShape(0, "Arrow", [100, 400], [300, 400], style({ width: 3, color: [0, 0, 0] }));
    const h = (r: number[]) => r[3] - r[1];
    // MuPDF's own heads would make this about 39pt tall
    expect(h(a[0].rect)).toBeLessThan(18);
    expect(a[0].shape!.kind).toBe("Arrow");
    // the head is drawn at the tip
    expect(px(e, 296, 400)).toEqual([0, 0, 0].map(() => expect.any(Number)));
    expect(px(e, 296, 400)[0]).toBeLessThan(100);
    expect(px(e, 292, 403)[0]).toBeLessThan(140);
    a = e.styleAnnot(0, a[0].index, { width: 6 });
    expect(h(a[0].rect)).toBeLessThan(30);
    a = e.moveAnnot(0, a[0].index, 0, 50);
    expect(h(a[0].rect)).toBeLessThan(30);
    expect(px(e, 200, 450)[0]).toBeLessThan(100);
    const d = e.drawShape(0, "DoubleArrow", [100, 600], [300, 600], style({ width: 2, line: "dashed", opacity: 0.5 }));
    expect(d[1].shape!.kind).toBe("DoubleArrow");
    expect(d[1].shape!.line).toBe("dashed");
    expect(h(d[1].rect)).toBeLessThan(14);
  });
});
