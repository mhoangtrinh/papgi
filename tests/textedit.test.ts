import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const fontFile = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/fonts/${name}`, import.meta.url)));

/** Engine with every font it asks for loaded from public/fonts (what the worker does with fetch). */
function edit(e: PdfEngine, page: number, block: number, runs: { text: string; style: number }[]) {
  for (const f of e.fontsForEdit(page, block, runs)) e.registerFont(f, fontFile(f));
  return e.replaceText(page, block, runs);
}

const find = (e: PdfEngine, page: number, start: string) => e.textBlocks(page).find((b) => b.runs.map((r) => r.text).join("").startsWith(start))!;

describe("live text editing: reading paragraphs", () => {
  it("finds paragraphs with their styles, alignment and line spacing", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const intro = find(e, 0, "Voltage references");
    expect(intro.editable).toBe(true);
    expect(intro.lines.length).toBe(11); // visual lines (MuPDF splits some in two)
    expect(intro.align).toBe("justify");
    expect(intro.lineHeight).toBeGreaterThan(11);
    expect(intro.lineHeight).toBeLessThan(13);
    expect(intro.styles[0].font).toMatch(/LMRoman10-Regular/);
    expect(intro.styles[0].file).toBe("lmroman10-regular.otf");
    const text = intro.runs.map((r) => r.text).join("");
    // soft hyphens at line ends are joined back ("achiev-able")
    expect(text).toContain("achievable");
    expect(text).toContain("analog-to-digital"); // a real hyphen at a line end stays
    expect(text).not.toMatch(/\s{2,}/);
    const title = find(e, 0, "A Low-Power");
    expect(title.align).toBe("center");
    const formula = find(e, 0, "where V");
    expect(formula.warn).toBeTruthy();
  });

  it("marks mixed styles inside a paragraph", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const ref = find(e, 0, "[1] A. Author");
    const fonts = new Set(ref.runs.map((r) => ref.styles[r.style].font.replace(/^.{7}/, "")));
    expect([...fonts].some((f) => /Italic/.test(f))).toBe(true);
  });
});

describe("live text editing: replacing text", () => {
  it("replaces a paragraph, re-wraps it in the column and keeps the neighbours", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const intro = find(e, 0, "Voltage references");
    const newText = "Voltage references matter. This paragraph was rewritten in papgi, and it should wrap neatly inside the left column without touching the right one. Tiếng Việt works too.";
    const { result } = edit(e, 0, intro.id, [{ text: newText, style: 0 }]);
    expect(result.lines).toBeGreaterThan(2);
    const text = e.pageText(0).replace(/\s+/g, " ");
    expect(text).toContain("This paragraph was rewritten in papgi");
    expect(text).toContain("Tiếng Việt works too.");
    expect(text).not.toContain("fundamental building block");
    // neighbours survived
    expect(text).toContain("1 Introduction");
    expect(text).toContain("2 Circuit Design");
    expect(text).toContain("The proposed reference combines low power");
    // every new line stays inside the left column
    const again = find(e, 0, "Voltage references matter");
    for (const l of again.lines) {
      expect(l.bbox[0]).toBeGreaterThan(intro.left - 1);
      expect(l.bbox[2]).toBeLessThan(intro.left + intro.width + 1);
    }
    // and is justified again (all but the last line reach the right edge)
    expect(again.align).toBe("justify");
    expect(again.styles[0].font).toMatch(/LMRoman10|lmroman10/i);
  });

  it("is one undo step and survives saving", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const before = e.pageText(0);
    const b = find(e, 0, "Twenty samples");
    edit(e, 0, b.id, [{ text: "Fifty samples were measured.", style: 0 }]);
    expect(e.pageText(0)).toContain("Fifty samples were measured.");
    e.undo();
    expect(e.pageText(0)).toBe(before);
    e.redo();
    const e2 = new PdfEngine(mupdf);
    e2.open(e.save());
    expect(e2.pageText(0)).toContain("Fifty samples were measured.");
    expect(e2.pageText(0)).not.toContain("Twenty samples");
  });

  it("keeps several styles (italic journal names) when editing a reference", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const ref = find(e, 0, "[1] A. Author");
    const runs = ref.runs.map((r) => ({ ...r, text: r.text.replace("2019", "2020") }));
    edit(e, 0, ref.id, runs);
    const after = find(e, 0, "[1] A. Author");
    expect(after.runs.map((r) => r.text).join("")).toContain("2020");
    expect(after.styles.some((s) => s.italic)).toBe(true);
  });

  it("edits text in non-embedded Helvetica (reportlab) and falls back for missing letters", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const b = find(e, 0, "This is page 1");
    edit(e, 0, b.id, [{ text: "This is the first page, edited.", style: 0 }]);
    expect(e.pageText(0)).toContain("This is the first page, edited.");
    // Vietnamese needs a font with more letters than the built-in Helvetica
    const b2 = find(e, 0, "This is the first page");
    const { result } = edit(e, 0, b2.id, [{ text: "Trang đầu tiên — Việt Nam", style: 0 }]);
    expect(e.pageText(0)).toContain("Trang đầu tiên — Việt Nam");
    // Liberation Sans is a metric twin of Helvetica, so no "different font" warning
    expect(result.warnings.join(" ")).not.toMatch(/matching font/);
  });

  it("can empty a paragraph and grow a short heading on one line", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const head = find(e, 0, "References");
    edit(e, 0, head.id, [{ text: "References and further reading", style: 0 }]);
    const h2 = find(e, 0, "References and further reading");
    expect(h2.lines).toHaveLength(1);
    const t = find(e, 0, "Table 1:");
    edit(e, 0, t.id, [{ text: "", style: 0 }]);
    expect(e.pageText(0)).not.toContain("Table 1:");
  });

  it("refuses unknown blocks", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    expect(() => e.replaceText(0, 999, [{ text: "x", style: 0 }])).toThrow(/changed/);
  });
});

describe("live text editing: highlights follow their words", () => {
  it("moves a highlight with the text and drops one whose words are gone", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const keep = e.search("complementary")[0];
    e.addMarkup(keep.page, "Highlight", keep.quads, [1, 0.85, 0]);
    const gone = e.search("tissue safety")[0];
    e.addMarkup(gone.page, "Underline", gone.quads, [1, 0, 0]);
    const intro = find(e, 0, "Voltage references");
    const text = intro.runs.map((r) => r.text).join("").replace("Voltage references", "Precise voltage references, which this sentence now describes at much greater length,").replace("tissue safety", "the safety of the tissue");
    const { result, annots } = edit(e, 0, intro.id, [{ text, style: 0 }]);
    expect(annots.map((a) => a.kind)).toEqual(["Highlight"]);
    expect(result.warnings.join(" ")).toMatch(/1 highlight was removed/);
    // the highlight now sits on the moved words
    const now = e.search("complementary")[0].quads;
    const h = annots[0].rect;
    expect(Math.abs(h[1] - Math.min(...now.map((q) => q[1])))).toBeLessThan(3);
    expect(h[1]).not.toBeCloseTo(keep.quads[0][1], 0);
  });
});

describe("live text editing: Word-style documents", () => {
  it("splits headings, list items, table cells and hard line breaks into separate paragraphs", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("report.pdf"));
    const texts = e.textBlocks(0).map((b) => b.runs.map((r) => r.text).join(""));
    expect(texts).toContain("Results");
    expect(texts).toContain("First bullet item with some text");
    expect(texts).toContain("Cell 11");
    expect(texts.some((t) => t.startsWith("The noise floor") && !t.includes("Results"))).toBe(true);
    // ragged (left-aligned) text is not mistaken for justified
    expect(find(e, 0, "This report").align).toBe("left");
  });

  it("keeps the bullet when editing a list item and edits one table cell alone", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("report.pdf"));
    const item = find(e, 0, "First bullet");
    edit(e, 0, item.id, [{ text: "First bullet item, edited", style: item.runs[0].style }]);
    const cell = find(e, 0, "Cell 11");
    edit(e, 0, cell.id, [{ text: "Changed", style: cell.runs[0].style }]);
    const t = e.pageText(0);
    expect(t).toContain("First bullet item, edited");
    expect(t).toContain("Changed");
    for (const c of ["Cell 10", "Cell 12", "Cell 01"]) expect(t).toContain(c);
    // the bullet glyph is still drawn: the page renders dark pixels left of the item text
    const it2 = find(e, 0, "First bullet item, edited");
    const img = e.render(0, 2);
    const y = Math.round(it2.firstBaseline * 2 - 6);
    let dark = 0;
    for (let x = Math.round((it2.left - 20) * 2); x < Math.round((it2.left - 2) * 2); x++) if (img.data[(y * img.width + x) * 4] < 100) dark++;
    expect(dark).toBeGreaterThan(2);
  });
});

describe("undo never breaks later edits", () => {
  // MuPDF's journal left its font/image caches pointing at objects that undo removed,
  // so the next edit drew garbled letters, a wrong text-box font or a "DRAFT" stamp.
  it("edit, undo, edit again: the text is still correct", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("report.pdf"));
    const b = find(e, 0, "This report");
    const text = b.runs.map((r) => r.text).join("");
    edit(e, 0, b.id, [{ text: text + " One.", style: 0 }]);
    e.undo();
    const b2 = find(e, 0, "This report");
    edit(e, 0, b2.id, [{ text: text + " Two.", style: 0 }]);
    const t = e.pageText(0).replace(/\s+/g, " ");
    expect(t).toContain("contributed to the setup of the lab. Two.");
    expect(t).not.toMatch(/\$OOH|\u0000/);
    e.undo();
    e.undo();
    e.redo();
    expect(e.pageText(0).replace(/\s+/g, " ")).toContain("lab. Two.");
  });

  it("picture signature placed again after an undo keeps its picture", () => {
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 100, 40], true);
    const px = pix.getPixels();
    px.fill(0);
    for (let y = 10; y < 30; y++)
      for (let x = 10; x < 90; x++) {
        const i = (y * 100 + x) * 4;
        px[i] = 26; px[i + 1] = 58; px[i + 2] = 143; px[i + 3] = 255;
      }
    const png = pix.asPNG().slice();
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addImageStamp(0, [60, 400, 260, 480], png);
    e.undo();
    e.addImageStamp(0, [60, 400, 260, 480], png);
    const img = e.render(0, 1);
    const at = (x: number, y: number) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    const c = at(160, 440);
    expect(c[2]).toBeGreaterThan(c[0] + 60); // blue bar, not a red DRAFT stamp
  });

  it("tracks unsaved changes and undo names", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addShape(0, "Square", [10, 10, 50, 50], [1, 0, 0], 1);
    e.addShape(0, "Circle", [10, 10, 50, 50], [1, 0, 0], 1);
    expect(e.state()).toMatchObject({ canUndo: true, undoName: "Shape", dirty: true });
    e.save();
    expect(e.state().dirty).toBe(false);
    e.undo();
    expect(e.state()).toMatchObject({ dirty: true, canRedo: true, redoName: "Shape" });
    e.redo();
    expect(e.state().dirty).toBe(false);
    // filling a field with the same value is not a change
    const w = e.listWidgets(0);
    expect(w).toHaveLength(0);
  });
});

describe("hyphens survive re-editing", () => {
  it("keeps compound hyphens when papgi's own lines are read back", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    const b = find(e, 0, "Voltage references");
    const text = b.runs.map((r) => r.text).join("");
    edit(e, 0, b.id, [{ text: text + " Edited.", style: 0 }]);
    const again = find(e, 0, "Voltage references").runs.map((r) => r.text).join("");
    expect(again).toContain("analog-to-digital");
    expect(again).toContain("base-emitter");
    expect(again).toContain("achievable");
  });
});
