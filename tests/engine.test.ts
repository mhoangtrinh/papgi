import { describe, it, expect, beforeEach } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));

function firstLine(e: PdfEngine, page: number) {
  return e.pageText(page).trim().split("\n")[0];
}

describe("PdfEngine: documents", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
  });

  it("opens a PDF and reports pages", () => {
    const info = e.open(sample("pages.pdf"), "pages.pdf")!;
    expect(info.pageCount).toBe(5);
    expect(info.pages[0].w).toBeCloseTo(595.28, 1);
    expect(info.pages[0].h).toBeCloseTo(841.89, 1);
    expect(info.dirty).toBe(false);
    expect(info.canUndo).toBe(false);
  });

  it("rejects non-PDF data and keeps the open document", () => {
    e.open(sample("pages.pdf"));
    expect(() => e.open(new TextEncoder().encode("hello"), "x.txt")).toThrow();
    expect(e.info().pageCount).toBe(5);
  });

  it("renders a page to RGBA at the requested scale", () => {
    e.open(sample("pages.pdf"));
    const img = e.render(0, 0.5);
    expect(img.width).toBe(Math.ceil(595.28 * 0.5));
    expect(img.height).toBe(Math.ceil(841.89 * 0.5));
    expect(img.data.length).toBe(img.width * img.height * 4);
    // top band of page 1 is red (#e63946), bottom area white
    const px = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
    const close = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);
    expect(close(px(5, 5), [0xe6, 0x39, 0x46, 255])).toBe(true);
    expect(px(5, img.height - 5)).toEqual([255, 255, 255, 255]);
  });

  it("renders exactly like MuPDF's own page renderer", () => {
    e.open(sample("paper.pdf"));
    for (const scale of [0.5, 1.5]) {
      const img = e.render(0, scale);
      const doc = mupdf.Document.openDocument(sample("paper.pdf"), "application/pdf");
      const ref = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      expect(img.width).toBe(ref.getWidth());
      expect(img.height).toBe(ref.getHeight());
      const rp = ref.getPixels();
      let diff = 0;
      for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) diff += Math.abs(img.data[i] - rp[j]) + Math.abs(img.data[i + 1] - rp[j + 1]);
      expect(diff / (img.width * img.height)).toBeLessThan(0.5);
    }
  });

  it("extracts, selects and copies text from the paper", () => {
    e.open(sample("paper.pdf"));
    expect(e.pageText(0)).toContain("Bandgap Reference");
    const hits = e.search("bandgap");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    const q = hits[0].quads[0];
    // select across the first hit's quad
    const quads = e.selectText(0, [q[0] + 0.5, (q[1] + q[5]) / 2], [q[6] - 0.5, (q[3] + q[7]) / 2]);
    expect(quads.length).toBeGreaterThan(0);
    expect(e.copyText(0, [q[0] + 0.5, (q[1] + q[5]) / 2], [q[6] - 0.5, (q[3] + q[7]) / 2]).toLowerCase()).toContain("andga");
    expect(e.hasTextAt(0, [(q[0] + q[2]) / 2, (q[1] + q[5]) / 2])).toBe(true);
    expect(e.hasTextAt(0, [3, 3])).toBe(false);
  });

  it("finds no text in the scanned page (needs OCR later)", () => {
    e.open(sample("scan.pdf"));
    expect(e.pageText(0).trim()).toBe("");
  });
});

