// The engine keeps drawn page contents so annotation changes only redraw annotations.
// After every kind of change, what it draws must equal a fresh render of the saved file.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as mupdf from "mupdf";
import { PdfEngine } from "../src/engine/engine";

const sample = (n: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${n}`, import.meta.url)));
const font = (n: string) => new Uint8Array(fs.readFileSync(new URL(`../public/fonts/${n}`, import.meta.url)));

function fresh(e: PdfEngine, index: number, scale: number) {
  const f = new PdfEngine(mupdf);
  f.open(e.save(false)); // (without marking the document saved)
  return f.render(index, scale);
}
function same(e: PdfEngine, index: number, scale = 1.3) {
  const a = e.render(index, scale);

  const b = fresh(e, index, scale);
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let diff = 0;
  for (let i = 0; i < a.data.length; i++) if (Math.abs(a.data[i] - b.data[i]) > 2) diff++;
  expect(diff).toBe(0);
}

describe("drawing with cached page contents", () => {
  it("matches a fresh render after annotation, text, page and undo changes", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    for (const f of fs.readdirSync(new URL("../public/fonts", import.meta.url)).filter((f) => /\.(otf|ttf)$/.test(f))) e.registerFont(f, font(f));
    const before = e.render(0, 1.3); // fills the cache
    e.addFreeText(0, [100, 100], "Cached?", 14, [0.8, 0, 0]);
    same(e, 0);
    expect(e.render(0, 1.3).data).not.toEqual(before.data); // the text box is there
    e.addMarkup(0, "Highlight", [[72, 300, 300, 300, 72, 312, 300, 312]], [1, 0.85, 0]);
    same(e, 0);
    e.moveAnnot(0, 0, 20, 10);
    same(e, 0);
    // change the page contents: edit a paragraph
    const blocks = e.textBlocks(0);
    const b = blocks.find((x) => x.editable && x.lines.length > 2)!;
    e.replaceText(0, b.id, [{ text: "Rewritten paragraph.", style: 0 }]);
    same(e, 0);
    e.undo();
    same(e, 0);
    e.undo();
    same(e, 0);
    e.redo();
    same(e, 0);
    e.rotatePages([0], 90);
    same(e, 0);
    e.undo();
    same(e, 0);
  });

  it("doesn't show an old page after pages are deleted or moved", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    for (let i = 0; i < 3; i++) e.render(i, 1);
    e.deletePages([0]);
    same(e, 0);
    same(e, 1);
    e.reorderPages([1, 0, 2, 3]);
    same(e, 0);
    e.undo();
    same(e, 0);
  });

  it("keeps memory bounded", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    for (let i = 0; i < 12; i++) e.render(i % e.info().pageCount, 3 + i * 0.1);
    expect((e as unknown as { contentBytes: number }).contentBytes).toBeLessThanOrEqual(PdfEngine.CONTENT_CACHE_BYTES);
  });

  it("undo and redo back and forth, then edit again", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("paper.pdf"));
    for (const f of fs.readdirSync(new URL("../public/fonts", import.meta.url)).filter((f) => /\.(otf|ttf)$/.test(f))) e.registerFont(f, font(f));
    const count = () => e.listAnnots(0).length;
    e.render(0, 1.3);
    e.addFreeText(0, [100, 100], "one", 12, [0, 0, 0]);
    e.addFreeText(0, [100, 140], "two", 12, [0, 0, 0]);
    const b = e.textBlocks(0).find((x) => x.editable && x.lines.length > 2)!;
    e.replaceText(0, b.id, [{ text: "Edited once.", style: 0 }]);
    e.addFreeText(0, [100, 180], "three", 12, [0, 0, 0]);
    expect(count()).toBe(3);
    e.undo();
    e.undo();
    expect(e.pageText(0)).not.toContain("Edited once.");
    same(e, 0);
    e.redo();
    expect(e.pageText(0)).toContain("Edited once.");
    same(e, 0);
    e.redo();
    expect(count()).toBe(3);
    same(e, 0);
    for (let i = 0; i < 4; i++) e.undo();
    expect(count()).toBe(0);
    expect(e.state().dirty).toBe(false);
    same(e, 0);
    for (let i = 0; i < 2; i++) e.redo();
    expect(count()).toBe(2);
    // a new change drops what could be redone; editing text afterwards still works cleanly
    const b2 = e.textBlocks(0).find((x) => x.editable && x.lines.length > 2)!;
    e.replaceText(0, b2.id, [{ text: "Edited after undo and redo.", style: 0 }]);
    expect(e.state().canRedo).toBe(false);
    expect(e.pageText(0)).toContain("Edited after undo and redo.");
    same(e, 0);
    e.undo();
    e.redo();
    expect(e.pageText(0)).toContain("Edited after undo and redo.");
    same(e, 0);
  });

  it("an undo copy made ahead of time restores the right state", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const count = () => e.listAnnots(0).length;
    e.prepareUndo();
    e.addFreeText(0, [100, 100], "one", 12, [0, 0, 0]);
    e.prepareUndo();
    e.prepareUndo(); // (twice: still the same copy)
    e.addFreeText(0, [100, 140], "two", 12, [0, 0, 0]);
    e.addFreeText(0, [100, 180], "three", 12, [0, 0, 0]); // (no copy prepared: made on the spot)
    e.prepareUndo();
    e.undo(); // the prepared copy must not be used after the document changed
    e.prepareUndo();
    e.addInk(0, [[[50, 50], [80, 90]]], [0, 0, 1], 2);
    expect(count()).toBe(3);
    e.undo();
    expect(count()).toBe(2);
    e.undo();
    expect(count()).toBe(1);
    e.prepareUndo();
    e.redo();
    expect(count()).toBe(2);
    e.prepareUndo();
    e.undo();
    e.undo();
    expect(count()).toBe(0);
    expect(e.state().dirty).toBe(false);
    same(e, 0);
  });
});
