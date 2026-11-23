import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";
import { fillTemplate } from "../src/engine/stamp";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const font = (f: string) => new Uint8Array(fs.readFileSync(new URL(`../public/fonts/${f}`, import.meta.url)));

describe("watermark", () => {
  it("puts the text on every page as real content, see-through; one undo step", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.watermark({ text: "CONFIDENTIAL", size: 60, color: [0.9, 0.2, 0.2], opacity: 0.25, angle: 45, bold: true, pages: [0, 1, 2, 3, 4] });
    for (let i = 0; i < 5; i++) expect(e.pageText(i)).toContain("CONFIDENTIAL");
    expect(e.state().undoName).toBe("Watermark");
    // see-through red over white near the middle of the page
    const img = e.render(0, 1);
    let reddish = 0;
    for (let y = 300; y < 500; y += 2)
      for (let x = 150; x < 450; x += 2) {
        const i = (y * img.width + x) * 4;
        if (img.data[i] > 200 && img.data[i + 1] < 220 && img.data[i + 1] > 150) reddish++;
      }
    expect(reddish).toBeGreaterThan(200);
    e.undo();
    expect(e.pageText(0)).not.toContain("CONFIDENTIAL");
  });

  it("uses a bundled font for letters Helvetica lacks (Vietnamese)", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    expect(e.stampFontFile(["Bản nháp"])).toBe("LiberationSans-Regular.ttf");
    expect(e.stampFontFile(["DRAFT – Entwurf"])).toBeNull();
    e.registerFont("LiberationSans-Regular.ttf", font("LiberationSans-Regular.ttf"));
    e.watermark({ text: "Bản nháp", size: 40, color: [0, 0, 0], opacity: 0.3, angle: 0, bold: false, pages: [0] });
    expect(e.pageText(0)).toContain("Bản nháp");
  });

  it("is upright as seen on a turned page", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.rotatePages([0], 90);
    e.watermark({ text: "TURNED", size: 50, color: [0, 0, 0], opacity: 1, angle: 0, bold: false, pages: [0] });
    const page = mupdf.Document.openDocument(e.save(), "application/pdf").loadPage(0);
    type Line = { text: string; bbox: { x: number; y: number; w: number; h: number } };
    const line: Line = JSON.parse(page.toStructuredText("").asJSON()).blocks.flatMap((b: { lines?: Line[] }) => b.lines ?? []).find((l: Line) => l.text.includes("TURNED"));
    // a wide, low box in the middle of the page as seen: written left to right
    const b = page.getBounds();
    expect(line.bbox.w).toBeGreaterThan(line.bbox.h * 2);
    expect(Math.abs(line.bbox.x + line.bbox.w / 2 - (b[0] + b[2]) / 2)).toBeLessThan(5);
  });
});

describe("page numbers, header and footer", () => {
  it("numbers pages, skipping a title page, with a header", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const n = e.headerFooter({ items: { bc: "Page {page} of {pages}", tl: "Report – {date}" }, size: 10, color: [0, 0, 0], margin: 28, startAt: 1, skipFirst: true, pages: [0, 1, 2, 3, 4], date: "24.11.2026" });
    expect(n).toBe(4);
    expect(e.pageText(0)).not.toContain("of 4");
    expect(e.pageText(1)).toContain("Page 1 of 4");
    expect(e.pageText(4)).toContain("Page 4 of 4");
    expect(e.pageText(2)).toContain("Report – 24.11.2026");
    // at the bottom, in the middle
    const lines = e.textLines([1]).filter((l) => l.text.includes("Page 1 of 4"));
    expect(lines[0].y).toBeGreaterThan(740);
    expect(e.state().undoName).toBe("Page numbers");
  });

  it("fills in the template", () => {
    expect(fillTemplate("{page} / {pages} · {file}", { page: 3, pages: 9, file: "a.pdf" })).toBe("3 / 9 · a.pdf");
  });
});

describe("password protection", () => {
  it("protects the saved file with a password, and can remove it again", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    expect(e.protection().locked).toBe(false);
    e.setProtection({ user: "geheim" });
    expect(e.state().dirty).toBe(true);
    expect(e.protection()).toEqual({ locked: true, changed: true });
    const locked = mupdf.Document.openDocument(e.save(), "application/pdf");
    expect(locked.needsPassword()).toBe(true);
    expect(locked.authenticatePassword("wrong")).toBe(0);
    expect(locked.authenticatePassword("geheim")).toBeGreaterThan(0);
    expect(locked.loadPage(0).toStructuredText("").asText()).toContain("Page 1");
    // open the protected file, remove the password
    const e2 = new PdfEngine(mupdf);
    expect(e2.open(e.save())).toBeNull();
    expect(e2.authenticate("geheim")).not.toBeNull();
    expect(e2.protection().locked).toBe(true);
    e2.setProtection("none");
    const open = mupdf.Document.openDocument(e2.save(), "application/pdf");
    expect(open.needsPassword()).toBe(false);
  });

  it("refuses empty passwords and commas", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    expect(() => e.setProtection({ user: "" })).toThrow(/empty/);
    expect(() => e.setProtection({ user: "a,b" })).toThrow(/comma/);
  });
});

describe("redaction", () => {
  it("redacts an area: the text is gone (not just covered) and a black box is there", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addInk(0, [[[60, 160], [200, 170]]], [0, 0, 1], 2);
    e.redactArea(0, [40, 150, 450, 180]);
    expect(e.pageText(0)).not.toContain("reordering");
    expect(e.listAnnots(0).length).toBe(0);
    const img = e.render(0, 1);
    const i = (165 * img.width + 200) * 4;
    expect(Array.from(img.data.slice(i, i + 3))).toEqual([0, 0, 0]);
    const saved = mupdf.Document.openDocument(e.save(), "application/pdf");
    expect(saved.loadPage(0).toStructuredText("").asText()).not.toContain("reordering");
  });

  it("redacts every match of a text in one step, and nothing else", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const r = e.redactText("reordering");
    expect(r.count).toBe(5);
    expect(r.pages).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < 5; i++) {
      const t = e.pageText(i);
      expect(t).not.toContain("reordering");
      expect(t).toContain("rotating");
    }
    expect(e.state().undoName).toBe("Redact");
    e.undo();
    expect(e.pageText(3)).toContain("reordering");
    expect(e.redactText("no such words").count).toBe(0);
  });
});

describe("sticky notes", () => {
  it("adds a note with text, changes it, and it survives saving", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    let a = e.addNote(0, [300, 300], "Check this number", [1, 0.83, 0]);
    expect(a[0].kind).toBe("Text");
    expect(a[0].contents).toBe("Check this number");
    a = e.setNoteText(0, a[0].index, "Checked: fine");
    expect(a[0].contents).toBe("Checked: fine");
    expect(e.state().undoName).toBe("Note");
    // the same text again: no undo step
    e.setNoteText(0, a[0].index, "Checked: fine");
    const d = new mupdf.PDFDocument(e.save());
    const n = d.loadPage(0).getAnnotations()[0];
    expect([n.getType(), n.getContents()]).toEqual(["Text", "Checked: fine"]);
    // it's an item like others: copy, move
    e.copyAnnot(0, 0);
    const p = e.paste(1, [100, 100]);
    expect(p.annots[p.index].contents).toBe("Checked: fine");
  });
});