describe("PdfEngine: annotations, undo and save", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
  });

  it("adds a highlight, undoes and redoes it", () => {
    const hit = e.search("Voltage references")[0];
    const annots = e.addMarkup(hit.page, "Highlight", hit.quads, [1, 0.85, 0]);
    expect(annots).toHaveLength(1);
    expect(annots[0].kind).toBe("Highlight");
    expect(e.info().dirty).toBe(true);
    let info = e.undo();
    expect(e.listAnnots(0)).toHaveLength(0);
    expect(info.dirty).toBe(false);
    info = e.redo();
    expect(e.listAnnots(0)).toHaveLength(1);
    expect(info.dirty).toBe(true);
  });

  it("adds ink, shapes, arrows and text boxes", () => {
    e.addInk(0, [[[100, 100], [150, 120], [200, 100]]], [0, 0, 1], 2);
    e.addShape(0, "Square", [50, 50, 150, 100], [1, 0, 0], 1.5);
    e.addShape(0, "Circle", [200, 50, 260, 100], [0, 0.6, 0], 1);
    e.addArrow(0, [300, 300], [380, 340], [1, 0, 0], 2);
    const list = e.addFreeText(0, [100, 400], "Check this\nsecond line", 12, [0.8, 0, 0]);
    expect(list.map((a) => a.kind)).toEqual(["Ink", "Square", "Circle", "Line", "FreeText"]);
    const ft = list[4];
    expect(ft.contents).toBe("Check this\nsecond line");
    expect(ft.fontSize).toBe(12);
    expect(ft.rect[0]).toBeCloseTo(100, 0);
    expect(ft.rect[1]).toBeCloseTo(400, 0);
    // two lines tall
    expect(ft.rect[3] - ft.rect[1]).toBeGreaterThan(24);
  });

  it("edits, moves, recolours and deletes annotations", () => {
    let list = e.addFreeText(0, [100, 400], "Hello", 12, [0, 0, 0]);
    list = e.editFreeText(0, list[0].index, "Hello there", 14, [0, 0, 1]);
    expect(list[0].contents).toBe("Hello there");
    expect(list[0].fontSize).toBe(14);
    const before = list[0].rect;
    list = e.moveAnnot(0, list[0].index, 10, 20);
    expect(list[0].rect[0]).toBeCloseTo(before[0] + 10, 0);
    expect(list[0].rect[1]).toBeCloseTo(before[1] + 20, 0);

    list = e.addInk(0, [[[10, 10], [20, 20]]], [0, 0, 0], 1);
    const ink = list.find((a) => a.kind === "Ink")!;
    list = e.moveAnnot(0, ink.index, 5, 5);
    const moved = list.find((a) => a.kind === "Ink")!;
    expect(moved.rect[0]).toBeCloseTo(ink.rect[0] + 5, 0);

    list = e.setAnnotColor(0, moved.index, [1, 0, 0]);
    expect(list.find((a) => a.kind === "Ink")!.color).toEqual([1, 0, 0]);

    list = e.deleteAnnot(0, moved.index);
    expect(list.map((a) => a.kind)).toEqual(["FreeText"]);
    // empty text deletes the box
    list = e.editFreeText(0, list[0].index, "   ", 12, [0, 0, 0]);
    expect(list).toHaveLength(0);
  });

  it("saves annotations into a PDF that reopens with them", () => {
    e.addShape(0, "Square", [50, 50, 150, 100], [1, 0, 0], 1.5);
    e.addFreeText(0, [100, 400], "Saved note", 12, [0, 0, 0]);
    const bytes = e.save();
    expect(e.info().dirty).toBe(false);
    const e2 = new PdfEngine(mupdf);
    e2.open(bytes);
    const list = e2.listAnnots(0);
    expect(list.map((a) => a.kind)).toEqual(["Square", "FreeText"]);
    expect(list[1].contents).toBe("Saved note");
    // the text box text is part of the rendered/searchable page appearance
    expect(new TextDecoder("latin1").decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("stays dirty after undo + a different edit (save point is tracked per step)", () => {
    e.addShape(0, "Square", [50, 50, 150, 100], [1, 0, 0], 1);
    e.save();
    e.undo();
    expect(e.isDirty()).toBe(true);
    e.addShape(0, "Circle", [50, 50, 150, 100], [1, 0, 0], 1);
    expect(e.isDirty()).toBe(true);
  });
});

describe("PdfEngine: forms", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("form.pdf"));
  });

  it("lists the fields with their types and values", () => {
    const ws = e.listWidgets(0);
    const byName = (n: string) => ws.filter((w) => w.name === n);
    expect(byName("name")[0].kind).toBe("text");
    expect(byName("comments")[0].multiline).toBe(true);
    expect(byName("role")[0].kind).toBe("combobox");
    expect(byName("role")[0].options).toEqual(["PhD student", "Postdoc", "Staff", "Guest"]);
    expect(byName("cleanroom")[0].checked).toBe(false);
    expect(byName("training")[0].checked).toBe(true);
    expect(byName("building").map((w) => w.checked)).toEqual([true, false, false]);
  });

  it("fills text, choices, checkboxes and radios, and keeps them after saving", () => {
    let ws = e.listWidgets(0);
    const idx = (n: string, k = 0) => ws.filter((w) => w.name === n)[k].index;
    ws = e.setFieldText(0, idx("name"), "Hoang Trinh");
    ws = e.setFieldChoice(0, idx("role"), "Postdoc");
    ws = e.toggleField(0, idx("cleanroom"));
    ws = e.toggleField(0, idx("building", 2));
    expect(ws.filter((w) => w.name === "building").map((w) => w.checked)).toEqual([false, false, true]);

    const e2 = new PdfEngine(mupdf);
    e2.open(e.save());
    const w2 = e2.listWidgets(0);
    const get = (n: string, k = 0) => w2.filter((w) => w.name === n)[k];
    expect(get("name").value).toBe("Hoang Trinh");
    expect(get("role").value).toBe("Postdoc");
    expect(get("cleanroom").checked).toBe(true);
    expect(get("building", 2).checked).toBe(true);
    expect(get("building", 0).checked).toBe(false);
  });

  it("form edits are undoable", () => {
    const i = e.listWidgets(0).find((w) => w.name === "email")!.index;
    e.setFieldText(0, i, "a@b.c");
    e.undo();
    expect(e.listWidgets(0).find((w) => w.name === "email")!.value).toBe("");
  });

  it("flattens fields into the page", () => {
    const i = e.listWidgets(0).find((w) => w.name === "name")!.index;
    e.setFieldText(0, i, "Flat Name");
    e.flatten();
    expect(e.listWidgets(0)).toHaveLength(0);
    expect(e.pageText(0)).toContain("Flat Name");
  });
});

