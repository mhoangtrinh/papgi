// PDF → Word (.docx). Two ways:
// - "pictures": every page as one picture on a page of the same size (looks the same, not editable);
// - "editable": text rebuilt as Word paragraphs (fonts, sizes, bold/italic, colours, super-/subscript,
//   alignment, indents, spacing, line breaks), tables with ruling lines as Word tables (merged cells,
//   borders, shading), text blocks side by side as borderless tables, two-column pages as Word
//   columns, lists with hanging indents; pictures inline, beside the text (wrapped) or in the flow;
//   drawings, formulas and turned text as pictures of their area; the remaining lines and boxes as
//   one see-through picture behind the text; pages that are only a scan as pictures.
// Lines are kept as long as in the PDF: where Word's font would make a line too long, the letters
// get a little tighter, and Word hyphenates when the PDF does.
import type * as MuPDF from "mupdf";
import { buildDocx, type DocxBlock, type DocxBorder, type DocxCell, type DocxParagraph, type DocxRun, type DocxSection, type DocxTable } from "../core/docx";
import { PasswordError, type PdfInput } from "./tools";

type M = typeof MuPDF;
type Rect = [number, number, number, number];

export interface WordOptions {
  mode: "editable" | "pictures";
  /** Pictures mode: resolution. */
  dpi?: number;
}

export interface WordResult {
  bytes: Uint8Array;
  /** Pages that went in as pictures although text was asked for (scans), 0-based. */
  scanned: number[];
}

function open(mupdf: M, f: PdfInput): MuPDF.PDFDocument {
  let doc: MuPDF.PDFDocument | null = null;
  try {
    doc = mupdf.Document.openDocument(f.bytes, "application/pdf").asPDF();
  } catch {
    doc = null;
  }
  if (!doc) throw new Error(`“${f.name}” isn't a PDF file that can be read`);
  if (doc.needsPassword() && !(f.password && doc.authenticatePassword(f.password))) {
    doc.destroy();
    throw new PasswordError(f.name);
  }
  return doc;
}

export function pdfToWord(mupdf: M, f: PdfInput, pages: number[], opts: WordOptions, turns: number[] = []): WordResult {
  const doc = open(mupdf, f);
  const title = f.name.replace(/\.[^.]+$/, "");
  try {
    const sections: DocxSection[] = [];
    const scanned: number[] = [];
    if (opts.mode === "pictures") {
      pages.forEach((p, k) => sections.push(picturePage(mupdf, doc, p, opts.dpi ?? 150, turns[k] ?? 0)));
      return { bytes: buildDocx(sections, { title }), scanned };
    }
    const conv = new Converter(mupdf);
    const extracted = pages.map((p) => conv.extract(doc, p));
    conv.finishStyles(extracted);
    extracted.forEach((pg, k) => {
      if (pg.scan) {
        scanned.push(pages[k]);
        sections.push(picturePage(mupdf, doc, pages[k], 150, 0));
      } else sections.push(...conv.layout(pg));
    });
    return {
      bytes: buildDocx(sections, { title, font: conv.mainFont, size: conv.bodySize, lang: conv.lang, hyphenate: conv.hyphenJoins >= 2 }),
      scanned,
    };
  } finally {
    doc.destroy();
  }
}

/** One page as one picture on a page of its size. */
function picturePage(mupdf: M, doc: MuPDF.PDFDocument, index: number, dpi: number, turn: number): DocxSection {
  const page = doc.loadPage(index);
  try {
    const b = page.getBounds();
    const t = (((Math.round(turn / 90) * 90) % 360) + 360) % 360;
    let w = b[2] - b[0];
    let h = b[3] - b[1];
    if (t % 180) [w, h] = [h, w];
    const s = Math.min(dpi / 72, Math.sqrt(30e6 / Math.max(1, w * h)));
    const pix = page.toPixmap(mupdf.Matrix.concat(mupdf.Matrix.scale(s, s), mupdf.Matrix.rotate(t)), mupdf.ColorSpace.DeviceRGB, false, true);
    let data: Uint8Array;
    try {
      data = pix.asJPEG(88, false).slice();
    } finally {
      pix.destroy();
    }
    return { width: w, height: h, margins: { top: 0, right: 0, bottom: 0, left: 0 }, blocks: [{ kind: "img", type: "jpeg", data, w, h, anchor: { x: 0, y: 0 }, name: `Page ${index + 1}` }] };
  } finally {
    page.destroy();
  }
}

// ---------------------------------------------------------------- editable

interface FontInfo {
  family: string;
  bold: boolean;
  italic: boolean;
}

interface Ch {
  c: string;
  /** Origin (baseline start). */
  x: number;
  y: number;
  /** Right edge, top and bottom of the glyph box. */
  x1: number;
  top: number;
  bottom: number;
  size: number;
  font: FontInfo;
  color: string;
  underline?: boolean;
  strike?: boolean;
  /** Background colour (highlighter). */
  shade?: string;
}

/** A piece of a line (MuPDF splits lines at big gaps), or a small picture in a line. */
interface Seg {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  chars: Ch[];
  pic?: PicItem;
}

/** A visual line: pieces on the same baseline, left to right. */
interface Row {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  base: number;
  size: number;
  segs: Seg[];
}

interface TextItem {
  kind: "text";
  r: Rect;
  rows: Row[];
}

interface PicItem {
  kind: "pic";
  r: Rect;
  data: Uint8Array;
  type: "png" | "jpeg";
  /** Placed on the page, outside the text flow (turned text). */
  float?: boolean;
  /** Behind text that sits on it (a picture or box with text on top). */
  behind?: boolean;
}

interface TableCell {
  r0: number;
  c0: number;
  /** (exclusive) */
  r1: number;
  c1: number;
  fill?: string;
  borders: { top: DocxBorder | null; left: DocxBorder | null; bottom: DocxBorder | null; right: DocxBorder | null };
  segs: Seg[];
  pics: PicItem[];
  /** Whole content laid out in the cell (columns side by side). */
  items?: Item[];
}

interface TableItem {
  kind: "table";
  r: Rect;
  xs: number[];
  ys: number[];
  cells: TableCell[];
}

type Item = TextItem | PicItem | TableItem;

interface PageData {
  index: number;
  w: number;
  h: number;
  items: Item[];
  scan: boolean;
  /** Lines, boxes, fills and form fields: one see-through picture behind the text. */
  decor?: Uint8Array;
}

interface Rule {
  /** Horizontal: at y = c from a to b; vertical: at x = c. */
  o: "h" | "v";
  c: number;
  a: number;
  b: number;
  w: number;
  color: string;
}

const BULLETS = new Set(["•", "◦", "▪", "■", "□", "●", "○", "‣", "⁃", "–", "-", "∙", "·", "➢", "➤", "►", "✓", "✔", "❖", "◆", "◇"]);

/** Height of one line of text ("single" spacing) per font size, as Word lays it out. */
function lineFactor(family: string): number {
  const f = family.toLowerCase();
  if (/calibri|carlito/.test(f)) return 1.22;
  if (/cambria|caladea/.test(f)) return 1.17;
  if (/courier/.test(f)) return 1.13;
  if (/segoe|verdana|tahoma/.test(f)) return 1.21;
  return 1.15;
}

/** Symbol-font bullets in the private use area. */
const PUA: Record<number, string> = { 0xf0b7: "•", 0xf0a7: "▪", 0xf0a8: "▪", 0xf06e: "■", 0xf076: "❖", 0xf0d8: "➢", 0xf0fc: "✓", 0xf0e0: "→", 0xf06f: "□", 0xf0a1: "○", 0xf02d: "-" };

/** (the lower one of the two middle values) */
const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const overlaps = (a: Rect, b: Rect, pad = 0) => a[0] < b[2] + pad && b[0] < a[2] + pad && a[1] < b[3] + pad && b[1] < a[3] + pad;
/** How much of `a` lies in `b` (0-1). */
const inside = (a: Rect, b: Rect) => {
  const i: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return area(a) > 0 ? area(i) / area(a) : a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3] ? 1 : 0;
};
const segRect = (s: Seg): Rect => [s.x0, s.top, s.x1, s.bottom];
const center = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
const contains = (r: Rect, x: number, y: number, pad = 0) => x >= r[0] - pad && x <= r[2] + pad && y >= r[1] - pad && y <= r[3] + pad;
const yOverlap = (a: Rect, b: Rect) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]);

/** Word-friendly font family from a PDF font name. */
export function wordFont(name: string): FontInfo {
  let n = name.replace(/^[A-Z]{6}\+/, "");
  const lower = n.toLowerCase();
  const bold = /bold|black|heavy|semibold|demi|[-,]bd\b|medium/.test(lower) && !/semilight/.test(lower);
  const italic = /italic|oblique|[-,]it\b|slanted/.test(lower);
  n = n.replace(/[-,_ ]?(PSMT|PS|MT)$/i, "");
  n = n.replace(/[-,_ ]?(Regular|Roman|Book|Normal|Plain|Bold|Italic|Oblique|BoldItalic|BoldOblique|Semibold|SemiBold|Medium|Light|Black|Heavy|Demi|It|Bd|BdIt)+$/i, "");
  n = n.replace(/[-,_]+$/, "");
  const l = n.toLowerCase().replace(/[^a-z]/g, "");
  const map: [RegExp, string][] = [
    [/^(lmroman|lmr|cmr|cmu(serif)?|cmbx|cmti|cmsl|lmmath|cmmi|cmsy|lmmathsymbols|cmex|lmmathextension|nimbusrom|tex(gyre)?termes|termes|times|timesnewroman|tinos|liberationserif|dejavuserif|stix|xits|ptm)/, "Times New Roman"],
    [/^(lmsans|lmss|cmss|cmusans|helvetica|arial|arimo|liberationsans|nimbussan|texgyreheros|heros|phv)/, "Arial"],
    [/^(lmmono|lmtt|cmtt|cmutypewriter|courier|cousine|liberationmono|nimbusmon|texgyrecursor|pcr)/, "Courier New"],
    [/^carlito/, "Calibri"],
    [/^caladea/, "Cambria"],
    // (symbol fonts: the characters are real Unicode, the document's font shows them)
    [/^(symbolmt|symbol|opensymbol|wingdings|zapfdingbats|dingbats)/, ""],
  ];
  for (const [re, fam] of map) if (re.test(l)) return { family: fam, bold: fam ? bold : false, italic: fam ? italic : false };
  // CamelCase names: "MinionPro" -> "Minion Pro", "SourceSansPro" -> "Source Sans Pro"
  const family = n.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ").trim() || "Calibri";
  return { family, bold, italic };
}

function hex(color: ArrayLike<number> | undefined): string {
  if (!color) return "000000";
  let r = 0;
  let g = 0;
  let b = 0;
  if (color.length === 1) r = g = b = color[0];
  else if (color.length === 3) [r, g, b] = [color[0], color[1], color[2]];
  else if (color.length === 4) {
    const [c, m, y, k] = [color[0], color[1], color[2], color[3]];
    r = (1 - c) * (1 - k);
    g = (1 - m) * (1 - k);
    b = (1 - y) * (1 - k);
  }
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return (h(r) + h(g) + h(b)).toUpperCase();
}

