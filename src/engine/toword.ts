// PDF → Word (.docx). Two ways:
// - "pictures": every page as one picture on a page of the same size (looks the same, not editable);
// - "editable": text rebuilt as Word paragraphs (fonts, sizes, bold/italic, colours, super-/subscript,
//   alignment, indents, spacing), two-column pages as Word columns, rows with big gaps as tab stops,
//   bullets as hanging indents; pictures stay pictures, vector drawings and stacked formulas become
//   pictures of their area; pages that are only a scan come out as pictures.
import type * as MuPDF from "mupdf";
import {
  buildDocx,
  type DocxBlock,
  type DocxParagraph,
  type DocxRun,
  type DocxSection,
} from "../core/docx";
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
  if (
    doc.needsPassword() &&
    !(f.password && doc.authenticatePassword(f.password))
  ) {
    doc.destroy();
    throw new PasswordError(f.name);
  }
  return doc;
}

export function pdfToWord(
  mupdf: M,
  f: PdfInput,
  pages: number[],
  opts: WordOptions,
  turns: number[] = [],
): WordResult {
  const doc = open(mupdf, f);
  const title = f.name.replace(/\.[^.]+$/, "");
  try {
    const sections: DocxSection[] = [];
    const scanned: number[] = [];
    if (opts.mode === "pictures") {
      pages.forEach((p, k) =>
        sections.push(
          picturePage(mupdf, doc, p, opts.dpi ?? 150, turns[k] ?? 0),
        ),
      );
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
      bytes: buildDocx(sections, {
        title,
        font: conv.mainFont,
        size: conv.bodySize,
      }),
      scanned,
    };
  } finally {
    doc.destroy();
  }
}

/** One page as one picture on a page of its size. */
function picturePage(
  mupdf: M,
  doc: MuPDF.PDFDocument,
  index: number,
  dpi: number,
  turn: number,
): DocxSection {
  const page = doc.loadPage(index);
  try {
    const b = page.getBounds();
    const t = (((Math.round(turn / 90) * 90) % 360) + 360) % 360;
    let w = b[2] - b[0];
    let h = b[3] - b[1];
    if (t % 180) [w, h] = [h, w];
    const s = Math.min(dpi / 72, Math.sqrt(30e6 / Math.max(1, w * h)));
    const pix = page.toPixmap(
      mupdf.Matrix.concat(mupdf.Matrix.scale(s, s), mupdf.Matrix.rotate(t)),
      mupdf.ColorSpace.DeviceRGB,
      false,
      true,
    );
    let data: Uint8Array;
    try {
      data = pix.asJPEG(88, false).slice();
    } finally {
      pix.destroy();
    }
    return {
      width: w,
      height: h,
      margins: { top: 0, right: 0, bottom: 0, left: 0 },
      blocks: [
        {
          kind: "img",
          type: "jpeg",
          data,
          w,
          h,
          anchor: { x: 0, y: 0 },
          name: `Page ${index + 1}`,
        },
      ],
    };
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
}

/** A piece of a line (MuPDF splits lines at big gaps). */
interface Seg {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  chars: Ch[];
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
}

type Item = TextItem | PicItem;

interface PageData {
  index: number;
  w: number;
  h: number;
  items: Item[];
  scan: boolean;
  /** Lines, boxes, fills and form fields: one see-through picture behind the text. */
  decor?: Uint8Array;
}

const BULLETS = new Set([
  "•",
  "◦",
  "▪",
  "■",
  "□",
  "●",
  "○",
  "‣",
  "⁃",
  "–",
  "-",
  "∙",
  "·",
  "➢",
  "➤",
  "►",
  "✓",
  "✔",
  "❖",
  "◆",
  "◇",
]);
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
const PUA: Record<number, string> = {
  0xf0b7: "•",
  0xf0a7: "▪",
  0xf0a8: "▪",
  0xf06e: "■",
  0xf076: "❖",
  0xf0d8: "➢",
  0xf0fc: "✓",
  0xf0e0: "→",
  0xf06f: "□",
  0xf0a1: "○",
  0xf02d: "-",
};

const median = (v: number[]) => {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
const union = (a: Rect, b: Rect): Rect => [
  Math.min(a[0], b[0]),
  Math.min(a[1], b[1]),
  Math.max(a[2], b[2]),
  Math.max(a[3], b[3]),
];
const overlaps = (a: Rect, b: Rect, pad = 0) =>
  a[0] < b[2] + pad &&
  b[0] < a[2] + pad &&
  a[1] < b[3] + pad &&
  b[1] < a[3] + pad;
const inside = (a: Rect, b: Rect) => {
  const i: Rect = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3]),
  ];
  return area(a) > 0 ? area(i) / area(a) : 0;
};

