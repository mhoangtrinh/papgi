import { it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));

it("a copy for sending has everything added as part of the pages; the open document is unchanged", () => {
  const e = new PdfEngine(mupdf);
  e.open(sample("form.pdf"));
  e.addFreeText(0, [100, 300], "Hello text box", 14, [0, 0, 0]);
  e.addInk(0, [[[100, 400], [150, 420], [200, 390], [250, 430]]], [0.1, 0.1, 0.5], 1.5);
  e.setFieldText(0, 0, "Hoang");
  const dirty = e.state().dirty;
  const d = mupdf.Document.openDocument(e.save(false, true), "application/pdf") as mupdf.PDFDocument;
  const p = d.loadPage(0);
  expect(p.getAnnotations().length).toBe(0);
  expect(p.getWidgets().length).toBe(0);
  const text = p.toStructuredText("").asText();
  expect(text).toContain("Hello text box");
  expect(text).toContain("Hoang");
  // still editable here, still unsaved
  expect(e.listAnnots(0).length).toBe(2);
  expect(e.listWidgets(0).length).toBeGreaterThan(0);
  expect(e.state().dirty).toBe(dirty);
});