describe("PdfEngine: pages", () => {
  let e: PdfEngine;
  beforeEach(() => {
    e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
  });

  it("reorders pages", () => {
    e.reorderPages([4, 0, 1, 2, 3]);
    expect(firstLine(e, 0)).toBe("Page 5");
    expect(firstLine(e, 1)).toBe("Page 1");
    e.undo();
    expect(firstLine(e, 0)).toBe("Page 1");
    expect(() => e.reorderPages([0, 0, 1, 2, 3])).toThrow();
  });

  it("deletes pages but never the last one", () => {
    const info = e.deletePages([1, 3]);
    expect(info.pageCount).toBe(3);
    expect([0, 1, 2].map((i) => firstLine(e, i))).toEqual(["Page 1", "Page 3", "Page 5"]);
    expect(() => e.deletePages([0, 1, 2])).toThrow();
  });

  it("rotates pages", () => {
    let info = e.rotatePages([0, 2], 90);
    expect(info.pages[0].rotation).toBe(90);
    expect(info.pages[0].w).toBeCloseTo(841.89, 1);
    expect(info.pages[1].rotation).toBe(0);
    info = e.rotatePages([0], -90);
    expect(info.pages[0].rotation).toBe(0);
    info = e.rotatePages([2], 180);
    expect(info.pages[2].rotation).toBe(270);
  });

  it("inserts another PDF and a blank page", () => {
    let info = e.insertPdf(sample("form.pdf"), 1);
    expect(info.pageCount).toBe(6);
    expect(firstLine(e, 1)).toContain("Lab Access Registration");
    // the inserted form keeps its fields
    expect(e.listWidgets(1).length).toBeGreaterThan(5);
    info = e.insertBlankPage(6);
    expect(info.pageCount).toBe(7);
    expect(e.pageText(6).trim()).toBe("");
  });

  it("extracts pages into a new PDF", () => {
    const bytes = e.extractPages([4, 2]);
    const e2 = new PdfEngine(mupdf);
    const info = e2.open(bytes)!;
    expect(info.pageCount).toBe(2);
    expect(firstLine(e2, 0)).toBe("Page 5");
    expect(firstLine(e2, 1)).toBe("Page 3");
  });
});