/** Word-friendly font family from a PDF font name. */
export function wordFont(name: string): FontInfo {
  let n = name.replace(/^[A-Z]{6}\+/, "");
  const lower = n.toLowerCase();
  const bold =
    /bold|black|heavy|semibold|demi|[-,]bd\b|medium/.test(lower) &&
    !/semilight/.test(lower);
  const italic = /italic|oblique|[-,]it\b|slanted/.test(lower);
  n = n.replace(/[-,_ ]?(PSMT|PS|MT)$/i, "");
  n = n.replace(
    /[-,_ ]?(Regular|Roman|Book|Normal|Plain|Bold|Italic|Oblique|BoldItalic|BoldOblique|Semibold|SemiBold|Medium|Light|Black|Heavy|Demi|It|Bd|BdIt)+$/i,
    "",
  );
  n = n.replace(/[-,_]+$/, "");
  const l = n.toLowerCase().replace(/[^a-z]/g, "");
  const map: [RegExp, string][] = [
    [
      /^(lmroman|lmr|cmr|cmu(serif)?|cmbx|cmti|cmsl|lmmath|cmmi|cmsy|lmmathsymbols|cmex|lmmathextension|nimbusrom|tex(gyre)?termes|termes|times|timesnewroman|tinos|liberationserif|dejavuserif|stix|xits|ptm)/,
      "Times New Roman",
    ],
    [
      /^(lmsans|lmss|cmss|cmusans|helvetica|arial|arimo|liberationsans|nimbussan|texgyreheros|heros|phv)/,
      "Arial",
    ],
    [
      /^(lmmono|lmtt|cmtt|cmutypewriter|courier|cousine|liberationmono|nimbusmon|texgyrecursor|pcr)/,
      "Courier New",
    ],
    [/^carlito/, "Calibri"],
    [/^caladea/, "Cambria"],
    // (symbol fonts: the characters are real Unicode, the document's font shows them)
    [/^(symbolmt|symbol|opensymbol|wingdings|zapfdingbats|dingbats)/, ""],
  ];
  for (const [re, fam] of map)
    if (re.test(l))
      return {
        family: fam,
        bold: fam ? bold : false,
        italic: fam ? italic : false,
      };
  // CamelCase names: "MinionPro" -> "Minion Pro", "SourceSansPro" -> "Source Sans Pro"
  const family =
    n
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/[-_]+/g, " ")
      .trim() || "Calibri";
  return { family, bold, italic };
}

function hex(color: number[]): string {
  let r = 0;
  let g = 0;
  let b = 0;
  if (color.length === 1) r = g = b = color[0];
  else if (color.length === 3) [r, g, b] = color;
  else if (color.length === 4) {
    const [c, m, y, k] = color;
    r = (1 - c) * (1 - k);
    g = (1 - m) * (1 - k);
    b = (1 - y) * (1 - k);
  }
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return (h(r) + h(g) + h(b)).toUpperCase();
}

class Converter {
  private fonts = new Map<string, FontInfo>();
  private stroke: MuPDF.StrokeState;
  mainFont = "Calibri";
  bodySize = 11;
  /** Heading sizes, biggest first (level 1, 2, 3). */
  private headingSizes: number[] = [];

  constructor(private mupdf: M) {
    this.stroke = new mupdf.StrokeState({
      lineCap: "Butt",
      lineJoin: "Miter",
      lineWidth: 0,
      miterLimit: 10,
    } as MuPDF.StrokeStateData);
  }

