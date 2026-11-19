// Text recognition results -> an invisible text layer on a scanned page, so its words can
// be selected, searched, highlighted and (via the text editor) changed.
import type * as MuPDF from "mupdf";
import type { Rect } from "../core/geometry";

type M = typeof MuPDF;

/** One recognised word in page space (points). */
export interface OcrWord {
  text: string;
  bbox: Rect;
  /** Baseline y at the word's left edge, the baseline's slope (page skew), and the font size. */
  baseline: number;
  slope?: number;
  size: number;
  /** Same line as the word before: the gap between them gets a (stretched) space. */
  join?: boolean;
}

/** Page dictionary key marking pages that carry papgi's recognised text. */
export const OCR_KEY = "PapgiOCR";
/**
 * Recognised text is written with Carlito (bundled; covers Latin incl. Vietnamese, Greek and
 * Cyrillic). On a recognised page papgi's own edits use Liberation, so the two never mix up.
 */
export const OCR_FONT_FILE = "Carlito-Regular.ttf";
export const OCR_FONT = /Carlito/i;
/** Height of the glyph box MuPDF reports for Carlito text, in em (it ignores horizontal stretch). */
export const OCR_EM_BOX = 1.22;

export function isOcrPage(page: MuPDF.PDFPage): boolean {
  const v = page.getObject().get(OCR_KEY);
  return !v.isNull();
}

/** Write recognised words as invisible text (render mode 3) on top of the scan. */
export function addOcrWords(mupdf: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, words: OcrWord[], font: MuPDF.Font): number {
  const pageObj = page.getObject();
  const res = ownResources(doc, pageObj);
  let fontDict = res.get("Font");
  if (!fontDict.isDictionary()) {
    fontDict = doc.newDictionary();
    res.put("Font", fontDict);
  }
  let k = 1;
  while (!fontDict.get(`PapgiOCR${k}`).isNull()) k++;
  const name = `PapgiOCR${k}`;
  fontDict.put(name, doc.addFont(font));

  const inv = mupdf.Matrix.invert(page.getTransform());
  const num = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(+v.toFixed(3)));
  let ops = "q 3 Tr\n";
  let written = 0;
  const spaceGid = font.encodeCharacter(32);
  const spaceAdv = spaceGid ? font.advanceGlyph(spaceGid) : 0;
  const show = (hex: string, adv: number, x: number, y: number, width: number, size: number, k: number) => {
    const tz = Math.min(1000, Math.max(10, (100 * width) / Math.max(0.01, adv * size)));
    // along the skewed baseline, so the words of a line stay one line for selection and editing
    const cos = 1 / Math.sqrt(1 + k * k);
    const sin = k * cos;
    const tm = mupdf.Matrix.concat([cos, sin, sin, -cos, x, y], inv);
    ops += `BT /${name} ${num(size)} Tf ${num(tz)} Tz ${tm.map(num).join(" ")} Tm <${hex}> Tj ET\n`;
  };
  let prev: OcrWord | null = null;
  for (const w of words) {
    const text = w.text.trim();
    if (!text) continue;
    let hex = "";
    let adv = 0;
    for (const ch of text) {
      const gid = font.encodeCharacter(ch.codePointAt(0)!);
      hex += gid.toString(16).padStart(4, "0");
      adv += gid ? font.advanceGlyph(gid) : 0.5;
    }
    const size = Math.max(2, w.size);
    const k = w.slope ?? 0;
    // A real space spanning the gap to the word before: MuPDF would start a new line at a gap
    // wider than about 0.8 em (common between sentences on a scan), and copied text gets spaces.
    if (w.join && prev && spaceAdv) {
      const gap = w.bbox[0] - prev.bbox[2];
      if (gap > 0.05) show(spaceGid.toString(16).padStart(4, "0"), spaceAdv, prev.bbox[2], w.baseline - k * gap, gap, size, k);
    }
    show(hex, adv, w.bbox[0], w.baseline, w.bbox[2] - w.bbox[0], size, k);
    written++;
    prev = w;
  }
  ops += "Q\n";
  if (written) appendContent(doc, pageObj, ops);
  pageObj.put(OCR_KEY, true);
  return written;
}

/** The page's own Resources dictionary (copied from the parent if it was inherited). */
export function ownResources(doc: MuPDF.PDFDocument, pageObj: MuPDF.PDFObject): MuPDF.PDFObject {
  const own = pageObj.get("Resources");
  if (own.isDictionary()) return own;
  const inherited = pageObj.getInheritable("Resources");
  const res = doc.newDictionary();
  if (inherited.isDictionary()) inherited.forEach((v, k) => res.put(k as string, v));
  pageObj.put("Resources", res);
  return pageObj.get("Resources");
}

/** Add drawing operators after the page's existing content (keeping its graphics state sealed off). */
export function appendContent(doc: MuPDF.PDFDocument, pageObj: MuPDF.PDFObject, ops: string): void {
  const enc = new TextEncoder();
  const contents = pageObj.get("Contents");
  const arr = doc.newArray();
  arr.push(doc.addStream(enc.encode("q\n"), {}));
  if (contents.isArray()) contents.forEach((c) => arr.push(c));
  else if (!contents.isNull()) arr.push(contents);
  arr.push(doc.addStream(enc.encode("Q\n"), {}));
  arr.push(doc.addStream(enc.encode(ops), {}));
  pageObj.put("Contents", arr);
}

/**
 * Paper and ink colours of a page area, from a rendered image (RGBA, row-major).
 * Paper = typical bright pixel, ink = typical dark pixel.
 */
export function sampleColors(data: Uint8ClampedArray): { paper: [number, number, number]; ink: [number, number, number] } {
  const px: [number, number, number, number][] = [];
  for (let i = 0; i < data.length; i += 4) px.push([data[i], data[i + 1], data[i + 2], 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]]);
  if (!px.length) return { paper: [1, 1, 1], ink: [0, 0, 0] };
  px.sort((a, b) => a[3] - b[3]);
  const pick = (from: number, to: number): [number, number, number] => {
    const s = px.slice(Math.floor(px.length * from), Math.max(Math.floor(px.length * from) + 1, Math.floor(px.length * to)));
    const med = (k: number) => s.map((p) => p[k]).sort((a, b) => a - b)[s.length >> 1] / 255;
    return [med(0), med(1), med(2)];
  };
  return { paper: pick(0.6, 0.95), ink: pick(0, 0.01) };
}