describe("PdfEngine: passwords", () => {
  it("asks for and accepts a password", () => {
    const doc = new mupdf.PDFDocument(sample("pages.pdf"));
    const locked = doc.saveToBuffer("encrypt=aes-128,user-password=secret,owner-password=owner").asUint8Array().slice();
    const e = new PdfEngine(mupdf);
    expect(e.open(locked)).toBeNull();
    expect(e.authenticate("wrong")).toBeNull();
    expect(e.authenticate("secret")!.pageCount).toBe(5);
  });
});

describe("PdfEngine: annotations survive page moves", () => {
  it("keeps annotations when inserting an annotated PDF and when extracting pages", () => {
    const a = new PdfEngine(mupdf);
    a.open(sample("pages.pdf"));
    a.addShape(2, "Square", [50, 50, 150, 100], [1, 0, 0], 1);
    a.addFreeText(2, [60, 200], "note on page 3", 12, [0, 0, 0]);
    const annotated = a.save();

    const b = new PdfEngine(mupdf);
    b.open(sample("paper.pdf"));
    b.insertPdf(annotated, 1);
    expect(b.listAnnots(3).map((x) => x.kind)).toEqual(["Square", "FreeText"]);
    const reopened = new PdfEngine(mupdf);
    reopened.open(b.save());
    expect(reopened.info().pageCount).toBe(6);
    expect(reopened.listAnnots(3).map((x) => x.kind)).toEqual(["Square", "FreeText"]);

    const ex = new PdfEngine(mupdf);
    ex.open(a.extractPages([2]));
    expect(ex.listAnnots(0).map((x) => x.kind)).toEqual(["Square", "FreeText"]);
  });
});

describe("PdfEngine: state", () => {
  it("reports undo/redo names and save state", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    expect(e.state()).toMatchObject({ canUndo: false, dirty: false });
    e.addShape(0, "Square", [10, 10, 50, 50], [1, 0, 0], 1);
    expect(e.state()).toMatchObject({ canUndo: true, dirty: true, undoName: "Shape" });
    e.save(false);
    expect(e.state().dirty).toBe(true);
    e.markSaved();
    expect(e.state().dirty).toBe(false);
    e.undo();
    expect(e.state()).toMatchObject({ canRedo: true, redoName: "Shape", dirty: true });
  });
});

describe("PdfEngine: image stamps", () => {
  it("places a transparent PNG and keeps the page visible behind it", () => {
    // 200x80 PNG: transparent with a solid blue bar in the middle
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 200, 80], true);
    const px = pix.getPixels();
    px.fill(0); // fully transparent (clear() would keep alpha opaque)
    for (let y = 30; y < 50; y++)
      for (let x = 20; x < 180; x++) {
        const i = (y * 200 + x) * 4;
        px[i] = 26; px[i + 1] = 58; px[i + 2] = 143; px[i + 3] = 255;
      }
    const png = pix.asPNG().slice();
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    // over the red header band of page 1 (y 0..120 pt)
    const list = e.addImageStamp(0, [100, 20, 300, 100], png);
    expect(list.map((a) => a.kind)).toEqual(["Stamp"]);
    const img = e.render(0, 1);
    const at = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    // centre of the bar is blue
    const c = at(200, 60);
    expect(c[2]).toBeGreaterThan(c[0] + 60);
    // transparent part still shows the red band
    const t = at(110, 25);
    expect(t[0]).toBeGreaterThan(200);
    expect(t[1]).toBeLessThan(90);
    // survives a save
    const e2 = new PdfEngine(mupdf);
    e2.open(e.save());
    expect(e2.listAnnots(0).map((a) => a.kind)).toEqual(["Stamp"]);
    const moved = e2.moveAnnot(0, 0, 10, 10);
    expect(moved[0].rect[0]).toBeCloseTo(110, 0);
  });
});

