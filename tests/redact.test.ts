import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import { PdfEngine } from "../src/engine/engine";
import { strokeOpsToGs, strokesText } from "../src/engine/redact";

function makePdf(content: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", doc.addSimpleFont(new mupdf.Font("Helvetica")));
  fonts.put("F2", doc.addSimpleFont(new mupdf.Font("Helvetica-Bold")));
  res.put("Font", fonts);
  doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, content));
  return doc.saveToBuffer("").asUint8Array().slice();
}

/** Pixels that changed in the top part of page 1 (away from the rub at the bottom). */
function changedByErasing(content: string, how: "brush" | "area" | "edit" = "brush"): number {
  const e = new PdfEngine(mupdf);
  e.open(makePdf(content));
  const a = e.render(0, 2);
  if (how === "brush") e.erase(0, [[500, 100], [520, 100]], 4, true);
  else e.eraseArea(0, [480, 80, 540, 120]);
  const b = e.render(0, 2);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) if (Math.floor(i / 4 / a.width) < 1400 && Math.abs(a.data[i] - b.data[i]) > 30) changed++;
  return changed;
}

describe("erasing keeps the rest of the page as it was", () => {
  // Many PDFs make bold by drawing letters with a thin outline (2 Tr). MuPDF 1.28's rewrite of
  // the page forgot the outline's width, so after erasing anything, such text turned very bold.
  const cases: Record<string, string> = {
    "outlined bold, width set before the text": "0.3 w 2 Tr\nBT /F1 14 Tf 50 750 Td (Fake bold text here) Tj ET\n0 Tr BT /F1 14 Tf 50 690 Td (Normal text) Tj ET",
    "outlined bold, width set inside the text": "BT 2 Tr 0.25 w /F1 14 Tf 50 750 Td (Fake bold text here) Tj ET\nBT 0 Tr /F2 14 Tf 50 690 Td (Real bold text) Tj ET",
    "white outline": "1 1 1 RG 2 w\nBT 2 Tr /F2 14 Tf 50 750 Td (White outlined bold) Tj ET\nBT 0 Tr /F1 14 Tf 50 690 Td (Normal text) Tj ET",
    "several widths, joins": "2 Tr 0.2 w 1 j BT /F1 10 Tf 50 750 Td (Small fake bold) Tj ET 0.6 w 2 j BT /F1 24 Tf 50 700 Td [(Big) -200 (fake bold)] TJ ET",
    "lines drawn after it": "0.3 w 2 Tr BT /F1 14 Tf 50 750 Td (Fake bold) Tj ET 0 Tr\n3 w 50 650 m 300 650 l S\nq 0.5 w 50 600 m 300 600 l S Q 50 550 m 300 550 l S\n2 J 1 j 6 w 60 500 m 300 500 l S",
    "hidden text (OCR)": "3 Tr BT /F1 14 Tf 50 750 Td (Hidden words) Tj ET 0 Tr BT /F1 14 Tf 50 690 Td (Normal text) Tj ET",
  };
  for (const [name, content] of Object.entries(cases)) {
    it(name, () => {
      expect(changedByErasing(content, "brush")).toBe(0);
      expect(changedByErasing(content, "area")).toBe(0);
    });
  }

  it("finds outlined text and rewrites only the stroke settings (not inside strings or pictures)", () => {
    expect(strokesText("BT 2 Tr (a) Tj ET")).toBe(true);
    expect(strokesText("BT 0 Tr (2 Tr) Tj ET 3 Tr")).toBe(false);
    const names: string[] = [];
    const out = strokeOpsToGs("0.5 w (1 w) Tj [(x 2 J)] TJ 1 j BI /W 1 /H 1 ID \x00 9 w EI 4 M", (k, v) => (names.push(`${k}=${v}`), `G${names.length}`));
    expect(out).toBe("/G1 gs (1 w) Tj [(x 2 J)] TJ /G2 gs BI /W 1 /H 1 ID \x00 9 w EI /G3 gs");
    expect(names).toEqual(["LW=0.5", "LJ=1", "ML=4"]);
    expect(strokeOpsToGs("BT (a) Tj ET", () => "x")).toBeNull();
  });
});
