import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const reopen = (e: PdfEngine) => mupdf.Document.openDocument(e.save(), "application/pdf") as mupdf.PDFDocument;
const yellow: [number, number, number] = [1, 0.83, 0];

describe("comment threads", () => {
  it("replies are saved as real replies to the note, listed under it, oldest first", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addNote(0, [100, 100], "Is this right?", yellow, "Aga");
    let notes = e.listAnnots(0);
    expect(notes).toHaveLength(1);
    expect(notes[0].author).toBe("Aga");
    expect(notes[0].date).toBeGreaterThan(0);
    e.addReply(0, notes[0].index, "Yes, checked.", "Hoang");
    notes = e.listAnnots(0);
    e.addReply(0, notes[0].index, "Thanks!", "Aga");
    notes = e.listAnnots(0);
    // replies don't show as items of their own
    expect(notes).toHaveLength(1);
    expect(notes[0].replies!.map((r) => [r.author, r.text])).toEqual([
      ["Hoang", "Yes, checked."],
      ["Aga", "Thanks!"],
    ]);
    expect(e.state().undoName).toBe("Reply");
    // other apps see replies that point at the note
    const d = reopen(e);
    const annots = d.loadPage(0).getAnnotations();
    expect(annots).toHaveLength(3);
    const noteNum = annots[0].getObject().asIndirect();
    expect(annots[1].getObject().get("IRT").asIndirect()).toBe(noteNum);
    expect(annots[2].getAuthor()).toBe("Aga");
  });

  it("a reply draws nothing on the page, and can be changed or deleted", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addNote(0, [100, 100], "Note", yellow, "A");
    const before = e.render(0, 1).data.slice();
    e.addReply(0, e.listAnnots(0)[0].index, "A reply", "B");
    const after = e.render(0, 1).data;
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0);
    const r = e.listAnnots(0)[0].replies![0];
    e.setReply(0, r.index, "Changed");
    expect(e.listAnnots(0)[0].replies![0].text).toBe("Changed");
    e.deleteAnnot(0, e.listAnnots(0)[0].replies![0].index);
    expect(e.listAnnots(0)[0].replies).toBeUndefined();
    e.undo();
    expect(e.listAnnots(0)[0].replies).toHaveLength(1);
  });

  it("deleting a note takes its replies with it", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addNote(0, [100, 100], "Note", yellow);
    e.addReply(0, 0, "One", "B");
    e.addReply(0, 0, "Two", "C");
    e.deleteAnnot(0, e.listAnnots(0)[0].index);
    expect(e.listAnnots(0)).toHaveLength(0);
    expect(reopen(e).loadPage(0).getAnnotations()).toHaveLength(0);
  });
});
