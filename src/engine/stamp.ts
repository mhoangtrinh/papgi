// Text stamped onto pages as real page content: watermarks, page numbers, headers and footers.
import type * as MuPDF from "mupdf";
import type { Point } from "../core/geometry";
import { appendContent, ownResources } from "./ocr";

type M = typeof MuPDF;

export interface WatermarkOptions {
  text: string;
  size: number; // points
  color: number[]; // RGB 0..1
  opacity: number; // 0..1
  angle: number; // degrees, counterclockwise as seen on the page
  bold: boolean;
  pages: number[];
}

export type Corner = "tl" | "tc" | "tr" | "bl" | "bc" | "br";

export interface HeaderFooterOptions {
  /** Text per place; {page}, {pages}, {date} and {file} are filled in. */
  items: Partial<Record<Corner, string>>;
  size: number;
  color: number[];
  margin: number; // distance from the page edge (points)
  startAt: number; // number of the first numbered page
  skipFirst: boolean; // nothing on the first page (a title page)
  pages: number[];
  file?: string;
  date?: string;
}

const num = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(+v.toFixed(4)));

/** Fill in {page}, {pages}, {date}, {file}. */
export function fillTemplate(t: string, v: { page: number; pages: number; date?: string; file?: string }): string {
  return t
    .replace(/\{page\}/g, String(v.page))
    .replace(/\{pages\}/g, String(v.pages))
    .replace(/\{date\}/g, v.date ?? "")
    .replace(/\{file\}/g, v.file ?? "");
}

/** The first font that has every character of the text (null: none has them all). */
export function pickFont(fonts: MuPDF.Font[], text: string): MuPDF.Font | null {
  const chars = [...text].filter((c) => c.trim());
  return fonts.find((f) => chars.every((c) => f.encodeCharacter(c.codePointAt(0)!) > 0)) ?? null;
}

/** Puts fonts (once per document) and graphics states on pages, and writes text runs. */
export class Stamper {
  private fontObjs = new Map<MuPDF.Font, MuPDF.PDFObject>();

  constructor(
    private m: M,
    private doc: MuPDF.PDFDocument,
  ) {}

  /** Width of the text in points. */
  width(font: MuPDF.Font, text: string, size: number): number {
    let w = 0;
    for (const c of text) {
      const g = font.encodeCharacter(c.codePointAt(0)!);
      w += g > 0 ? font.advanceGlyph(g) : 0.5;
    }
    return w * size;
  }

  /**
   * Draw text on a page. `at` is in page space (as seen, y down); the text's local origin
   * (baseline start) is placed there after moving it by `offset` (local, y up) and turning
   * it by `angle` (degrees counterclockwise as seen).
   */
  draw(page: MuPDF.PDFPage, runs: { text: string; at: Point; offset: Point; angle: number }[], font: MuPDF.Font, size: number, color: number[], opacity: number): void {
    const m = this.m;
    const pobj = page.getObject();
    const res = ownResources(this.doc, pobj);
    const dict = (key: string) => {
      let d = res.get(key);
      if (!d.isDictionary()) {
        res.put(key, this.doc.newDictionary());
        d = res.get(key);
      }
      return d;
    };
    const fonts = dict("Font");
    let fobj = this.fontObjs.get(font);
    if (!fobj) {
      fobj = this.doc.addFont(font);
      this.fontObjs.set(font, fobj);
    }
    let k = 1;
    while (!fonts.get(`PapgiF${k}`).isNull() && fonts.get(`PapgiF${k}`).asIndirect() !== fobj.asIndirect()) k++;
    const fname = `PapgiF${k}`;
    fonts.put(fname, fobj);
    let gs = "";
    if (opacity < 1) {
      const states = dict("ExtGState");
      let g = 1;
      while (!states.get(`PapgiGS${g}`).isNull()) g++;
      const st = this.doc.newDictionary();
      st.put("CA", opacity);
      st.put("ca", opacity);
      states.put(`PapgiGS${g}`, st);
      gs = `/PapgiGS${g} gs `;
    }
    const inv = m.Matrix.invert(page.getTransform());
    let ops = `q ${gs}${color.map(num).join(" ")} rg\nBT /${fname} ${num(size)} Tf\n`;
    for (const r of runs) {
      // local (y up) -> as seen (y down, turned, placed) -> PDF space
      const local = m.Matrix.concat(m.Matrix.translate(r.offset[0], r.offset[1]), m.Matrix.scale(1, -1));
      const seen = m.Matrix.concat(m.Matrix.concat(local, m.Matrix.rotate(-r.angle)), m.Matrix.translate(r.at[0], r.at[1]));
      const tm = m.Matrix.concat(seen, inv);
      let hex = "";
      for (const c of r.text) {
        const g = font.encodeCharacter(c.codePointAt(0)!);
        hex += Math.max(0, g).toString(16).padStart(4, "0");
      }
      ops += `${tm.map(num).join(" ")} Tm <${hex}> Tj\n`;
    }
    ops += "ET Q\n";
    appendContent(this.doc, pobj, ops);
  }
}

/** A watermark across each page: centred, turned by the angle. */
export function addWatermark(m: M, doc: MuPDF.PDFDocument, o: WatermarkOptions, font: MuPDF.Font): void {
  const st = new Stamper(m, doc);
  const w = st.width(font, o.text, o.size);
  for (const i of o.pages) {
    const page = doc.loadPage(i);
    try {
      const b = page.getBounds();
      const c: Point = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      // (cap height about 0.7 of the size: centred on that)
      st.draw(page, [{ text: o.text, at: c, offset: [-w / 2, -o.size * 0.35], angle: o.angle }], font, o.size, o.color, o.opacity);
    } finally {
      page.destroy();
    }
  }
}

/** Page numbers, headers and footers. Returns how many pages got something. */
export function addHeaderFooter(m: M, doc: MuPDF.PDFDocument, o: HeaderFooterOptions, fontFor: (text: string) => MuPDF.Font): number {
  const st = new Stamper(m, doc);
  const total = doc.countPages();
  let done = 0;
  o.pages.forEach((i, k) => {
    if (o.skipFirst && i === 0) return;
    const page = doc.loadPage(i);
    try {
      const b = page.getBounds();
      // numbered in the order the pages are (a skipped title page isn't counted)
      const n = o.startAt + k - (o.skipFirst && o.pages.includes(0) ? 1 : 0);
      const shown = o.skipFirst ? total - 1 : total;
      for (const [corner, tpl] of Object.entries(o.items) as [Corner, string][]) {
        if (!tpl?.trim()) continue;
        const text = fillTemplate(tpl, { page: n, pages: shown + o.startAt - 1, date: o.date, file: o.file });
        const font = fontFor(text);
        const w = st.width(font, text, o.size);
        const top = corner[0] === "t";
        const y = top ? b[1] + o.margin + o.size * 0.75 : b[3] - o.margin;
        const x = corner[1] === "l" ? b[0] + o.margin : corner[1] === "r" ? b[2] - o.margin - w : (b[0] + b[2]) / 2 - w / 2;
        st.draw(page, [{ text, at: [x, y], offset: [0, 0], angle: 0 }], font, o.size, o.color, 1);
      }
      done++;
    } finally {
      page.destroy();
    }
  });
  return done;
}