describe("PdfEngine: moving annotations between pages", () => {
  function stampPng() {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 100, 40], true);
    const px = pix.getPixels();
    px.fill(0);
    for (let y = 10; y < 30; y++)
      for (let x = 10; x < 90; x++) {
        const i = (y * 100 + x) * 4;
        px[i] = 26; px[i + 1] = 58; px[i + 2] = 143; px[i + 3] = 255;
      }
    return pix.asPNG().slice();
  }

  it("moves every kind of annotation to another page, at the requested spot", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addImageStamp(0, [100, 300, 300, 380], stampPng());
    e.addInk(0, [[[50, 400], [120, 450]]], [0, 0, 1], 2);
    e.addFreeText(0, [60, 500], "note", 12, [0, 0, 0]);
    const hit = e.search("This is page 1")[0];
    e.addMarkup(0, "Highlight", hit.quads, [1, 1, 0]);
    expect(e.listAnnots(0).map((a) => a.kind)).toEqual(["Stamp", "Ink", "FreeText", "Highlight"]);

    for (const kind of ["Stamp", "Ink", "FreeText", "Highlight"]) {
      const a = e.listAnnots(0).find((x) => x.kind === kind)!;
      const res = e.moveAnnotToPage(0, a.index, 2, [200, 600]);
      const moved = res.to[res.index];
      expect(moved.kind).toBe(kind);
      expect(moved.rect[0]).toBeCloseTo(200, 0);
      expect(moved.rect[1]).toBeCloseTo(600, 0);
      expect(res.from.some((x) => x.kind === kind)).toBe(false);
    }
    expect(e.listAnnots(0)).toHaveLength(0);
    expect(e.listAnnots(2)).toHaveLength(4);

    // the stamp image is drawn on its new page
    const st = e.listAnnots(2).find((x) => x.kind === "Stamp")!;
    const img = e.render(2, 1);
    const cx = Math.round((st.rect[0] + st.rect[2]) / 2), cy = Math.round((st.rect[1] + st.rect[3]) / 2);
    const px = Array.from(img.data.slice((cy * img.width + cx) * 4, (cy * img.width + cx) * 4 + 3));
    expect(px[2]).toBeGreaterThan(px[0] + 60);
  });

  it("is one undo step and survives saving", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addImageStamp(0, [100, 300, 300, 380], stampPng());
    e.moveAnnotToPage(0, 0, 3, [50, 50]);
    e.undo();
    expect(e.listAnnots(0).map((a) => a.kind)).toEqual(["Stamp"]);
    expect(e.listAnnots(3)).toHaveLength(0);
    e.redo();
    expect(e.listAnnots(3).map((a) => a.kind)).toEqual(["Stamp"]);
    const e2 = new PdfEngine(mupdf);
    e2.open(e.save());
    expect(e2.listAnnots(0)).toHaveLength(0);
    const moved = e2.listAnnots(3)[0];
    expect(moved.kind).toBe("Stamp");
    expect(moved.rect[0]).toBeCloseTo(50, 0);
  });

  it("renders a single annotation with a transparent background", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addImageStamp(0, [100, 300, 300, 380], stampPng());
    const img = e.renderAnnot(0, 0, 1)!;
    expect(img.width).toBeGreaterThan(190);
    expect(img.data[3]).toBe(0); // corner transparent
    const mid = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
    expect(img.data[mid + 3]).toBe(255);
    expect(img.data[mid + 2]).toBeGreaterThan(120);
  });
});