  private fontOf(font: MuPDF.Font): FontInfo {
    const name = font.getName();
    let f = this.fonts.get(name);
    if (!f) {
      const w = wordFont(name);
      f = {
        family: w.family,
        bold: w.bold || font.isBold(),
        italic: w.italic || font.isItalic(),
      };
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
      const blocks: { r: Rect; segs: Seg[] }[] = [];
      const images: Rect[] = [];
      let seg: Seg | null = null;
      let block: { r: Rect; segs: Seg[] } | null = null;
      const st = page.toStructuredText(
        "preserve-whitespace,preserve-images,preserve-spans",
      );
      st.walk({
        onImageBlock: (b) =>
          void images.push([b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy]),
        beginTextBlock: (b) =>
          void (block = {
            r: [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy],
            segs: [],
          }),
        endTextBlock: () => {
          if (block && block.segs.length) blocks.push(block);
          block = null;
        },
        beginLine: () =>
          void (seg = {
            x0: Infinity,
            x1: -Infinity,
            top: Infinity,
            bottom: -Infinity,
            chars: [],
          }),
        onChar: (c, origin, font, size, quad, color) => {
          if (!seg) return;
          const code = c.codePointAt(0) ?? 0;
          if (code >= 0xe000 && code <= 0xf8ff)
            c = PUA[code] ?? (seg.chars.length ? "" : "•");
          if (!c) return;
          const x0 = Math.min(quad[0], quad[4]) - ox;
          const x1 = Math.max(quad[2], quad[6]) - ox;
          const top = Math.min(quad[1], quad[3]) - oy;
          const bottom = Math.max(quad[5], quad[7]) - oy;
          seg.chars.push({
            c,
            x: origin[0] - ox,
            y: origin[1] - oy,
            x1,
            top,
            bottom,
            size,
            font: this.fontOf(font),
            color: hex(color),
          });
          if (c.trim()) {
            seg.x0 = Math.min(seg.x0, x0);
            seg.x1 = Math.max(seg.x1, x1);
            seg.top = Math.min(seg.top, top);
            seg.bottom = Math.max(seg.bottom, bottom);
          }
        },
        endLine: () => {
          if (seg && block && seg.chars.some((ch) => ch.c.trim()))
            block.segs.push(seg);
          seg = null;
        },
      });
      st.destroy();

      const textArea = blocks.reduce((n, b) => n + area(b.r), 0);
      // a page that is one big picture: a scan (with recognised text: use the text, drop the picture)
      const big = images.filter((r) => area(r) > 0.6 * W * H);
      if (!blocks.length) {
        if (big.length || images.length)
          return { index, w: W, h: H, items: [], scan: true };
      }
      const pics: Rect[] = images.filter(
        (r) => !(big.includes(r) && textArea > 0) && area(r) > 16,
      );

      // vector drawings: curves, slanted lines, shadings -> figures (straight rules and boxes stay out)
      const shapes: { r: Rect; complex: boolean }[] = [];
      const isComplex = (path: MuPDF.Path, ctm: number[]) => {
        let complex = false;
        let px = 0;
        let py = 0;
        const tp = (x: number, y: number) => [
          x * ctm[0] + y * ctm[2] + ctm[4],
          x * ctm[1] + y * ctm[3] + ctm[5],
        ];
        path.walk({
          moveTo: (x, y) => void ([px, py] = tp(x, y)),
          lineTo: (x, y) => {
            const [nx, ny] = tp(x, y);
            if (Math.abs(nx - px) > 0.5 && Math.abs(ny - py) > 0.5)
              complex = true;
            px = nx;
            py = ny;
          },
          curveTo: () => void (complex = true),
        });
        return complex;
      };
      const addShape = (
        path: MuPDF.Path,
        ctm: MuPDF.Matrix,
        stroke: MuPDF.StrokeState,
      ) => {
        const b = path.getBounds(stroke, ctm);
        const r: Rect = [b[0] - ox, b[1] - oy, b[2] - ox, b[3] - oy];
        if (!(r[2] > r[0]) || area(r) > 0.8 * W * H) return; // (page backgrounds)
        shapes.push({ r, complex: isComplex(path, ctm as number[]) });
      };
      const dev = new mupdf.Device({
        fillPath: (path: MuPDF.Path, _eo: boolean, ctm: MuPDF.Matrix) =>
          addShape(path, ctm, this.stroke),
        strokePath: (
          path: MuPDF.Path,
          stroke: MuPDF.StrokeState,
          ctm: MuPDF.Matrix,
        ) => addShape(path, ctm, stroke),
        fillShade: (shade: MuPDF.Shade, ctm: MuPDF.Matrix) => {
          const s0 = shade.getBounds();
          const m = ctm as number[];
          const xs: number[] = [];
          const ys: number[] = [];
          for (const [x, y] of [
            [s0[0], s0[1]],
            [s0[2], s0[1]],
            [s0[0], s0[3]],
            [s0[2], s0[3]],
          ]) {
            xs.push(x * m[0] + y * m[2] + m[4]);
            ys.push(x * m[1] + y * m[3] + m[5]);
          }
          const r: Rect = [
            Math.min(...xs) - ox,
            Math.min(...ys) - oy,
            Math.max(...xs) - ox,
            Math.max(...ys) - oy,
          ];
          if (area(r) < 0.8 * W * H) shapes.push({ r, complex: true });
        },
      } as never);
      try {
        page.runPageContents(dev, mupdf.Matrix.identity);
      } catch {
        /* (drawing problems: no figures) */
      }
      dev.close();

      // figures: complex shapes plus everything that touches them, grown together
      let figs: Rect[] = shapes.filter((s) => s.complex).map((s) => s.r);
      figs = this.grow(
        figs,
        shapes.map((s) => s.r),
        6,
      );
      figs = figs.filter(
        (r) => r[2] - r[0] >= 12 && r[3] - r[1] >= 12 && area(r) >= 300,
      );

      // text blocks that cross each other (stacked formulas): one picture for the lot
      const tb = blocks.map((b) => ({ ...b, r: this.segBox(b.segs) }));
      const knots: Rect[] = [];
      for (let i = 0; i < tb.length; i++)
        for (let j = i + 1; j < tb.length; j++) {
          const a = tb[i].r;
          const b = tb[j].r;
          const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
          const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
          if (ix > 1 && iy > 1) knots.push(union(a, b));
        }
      // inside a block: lines stacked closer than lines of text (fractions, limits) are a formula
      for (const b of tb) {
        const rows = this.rows(b.segs);
        for (let i = 1; i < rows.length; i++) {
          const a = rows[i - 1];
          const c = rows[i];
          const size = Math.min(a.size, c.size);
          const xo = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0);
          if (c.base - a.base < 0.72 * size && xo > -size) {
            // the whole width of the lines at that height
            let k: Rect = union(
              [a.x0, a.top, a.x1, a.bottom],
              [c.x0, c.top, c.x1, c.bottom],
            );
            for (const r of rows)
              if (
                Math.min(r.bottom, k[3]) - Math.max(r.top, k[1]) >
                0.3 * (r.bottom - r.top)
              )
                k = union(k, [r.x0, r.top, r.x1, r.bottom]);
            knots.push(k);
          }
        }
      }
      // pictures/figures take the text that sits on them (labels) and formula parts next to them
      let regions = [...this.merge(knots, 0), ...figs];
      const nearText = (r: Rect, t: Rect, size: number) =>
        inside(t, r) > 0.5 ||
        (overlaps(r, t, size * 1.2) &&
          t[3] - t[1] < 3 * size &&
          Math.min(r[3], t[3]) - Math.max(r[1], t[1]) > 0.3 * (t[3] - t[1]) &&
          r[3] - r[1] < 160);
      for (let pass = 0; pass < 3; pass++) {
        regions = this.merge(regions, 2).map((r) => {
          let g = r;
          for (const b of tb)
            if (
              nearText(g, b.r, this.blockSize(b.segs)) &&
              (inside(b.r, g) > 0.5 || knots.some((k) => overlaps(k, g)))
            )
              g = union(g, b.r);
          return g;
        });
      }
      regions = this.merge(regions, 2);
      const picRects = this.merge([...pics], 0).filter(
        (p) => !regions.some((r) => inside(p, r) > 0.9),
      );

      const items: Item[] = [];
      const render = (r: Rect, type: "png" | "jpeg"): PicItem | null => {
        const pad = type === "png" ? 1.5 : 0;
        const rr: Rect = [
          Math.max(0, r[0] - pad),
          Math.max(0, r[1] - pad),
          Math.min(W, r[2] + pad),
          Math.min(H, r[3] + pad),
        ];
        const s = Math.min(
          type === "png" ? 220 / 72 : 200 / 72,
          Math.sqrt(12e6 / Math.max(1, area(rr))),
        );
        const bbox: Rect = [
          Math.floor((rr[0] + ox) * s),
          Math.floor((rr[1] + oy) * s),
          Math.ceil((rr[2] + ox) * s),
          Math.ceil((rr[3] + oy) * s),
        ];
        if (bbox[2] - bbox[0] < 2 || bbox[3] - bbox[1] < 2) return null;
        const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
        try {
          pix.clear(255);
          const d = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
          page.run(d, mupdf.Matrix.identity);
          d.close();
          const data = (
            type === "png" ? pix.asPNG() : pix.asJPEG(88, false)
          ).slice();
          return { kind: "pic", r: rr, data, type };
        } finally {
          pix.destroy();
        }
      };
      for (const r of regions) {
        const p = render(r, "png");
        if (p) items.push(p);
      }
      for (const r of picRects) {
        const p = render(r, "jpeg");
        if (p) items.push(p);
      }
      const taken = [...regions, ...picRects];
      const decor = this.decor(page, W, H, ox, oy, taken);
      for (const b of tb) {
        if (taken.some((r) => inside(b.r, r) > 0.5)) continue;
        // single lines partly on a picture: keep only the pieces outside
        const segs = b.segs.filter(
          (sg) =>
            !taken.some(
              (r) => inside([sg.x0, sg.top, sg.x1, sg.bottom], r) > 0.5,
            ),
        );
        if (!segs.length) continue;
        items.push({
          kind: "text",
          r: this.segBox(segs),
          rows: this.rows(segs),
        });
      }
      return { index, w: W, h: H, items, scan: false, decor };
    } finally {
      page.destroy();
    }
  }

  /** Everything drawn that isn't text or a picture (rules, table lines, boxes, fills), plus form
   *  fields and annotations, on a see-through page-sized picture. Null if there is none. */
  private decor(
    page: MuPDF.PDFPage,
    W: number,
    H: number,
    ox: number,
    oy: number,
    skip: Rect[],
  ): Uint8Array | undefined {
    const mupdf = this.mupdf;
    const s = Math.min(200 / 72, Math.sqrt(24e6 / Math.max(1, W * H)));
    const bbox: Rect = [
      Math.floor(ox * s),
      Math.floor(oy * s),
      Math.ceil((ox + W) * s),
      Math.ceil((oy + H) * s),
    ];
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, true);
    let drawn = 0;
    try {
      pix.clear();
      const dd = new mupdf.DrawDevice(mupdf.Matrix.scale(s, s), pix);
      const off = (r: number[]) => {
        const rr: Rect = [r[0] - ox, r[1] - oy, r[2] - ox, r[3] - oy];
        return skip.some((k) => inside(rr, k) > 0.8);
      };
      const tf = (b: number[], m: number[]) => {
        const xs = [
          b[0] * m[0] + b[1] * m[2] + m[4],
          b[2] * m[0] + b[1] * m[2] + m[4],
          b[0] * m[0] + b[3] * m[2] + m[4],
          b[2] * m[0] + b[3] * m[2] + m[4],
        ];
        const ys = [
          b[0] * m[1] + b[1] * m[3] + m[5],
          b[2] * m[1] + b[1] * m[3] + m[5],
          b[0] * m[1] + b[3] * m[3] + m[5],
          b[2] * m[1] + b[3] * m[3] + m[5],
        ];
        return [
          Math.min(...xs),
          Math.min(...ys),
          Math.max(...xs),
          Math.max(...ys),
        ];
      };
      // page contents: only the drawing (text is rebuilt, pictures are their own)
      const filter = new mupdf.Device({
        fillPath: (
          p: MuPDF.Path,
          eo: boolean,
          ctm: MuPDF.Matrix,
          cs: MuPDF.ColorSpace,
          c: MuPDF.Color,
          a: number,
        ) => {
          if (off(p.getBounds(this.stroke, ctm))) return;
          drawn++;
          dd.fillPath(p, eo, ctm, cs, c, a);
        },
        strokePath: (
          p: MuPDF.Path,
          st: MuPDF.StrokeState,
          ctm: MuPDF.Matrix,
          cs: MuPDF.ColorSpace,
          c: MuPDF.Color,
          a: number,
        ) => {
          if (off(p.getBounds(st, ctm))) return;
          drawn++;
          dd.strokePath(p, st, ctm, cs, c, a);
        },
        fillShade: (sh: MuPDF.Shade, ctm: MuPDF.Matrix, a: number) => {
          if (off(tf(sh.getBounds(), ctm as number[]))) return;
          drawn++;
          dd.fillShade(sh, ctm, a);
        },
        fillImageMask: (
          im: MuPDF.Image,
          ctm: MuPDF.Matrix,
          cs: MuPDF.ColorSpace,
          c: MuPDF.Color,
          a: number,
        ) => {
          if (off(tf([0, 0, 1, 1], ctm as number[]))) return;
          drawn++;
          dd.fillImageMask(im, ctm, cs, c, a);
        },
        clipPath: (p: MuPDF.Path, eo: boolean, ctm: MuPDF.Matrix) =>
          dd.clipPath(p, eo, ctm),
        clipStrokePath: (
          p: MuPDF.Path,
          st: MuPDF.StrokeState,
          ctm: MuPDF.Matrix,
        ) => dd.clipStrokePath(p, st, ctm),
        clipText: (t: MuPDF.Text, ctm: MuPDF.Matrix) => dd.clipText(t, ctm),
        clipStrokeText: (
          t: MuPDF.Text,
          st: MuPDF.StrokeState,
          ctm: MuPDF.Matrix,
        ) => dd.clipStrokeText(t, st, ctm),
        clipImageMask: (im: MuPDF.Image, ctm: MuPDF.Matrix) =>
          dd.clipImageMask(im, ctm),
        popClip: () => dd.popClip(),
        beginMask: (
          r: MuPDF.Rect,
          l: boolean,
          cs: MuPDF.ColorSpace,
          c: MuPDF.Color,
        ) => dd.beginMask(r, l, cs, c),
        endMask: () => dd.endMask(),
        beginGroup: (
          r: MuPDF.Rect,
          cs: MuPDF.ColorSpace,
          i: boolean,
          k: boolean,
          bm: MuPDF.BlendMode,
          a: number,
        ) => dd.beginGroup(r, cs, i, k, bm, a),
        endGroup: () => dd.endGroup(),
        beginTile: (
          r: MuPDF.Rect,
          v: MuPDF.Rect,
          xs: number,
          ys: number,
          ctm: MuPDF.Matrix,
          id: number,
          d: number,
        ) => dd.beginTile(r, v, xs, ys, ctm, id, d),
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

  private segBox(segs: Seg[]): Rect {
    return segs.reduce<Rect>(
      (r, s) => [
        Math.min(r[0], s.x0),
        Math.min(r[1], s.top),
        Math.max(r[2], s.x1),
        Math.max(r[3], s.bottom),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  }

  private blockSize(segs: Seg[]): number {
    return (
      median(
        segs.flatMap((s) =>
          s.chars.filter((c) => c.c.trim()).map((c) => c.size),
        ),
      ) || 10
    );
  }

  /** Rectangles that touch (within `gap`) become one. */
  private merge(rs: Rect[], gap: number): Rect[] {
    const out = rs.map((r) => [...r] as Rect);
    for (let changed = true; changed;) {
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
            if (
              s[2] - s[0] > 3 * (g[2] - g[0]) + 40 ||
              s[3] - s[1] > 3 * (g[3] - g[1]) + 40
            )
              continue;
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
      const base =
        median(
          main.filter((c) => Math.abs(c.size - size) < 0.6).map((c) => c.y),
        ) || s.bottom;
      const row = rows.find(
        (r) =>
          Math.abs(r.base - base) < 0.35 * Math.min(size, r.size) ||
          (Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top) >
            0.6 * Math.min(r.bottom - r.top, s.bottom - s.top) &&
            Math.abs(r.base - base) < 0.6 * Math.max(size, r.size)),
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
      } else
        rows.push({
          x0: s.x0,
          x1: s.x1,
          top: s.top,
          bottom: s.bottom,
          base,
          size,
          segs: [s],
        });
    }
    for (const r of rows) {
      r.segs.sort((a, b) => a.x0 - b.x0);
      // pieces that overlap (accented letters MuPDF puts on their own line): one piece, letters in order
      const out: Seg[] = [];
      for (const sg of r.segs) {
        const last = out[out.length - 1];
        if (last && sg.x0 < last.x1 - 0.5) {
          // (the other piece holds a placeholder space where the letter goes: drop it)
          const ins = sg.chars.filter((c) => c.c.trim());
          const keep = (c: Ch) =>
            c.c.trim() ||
            !ins.some((d) => c.x >= d.x - 1 && c.x <= d.x + 0.5 * (d.x1 - d.x));
          const chars = [...last.chars.filter(keep), ...sg.chars].sort(
            (a, b) => a.x - b.x,
          );
          out[out.length - 1] = {
            x0: Math.min(last.x0, sg.x0),
            x1: Math.max(last.x1, sg.x1),
            top: Math.min(last.top, sg.top),
            bottom: Math.max(last.bottom, sg.bottom),
            chars,
          };
        } else out.push(sg);
      }
      r.segs = out;
    }
    return rows.sort((a, b) => a.base - b.base);
  }

  /** Body size, main font and heading sizes over all pages. */
  finishStyles(pages: PageData[]): void {
    const sizes = new Map<number, number>();
    const fams = new Map<string, number>();
    for (const p of pages)
      for (const it of p.items)
        if (it.kind === "text")
          for (const r of it.rows)
            for (const s of r.segs)
              for (const c of s.chars) {
                if (!c.c.trim()) continue;
                const k = Math.round(c.size * 2) / 2;
                sizes.set(k, (sizes.get(k) ?? 0) + 1);
                fams.set(c.font.family, (fams.get(c.font.family) ?? 0) + 1);
              }
    const top = (
      m: Map<never, number> | Map<number, number> | Map<string, number>,
    ) => [...(m as Map<unknown, number>)].sort((a, b) => b[1] - a[1])[0]?.[0];
    this.bodySize = (top(sizes) as number) ?? 11;
    this.mainFont = (top(fams) as string) ?? "Calibri";
    this.headingSizes = [...sizes.keys()]
      .filter((s) => s >= this.bodySize * 1.15)
      .sort((a, b) => b - a)
      .slice(0, 3);
  }

  // ---------- laying out a page ----------

  layout(pg: PageData): DocxSection[] {
    const { w: W, h: H } = pg;
    const items = pg.items;
    if (!items.length)
      return [
        {
          width: W,
          height: H,
          margins: { top: 72, right: 72, bottom: 72, left: 72 },
          blocks: pg.decor
            ? [
                {
                  kind: "img",
                  type: "png",
                  data: pg.decor,
                  w: W,
                  h: H,
                  anchor: { x: 0, y: 0 },
                },
              ]
            : [],
        },
      ];
    const L = Math.max(6, Math.min(...items.map((i) => i.r[0])) - 0.5);
    const Rx = Math.min(W - 6, Math.max(...items.map((i) => i.r[2])) + 0.5);
    const top = Math.max(6, Math.min(...items.map((i) => i.r[1])) - 2);
    const maxY = Math.max(...items.map((i) => i.r[3]));
    const bottom = Math.max(10, Math.min(H - maxY - 2, (H - maxY) * 0.5));
    const margins = { top, right: W - Rx, bottom, left: L };

    // two columns? the gap that splits the most text evenly
    const gut = this.gutter(items, W, H);
    type Band = { full: boolean; items: Item[]; top: number; bottom: number };
    const bands: Band[] = [];
    const sorted = items
      .slice()
      .sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0]);
    if (!gut) bands.push({ full: true, items: sorted, top: 0, bottom: 0 });
    else {
      for (const it of sorted) {
        const full = it.r[0] < gut.x - 2 && it.r[2] > gut.x + 2;
        const last = bands[bands.length - 1];
        if (last && last.full === full) last.items.push(it);
        else bands.push({ full, items: [it], top: 0, bottom: 0 });
      }
    }
    for (const b of bands) {
      b.top = Math.min(...b.items.map((i) => i.r[1]));
      b.bottom = Math.max(...b.items.map((i) => i.r[3]));
    }

    const sections: DocxSection[] = [];
    let cursor = top;
    bands.forEach((band, bi) => {
      const blocks: DocxBlock[] = [];
      if (bi === 0 && pg.decor)
        blocks.push({
          kind: "img",
          type: "png",
          data: pg.decor,
          w: W,
          h: H,
          anchor: { x: 0, y: 0 },
          name: "Lines and boxes",
        });
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
        if (b.blocks.length) b.blocks[0].colBreak = true;
        blocks.push(...a.blocks, ...b.blocks);
        cursor = Math.max(a.cursor, b.cursor);
      }
      sections.push({
        width: W,
        height: H,
        margins,
        cols,
        start: bi === 0 ? "page" : "continuous",
        blocks,
      });
    });
    return sections;
  }

  /** Two-column layout: where the gap between the columns is (null: one column). */
  private gutter(
    items: Item[],
    W: number,
    H: number,
  ): { x: number; leftEdge: number; rightEdge: number } | null {
    let best: {
      x: number;
      score: number;
      leftEdge: number;
      rightEdge: number;
    } | null = null;
    const textH = (list: Item[]) =>
      list.reduce((n, i) => n + (i.r[3] - i.r[1]), 0);
    const multi = (list: Item[]) =>
      list.some((i) => i.kind === "text" && i.rows.length >= 3);
    for (let x = W * 0.3; x <= W * 0.7; x += 2) {
      const left = items.filter((i) => i.r[2] <= x);
      const right = items.filter((i) => i.r[0] >= x);
      if (left.length < 2 || right.length < 2 || !multi(left) || !multi(right))
        continue;
      const lh = textH(left);
      const rh = textH(right);
      if (lh < 0.12 * H || rh < 0.12 * H) continue;
      // full-width items in between are fine, but not most of the page
      const cross = items.filter((i) => i.r[0] < x && i.r[2] > x);
      if (textH(cross) > lh + rh) continue;
      // forms and tables: left and right share their lines -> not columns
      const lb = left.flatMap((i) =>
        i.kind === "text" ? i.rows.map((r) => r.base) : [],
      );
      const rb = right.flatMap((i) =>
        i.kind === "text" ? i.rows.map((r) => r.base) : [],
      );
      const shared = rb.filter((b) =>
        lb.some((a) => Math.abs(a - b) < 0.6),
      ).length;
      if (rb.length && shared / rb.length > 0.6 && lb.length < 3 * rb.length)
        continue;
      const leftEdge = Math.max(...left.map((i) => i.r[2]));
      const rightEdge = Math.min(...right.map((i) => i.r[0]));
      const score = Math.min(lh, rh) + (rightEdge - leftEdge) * 0.01;
      if (!best || score > best.score) best = { x, score, leftEdge, rightEdge };
    }
    if (!best) return null;
    return {
      x: (best.leftEdge + best.rightEdge) / 2,
      leftEdge: best.leftEdge,
      rightEdge: best.rightEdge,
    };
  }

  /** Items of one column, top to bottom, as Word blocks. `cursor`: where the column's content starts. */
  private flow(
    items: Item[],
    colL: number,
    colR: number,
    cursor: number,
  ): { blocks: DocxBlock[]; cursor: number } {
    const blocks: DocxBlock[] = [];
    // text side by side (table cells, label + value): one block, rows with tabs
    const merged: Item[] = [];
    for (const it of items
      .slice()
      .sort((a, b) => a.r[1] - b.r[1] || a.r[0] - b.r[0])) {
      const last = merged[merged.length - 1];
      if (
        it.kind === "text" &&
        last?.kind === "text" &&
        Math.min(it.r[3], last.r[3]) - Math.max(it.r[1], last.r[1]) >
          0.4 * Math.min(it.r[3] - it.r[1], last.r[3] - last.r[1]) &&
        !overlaps([last.r[0], 0, last.r[2], 1], [it.r[0], 0, it.r[2], 1])
      ) {
        const segs = [
          ...last.rows.flatMap((r) => r.segs),
          ...it.rows.flatMap((r) => r.segs),
        ];
        merged[merged.length - 1] = {
          kind: "text",
          r: union(last.r, it.r),
          rows: this.rows(segs),
        };
      } else merged.push(it);
    }
    for (const it of merged) {
      if (it.kind === "pic") {
        const w = Math.min(it.r[2] - it.r[0], colR - colL);
        const h = (it.r[3] - it.r[1]) * (w / (it.r[2] - it.r[0]));
        const center =
          Math.abs((it.r[0] + it.r[2]) / 2 - (colL + colR) / 2) <
            0.03 * (colR - colL) + 2 && it.r[0] > colL + 4;
        blocks.push({
          kind: "img",
          data: it.data,
          type: it.type,
          w,
          h,
          before: Math.max(0, it.r[1] - cursor),
          align: center ? "center" : undefined,
          indLeft: center
            ? undefined
            : Math.max(0, Math.min(it.r[0] - colL, colR - colL - w)),
        });
        cursor = it.r[1] + h;
        continue;
      }
      for (const p of this.paragraphs(it, colL, colR)) {
        const natural = p.size * lineFactor(p.font || this.mainFont);
        const lineH = Math.max(p.pitch, natural);
        p.block.before = Math.max(
          0,
          p.firstBase - cursor - (lineH - 0.22 * p.size),
        );
        blocks.push(p.block);
        cursor = p.lastBase + 0.22 * p.size;
      }
    }
    return { blocks, cursor };
  }

  /** A text block as paragraphs. */
  private paragraphs(
    it: TextItem,
    colL: number,
    colR: number,
  ): {
    block: DocxParagraph;
    firstBase: number;
    lastBase: number;
    size: number;
    pitch: number;
    font: string;
  }[] {
    const rows = it.rows;
    const pitches = rows
      .slice(1)
      .map((r, i) => r.base - rows[i].base)
      .filter((d) => d > 0);
    const pitch = median(pitches) || 0;
    const bx0 = Math.min(...rows.map((r) => r.x0));
    const bx1 = Math.max(...rows.map((r) => r.x1));
    const ragged =
      rows.length >= 3 &&
      rows.slice(0, -1).filter((r) => r.x1 < bx1 - 2 * r.size).length >
        (rows.length - 1) / 3;

    const dominant = (r: Row) => {
      const cs = r.segs.flatMap((s) => s.chars).filter((c) => c.c.trim());
      const bold = cs.filter((c) => c.font.bold).length > cs.length / 2;
      return { size: Math.round(r.size * 2) / 2, bold };
    };
    const tabRow = (r: Row) =>
      r.segs.some((s, i) => i > 0 && s.x0 - r.segs[i - 1].x1 > 1.5 * r.size);
    const marker = (
      r: Row,
    ): { x: number; textX: number; glued?: number } | null => {
      const first = r.segs[0];
      const t = first.chars
        .map((c) => c.c)
        .join("")
        .trim();
      const next = r.segs[1];
      const isMark =
        BULLETS.has(t) ||
        /^(\(?\d{1,3}[.)]|\(?[a-z][.)]|\(?[ivx]{1,4}[.)]|\[\d{1,3}\])$/i.test(
          t,
        );
      if (isMark && next && next.x0 - first.x1 > 0.4 * r.size)
        return { x: first.x0, textX: next.x0 };
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
      if (after && after.x - cs[end].x1 > 0.2 * r.size)
        return { x: first.x0, textX: after.x, glued: end };
      return null;
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
      const startsIndented =
        r.x0 > bx0 + 0.8 * r.size &&
        rows.slice(i + 1, i + 2).some((n) => n.x0 < r.x0 - 0.5 * r.size);
      const m = marker(r);
      const gm = groupMark as { x: number; textX: number } | null;
      // a list item's next line, under its text
      if (
        gm &&
        !m &&
        Math.abs(r.x0 - gm.textX) < 0.6 * r.size &&
        gap <= 1.45 * typical &&
        Math.abs(dp.size - dr.size) <= 0.6 &&
        !tabRow(r)
      )
        return void g.push(r);
      const prevShort =
        !ragged &&
        rows.length >= 3 &&
        prev.x1 < bx1 - Math.max(3 * prev.size, 0.12 * (bx1 - bx0)) &&
        r.x0 < bx0 + 1.5 * r.size;
      const prevEnds =
        ragged &&
        /[.:!?]\s*$/.test(this.rowText(prev)) &&
        prev.x1 < bx0 + 0.6 * (bx1 - bx0);
      const breaks =
        tabRow(r) ||
        tabRow(prev) ||
        !!m ||
        Math.abs(dp.size - dr.size) > 0.6 ||
        dp.bold !== dr.bold ||
        gap > 1.45 * typical ||
        startsIndented ||
        prevShort ||
        prevEnds;
      if (breaks) {
        groups.push([r]);
        groupMark = m;
      } else g.push(r);
    });

    return groups.map((g) =>
      this.paragraph(g, colL, colR, pitch, marker(g[0]), tabRow(g[0])),
    );
  }

  private rowText(r: Row): string {
    return r.segs
      .map((s) => s.chars.map((c) => c.c).join(""))
      .join(" ")
      .trim();
  }

  private paragraph(
    g: Row[],
    colL: number,
    colR: number,
    blockPitch: number,
    mark: { x: number; textX: number; glued?: number } | null,
    tabs: boolean,
  ): {
    block: DocxParagraph;
    firstBase: number;
    lastBase: number;
    size: number;
    pitch: number;
    font: string;
  } {
    const size = median(g.map((r) => r.size));
    const pitch =
      g.length > 1 ? median(g.slice(1).map((r, i) => r.base - g[i].base)) : 0;
    const runs: DocxRun[] = [];
    const tabStops: number[] = [];
    let lastText = "";
    const push = (c: Ch, text: string, rowBase: number, rowSize: number) => {
      let vert: DocxRun["vert"];
      let sz = c.size;
      if (!text.trim()) sz = Math.max(c.size, rowSize);
      if (c.size < rowSize * 0.85 && c.c.trim() && text.trim()) {
        if (c.y < rowBase - 0.15 * rowSize) vert = "superscript";
        else if (c.y > rowBase + 0.08 * rowSize) vert = "subscript";
        if (vert) sz = rowSize;
      }
      const run: DocxRun = {
        text,
        font: c.font.family || undefined,
        size: Math.round(sz * 2) / 2,
        bold: c.font.bold,
        italic: c.font.italic,
        color: c.color,
        vert,
      };
      const prev = runs[runs.length - 1];
      if (
        prev &&
        prev.font === run.font &&
        prev.size === run.size &&
        !!prev.bold === !!run.bold &&
        !!prev.italic === !!run.italic &&
        prev.color === run.color &&
        prev.vert === run.vert
      )
        prev.text += text;
      else if (prev && !text.trim() && !text.includes("\t") && !prev.vert)
        prev.text += text;
      else runs.push(run);
      lastText += text;
    };

    g.forEach((r, ri) => {
      // between rows: a space, or nothing after a hyphen that splits a word
      if (ri > 0) {
        const nextChar = r.segs[0].chars.find((c) => c.c.trim())?.c ?? "";
        // ("analog-to-" + "digital": a compound word keeps its hyphen)
        const word = lastText.split(/\s/).pop() ?? "";
        if (
          /\p{L}-$/u.test(lastText) &&
          /^\p{Ll}/u.test(nextChar) &&
          word.indexOf("-") === word.length - 1
        ) {
          const prev = runs[runs.length - 1];
          prev.text = prev.text.slice(0, -1);
          lastText = lastText.slice(0, -1);
        } else if (/\p{L}-$/u.test(lastText) && /^\p{Ll}/u.test(nextChar)) {
          // (keeps the hyphen, no space)
        } else if (!/\s$/.test(lastText)) {
          const c = r.segs[0].chars[0];
          push(c, " ", r.base, r.size);
        }
      }
      r.segs.forEach((s, si) => {
        const chars = s.chars;
        // trim the piece's own leading/trailing spaces
        let a = 0;
        let b = chars.length - 1;
        while (a <= b && !chars[a].c.trim()) a++;
        while (b >= a && !chars[b].c.trim()) b--;
        if (a > b) return;
        const separate =
          mark && mark.glued === undefined && si === 1 && ri === 0;
        if (si > 0 || (ri === 0 && tabs && s.x0 > colL + 2) || separate) {
          const gap = si > 0 ? s.x0 - r.segs[si - 1].x1 : Infinity;
          // (in a table row, smaller gaps are cell gaps too)
          if ((tabs && gap > 0.9 * r.size) || (tabs && si === 0) || separate) {
            tabStops.push(s.x0 - colL);
            push(chars[a], "\t", r.base, r.size);
          } else if (
            !/\s$/.test(lastText) &&
            gap > 0.15 * Math.min(r.size, chars[a].size * 1.4)
          )
            push(chars[a], " ", r.base, r.size);
        }
        let prevC: Ch | null = null;
        for (let k = a; k <= b; k++) {
          const c = chars[k];
          // words placed apart without a space character
          if (
            prevC &&
            c.c.trim() &&
            prevC.c.trim() &&
            c.x - prevC.x1 > 0.22 * c.size
          )
            push(prevC, " ", r.base, r.size);
          push(c, c.c, r.base, r.size);
          prevC = c;
        }
      });
      // a marker glued to its text ("• text", "[2] text"): tab after it
      if (ri === 0 && mark?.glued !== undefined) {
        const first = runs.findIndex((x) => x.text.trim());
        if (first >= 0)
          runs[first].text = runs[first].text.replace(
            /^(\s*(?:\[[^\]]{1,3}\]|\S))\s+/,
            "$1\t",
          );
        tabStops.push(mark.textX - colL);
      }
    });
    // tidy runs: no empty ones, no trailing spaces
    while (runs.length && !runs[runs.length - 1].text.trim()) runs.pop();
    if (runs.length)
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(
        /\s+$/,
        "",
      );

    const colW = colR - colL;
    const block: DocxParagraph = {
      kind: "p",
      runs: runs.filter((r) => r.text),
    };
    const x0s = g.map((r) => r.x0);
    const tol = Math.max(1.5, size * 0.3);
    if (mark) {
      block.indLeft = Math.max(0, mark.textX - colL);
      block.indFirst = mark.x - mark.textX;
      if (g.length > 1 && g.slice(0, -1).every((r) => r.x1 >= colR - tol))
        block.align = "both";
    } else if (tabs) {
      block.tabs = [];
    } else {
      const center = (r: Row) =>
        Math.abs((r.x0 + r.x1) / 2 - (colL + colR) / 2) < 0.02 * colW + 2;
      const fillsBoth =
        g.length > 1 && g.slice(0, -1).every((r) => r.x1 >= colR - tol);
      if (fillsBoth) block.align = "both";
      else if (g.every(center) && g.some((r) => r.x0 > colL + 0.06 * colW))
        block.align = "center";
      else if (
        g.every((r) => r.x1 >= colR - tol) &&
        g.every((r) => r.x0 > colL + 0.3 * colW)
      )
        block.align = "right";
      if (block.align !== "center" && block.align !== "right") {
        const rest = g.length > 1 ? Math.min(...x0s.slice(1)) : x0s[0];
        const left = Math.max(0, rest - colL);
        const first = x0s[0] - colL - left;
        if (left > 1.5) block.indLeft = left;
        if (Math.abs(first) > 1.5) block.indFirst = first;
      }
    }
    if (tabStops.length)
      block.tabs = [...new Set(tabStops.map((t) => Math.round(t * 2) / 2))]
        .filter((t) => t > 0)
        .sort((a, b) => a - b)
        .map((pos) => ({ pos }));
    const p = pitch || blockPitch;
    if (g.length > 1 && p > 0) block.line = p;
    // headings: bigger than the body text (or bold, short and alone) -> outline levels
    const text = runs.map((r) => r.text).join("");
    const lvl = this.headingSizes.findIndex(
      (s) => Math.abs(s - Math.round(size * 2) / 2) < 0.3,
    );
    const boldish =
      runs.filter((r) => r.bold).reduce((n, r) => n + r.text.length, 0) >
      text.length / 2;
    if (
      lvl >= 0 &&
      text.length < 200 &&
      g.length <= 3 &&
      (boldish || size >= this.bodySize * 1.3)
    ) {
      block.heading = lvl + 1;
      block.keepNext = true;
    }
    const fonts = runs
      .filter((r) => r.font && r.text.trim())
      .map((r) => r.font!);
    const font =
      fonts.sort(
        (a, b) =>
          fonts.filter((x) => x === b).length -
          fonts.filter((x) => x === a).length,
      )[0] ?? "";
    return {
      block,
      firstBase: g[0].base,
      lastBase: g[g.length - 1].base,
      size,
      pitch: g.length > 1 ? p : 0,
      font,
    };
  }
}