/** Simple union-find: groups of indices joined by `joined`. */
function groupsOf(n: number, joined: (i: number, j: number) => boolean): number[][] {
  const p = [...Array(n).keys()];
  const find = (i: number): number => (p[i] === i ? i : (p[i] = find(p[i])));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (joined(i, j)) p[find(i)] = find(j);
  const m = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!m.has(r)) m.set(r, []);
    m.get(r)!.push(i);
  }
  return [...m.values()];
}

/** Values closer than `tol` become one (their average). */
function cluster(v: number[], tol: number): number[] {
  const s = v.slice().sort((a, b) => a - b);
  const out: number[][] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x - last[last.length - 1] <= tol) last.push(x);
    else out.push([x]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

class Converter {
  private fonts = new Map<string, FontInfo>();
  private stroke: MuPDF.StrokeState;
  mainFont = "Calibri";
  bodySize = 11;
  lang = "en-US";
  /** Words split over two lines with a hyphen (Word then hyphenates too). */
  hyphenJoins = 0;
  /** Heading sizes, biggest first (level 1, 2, 3). */
  private headingSizes: number[] = [];
  /** Font metrics for Word's standard fonts (same widths as Times, Helvetica, Courier). */
  private metrics = new Map<string, MuPDF.Font | null>();
  private advCache = new Map<string, number>();

  constructor(private mupdf: M) {
    this.stroke = new mupdf.StrokeState({ lineCap: "Butt", lineJoin: "Miter", lineWidth: 0, miterLimit: 10 } as MuPDF.StrokeStateData);
  }

  private fontOf(font: MuPDF.Font): FontInfo {
    const name = font.getName();
    let f = this.fonts.get(name);
    if (!f) {
      const w = wordFont(name);
      f = { family: w.family, bold: w.bold || font.isBold(), italic: w.italic || font.isItalic() };
      this.fonts.set(name, f);
    }
    return f;
  }

  // ---------- reading a page ----------

  extract(doc: MuPDF.PDFDocument, index: number): PageData {
    const mupdf = this.mupdf;
    const page = doc.loadPage(index);
    try {
      const pb = page.getBounds();
      const W = pb[2] - pb[0];
      const H = pb[3] - pb[1];
      const ox = pb[0];
      const oy = pb[1];

      // text and pictures, as MuPDF sees them
      type Block = { segs: Seg[] };
      const blocks: Block[] = [];
      const turned: Rect[] = [];
      const images: Rect[] = [];
      let seg: Seg | null = null;
      let skew = false;
      let block: Block | null = null;
      const st = page.toStructuredText("preserve-whitespace,preserve-images,preserve-spans");
      st.walk({
        onImageBlock: (b) => void images.push([b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy]),
        beginTextBlock: () => void (block = { segs: [] }),
        endTextBlock: () => {
          if (block && block.segs.length) blocks.push(block);
          block = null;
        },
        beginLine: (b, wmode, dir) => {
          seg = { x0: Infinity, x1: -Infinity, top: Infinity, bottom: -Infinity, chars: [] };
          // turned or vertical text: kept as a picture
          skew = wmode !== 0 || Math.abs(dir[1]) > 0.05 || dir[0] < 0;
          if (skew) turned.push([b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy]);
        },
        onChar: (c, origin, font, size, quad, color) => {
          if (!seg || skew) return;
          const code = c.codePointAt(0) ?? 0;
          if (code >= 0xe000 && code <= 0xf8ff) c = PUA[code] ?? (seg.chars.length ? "" : "•");
          if (!c) return;
          const x0 = Math.min(quad[0], quad[4]) - ox;
          const x1 = Math.max(quad[2], quad[6]) - ox;
          const top = Math.min(quad[1], quad[3]) - oy;
          const bottom = Math.max(quad[5], quad[7]) - oy;
          seg.chars.push({ c, x: origin[0] - ox, y: origin[1] - oy, x1, top, bottom, size, font: this.fontOf(font), color: hex(color) });
          if (c.trim()) {
            seg.x0 = Math.min(seg.x0, x0);
            seg.x1 = Math.max(seg.x1, x1);
            seg.top = Math.min(seg.top, top);
            seg.bottom = Math.max(seg.bottom, bottom);
          }
        },
        endLine: () => {
          if (seg && block && !skew && seg.chars.some((ch) => ch.c.trim())) block.segs.push(seg);
          seg = null;
        },
      });
      st.destroy();

      // a page that is one big picture: a scan (with recognised text: use the text, drop the picture)
      const textArea = blocks.reduce((n, b) => n + area(this.segBox(b.segs)), 0);
      const big = images.filter((r) => area(r) > 0.6 * W * H);
      if (!blocks.length && (big.length || images.length) && !turned.length) return { index, w: W, h: H, items: [], scan: true };
      const pics: Rect[] = images
        .filter((r) => !(big.includes(r) && textArea > 0) && area(r) > 16)
        .map((r) => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])] as Rect);

      // drawings: complex shapes (curves, slanted lines, shadings) make figures; straight lines and
      // boxes are rules and fills (tables, underlines, frames)
      const shapes: { r: Rect; complex: boolean; closed?: boolean }[] = [];
      const rules: Rule[] = [];
      const fills: { r: Rect; color: string }[] = [];
      const addPath = (path: MuPDF.Path, ctm: MuPDF.Matrix, stroke: MuPDF.StrokeState | null, color: string) => {
        const m = ctm as number[];
        const tp = (x: number, y: number) => [x * m[0] + y * m[2] + m[4] - ox, x * m[1] + y * m[3] + m[5] - oy];
        const subs: number[][][] = [];
        let cur: number[][] = [];
        let complex = false;
        let closed = !stroke;
        path.walk({
          moveTo: (x, y) => {
            if (cur.length) subs.push(cur);
            cur = [tp(x, y)];
          },
          lineTo: (x, y) => void cur.push(tp(x, y)),
          curveTo: (_a, _b, _c, _d, x, y) => {
            complex = true;
            cur.push(tp(x, y));
          },
          closePath: () => {
            closed = true;
            if (cur.length) cur.push(cur[0]);
          },
        });
        if (cur.length) subs.push(cur);
        for (const s of subs) for (let i = 1; i < s.length; i++) if (Math.abs(s[i][0] - s[i - 1][0]) > 0.6 && Math.abs(s[i][1] - s[i - 1][1]) > 0.6) complex = true;
        const b = path.getBounds(stroke ?? this.stroke, ctm);
        const r: Rect = [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy];
        if (!(r[2] >= r[0]) || area(r) > 0.85 * W * H) return;
        shapes.push({ r, complex, closed });
        if (complex) return;
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        if (stroke) {
          const w = Math.max(0.25, stroke.getLineWidth() * scale);
          for (const s of subs)
            for (let i = 1; i < s.length; i++) {
              const [x0, y0] = s[i - 1];
              const [x1, y1] = s[i];
              if (Math.abs(y1 - y0) <= 0.6 && Math.abs(x1 - x0) > 2) rules.push({ o: "h", c: (y0 + y1) / 2, a: Math.min(x0, x1), b: Math.max(x0, x1), w, color });
              else if (Math.abs(x1 - x0) <= 0.6 && Math.abs(y1 - y0) > 2) rules.push({ o: "v", c: (x0 + x1) / 2, a: Math.min(y0, y1), b: Math.max(y0, y1), w, color });
            }
        } else
          for (const s of subs) {
            if (s.length < 4) continue;
            const xs = s.map((p) => p[0]);
            const ys = s.map((p) => p[1]);
            const rr: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
            const w = rr[2] - rr[0];
            const h = rr[3] - rr[1];
            if (h <= 2.5 && w > 2) rules.push({ o: "h", c: (rr[1] + rr[3]) / 2, a: rr[0], b: rr[2], w: Math.max(0.25, h), color });
            else if (w <= 2.5 && h > 2) rules.push({ o: "v", c: (rr[0] + rr[2]) / 2, a: rr[1], b: rr[3], w: Math.max(0.25, w), color });
            else if (w > 2 && h > 2) fills.push({ r: rr, color });
          }
      };
      const dev = new mupdf.Device({
        fillPath: (path: MuPDF.Path, _eo: boolean, ctm: MuPDF.Matrix, _cs: MuPDF.ColorSpace, color: number[]) => addPath(path, ctm, null, hex(color)),
        strokePath: (path: MuPDF.Path, stroke: MuPDF.StrokeState, ctm: MuPDF.Matrix, _cs: MuPDF.ColorSpace, color: number[]) => addPath(path, ctm, stroke, hex(color)),
        fillShade: (shade: MuPDF.Shade, ctm: MuPDF.Matrix) => {
          const r = this.tf(shade.getBounds(), ctm as number[], ox, oy);
          if (area(r) < 0.8 * W * H) shapes.push({ r, complex: true, closed: true });
        },
      } as never);
      try {
        page.runPageContents(dev, mupdf.Matrix.identity);
      } catch {
        /* (drawing problems: no figures) */
      }
      dev.close();

      // figures: complex shapes plus everything that touches them, grown together
      // (a closed shape with text inside is a box behind text, e.g. with round corners: not a figure)
      const allText = blocks.flatMap((b) => b.segs);
      const boxBehind = (sh: { r: Rect; closed?: boolean }) => sh.closed && allText.some((sg) => inside(segRect(sg), sh.r) > 0.9 && sg.chars.length > 2);
      const behindText = shapes.filter(boxBehind);
      let figs: Rect[] = shapes.filter((s) => s.complex && !behindText.includes(s)).map((s) => s.r);
      figs = this.grow(figs, shapes.filter((s) => !behindText.includes(s)).map((s) => s.r), 6);
      figs = figs.filter((r) => r[2] - r[0] >= 12 && r[3] - r[1] >= 12 && area(r) >= 300);

      // text blocks that cross each other are one block (superscripts, labels set apart)
      const boxes = blocks.map((b) => this.segBox(b.segs));
      const crossing = groupsOf(blocks.length, (i, j) => Math.min(boxes[i][2], boxes[j][2]) - Math.max(boxes[i][0], boxes[j][0]) > 1 && Math.min(boxes[i][3], boxes[j][3]) - Math.max(boxes[i][1], boxes[j][1]) > 1);
      const tb = crossing.map((g) => {
        const segs = g.flatMap((i) => blocks[i].segs);
        return { segs, r: this.segBox(segs) };
      });

      // formulas: lines stacked closer than lines of text, over each other (fractions, limits)
      const knots: Rect[] = [];
      for (const rows of tb.flatMap((b) => this.columns(b.segs).map((part) => this.rows(part)))) {
        // (a fraction around a line: its top and bottom part over each other, the line between them)
        for (let i = 0; i + 2 < rows.length; i++) {
          const a = rows[i];
          const c = rows[i + 2];
          const size = rows[i + 1].size;
          if (c.base - a.base > 2 * size) continue;
          const narrow = (sg: Seg) => sg.x1 - sg.x0 < 4 * size;
          if (a.segs.some((p) => narrow(p) && c.segs.some((q) => narrow(q) && Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0.5 * Math.min(p.x1 - p.x0, q.x1 - q.x0)))) {
            let k: Rect = union([a.x0, a.top, a.x1, a.bottom], [c.x0, c.top, c.x1, c.bottom]);
            for (const r of rows) if (Math.min(r.bottom, k[3]) - Math.max(r.top, k[1]) > 0.3 * (r.bottom - r.top)) k = union(k, [r.x0, r.top, r.x1, r.bottom]);
            knots.push(k);
          }
        }
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1];
          const c = rows[i];
          const size = Math.min(a.size, c.size);
          const narrow = Math.min(a.x1 - a.x0, c.x1 - c.x0);
          const wide = Math.max(a.x1 - a.x0, c.x1 - c.x0);
          // (pieces really over each other, not just lines side by side in columns)
          const stacked = a.segs.some((p) => c.segs.some((q) => Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 0.5 * Math.min(p.x1 - p.x0, q.x1 - q.x0)));
          if (c.base - a.base < 0.72 * size && stacked && (rows.length <= 4 || narrow < 0.4 * wide)) {
            let k: Rect = union([a.x0, a.top, a.x1, a.bottom], [c.x0, c.top, c.x1, c.bottom]);
            for (const r of rows) if (Math.min(r.bottom, k[3]) - Math.max(r.top, k[1]) > 0.3 * (r.bottom - r.top)) k = union(k, [r.x0, r.top, r.x1, r.bottom]);
            knots.push(k);
          }
        }
      }
      // text without real letters (fonts with no Unicode mapping): a picture of it
      for (const b of tb) {
        const cs = b.segs.flatMap((sg) => sg.chars).filter((c) => c.c.trim());
        if (cs.length && cs.filter((c) => c.c === "\ufffd").length > 0.25 * cs.length) knots.push(b.r);
      }
      // pictures/figures take the text that sits on them (labels) and formula parts next to them
      // small drawings (icons, symbols) stay in their line of text
      const pageSize = this.blockSize(allText);
      const icons = figs.filter((r) => r[2] - r[0] < 3.5 * pageSize && r[3] - r[1] < 3.5 * pageSize);
      let regions = [...this.merge(knots, 0), ...figs.filter((r) => !icons.includes(r))];
      const nearText = (r: Rect, t: Rect, size: number) =>
        inside(t, r) > 0.5 || (overlaps(r, t, size * 1.2) && t[3] - t[1] < 3 * size && yOverlap(r, t) > 0.3 * (t[3] - t[1]) && r[3] - r[1] < 160);
      for (let pass = 0; pass < 3; pass++) {
        regions = this.merge(regions, 2).map((r) => {
          let g = r;
          for (const b of tb) if (nearText(g, b.r, this.blockSize(b.segs)) && (inside(b.r, g) > 0.5 || knots.some((k) => overlaps(k, g)))) g = union(g, b.r);
          return g;
        });
      }
      regions = this.merge(regions, 2);
      const turnedRegions = this.merge(turned, 3).filter((r) => !regions.some((g) => inside(r, g) > 0.8));

      // tables from ruling lines (not inside figures)
      const tables = this.tables(
        rules.filter((r) => !regions.some((g) => inside(r.o === "h" ? [r.a, r.c - 1, r.b, r.c + 1] : [r.c - 1, r.a, r.c + 1, r.b], g) > 0.8)),
        fills,
        W,
        H,
      );
      const cellAt = (x: number, y: number) => {
        for (const t of tables) {
          if (!contains(t.r, x, y, -0.5)) continue;
          const c = t.cells.find((c) => contains([t.xs[c.c0], t.ys[c.r0], t.xs[c.c1], t.ys[c.r1]], x, y));
          if (c) return c;
        }
        return null;
      };

      // underlines, strike-throughs and highlights belong to the letters (they move with the text)
      const used: Rect[] = [];
      const allSegs = tb.flatMap((b) => b.segs);
      const tableRule = (r: Rule) => tables.some((t) => inside(r.o === "h" ? [r.a, r.c - 0.5, r.b, r.c + 0.5] : [r.c - 0.5, r.a, r.c + 0.5, r.b], [t.r[0] - 2, t.r[1] - 2, t.r[2] + 2, t.r[3] + 2]) > 0.9);
      for (const rl of rules) {
        if (rl.o !== "h" || rl.w > 2.5 || tableRule(rl)) continue;
        let hit = false;
        for (const sg of allSegs) {
          if (sg.x1 < rl.a - 1 || sg.x0 > rl.b + 1 || rl.c < sg.top - 2 || rl.c > sg.bottom + 3) continue;
          for (const c of sg.chars) {
            const mid = (c.x + c.x1) / 2;
            if (mid < rl.a - 0.5 || mid > rl.b + 0.5) continue;
            const d = rl.c - c.y;
            if (d > -0.05 * c.size && d < 0.4 * c.size) c.underline = hit = true;
            else if (d < -0.12 * c.size && d > -0.45 * c.size) c.strike = hit = true;
          }
        }
        if (hit) used.push([rl.a - rl.w, rl.c - rl.w, rl.b + rl.w, rl.c + rl.w]);
      }
      for (const f of fills) {
        if (f.color === "FFFFFF" || tables.some((t) => inside(f.r, t.r) > 0.9)) continue;
        let hit = false;
        for (const sg of allSegs) {
          if (!overlaps(segRect(sg), f.r)) continue;
          for (const c of sg.chars) {
            const [cx, cy] = [(c.x + c.x1) / 2, (c.top + c.bottom) / 2];
            if (contains(f.r, cx, cy) && f.r[3] - f.r[1] < 2.4 * c.size) c.shade = (hit = true) && f.color;
          }
        }
        if (hit) used.push([f.r[0] - 0.5, f.r[1] - 0.5, f.r[2] + 0.5, f.r[3] + 0.5]);
      }

      const picAll = this.merge(pics, 0).filter((p) => !regions.some((r) => inside(p, r) > 0.9));
      // pictures with text on them: behind the (editable) text
      const hasText = (r: Rect) => allText.filter((sg) => inside(segRect(sg), r) > 0.5 && sg.chars.length > 2).length >= 1;
      const backs = picAll.filter(hasText);
      const picRects = picAll.filter((r) => !backs.includes(r));

      const items: Item[] = [];
      const render = (r: Rect, type: "png" | "jpeg", noText = false): PicItem | null => {
        const pad = type === "png" ? 1.5 : 0;
        const rr: Rect = [Math.max(0, r[0] - pad), Math.max(0, r[1] - pad), Math.min(W, r[2] + pad), Math.min(H, r[3] + pad)];
        const s = Math.min(type === "png" ? 220 / 72 : 200 / 72, Math.sqrt(12e6 / Math.max(1, area(rr))));
        const bbox: Rect = [Math.floor((rr[0] + ox) * s), Math.floor((rr[1] + oy) * s), Math.ceil((rr[2] + ox) * s), Math.ceil((rr[3] + oy) * s)];
        if (bbox[2] - bbox[0] < 2 || bbox[3] - bbox[1] < 2) return null;
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
        try {
          pix.clear(255);
          const d = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
          page.runPageContents(noText ? this.withoutText(d) : d, mupdf.Matrix.identity);
          d.close();
          const data = (type === "png" ? pix.asPNG() : pix.asJPEG(88, false)).slice();
          return { kind: "pic", r: rr, data, type };
        } finally {
          pix.destroy();
        }
      };
      const placed: PicItem[] = [];
      for (const r of regions) {
        const p = render(r, "png");
        if (p) placed.push(p);
      }
      for (const r of turnedRegions) {
        const p = render(r, "png");
        if (p) placed.push({ ...p, float: true });
      }
      for (const r of icons) {
        if (regions.some((g) => overlaps(g, r))) continue;
        const p = render(r, "png", true);
        if (p) placed.push(p);
      }
      for (const r of picRects) {
        const p = render(r, "jpeg");
        if (p) placed.push(p);
      }
      for (const r of backs) {
        const p = render(r, "jpeg", true);
        if (p) items.push({ ...p, behind: true });
      }
      // pictures inside table cells belong to the cell
      for (const p of placed) {
        const cell = !p.float ? cellAt(...center(p.r)) : null;
        if (cell) cell.pics.push(p);
        else items.push(p);
      }

      const taken = [...regions, ...picRects, ...turnedRegions];
      for (const b of tb) {
        if (taken.some((r) => inside(b.r, r) > 0.5)) continue;
        // pieces on a picture are in the picture; pieces in a table go to their cell
        const free: Seg[] = [];
        for (const sg of b.segs) {
          if (taken.some((r) => inside(segRect(sg), r) > 0.5)) continue;
          const cell = cellAt(...center(segRect(sg)));
          if (cell) cell.segs.push(sg);
          else free.push(sg);
        }
        for (const part of this.columns(free)) items.push({ kind: "text", r: this.segBox(part), rows: this.rows(part) });
      }
      items.push(...tables);

      const decor = this.decor(page, W, H, ox, oy, taken, tables.map((t) => t.r), used);
      return { index, w: W, h: H, items, scan: false, decor };
    } finally {
      page.destroy();
    }
  }

  /** A device that draws everything but text. */
  private withoutText(dd: MuPDF.Device): MuPDF.Device {
    return new this.mupdf.Device({
      fillPath: (p: MuPDF.Path, eo: boolean, ctm: MuPDF.Matrix, cs: MuPDF.ColorSpace, c: MuPDF.Color, a: number) => dd.fillPath(p, eo, ctm, cs, c, a),
      strokePath: (p: MuPDF.Path, st: MuPDF.StrokeState, ctm: MuPDF.Matrix, cs: MuPDF.ColorSpace, c: MuPDF.Color, a: number) => dd.strokePath(p, st, ctm, cs, c, a),
      fillShade: (sh: MuPDF.Shade, ctm: MuPDF.Matrix, a: number) => dd.fillShade(sh, ctm, a),
      fillImage: (im: MuPDF.Image, ctm: MuPDF.Matrix, a: number) => dd.fillImage(im, ctm, a),
      fillImageMask: (im: MuPDF.Image, ctm: MuPDF.Matrix, cs: MuPDF.ColorSpace, c: MuPDF.Color, a: number) => dd.fillImageMask(im, ctm, cs, c, a),
      clipPath: (p: MuPDF.Path, eo: boolean, ctm: MuPDF.Matrix) => dd.clipPath(p, eo, ctm),
      clipStrokePath: (p: MuPDF.Path, st: MuPDF.StrokeState, ctm: MuPDF.Matrix) => dd.clipStrokePath(p, st, ctm),
      clipText: (t: MuPDF.Text, ctm: MuPDF.Matrix) => dd.clipText(t, ctm),
      clipStrokeText: (t: MuPDF.Text, st: MuPDF.StrokeState, ctm: MuPDF.Matrix) => dd.clipStrokeText(t, st, ctm),
      clipImageMask: (im: MuPDF.Image, ctm: MuPDF.Matrix) => dd.clipImageMask(im, ctm),
      popClip: () => dd.popClip(),
      beginMask: (r: MuPDF.Rect, l: boolean, cs: MuPDF.ColorSpace, c: MuPDF.Color) => dd.beginMask(r, l, cs, c),
      endMask: () => dd.endMask(),
      beginGroup: (r: MuPDF.Rect, cs: MuPDF.ColorSpace, i: boolean, k: boolean, bm: MuPDF.BlendMode, a: number) => dd.beginGroup(r, cs, i, k, bm, a),
      endGroup: () => dd.endGroup(),
      beginTile: (r: MuPDF.Rect, v: MuPDF.Rect, xs: number, ys: number, ctm: MuPDF.Matrix, id: number, d: number) => dd.beginTile(r, v, xs, ys, ctm, id, d),
      endTile: () => dd.endTile(),
    } as never);
  }

  /** A rectangle through a matrix (page coordinates, minus the page's origin). */
  private tf(b: ArrayLike<number>, m: number[], ox: number, oy: number): Rect {
    const xs = [b[0] * m[0] + b[1] * m[2] + m[4], b[2] * m[0] + b[1] * m[2] + m[4], b[0] * m[0] + b[3] * m[2] + m[4], b[2] * m[0] + b[3] * m[2] + m[4]];
    const ys = [b[0] * m[1] + b[1] * m[3] + m[5], b[2] * m[1] + b[1] * m[3] + m[5], b[0] * m[1] + b[3] * m[3] + m[5], b[2] * m[1] + b[3] * m[3] + m[5]];
    return [Math.min(...xs) - ox, Math.min(...ys) - oy, Math.max(...xs) - ox, Math.max(...ys) - oy];
  }

  /** Tables from ruling lines: grids of horizontal and vertical lines that touch. */
  private tables(all: Rule[], fills: { r: Rect; color: string }[], W: number, H: number): TableItem[] {
    // collinear pieces become one line
    const join = (list: Rule[]) => {
      const out: Rule[] = [];
      for (const r of list.slice().sort((a, b) => a.c - b.c || a.a - b.a)) {
        const last = out.find((o) => Math.abs(o.c - r.c) < 1 && r.a <= o.b + 2 && r.b >= o.a - 2);
        if (last) {
          last.a = Math.min(last.a, r.a);
          last.b = Math.max(last.b, r.b);
          last.w = Math.max(last.w, r.w);
        } else out.push({ ...r });
      }
      return out;
    };
    const lines = [...join(all.filter((r) => r.o === "h")), ...join(all.filter((r) => r.o === "v"))];
    const touch = (p: Rule, q: Rule) => {
      if (p.o === q.o) return Math.abs(p.c - q.c) < 1 && p.a <= q.b + 2 && q.a <= p.b + 2;
      const [h, v] = p.o === "h" ? [p, q] : [q, p];
      return v.c >= h.a - 2.5 && v.c <= h.b + 2.5 && h.c >= v.a - 2.5 && h.c <= v.b + 2.5;
    };
    const out: TableItem[] = [];
    const comps = groupsOf(lines.length, (i, j) => touch(lines[i], lines[j])).map((g) => g.map((i) => lines[i]));
    while (comps.length) {
      const comp = comps.shift()!;
      const hs = comp.filter((l) => l.o === "h");
      const vs = comp.filter((l) => l.o === "v");
      if (hs.length < 2 || vs.length < 2) continue;
      // a frame around a big area with tables inside: take the frame off, look again
      {
        const bx: Rect = [Math.min(...hs.map((h) => h.a)), Math.min(...vs.map((v) => v.a)), Math.max(...hs.map((h) => h.b)), Math.max(...vs.map((v) => v.b))];
        const full = (l: Rule) => (l.o === "h" ? l.b - l.a > 0.95 * (bx[2] - bx[0]) && (Math.abs(l.c - bx[1]) < 2 || Math.abs(l.c - bx[3]) < 2) : l.b - l.a > 0.95 * (bx[3] - bx[1]) && (Math.abs(l.c - bx[0]) < 2 || Math.abs(l.c - bx[2]) < 2));
        const frame = comp.filter(full);
        if (frame.length >= 4 && area(bx) > 0.3 * W * H && comp.length > frame.length + 3) {
          const rest = comp.filter((l) => !frame.includes(l));
          comps.push(...groupsOf(rest.length, (i, j) => touch(rest[i], rest[j])).map((g) => g.map((i) => rest[i])));
          continue;
        }
      }
      const box: Rect = [
        Math.min(...hs.map((h) => h.a), ...vs.map((v) => v.c)),
        Math.min(...vs.map((v) => v.a), ...hs.map((h) => h.c)),
        Math.max(...hs.map((h) => h.b), ...vs.map((v) => v.c)),
        Math.max(...vs.map((v) => v.b), ...hs.map((h) => h.c)),
      ];
      if (box[2] - box[0] < 10 || box[3] - box[1] < 8) continue;
      const xs = cluster([...vs.map((v) => v.c), box[0], box[2]], 2);
      const ys = cluster([...hs.map((h) => h.c), box[1], box[3]], 2);
      const nr = ys.length - 1;
      const nc = xs.length - 1;
      if (nr < 1 || nc < 1 || nr * nc > 5000) continue;
      // a frame around (most of) the page is not a table
      if (area(box) > 0.4 * W * H && nr * nc <= 2) continue;
      const cover = (list: Rule[], c: number, a: number, b: number) => {
        let len = 0;
        let best: Rule | null = null;
        for (const l of list)
          if (Math.abs(l.c - c) < 2) {
            const o = Math.min(l.b, b) - Math.max(l.a, a);
            if (o > 0) {
              len += o;
              best = best && best.w >= l.w ? best : l;
            }
          }
        return len >= 0.6 * (b - a) ? best : null;
      };
      const hEdge = (i: number, j: number) => cover(hs, ys[i], xs[j], xs[j + 1]);
      const vEdge = (i: number, j: number) => cover(vs, xs[j], ys[i], ys[i + 1]);
      // grid cells without a line between them are one cell
      const idx = (i: number, j: number) => i * nc + j;
      const parent = [...Array(nr * nc).keys()];
      const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
      for (let i = 0; i < nr; i++)
        for (let j = 0; j < nc; j++) {
          if (j + 1 < nc && !vEdge(i, j + 1)) parent[find(idx(i, j))] = find(idx(i, j + 1));
          if (i + 1 < nr && !hEdge(i + 1, j)) parent[find(idx(i, j))] = find(idx(i + 1, j));
        }
      const groups = new Map<number, number[]>();
      for (let k = 0; k < nr * nc; k++) {
        const r = find(k);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r)!.push(k);
      }
      const cells: TableCell[] = [];
      const style = (r: Rule | null): DocxBorder | null => (r ? { color: r.color, width: r.w } : null);
      const addCell = (r0: number, c0: number, r1: number, c1: number) => {
        const rect: Rect = [xs[c0], ys[r0], xs[c1], ys[r1]];
        const fill = fills
          .filter((f) => inside(rect, f.r) > 0.8 && f.color !== "FFFFFF")
          .sort((a, b) => area(a.r) - area(b.r))[0]?.color;
        cells.push({ r0, c0, r1, c1, fill, segs: [], pics: [], borders: { top: style(hEdge(r0, c0)), bottom: style(hEdge(r1, c0)), left: style(vEdge(r0, c0)), right: style(vEdge(r0, c1)) } });
      };
      for (const ks of groups.values()) {
        const is = ks.map((k) => Math.floor(k / nc));
        const js = ks.map((k) => k % nc);
        const r0 = Math.min(...is);
        const r1 = Math.max(...is) + 1;
        const c0 = Math.min(...js);
        const c1 = Math.max(...js) + 1;
        if (ks.length === (r1 - r0) * (c1 - c0)) addCell(r0, c0, r1, c1);
        // (not a rectangle: each grid cell on its own)
        else for (const k of ks) addCell(Math.floor(k / nc), k % nc, Math.floor(k / nc) + 1, (k % nc) + 1);
      }
      out.push({ kind: "table", r: box, xs, ys, cells: cells.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0) });
    }
    // a table around other tables: keep the inner ones
    return out.filter((t) => !out.some((o) => o !== t && inside(o.r, t.r) > 0.9 && area(o.r) < area(t.r)));
  }

  /** Everything drawn that isn't text, a picture or a table line (rules, boxes, fills), plus form
   *  fields and annotations, on a see-through page-sized picture. Undefined if there is none. */
  private decor(page: MuPDF.PDFPage, W: number, H: number, ox: number, oy: number, skip: Rect[], tables: Rect[], used: Rect[]): Uint8Array | undefined {
    const mupdf = this.mupdf;
    const s = Math.min(200 / 72, Math.sqrt(24e6 / Math.max(1, W * H)));
    const bbox: Rect = [Math.floor(ox * s), Math.floor(oy * s), Math.ceil((ox + W) * s), Math.ceil((oy + H) * s)];
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
    let drawn = 0;
    try {
      pix.clear();
      const dd = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
      const off = (r: ArrayLike<number>) => {
        const rr: Rect = [r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy];
        // (table lines and cell colours are the Word table's own)
        return (
          skip.some((k) => inside(rr, k) > 0.8) ||
          tables.some((t) => inside(rr, [t[0] - 2, t[1] - 2, t[2] + 2, t[3] + 2]) > 0.95) ||
          // (underlines and highlights are now part of the text)
          used.some((u) => inside(rr, u) > 0.9 && area(rr) > 0.5 * area(u))
        );
      };
      const filter = new mupdf.Device({
        fillPath: (p: MuPDF.Path, eo: boolean, ctm: MuPDF.Matrix, cs: MuPDF.ColorSpace, c: MuPDF.Color, a: number) => {
          if (off(p.getBounds(this.stroke, ctm))) return;
          drawn++;
          dd.fillPath(p, eo, ctm, cs, c, a);
        },
        strokePath: (p: MuPDF.Path, st: MuPDF.StrokeState, ctm: MuPDF.Matrix, cs: MuPDF.ColorSpace, c: MuPDF.Color, a: number) => {
          if (off(p.getBounds(st, ctm))) return;
          drawn++;
          dd.strokePath(p, st, ctm, cs, c, a);
        },
        fillShade: (sh: MuPDF.Shade, ctm: MuPDF.Matrix, a: number) => {
          if (off(this.tf(sh.getBounds(), ctm as number[], 0, 0))) return;
          drawn++;
          dd.fillShade(sh, ctm, a);
        },
        fillImageMask: (im: MuPDF.Image, ctm: MuPDF.Matrix, cs: MuPDF.ColorSpace, c: MuPDF.Color, a: number) => {
          if (off(this.tf([0, 0, 1, 1], ctm as number[], 0, 0))) return;
          drawn++;
          dd.fillImageMask(im, ctm, cs, c, a);
        },
        clipPath: (p: MuPDF.Path, eo: boolean, ctm: MuPDF.Matrix) => dd.clipPath(p, eo, ctm),
        clipStrokePath: (p: MuPDF.Path, st: MuPDF.StrokeState, ctm: MuPDF.Matrix) => dd.clipStrokePath(p, st, ctm),
        clipText: (t: MuPDF.Text, ctm: MuPDF.Matrix) => dd.clipText(t, ctm),
        clipStrokeText: (t: MuPDF.Text, st: MuPDF.StrokeState, ctm: MuPDF.Matrix) => dd.clipStrokeText(t, st, ctm),
        clipImageMask: (im: MuPDF.Image, ctm: MuPDF.Matrix) => dd.clipImageMask(im, ctm),
        popClip: () => dd.popClip(),
        beginMask: (r: MuPDF.Rect, l: boolean, cs: MuPDF.ColorSpace, c: MuPDF.Color) => dd.beginMask(r, l, cs, c),
        endMask: () => dd.endMask(),
        beginGroup: (r: MuPDF.Rect, cs: MuPDF.ColorSpace, i: boolean, k: boolean, bm: MuPDF.BlendMode, a: number) => dd.beginGroup(r, cs, i, k, bm, a),
        endGroup: () => dd.endGroup(),
        beginTile: (r: MuPDF.Rect, v: MuPDF.Rect, xs: number, ys: number, ctm: MuPDF.Matrix, id: number, d: number) => dd.beginTile(r, v, xs, ys, ctm, id, d),
        endTile: () => dd.endTile(),
      } as never);
      try {
        page.runPageContents(filter, mupdf.Matrix.identity);
      } catch {
        /* (whatever was drawn stays) */
      }
      filter.close();
      // form fields and annotations as they look (their text included: it isn't in the page text)
      const before = drawn;
      const count = new mupdf.Device({
        fillPath: () => void drawn++,
        strokePath: () => void drawn++,
        fillText: () => void drawn++,
        fillImage: () => void drawn++,
        fillShade: () => void drawn++,
      } as never);
      try {
        page.runPageAnnots(count, mupdf.Matrix.identity);
        page.runPageWidgets(count, mupdf.Matrix.identity);
      } catch {
        /* (none) */
      }
      count.close();
      if (drawn > before) {
        try {
          page.runPageAnnots(dd, mupdf.Matrix.identity);
          page.runPageWidgets(dd, mupdf.Matrix.identity);
        } catch {
          /* (whatever was drawn stays) */
        }
      }
      dd.close();
      if (!drawn) return undefined;
      return pix.asPNG().slice();
    } finally {
      pix.destroy();
    }
  }

  /** A block's columns: split where an empty strip runs from its top to its bottom (forms, boxes,
   *  tables without lines). Narrow pieces (bullets, numbers) stay with their text. */
  private columns(segs: Seg[]): Seg[][] {
    if (segs.length < 2) return segs.length ? [segs] : [];
    const size = this.blockSize(segs);
    const spans = segs.map((s) => [s.x0, s.x1]).sort((a, b) => a[0] - b[0]);
    const cuts: number[] = [];
    let end = spans[0][1];
    for (const [a, b] of spans.slice(1)) {
      if (a - end >= 1.5 * size) cuts.push((a + end) / 2);
      end = Math.max(end, b);
    }
    if (!cuts.length) return [segs];
    let parts = [-Infinity, ...cuts, Infinity].slice(1).map((c, i, arr) => segs.filter((s) => (s.x0 + s.x1) / 2 < c && (s.x0 + s.x1) / 2 >= (i ? arr[i - 1] : -Infinity)));
    // pieces narrower than a few letters join the next column
    for (let i = 0; i < parts.length - 1; ) {
      const b = this.segBox(parts[i]);
      if (b[2] - b[0] < 3 * size) {
        parts[i + 1] = [...parts[i], ...parts[i + 1]];
        parts.splice(i, 1);
      } else i++;
    }
    parts = parts.filter((p) => p.length);
    return parts;
  }

  private segBox(segs: Seg[]): Rect {
    return segs.reduce<Rect>((r, s) => [Math.min(r[0], s.x0), Math.min(r[1], s.top), Math.max(r[2], s.x1), Math.max(r[3], s.bottom)], [Infinity, Infinity, -Infinity, -Infinity]);
  }

  private blockSize(segs: Seg[]): number {
    return median(segs.flatMap((s) => s.chars.filter((c) => c.c.trim()).map((c) => c.size))) || 10;
  }

  /** Rectangles that touch (within `gap`) become one. */
  private merge(rs: Rect[], gap: number): Rect[] {
    const out = rs.map((r) => [...r] as Rect);
    for (let changed = true; changed; ) {
      changed = false;
      for (let i = 0; i < out.length && !changed; i++)
        for (let j = i + 1; j < out.length; j++)
          if (overlaps(out[i], out[j], gap)) {
            out[i] = union(out[i], out[j]);
            out.splice(j, 1);
            changed = true;
            break;
          }
    }
    return out;
  }

  /** Seeds grow by every shape that touches them. */
  private grow(seeds: Rect[], all: Rect[], gap: number): Rect[] {
    let out = this.merge(seeds, gap);
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      out = out.map((r) => {
        let g = r;
        for (const s of all)
          if (overlaps(g, s, gap) && inside(s, g) < 1) {
            // (long rules across the page don't make a figure page-wide)
            if (s[2] - s[0] > 3 * (g[2] - g[0]) + 40 || s[3] - s[1] > 3 * (g[3] - g[1]) + 40) continue;
            g = union(g, s);
            changed = true;
          }
        return g;
      });
      out = this.merge(out, gap);
      if (!changed) break;
    }
    return out;
  }

  /** Lines (pieces on one baseline together), top to bottom. */
  private rows(segs: Seg[]): Row[] {
    const rows: Row[] = [];
    const sorted = segs.slice().sort((a, b) => a.top - b.top || a.x0 - b.x0);
    for (const s of sorted) {
      const main = s.chars.filter((c) => c.c.trim());
      const size = median(main.map((c) => c.size)) || 10;
      const base = median(main.filter((c) => Math.abs(c.size - size) < 0.6).map((c) => c.y)) || s.bottom;
      // (a smaller piece raised or lowered next to a line: super-/subscript of that line)
      const script = (r: Row) => {
        const [big, small] = size < r.size ? [{ size: r.size, base: r.base }, { size, base }] : [{ size, base }, { size: r.size, base: r.base }];
        const near = s.x0 < r.x1 + 1.5 * big.size && s.x1 > r.x0 - 1.5 * big.size;
        return near && small.size < 0.85 * big.size && small.base > big.base - 0.75 * big.size && small.base < big.base + 0.45 * big.size;
      };
      const row = rows.find(
        (r) =>
          Math.abs(r.base - base) < 0.35 * Math.min(size, r.size) ||
          (Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top) > 0.6 * Math.min(r.bottom - r.top, s.bottom - s.top) && Math.abs(r.base - base) < 0.6 * Math.max(size, r.size)) ||
          script(r),
      );
      if (row) {
        row.segs.push(s);
        row.x0 = Math.min(row.x0, s.x0);
        row.x1 = Math.max(row.x1, s.x1);
        row.top = Math.min(row.top, s.top);
        row.bottom = Math.max(row.bottom, s.bottom);
        if (size > row.size) {
          row.size = size;
          row.base = base;
        }
      } else rows.push({ x0: s.x0, x1: s.x1, top: s.top, bottom: s.bottom, base, size, segs: [s] });
    }
    for (const r of rows) {
      r.segs.sort((a, b) => a.x0 - b.x0);
      // pieces that overlap (accented letters MuPDF puts on their own line): one piece, letters in order
      const out: Seg[] = [];
      for (const sg of r.segs) {
        const last = out[out.length - 1];
        if (last && !last.pic && !sg.pic && sg.x0 < last.x1 - 0.5) {
          // (the other piece holds a placeholder space where the letter goes: drop it)
          const ins = sg.chars.filter((c) => c.c.trim());
          const keep = (c: Ch) => c.c.trim() || !ins.some((d) => c.x >= d.x - 1 && c.x <= d.x + 0.5 * (d.x1 - d.x));
          const chars = [...last.chars.filter(keep), ...sg.chars].sort((a, b) => a.x - b.x);
          out[out.length - 1] = { x0: Math.min(last.x0, sg.x0), x1: Math.max(last.x1, sg.x1), top: Math.min(last.top, sg.top), bottom: Math.max(last.bottom, sg.bottom), chars };
        } else out.push(sg);
      }
      r.segs = out;
    }
    return rows.sort((a, b) => a.base - b.base);
  }

  /** Body size, main font, heading sizes and language over all pages. */
  finishStyles(pages: PageData[]): void {
    const sizes = new Map<number, number>();
    const fams = new Map<string, number>();
    let text = "";
    const visit = (rows: Row[]) => {
      for (const r of rows)
        for (const s of r.segs)
          for (const c of s.chars) {
            if (text.length < 20000) text += c.c;
            if (!c.c.trim()) continue;
            const k = Math.round(c.size * 2) / 2;
            sizes.set(k, (sizes.get(k) ?? 0) + 1);
            if (c.font.family) fams.set(c.font.family, (fams.get(c.font.family) ?? 0) + 1);
          }
    };
    for (const p of pages)
      for (const it of p.items) {
        if (it.kind === "text") visit(it.rows);
        if (it.kind === "table") for (const c of it.cells) visit(this.rows(c.segs));
      }
    const top = <K>(m: Map<K, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0];
    this.bodySize = top(sizes) ?? 11;
    this.mainFont = top(fams) ?? "Calibri";
    this.headingSizes = [...sizes.keys()]
      .filter((s) => s >= this.bodySize * 1.15)
      .sort((a, b) => b - a)
      .slice(0, 3);
    const words = ` ${text.toLowerCase().replace(/\s+/g, " ")} `;
    const count = (re: RegExp) => (words.match(re) ?? []).length;
    if (count(/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/g) > 20) this.lang = "vi-VN";
    else if (count(/ (der|die|und|das|ist|nicht|mit|für|wird|werden) /g) > 8) this.lang = "de-DE";
    else if (count(/ (le|la|les|des|est|et|une|pour|dans) /g) > 10) this.lang = "fr-FR";
    else this.lang = "en-US";
  }

  // ---------- laying out a page ----------

  layout(pg: PageData): DocxSection[] {
    const { w: W, h: H } = pg;
    const decor: DocxBlock[] = pg.decor ? [{ kind: "img", type: "png", data: pg.decor, w: W, h: H, anchor: { x: 0, y: 0 }, name: "Lines and boxes" }] : [];
    // things outside the text flow: placed where they are
    const floats: DocxBlock[] = pg.items
      .filter((i): i is PicItem => i.kind === "pic" && !!(i.float || i.behind))
      .map((p) => ({ kind: "img", type: p.type, data: p.data, w: p.r[2] - p.r[0], h: p.r[3] - p.r[1], anchor: { x: p.r[0], y: p.r[1], behind: !!p.behind } }));
    let items = pg.items.filter((i) => !(i.kind === "pic" && (i.float || i.behind)));
    if (!items.length) return [{ width: W, height: H, margins: { top: 72, right: 72, bottom: 72, left: 72 }, blocks: [...decor, ...floats] }];
    const L = Math.max(6, Math.min(...items.map((i) => i.r[0])) - 0.5);
    const Rx = Math.min(W - 6, Math.max(...items.map((i) => i.r[2])) + 0.5);

    // page header and footer: short text at the top/bottom edge, set apart from the rest
    const edge = (fromTop: boolean) => {
      const sorted = items.slice().sort((a, b) => (fromTop ? a.r[1] - b.r[1] : b.r[3] - a.r[3]));
      const picked: TextItem[] = [];
      for (const it of sorted) {
        const near = fromTop ? it.r[3] < 0.12 * H : it.r[1] > 0.86 * H;
        if (!near || it.kind !== "text" || it.rows.length > 2) break;
        picked.push(it);
      }
      if (!picked.length || picked.length === items.length) return [];
      const rest = items.filter((i) => !picked.includes(i as TextItem));
      const size = Math.max(...picked.map((p) => p.rows[0].size));
      const gap = fromTop ? Math.min(...rest.map((i) => i.r[1])) - Math.max(...picked.map((p) => p.r[3])) : Math.min(...picked.map((p) => p.r[1])) - Math.max(...rest.map((i) => i.r[3]));
      return gap > 1.2 * size ? picked : [];
    };
    const head = edge(true);
    items = items.filter((i) => !head.includes(i as TextItem));
    const foot = edge(false);
    items = items.filter((i) => !foot.includes(i as TextItem));
    const headTop = head.length ? Math.min(...head.map((i) => i.r[1])) : 0;
    const footTop = foot.length ? Math.min(...foot.map((i) => i.r[1])) : H;
    const footBottom = foot.length ? Math.max(...foot.map((i) => i.r[3])) : H;
    const header = head.length ? this.flow(head, L, Rx, headTop - 1).blocks : undefined;
    const footer = foot.length ? this.flow(foot, L, Rx, footTop - 1).blocks : undefined;
    // (the first block of a header/footer starts at the part's top)
    if (header?.[0]) header[0].before = 0;
    if (footer?.[0]) footer[0].before = 0;

    const top = Math.max(6, Math.min(...items.map((i) => i.r[1])) - 2);
    const maxY = Math.max(...items.map((i) => i.r[3]));
    const bottom = Math.max(10, Math.min(H - maxY - 2, (H - maxY) * 0.5), foot.length ? H - footTop + 2 : 0);
    const margins = { top, right: W - Rx, bottom, left: L };
    const hf = { header, footer, headerDist: Math.max(4, headTop - 1), footerDist: Math.max(4, H - footBottom - 2) };

    // two columns? the gap that splits the most text evenly
    const gut = this.gutter(items, W, H);
    type Band = { full: boolean; items: Item[] };
    const bands: Band[] = [];
    const sorted = items.slice().sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0]);
    // (items beside a full-width one are part of the full width too: author lists, headers)
    const fullSet = new Set(gut ? sorted.filter((it) => it.r[0] < gut.x - 2 && it.r[2] > gut.x + 2) : []);
    for (let grew = true; grew; ) {
      grew = false;
      for (const it of sorted)
        if (!fullSet.has(it) && [...fullSet].some((f) => yOverlap(f.r, it.r) > 0.4 * Math.min(f.r[3] - f.r[1], it.r[3] - it.r[1]))) {
          fullSet.add(it);
          grew = true;
        }
    }
    if (!gut) bands.push({ full: true, items: sorted });
    else
      for (const it of sorted) {
        const full = fullSet.has(it);
        const last = bands[bands.length - 1];
        if (last && last.full === full) last.items.push(it);
        else bands.push({ full, items: [it] });
      }

    const sections: DocxSection[] = [];
    let cursor = top;
    bands.forEach((band, bi) => {
      const blocks: DocxBlock[] = bi === 0 ? [...decor, ...floats] : [];
      let cols: DocxSection["cols"];
      if (band.full || !gut) {
        const res = this.flow(band.items, L, Rx, cursor);
        blocks.push(...res.blocks);
        cursor = res.cursor;
      } else {
        const left = band.items.filter((i) => i.r[2] <= gut.x + 2);
        const right = band.items.filter((i) => i.r[0] >= gut.x - 2);
        const lx1 = Math.max(gut.leftEdge, ...left.map((i) => i.r[2]));
        const rx0 = Math.min(gut.rightEdge, ...right.map((i) => i.r[0]));
        cols = [
          { w: lx1 - L, space: Math.max(6, rx0 - lx1) },
          { w: Rx - rx0, space: 0 },
        ];
        const a = this.flow(left, L, lx1, cursor);
        const b = this.flow(right, rx0, Rx, cursor);
        const firstFlowing = b.blocks.find((x) => !(x.kind === "img" && x.anchor));
        if (firstFlowing) firstFlowing.colBreak = true;
        blocks.push(...a.blocks, ...b.blocks);
        cursor = Math.max(a.cursor, b.cursor);
      }
      sections.push({ width: W, height: H, margins, cols, start: bi === 0 ? "page" : "continuous", blocks, ...hf });
    });
    return sections;
  }

  /** Two-column layout: where the gap between the columns is (null: one column). */
  private gutter(items: Item[], W: number, H: number): { x: number; leftEdge: number; rightEdge: number } | null {
    let best: { x: number; score: number; leftEdge: number; rightEdge: number } | null = null;
    const textH = (list: Item[]) => list.reduce((n, i) => n + (i.r[3] - i.r[1]), 0);
    const multi = (list: Item[]) => list.some((i) => i.kind === "text" && i.rows.length >= 3);
    const lines = (list: Item[]) => list.reduce((n, i) => n + (i.kind === "text" ? i.rows.length : 0), 0);
    // columns of running text: most of their lines are in paragraphs of 3+ lines
    // (and the lines fill the column: forms and tables have short lines here and there)
    const prose = (list: Item[]) => {
      if (list.reduce((n, i) => n + (i.kind === "text" && i.rows.length >= 3 ? i.rows.length : 0), 0) < 0.5 * lines(list)) return false;
      const x0 = Math.min(...list.map((i) => i.r[0]));
      const x1 = Math.max(...list.map((i) => i.r[2]));
      const widths = list.flatMap((i) => (i.kind === "text" ? i.rows.map((r) => r.x1 - r.x0) : []));
      return median(widths) >= 0.55 * (x1 - x0);
    };
    for (let x = W * 0.3; x <= W * 0.7; x += 2) {
      const left = items.filter((i) => i.r[2] <= x);
      const right = items.filter((i) => i.r[0] >= x);
      if (!left.length || !right.length || !multi(left) || !multi(right) || lines(left) < 5 || lines(right) < 5 || !prose(left) || !prose(right)) continue;
      const lh = textH(left);
      const rh = textH(right);
      if (lh < 0.1 * H || rh < 0.1 * H) continue;
      // full-width items in between are fine (title, tables, pictures), but not nearly all of the page
      const cross = items.filter((i) => i.r[0] < x && i.r[2] > x);
      if (textH(cross) > 3 * (lh + rh)) continue;
      // forms and tables: left and right share their lines -> not columns
      const lb = left.flatMap((i) => (i.kind === "text" ? i.rows.map((r) => r.base) : []));
      const rb = right.flatMap((i) => (i.kind === "text" ? i.rows.map((r) => r.base) : []));
      const shared = rb.filter((b) => lb.some((a) => Math.abs(a - b) < 0.6)).length;
      if (rb.length && shared / rb.length > 0.6 && lb.length < 3 * rb.length) continue;
      const leftEdge = Math.max(...left.map((i) => i.r[2]));
      const rightEdge = Math.min(...right.map((i) => i.r[0]));
      const score = Math.min(lh, rh) + (rightEdge - leftEdge) * 0.01;
      if (!best || score > best.score) best = { x, score, leftEdge, rightEdge };
    }
    if (!best) return null;
    return { x: (best.leftEdge + best.rightEdge) / 2, leftEdge: best.leftEdge, rightEdge: best.rightEdge };
  }

  /** Items of one column (or cell), top to bottom, as Word blocks. `cursor`: where the content starts. */
  private flow(input: Item[], colL: number, colR: number, cursor: number): { blocks: DocxBlock[]; cursor: number } {
    const blocks: DocxBlock[] = [];
    let items = input.slice().sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0]);
    const texts = () => items.filter((i): i is TextItem => i.kind === "text");

    // small pictures in a line of text (icons, symbols): in the line
    for (const p of items.filter((i): i is PicItem => i.kind === "pic")) {
      const ph = p.r[3] - p.r[1];
      for (const t of texts()) {
        const row = t.rows.find((r) => {
          const mid = (p.r[1] + p.r[3]) / 2;
          return ph < 3 * r.size && mid > r.top - 0.3 * r.size && mid < r.bottom + 0.3 * r.size && p.r[0] < t.r[2] + 4 * r.size && p.r[2] > t.r[0] - 4 * r.size;
        });
        if (row) {
          row.segs.push({ x0: p.r[0], x1: p.r[2], top: p.r[1], bottom: p.r[3], chars: [], pic: p });
          row.segs.sort((a, b) => a.x0 - b.x0);
          row.x0 = Math.min(row.x0, p.r[0]);
          row.x1 = Math.max(row.x1, p.r[2]);
          t.r = union(t.r, p.r);
          items = items.filter((i) => i !== p);
          break;
        }
      }
    }

    // text side by side (table cells without lines, label + value, columns): one line with tabs,
    // or a borderless table when the pieces have several lines each
    const merged: Item[] = [];
    let group: Item[] = [];
    const flush = () => {
      if (group.length === 1) merged.push(group[0]);
      else if (group.length > 1) {
        // the pieces' columns: pieces over each other are one column
        const cols = groupsOf(group.length, (i, j) => Math.min(group[i].r[2], group[j].r[2]) - Math.max(group[i].r[0], group[j].r[0]) > 0).map((ix) => ix.map((i) => group[i]));
        const rowsIn = (c: Item[]) => c.reduce((n, t) => n + (t.kind === "text" ? t.rows.length : 3), 0);
        const textOnly = group.every((g) => g.kind === "text");
        const textCols = cols.filter((c) => c.some((x) => x.kind === "text")).length;
        if (cols.length < 2) merged.push(...group);
        // (pictures beside one column of text: the text flows around them)
        else if (!group.some((g) => g.kind === "table") && textCols <= 1) merged.push(...group);
        else if (!textOnly || cols.filter((c) => rowsIn(c) >= 2).length >= 2 || cols.some((c) => rowsIn(c) >= 3)) merged.push(this.gridTable(cols));
        else {
          const segs = (group as TextItem[]).flatMap((g) => g.rows.flatMap((r) => r.segs));
          merged.push({ kind: "text", r: group.reduce<Rect>((r, g) => union(r, g.r), group[0].r), rows: this.rows(segs) });
        }
      }
      group = [];
    };
    for (const it of items) {
      const span = group.length ? group.reduce<Rect>((r, g) => union(r, g.r), group[0].r) : null;
      const side = !!span && yOverlap(it.r, span) > 0.4 * Math.min(it.r[3] - it.r[1], span[3] - span[1]);
      if (span && !side) flush();
      group.push(it);
    }
    flush();
    items = merged.sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0]);

    // pictures beside text: placed on the page with the text flowing around them
    const besideText = (p: PicItem) => items.some((t) => t.kind === "text" && yOverlap(t.r, p.r) > 0.3 * Math.min(t.r[3] - t.r[1], p.r[3] - p.r[1]) && (t.r[2] <= p.r[0] + 2 || t.r[0] >= p.r[2] - 2));

    for (const it of items) {
      if (it.kind === "pic") {
        const w = Math.min(it.r[2] - it.r[0], colR - colL);
        const h = (it.r[3] - it.r[1]) * (w / (it.r[2] - it.r[0]));
        if (besideText(it)) {
          blocks.push({ kind: "img", data: it.data, type: it.type, w, h, anchor: { x: it.r[0], y: it.r[1], wrap: "square" } });
          continue;
        }
        const mid = Math.abs((it.r[0] + it.r[2]) / 2 - (colL + colR) / 2) < 0.03 * (colR - colL) + 2 && it.r[0] > colL + 4;
        blocks.push({ kind: "img", data: it.data, type: it.type, w, h, before: Math.max(0, it.r[1] - cursor), align: mid ? "center" : undefined, indLeft: mid ? undefined : Math.max(0, Math.min(it.r[0] - colL, colR - colL - w)) });
        cursor = it.r[1] + h;
        continue;
      }
      if (it.kind === "table") {
        blocks.push(this.table(it, colL, Math.max(0, it.r[1] - cursor)));
        cursor = it.r[3];
        continue;
      }
      // text beside a picture that the text flows around: its lines end at the picture
      const wraps = items.filter((p): p is PicItem => p.kind === "pic" && besideText(p) && yOverlap(p.r, it.r) > 0);
      const right = Math.min(colR, ...wraps.filter((p) => p.r[0] >= it.r[2] - 2).map((p) => p.r[0] - 4));
      const left = Math.max(colL, ...wraps.filter((p) => p.r[2] <= it.r[0] + 2).map((p) => p.r[2] + 4));
      for (const p of this.paragraphs(it, left, right, colL)) {
        p.block.before = Math.max(0, p.firstBase - cursor - (p.lineH - 0.22 * p.size));
        blocks.push(p.block);
        cursor = p.lastBase + 0.22 * p.size;
      }
    }
    return { blocks, cursor };
  }

  /** Columns side by side as one row of a table without lines. */
  private gridTable(cols: Item[][]): TableItem {
    const boxes = cols.map((c) => ({ c, r: c.reduce<Rect>((acc, t) => union(acc, t.r), c[0].r) })).sort((a, b) => a.r[0] - b.r[0]);
    const r = boxes.reduce<Rect>((acc, b) => union(acc, b.r), boxes[0].r);
    const xs = [r[0] - 1.5, ...boxes.slice(1).map((b, i) => (boxes[i].r[2] + b.r[0]) / 2), r[2] + 1.5];
    const none = { top: null, left: null, bottom: null, right: null };
    return {
      kind: "table",
      r,
      xs,
      ys: [r[1] - 1, r[3] + 1],
      cells: boxes.map((b, i) => {
        const texts = b.c.filter((t): t is TextItem => t.kind === "text");
        // text only: one block (its lines can mix); anything else: laid out as it is
        if (texts.length === b.c.length) return { r0: 0, c0: i, r1: 1, c1: i + 1, borders: none, segs: texts.flatMap((t) => t.rows.flatMap((row) => row.segs)), pics: [] };
        return { r0: 0, c0: i, r1: 1, c1: i + 1, borders: none, segs: [], pics: [], items: b.c };
      }),
    };
  }

  /** A table as a Word table: grid, merged cells, borders, colours, cell contents. */
  private table(t: TableItem, colL: number, before: number): DocxTable {
    const pad = 1.5;
    const rows: DocxTable["rows"] = t.ys.slice(0, -1).map((y, i) => ({ height: t.ys[i + 1] - y, cells: [] }));
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < t.xs.length - 1; ) {
        const c = t.cells.find((x) => x.r0 <= i && x.r1 > i && x.c0 === j);
        if (!c) {
          rows[i].cells.push({ blocks: [] });
          j++;
          continue;
        }
        const span = c.c1 - c.c0;
        const cell: DocxCell = { span, fill: c.fill, borders: c.borders, blocks: [] };
        if (c.r1 - c.r0 > 1) cell.vmerge = c.r0 === i ? "restart" : "continue";
        if (c.r0 === i) {
          const l = t.xs[c.c0] + pad;
          const r = t.xs[c.c1] - pad;
          const ctop = t.ys[c.r0];
          const cbot = t.ys[c.r1];
          const items: Item[] = c.items ? c.items.slice() : [...c.pics];
          if (!c.items && c.segs.length) items.push({ kind: "text", r: this.segBox(c.segs), rows: this.rows(c.segs) });
          const content = items.length ? items.reduce<Rect>((acc, x) => union(acc, x.r), items[0].r) : null;
          let start = ctop + 0.5;
          if (content) {
            const above = content[1] - ctop;
            const below = cbot - content[3];
            if (above > 3 && Math.abs(above - below) < Math.max(2, 0.25 * above)) {
              cell.valign = "center";
              start = content[1] - 0.5;
            } else if (below < 2.5 && above > 4) {
              cell.valign = "bottom";
              start = content[1] - 0.5;
            }
          }
          cell.blocks = this.flow(items, l, r, start).blocks;
          // single lines in a cell: no taller than the PDF's row (Word's line height is often more)
          const room = cbot - ctop;
          for (const b of cell.blocks)
            if (b.kind === "p" && !b.line && !b.lineExact && !b.runs.some((x) => x.image)) {
              const sz = Math.max(...b.runs.map((x) => x.size ?? this.bodySize), 1);
              const nat = sz * lineFactor(this.mainFontOf(b.runs) || this.mainFont);
              if (nat > room - 0.5) b.lineExact = Math.max(sz * 1.02, room - 0.5);
            }
        }
        rows[i].cells.push(cell);
        j += span;
      }
    }
    return { kind: "table", cols: t.xs.slice(1).map((x, i) => x - t.xs[i]), rows, pad, indLeft: t.xs[0] - colL + pad, before };
  }

  /** A text block as paragraphs. */
  /** (`indentFrom`: where indents count from, when the lines are narrowed by a picture beside them) */
  private paragraphs(it: TextItem, colL: number, colR: number, indentFrom = colL): { block: DocxParagraph; firstBase: number; lastBase: number; size: number; lineH: number }[] {
    const rows = it.rows;
    const pitches = rows
      .slice(1)
      .map((r, i) => r.base - rows[i].base)
      .filter((d) => d > 0);
    const pitch = median(pitches) || 0;
    const bx0 = Math.min(...rows.map((r) => r.x0));

    const dominant = (r: Row) => {
      const cs = r.segs.flatMap((s) => s.chars).filter((c) => c.c.trim());
      const bold = cs.filter((c) => c.font.bold).length > cs.length / 2;
      return { size: Math.round(r.size * 2) / 2, bold };
    };
    const tabRow = (r: Row) => r.segs.some((s, i) => i > 0 && !s.pic && !r.segs[i - 1].pic && s.x0 - r.segs[i - 1].x1 > 1.5 * r.size);
    const marker = (r: Row): { x: number; textX: number; glued?: number } | null => {
      const first = r.segs[0];
      if (first.pic) return null;
      const t = first.chars
        .map((c) => c.c)
        .join("")
        .trim();
      const next = r.segs[1];
      const isMark = BULLETS.has(t) || /^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)]|\[\d{1,3}\])$/i.test(t);
      if (isMark && next && next.x0 - first.x1 > 0.4 * r.size) return { x: first.x0, textX: next.x0 };
      // marker glued to the text in the same piece: "• text", "[2] text"
      const cs = first.chars;
      const k = cs.findIndex((c) => c.c.trim());
      if (k < 0) return null;
      let end = k;
      if (BULLETS.has(cs[k].c) && cs[k].c !== "-" && cs[k].c !== "–") end = k;
      else if (cs[k].c === "[") {
        end = cs.findIndex((c, i) => i > k && c.c === "]");
        if (end < 0 || end - k > 4) return null;
      } else return null;
      const after = cs.find((c, i) => i > end && c.c.trim());
      if (after && after.x - cs[end].x1 > 0.2 * r.size) return { x: first.x0, textX: after.x, glued: end };
      return null;
    };
    /** Width of the first word of a line (to see if it would have fitted on the line before). */
    const firstWord = (r: Row) => {
      const cs = r.segs[0].chars;
      const k = cs.findIndex((c) => c.c.trim());
      if (r.segs[0].pic || k < 0) return r.segs[0].x1 - r.segs[0].x0;
      let end = cs.findIndex((c, i) => i > k && !c.c.trim());
      if (end < 0) end = cs.length;
      return cs[end - 1].x1 - cs[k].x;
    };

    // split into paragraphs
    const groups: Row[][] = [];
    let groupMark: { x: number; textX: number } | null = null;
    rows.forEach((r, i) => {
      if (i === 0) {
        groupMark = marker(r);
        return groups.push([r]);
      }
      const prev = rows[i - 1];
      const g = groups[groups.length - 1];
      const dp = dominant(prev);
      const dr = dominant(r);
      const gap = r.base - prev.base;
      const typical = pitch || r.size * 1.2;
      const startsIndented = r.x0 > bx0 + 0.8 * r.size && rows.slice(i + 1, i + 2).some((n) => n.x0 < r.x0 - 0.5 * r.size);
      const m = marker(r);
      const gm = groupMark as { x: number; textX: number } | null;
      // a line that ends with room for the next line's first word was ended on purpose
      const room = colR - prev.x1 + (prev.x0 - bx0);
      const colW = colR - colL;
      const onPurpose =
        room > firstWord(r) + 0.6 * r.size &&
        !/\p{L}-$/u.test(this.rowText(prev)) &&
        (room > 0.15 * colW || /[.:;!?)]\s*$/.test(this.rowText(prev)) || prev.x1 - prev.x0 < 0.7 * colW);
      // a list item's next line, under its text
      if (gm && !m && Math.abs(r.x0 - gm.textX) < 0.6 * r.size && gap <= 1.45 * typical && Math.abs(dp.size - dr.size) <= 0.6 && !tabRow(r) && !onPurpose) return void g.push(r);
      const breaks = tabRow(r) || tabRow(prev) || !!m || Math.abs(dp.size - dr.size) > 0.6 || dp.bold !== dr.bold || gap > 1.45 * typical || startsIndented || onPurpose;
      if (breaks) {
        groups.push([r]);
        groupMark = m;
      } else g.push(r);
    });

    return groups.map((g) => this.paragraph(g, colL, colR, pitch, marker(g[0]), tabRow(g[0]), indentFrom));
  }

  /** The font most of the runs use. */
  private mainFontOf(runs: DocxRun[]): string {
    const n = new Map<string, number>();
    for (const r of runs) if (r.font && r.text.trim()) n.set(r.font, (n.get(r.font) ?? 0) + r.text.length);
    return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }

  private rowText(r: Row): string {
    return r.segs
      .map((s) => s.chars.map((c) => c.c).join(""))
      .join(" ")
      .trim();
  }

  /** Advance of a character in the font Word will use (pt), or the PDF's when Word's font is unknown. */
  private advance(c: Ch): number {
    const fam = c.font.family || this.mainFont;
    const base = /times new roman/i.test(fam) ? "Times" : /^arial$/i.test(fam) ? "Helvetica" : /courier new/i.test(fam) ? "Courier" : null;
    if (!base) return c.c.trim() ? c.x1 - c.x : 0.25 * c.size;
    const style =
      base === "Times"
        ? c.font.bold
          ? c.font.italic
            ? "-BoldItalic"
            : "-Bold"
          : c.font.italic
            ? "-Italic"
            : "-Roman"
        : c.font.bold
          ? c.font.italic
            ? "-BoldOblique"
            : "-Bold"
          : c.font.italic
            ? "-Oblique"
            : "";
    const name = base + style;
    const key = name + c.c;
    let a = this.advCache.get(key);
    if (a === undefined) {
      let f = this.metrics.get(name);
      if (f === undefined) {
        try {
          f = new this.mupdf.Font(name);
        } catch {
          f = null;
        }
        this.metrics.set(name, f);
      }
      const gid = f ? f.encodeCharacter(c.c.codePointAt(0) ?? 32) : 0;
      a = f && gid > 0 ? f.advanceGlyph(gid, 0) : -1;
      this.advCache.set(key, a);
    }
    return a >= 0 ? a * c.size : c.c.trim() ? c.x1 - c.x : 0.25 * c.size;
  }

  private paragraph(
    g: Row[],
    colL: number,
    colR: number,
    blockPitch: number,
    mark: { x: number; textX: number; glued?: number } | null,
    tabs: boolean,
    indentFrom = colL,
  ): { block: DocxParagraph; firstBase: number; lastBase: number; size: number; lineH: number } {
    const size = median(g.map((r) => r.size));
    const pitch = g.length > 1 ? median(g.slice(1).map((r, i) => r.base - g[i].base)) : 0;
    const runs: DocxRun[] = [];
    const tabStops: number[] = [];
    let lastText = "";
    // the width each line will have in Word (to keep lines as long as in the PDF)
    const widths: number[] = [];
    const letterCounts: number[] = [];
    let width = 0;
    let letters = 0;
    const push = (c: Ch, text: string, rowBase: number, rowSize: number) => {
      let vert: DocxRun["vert"];
      let sz = c.size;
      if (!text.trim()) sz = Math.max(c.size, rowSize);
      if (c.size < rowSize * 0.85 && c.c.trim() && text.trim()) {
        if (c.y < rowBase - 0.15 * rowSize) vert = "superscript";
        else if (c.y > rowBase + 0.08 * rowSize) vert = "subscript";
        if (vert) sz = rowSize;
      }
      const run: DocxRun = { text, font: c.font.family || undefined, size: Math.round(sz * 2) / 2, bold: c.font.bold, italic: c.font.italic, color: c.color, vert, underline: c.underline, strike: c.strike, shade: c.shade };
      const prev = runs[runs.length - 1];
      const same = (a: DocxRun, b: DocxRun) =>
        a.font === b.font && a.size === b.size && !!a.bold === !!b.bold && !!a.italic === !!b.italic && a.color === b.color && a.vert === b.vert && !!a.underline === !!b.underline && !!a.strike === !!b.strike && a.shade === b.shade;
      if (prev && !prev.image && same(prev, run)) prev.text += text;
      else if (prev && !prev.image && !text.trim() && !text.includes("\t") && !prev.vert && !prev.underline && !prev.strike && !prev.shade) prev.text += text;
      else runs.push(run);
      lastText += text;
      if (text !== "\t") {
        for (const ch of text) width += this.advance({ ...c, c: ch, size: vert ? sz * 0.65 : sz });
        letters += text.length;
      }
    };

    g.forEach((r, ri) => {
      if (ri > 0) {
        widths.push(width);
        letterCounts.push(letters);
        width = 0;
        letters = 0;
        // between lines: a space, or nothing after a hyphen that splits a word
        // ("analog-to-" + "digital": a compound word keeps its hyphen)
        const nextChar = r.segs[0].chars.find((c) => c.c.trim())?.c ?? "";
        const word = lastText.split(/\s/).pop() ?? "";
        const firstChar = r.segs[0].chars[0];
        if (/\p{L}-$/u.test(lastText) && /^\p{Ll}/u.test(nextChar) && word.indexOf("-") === word.length - 1) {
          const prev = runs[runs.length - 1];
          prev.text = prev.text.slice(0, -1);
          lastText = lastText.slice(0, -1);
          this.hyphenJoins++;
        } else if (/\p{L}-$/u.test(lastText) && /^\p{Ll}/u.test(nextChar)) {
          // (keeps the hyphen, no space)
        } else if (!/\s$/.test(lastText) && firstChar) push(firstChar, " ", r.base, r.size);
      }
      r.segs.forEach((s, si) => {
        if (s.pic) {
          const gap = si > 0 ? s.x0 - r.segs[si - 1].x1 : 0;
          if (si > 0 && gap > 0.15 * r.size && !/\s$/.test(lastText)) {
            runs.push({ text: " " });
            lastText += " ";
          }
          const h = Math.min(s.pic.r[3] - s.pic.r[1], r.size * 2.2);
          const w = (s.pic.r[2] - s.pic.r[0]) * (h / (s.pic.r[3] - s.pic.r[1]));
          runs.push({ text: "", image: { kind: "img", data: s.pic.data, type: s.pic.type, w, h } });
          width += w;
          lastText += "⁠";
          const next = r.segs[si + 1];
          if (next && next.x0 - s.x1 > 0.15 * r.size) {
            runs.push({ text: " " });
            lastText += " ";
          }
          return;
        }
        const chars = s.chars;
        // trim the piece's own leading/trailing spaces
        let a = 0;
        let b = chars.length - 1;
        while (a <= b && !chars[a].c.trim()) a++;
        while (b >= a && !chars[b].c.trim()) b--;
        if (a > b) return;
        const separate = mark && mark.glued === undefined && si === 1 && ri === 0;
        if (si > 0 || (ri === 0 && tabs && s.x0 > colL + 2) || separate) {
          const gap = si > 0 ? s.x0 - r.segs[si - 1].x1 : Infinity;
          // (in a table row, smaller gaps are cell gaps too)
          if ((tabs && gap > 0.9 * r.size) || (tabs && si === 0) || separate) {
            tabStops.push(s.x0 - indentFrom);
            push(chars[a], "\t", r.base, r.size);
          } else if (!/\s$/.test(lastText) && gap > 0.15 * Math.min(r.size, chars[a].size * 1.4)) push(chars[a], " ", r.base, r.size);
        }
        let prevC: Ch | null = null;
        for (let k = a; k <= b; k++) {
          const c = chars[k];
          // words placed apart without a space character
          if (prevC && c.c.trim() && prevC.c.trim() && c.x - prevC.x1 > 0.22 * c.size) push(prevC, " ", r.base, r.size);
          // (several spaces in a row: one)
          if (!c.c.trim() && /\s$/.test(lastText)) continue;
          push(c, c.c.trim() ? c.c : " ", r.base, r.size);
          prevC = c;
        }
      });
      // a marker glued to its text ("• text", "[2] text"): tab after it
      if (ri === 0 && mark?.glued !== undefined) {
        const first = runs.findIndex((x) => x.text.trim());
        if (first >= 0) runs[first].text = runs[first].text.replace(/^(\s*(?:\[[^\]]{1,3}\]|\S))\s+/, "$1\t");
        tabStops.push(mark.textX - indentFrom);
      }
    });
    widths.push(width);
    letterCounts.push(letters);
    // tidy runs: no empty ones, no trailing spaces
    while (runs.length && !runs[runs.length - 1].image && !runs[runs.length - 1].text.trim()) runs.pop();
    const lastRun = runs[runs.length - 1];
    if (lastRun && !lastRun.image) lastRun.text = lastRun.text.replace(/\s+$/, "");

    const colW = colR - colL;
    const block: DocxParagraph = { kind: "p", runs: runs.filter((r) => r.text || r.image) };
    const x0s = g.map((r) => r.x0);
    const tol = Math.max(1.5, size * 0.3);
    const gx1 = Math.max(...g.map((r) => r.x1));
    const narrowed = indentFrom !== colL;
    if (mark) {
      block.indLeft = Math.max(0, mark.textX - indentFrom);
      block.indFirst = mark.x - mark.textX;
      if (g.length > 1 && g.slice(0, -1).every((r) => r.x1 >= gx1 - tol)) block.align = "both";
    } else if (!tabs) {
      const mid = (r: Row) => Math.abs(r.x0 - colL - (colR - r.x1)) < Math.max(3, 0.04 * colW) && r.x0 - colL > 2;
      const fillsBoth = g.length > 1 && g.slice(0, -1).every((r) => r.x1 >= gx1 - tol) && g.slice(2).every((r) => Math.abs(r.x0 - g[1].x0) < tol);
      if (fillsBoth) block.align = "both";
      else if (g.every(mid)) block.align = "center";
      else if (g.every((r) => r.x1 >= colR - tol) && g.some((r) => r.x0 > colL + 0.25 * colW)) block.align = "right";
      if (block.align !== "center" && block.align !== "right") {
        const rest = g.length > 1 ? Math.min(...x0s.slice(1)) : x0s[0];
        const left = Math.max(0, rest - (narrowed ? colL : indentFrom));
        const first = x0s[0] - (narrowed ? colL : indentFrom) - left;
        if (left > 1.5) block.indLeft = left;
        if (Math.abs(first) > 1.5) block.indFirst = first;
      }
    }
    // a paragraph narrower than its column: the same width in Word
    if (!narrowed && g.length > 1 && block.align !== "center" && block.align !== "right" && colR - gx1 > Math.max(4, size)) block.indRight = colR - gx1 - 0.5;
    if (tabStops.length)
      block.tabs = [...new Set(tabStops.map((t) => Math.round(t * 2) / 2))]
        .filter((t) => t > 0)
        .sort((a, b) => a - b)
        .map((pos) => ({ pos }));
    const p = pitch || blockPitch;
    const natural = size * lineFactor(this.mainFontOf(runs) || this.mainFont);
    const hasPic = runs.some((r) => r.image);
    let lineH = natural;
    if (g.length > 1 && p > 0) {
      // (tighter than Word's own line height: exact, so the text takes the same room)
      if (p < natural && !hasPic) block.lineExact = p;
      else block.line = p;
      lineH = hasPic ? Math.max(p, natural) : p;
    }

    // lines as long as in the PDF: tighter letters where Word's font is wider
    if (!tabs) {
      const room = colW - (block.indLeft ?? 0) - (block.indRight ?? 0);
      let need = 0;
      widths.forEach((w, i) => {
        const avail = room - (i === 0 ? (block.indFirst ?? 0) : 0) - 0.5;
        if (w > avail && letterCounts[i]) need = Math.min(need, (avail - w) / letterCounts[i]);
      });
      if (need < 0) {
        const sp = Math.max(-0.12 * size, need - 0.01);
        for (const r of block.runs) if (!r.image) r.spacing = Math.round(sp * 20) / 20;
      }
    }

    // headings: bigger than the body text (or bold and big), short -> outline levels
    const text = runs.map((r) => r.text).join("");
    const lvl = this.headingSizes.findIndex((s) => Math.abs(s - Math.round(size * 2) / 2) < 0.3);
    const boldish = runs.filter((r) => r.bold).reduce((n, r) => n + r.text.length, 0) > text.length / 2;
    if (lvl >= 0 && text.length < 200 && g.length <= 3 && (boldish || size >= this.bodySize * 1.3)) {
      block.heading = lvl + 1;
      block.keepNext = true;
    }
    return { block, firstBase: g[0].base, lastBase: g[g.length - 1].base, size, lineH };
  }
}
