// Live text editing: find paragraphs on a page, then replace one with new text.
// The old glyphs are really removed (redaction), and the new text is drawn into the
// page content with the original font when it can be reused, otherwise with the
// closest bundled font (Latin Modern, Carlito, Caladea, Liberation).

import type * as MuPDF from "mupdf";
import type { Point, Quad, Rect } from "../core/geometry";
import { substituteFor, cleanFontName, isBoldName, isItalicName } from "../core/fontmatch";
import { layoutParagraph, normalizeRuns, type Align, type Run } from "../core/textlayout";

type M = typeof MuPDF;

export interface EditStyle {
  font: string; // font name in the PDF
  size: number;
  color: [number, number, number]; // 0..1
  bold: boolean;
  italic: boolean;
  css: string; // font stack for the in-page editor
  family: string; // bundled family to load for the editor
  file: string; // bundled substitute font file
  exact: boolean; // the substitute is a look-alike with the same letter widths
}

export interface EditLine {
  bbox: Rect;
  baseline: number;
}

export interface EditBlock {
  id: number;
  bbox: Rect;
  lines: EditLine[];
  runs: Run[];
  styles: EditStyle[];
  align: Align;
  lineHeight: number;
  firstBaseline: number;
  /** Left edge and width available for the edited text (can be wider than the old text). */
  left: number;
  width: number;
  /** Offset of the first line (paragraph indent) and of the other lines (hanging indent) from `left`. */
  firstIndent: number;
  restIndent: number;
  editable: boolean;
  reason?: string;
  /** Shown before editing, e.g. when formulas would lose their layout. */
  warn?: string;
}

export interface EditResult {
  lines: number;
  bbox: Rect;
  overflow: boolean;
  warnings: string[];
}

interface CharInfo {
  c: string;
  origin: Point;
  font: MuPDF.Font;
  size: number;
  quad: Quad;
  color: number[];
}

interface RawLine {
  bbox: Rect;
  dir: Point;
  wmode: number;
  chars: CharInfo[];
}

interface RawBlock {
  bbox: Rect;
  lines: RawLine[];
}

interface Extracted {
  blocks: EditBlock[];
  fonts: Map<string, MuPDF.Font>;
  samples: Map<string, { c: string; w: number; size: number }[]>;
}

const MATH_FONT = /math|cmmi|cmsy|cmex|msam|msbm|symbol|stix.*math|eufm|rsfs/i;

function toRGB(c: number[]): [number, number, number] {
  if (c.length === 3) return [c[0], c[1], c[2]];
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 4) return [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  return [0, 0, 0];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Walk the page's structured text into blocks of lines of characters. */
function walk(st: MuPDF.StructuredText): RawBlock[] {
  const blocks: RawBlock[] = [];
  let b: RawBlock | null = null;
  let l: RawLine | null = null;
  st.walk({
    beginTextBlock: (bbox) => {
      b = { bbox: [...bbox] as Rect, lines: [] };
      blocks.push(b);
    },
    beginLine: (bbox, wmode, dir) => {
      l = { bbox: [...bbox] as Rect, dir: [...dir] as Point, wmode, chars: [] };
      b?.lines.push(l);
    },
    onChar: (c, origin, font, size, quad, color) => {
      l?.chars.push({ c, origin: [...origin] as Point, font, size, quad: [...quad] as Quad, color: [...(color ?? [0])] });
    },
  });
  return blocks;
}

/** One run of text on one baseline, with no big gaps inside (a table cell, a line of a paragraph...). */
interface Seg {
  chars: CharInfo[]; // trimmed, without a list marker
  baseline: number;
  size: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  marker: boolean; // the line started with a bullet / number that we leave alone
  editable: boolean;
  raw: number; // MuPDF block it came from
  /** Mean word gap in ems (NaN if the line has no word gaps). Justified lines differ from each other. */
  spacing: number;
}

const isSpace = (c: string) => /\s/.test(c);
const BULLET = /^([•◦▪▫‣∙·●○■□►▸✓✔–—*\-]|[-])$/;
const NUMBERING = /^(\(?([0-9]{1,3}|[ivxIVX]{1,4}|[a-zA-Z])[.)]|[0-9]{1,3}(\.[0-9]{1,3}){0,3}\.?|§\d*)$/;

function quadX0(c: CharInfo) {
  return Math.min(c.quad[0], c.quad[4]);
}
function quadX1(c: CharInfo) {
  return Math.max(c.quad[2], c.quad[6]);
}

/** Split a MuPDF line at big gaps (table cells, tab stops) into separate pieces of text. */
function splitLine(ln: RawLine, raw: number): Seg[] {
  const horizontal = ln.wmode === 0 && Math.abs(ln.dir[0] - 1) < 0.02 && Math.abs(ln.dir[1]) < 0.02;
  const out: CharInfo[][] = [];
  let cur: CharInfo[] = [];
  let prev: CharInfo | null = null;
  for (const c of ln.chars) {
    if (!isSpace(c.c)) {
      if (prev && horizontal && quadX0(c) - quadX1(prev) > Math.max(c.size, prev.size) * 1.2) {
        out.push(cur);
        cur = [];
      }
      prev = c;
    }
    cur.push(c);
  }
  out.push(cur);
  return out.map((chars) => makeSeg(chars, raw, horizontal)).filter((x): x is Seg => !!x);
}

function makeSeg(all: CharInfo[], raw: number, editable: boolean): Seg | null {
  let s = 0;
  let e = all.length - 1;
  while (s <= e && isSpace(all[s].c)) s++;
  while (e >= s && isSpace(all[e].c)) e--;
  if (s > e) return null;
  let chars = all.slice(s, e + 1);
  // a list marker ("•", "1.", "a)", "2.1") followed by a gap stays as it is
  let marker = false;
  let k = 0;
  while (k < chars.length && !isSpace(chars[k].c) && k < 6) k++;
  const first = chars.slice(0, k).map((c) => c.c).join("");
  let rest = k;
  while (rest < chars.length && isSpace(chars[rest].c)) rest++;
  if (k > 0 && rest < chars.length && k <= 5) {
    const gap = quadX0(chars[rest]) - quadX1(chars[k - 1]);
    const size = chars[0].size;
    if ((BULLET.test(first) && gap > size * 0.2) || (NUMBERING.test(first) && gap > size * 0.6)) {
      chars = chars.slice(rest);
      marker = true;
    }
  }
  // nothing visible (e.g. a bullet symbol that maps to no character): leave it alone
  if (!chars.some((c) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(c.c))) return null;
  const main = Math.max(...chars.map((c) => c.size));
  const baseline = median(chars.filter((c) => c.size >= main - 0.01).map((c) => c.origin[1]));
  // mean word gap of the line, in ems
  const gapsEm: number[] = [];
  for (let i = 1; i < chars.length - 1; i++) {
    if (!isSpace(chars[i].c) || isSpace(chars[i - 1].c) || isSpace(chars[i + 1].c)) continue;
    gapsEm.push((quadX0(chars[i + 1]) - quadX1(chars[i - 1])) / main);
  }
  const spacing = gapsEm.length ? gapsEm.reduce((a, b) => a + b, 0) / gapsEm.length : NaN;
  return {
    spacing,
    chars,
    baseline,
    size: main,
    x0: quadX0(chars[0]),
    x1: quadX1(chars[chars.length - 1]),
    top: Math.min(...chars.map((c) => Math.min(c.quad[1], c.quad[3]))),
    bottom: Math.max(...chars.map((c) => Math.max(c.quad[5], c.quad[7]))),
    marker,
    editable,
    raw,
  };
}

/** MuPDF sometimes splits one visual line in two; glue pieces on the same baseline with a normal gap. */
function mergeSegs(segs: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const g of segs) {
    const p = out[out.length - 1];
    if (p && p.raw === g.raw && !g.marker && Math.abs(p.baseline - g.baseline) < g.size * 0.3 && g.x0 >= p.x1 - 1 && g.x0 - p.x1 < Math.max(p.size, g.size) * 1.2) {
      const sp = p.chars[p.chars.length - 1];
      p.chars = [...p.chars, { ...sp, c: " " }, ...g.chars];
      p.x1 = g.x1;
      p.top = Math.min(p.top, g.top);
      p.bottom = Math.max(p.bottom, g.bottom);
      p.size = Math.max(p.size, g.size);
      p.editable &&= g.editable;
    } else out.push({ ...g, chars: g.chars.slice() });
  }
  return out;
}

/** Width of the first word of a line (to tell a wrapped line from a deliberate line break). */
function firstWordWidth(g: Seg): number {
  let end = 0;
  while (end < g.chars.length && !isSpace(g.chars[end].c)) end++;
  return quadX1(g.chars[Math.max(0, end - 1)]) - g.x0;
}

/** Group pieces of text into paragraphs. */
function paragraphs(segs: Seg[]): Seg[][] {
  // right edge of the text column a line sits in: lines starting near the same x, or in the same MuPDF block
  const colRightOf = (g: Seg) => Math.max(...segs.filter((o) => o.raw === g.raw || Math.abs(o.x0 - g.x0) < g.size * 2).map((o) => o.x1));
  const out: Seg[][] = [];
  let cur: Seg[] = [];
  for (const g of segs) {
    const prev = cur[cur.length - 1];
    let split = !prev;
    if (prev) {
      const gap = g.baseline - prev.baseline;
      const spaceW = g.size * 0.25;
      const usualGap = cur.length >= 2 ? cur[cur.length - 1].baseline - cur[cur.length - 2].baseline : 0;
      split =
        prev.raw !== g.raw ||
        !g.editable ||
        !prev.editable ||
        g.marker ||
        gap < g.size * 0.3 || // side by side (table cells), or going back up
        Math.abs(g.size - prev.size) > Math.max(prev.size, g.size) * 0.1 ||
        gap > Math.max(g.size * 1.7, usualGap ? usualGap * 1.3 : 0) ||
        (usualGap > 0 && Math.abs(gap - usualGap) > usualGap * 0.2) ||
        (cur.length >= 2 && Math.abs(g.x0 - cur[1].x0) > g.size * 0.5) ||
        // lines of one paragraph sit under each other (not table cells in different columns)
        Math.min(g.x1, prev.x1) - Math.max(g.x0, prev.x0) < Math.min(g.x1 - g.x0, prev.x1 - prev.x0) * 0.5 ||
        Math.abs(g.x0 - prev.x0) > g.size * 4 ||
        // the previous line stopped early although this line's first word would have fitted: a hard break
        prev.x1 + spaceW + firstWordWidth(g) < colRightOf(prev) - g.size * 0.5;
    }
    if (split && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(g);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function extractBlocks(page: MuPDF.PDFPage): Extracted {
  const st = page.toStructuredText("preserve-whitespace");
  const raw = walk(st);
  const fonts = new Map<string, MuPDF.Font>();
  const samples = new Map<string, { c: string; w: number; size: number }[]>();
  const pageBounds = page.getBounds();
  const pageCenter = (pageBounds[0] + pageBounds[2]) / 2;

  const segs = mergeSegs(raw.flatMap((rb, ri) => rb.lines.flatMap((ln) => splitLine(ln, ri))));
  const paras = paragraphs(segs);

  const blocks: EditBlock[] = paras.map((ls, id) => {
    const styles: EditStyle[] = [];
    const styleIndex = new Map<string, number>();
    const styleOf = (ch: CharInfo): number => {
      const name = ch.font.getName();
      const rgb = toRGB(ch.color);
      const key = `${name}|${ch.size.toFixed(2)}|${rgb.map((v) => v.toFixed(3)).join(",")}`;
      let i = styleIndex.get(key);
      if (i === undefined) {
        const clean = cleanFontName(name);
        const sub = substituteFor({ name, bold: ch.font.isBold(), italic: ch.font.isItalic(), serif: ch.font.isSerif(), mono: ch.font.isMono() });
        i = styles.length;
        styles.push({
          font: name,
          size: ch.size,
          color: rgb,
          bold: ch.font.isBold() || isBoldName(clean),
          italic: ch.font.isItalic() || isItalicName(clean),
          css: sub.css,
          family: sub.family,
          file: sub.file,
          exact: sub.exact,
        });
        styleIndex.set(key, i);
      }
      return i;
    };

    const runs: Run[] = [];
    let math = false;
    let shifted = false;
    ls.forEach((g, li) => {
      for (const ch of g.chars) {
        const name = ch.font.getName();
        if (MATH_FONT.test(name)) math = true;
        if (Math.abs(ch.origin[1] - g.baseline) > ch.size * 0.15) shifted = true;
        if (!fonts.has(name)) fonts.set(name, ch.font);
        if (!isSpace(ch.c)) {
          const list = samples.get(name) ?? [];
          if (list.length < 40) list.push({ c: ch.c, w: Math.abs(ch.quad[2] - ch.quad[0]), size: ch.size });
          samples.set(name, list);
        }
      }
      // join with the previous line: drop a typesetter's hyphen, otherwise add a space
      if (li > 0 && runs.length) {
        const prev = runs[runs.length - 1];
        const first = g.chars[0].c;
        const word = /\S*$/.exec(prev.text)?.[0] ?? "";
        if (word.endsWith("-") && /\p{L}/u.test(first)) {
          // Hyphen at the line end: a typesetter's break inside a word is removed, a compound's
          // hyphen stays ("analog-to-|digital", "analog-|to-digital"). Lines papgi wrote itself
          // only ever break at real hyphens; its fonts are embedded whole (no "ABCDEF+" tag).
          const nextWord = g.chars.map((c) => c.c).join("").split(/\s/)[0];
          const prevLine = ls[li - 1].chars;
          const hyphenFont = prevLine[prevLine.length - 1]?.font.getName() ?? "";
          const typesetBreak =
            /\p{Ll}/u.test(first) && !word.slice(0, -1).includes("-") && !nextWord.includes("-") && /\p{L}{2}-$/u.test(word) && /^[A-Z]{6}\+/.test(hyphenFont);
          if (typesetBreak) prev.text = prev.text.slice(0, -1);
        } else runs.push({ text: " ", style: prev.style });
      }
      for (const ch of g.chars) {
        const s = styleOf(ch);
        const last = runs[runs.length - 1];
        const c = isSpace(ch.c) ? " " : ch.c;
        if (last && last.style === s) last.text += c;
        else runs.push({ text: c, style: s });
      }
    });

    const lines: EditLine[] = ls.map((g) => ({ bbox: [g.x0, g.top, g.x1, g.bottom] as Rect, baseline: g.baseline }));
    const left = Math.min(...ls.map((g) => g.x0));
    const right = Math.max(...ls.map((g) => g.x1));
    const mainSize = Math.max(...ls.map((g) => g.size));
    const gaps = ls.slice(1).map((g, i) => g.baseline - ls[i].baseline).filter((x) => x > 0);
    const lineHeight = gaps.length ? median(gaps) : mainSize * 1.2;
    const tol = Math.max(1.5, mainSize * 0.2);

    let align: Align = "left";
    if (ls.length >= 2) {
      const body = ls.slice(0, -1);
      const fullR = body.filter((g) => Math.abs(g.x1 - right) < tol).length / body.length;
      const centre = (left + right) / 2;
      const centred = ls.every((g) => Math.abs((g.x0 + g.x1) / 2 - centre) < tol) && ls.some((g) => g.x0 - left > tol);
      const rightAligned = ls.every((g) => Math.abs(g.x1 - right) < tol) && ls.some((g) => g.x0 - left > tol);
      // Justified lines are each stretched by a different amount (and the last line not at all);
      // ragged text has the same word gap on every line.
      const sp = ls.map((g) => g.spacing).filter((v) => !Number.isNaN(v));
      const stretched = sp.length >= 2 && Math.max(...sp) - Math.min(...sp) > 0.03;
      if (centred) align = "center";
      else if (rightAligned) align = "right";
      else if (fullR >= 0.7 && stretched) align = "justify";
    } else if (Math.abs((left + right) / 2 - pageCenter) < 3 && right - left < (pageBounds[2] - pageBounds[0]) * 0.8 && !ls[0].marker) {
      align = "center";
    }

    const editable = ls.every((g) => g.editable);
    return {
      id,
      bbox: [left, Math.min(...ls.map((g) => g.top)), right, Math.max(...ls.map((g) => g.bottom))] as Rect,
      lines,
      runs: normalizeRuns(runs),
      styles,
      align,
      lineHeight,
      firstBaseline: ls[0].baseline,
      left,
      width: right - left,
      firstIndent: ls[0].x0 - left,
      restIndent: (ls[1]?.x0 ?? left) - left,
      raw: ls[0].raw,
      editable,
      reason: editable ? undefined : "Rotated or vertical text can't be edited yet.",
      warn: math || shifted ? "This paragraph has formulas or sub/superscripts. Editing puts all text on one baseline in plain style." : undefined,
    } as EditBlock & { raw: number };
  });

  // Room to grow: short lines may use the width of the column they sit in.
  const all = blocks as (EditBlock & { raw: number })[];
  const marginL = Math.min(...all.map((b) => b.left), pageBounds[2]);
  const marginR = Math.max(...all.map((b) => b.left + b.width), pageBounds[0]);
  for (const b of all) {
    // a single line pushed against the right margin (dates, signatures) is right-aligned
    const tolR = Math.max(2, Math.max(...b.styles.map((x) => x.size)) * 0.3);
    if (b.align === "left" && b.lines.length === 1 && Math.abs(b.left + b.width - marginR) < tolR && b.left - marginL > (marginR - marginL) * 0.3) b.align = "right";
    if (b.align === "center") {
      const c = b.left + b.width / 2;
      const half = Math.max(b.width / 2, Math.min(c - marginL, marginR - c));
      b.left = c - half;
      b.width = 2 * half;
      b.firstIndent = b.restIndent = 0;
    } else if (b.align === "right") {
      const r = b.left + b.width;
      const nl = Math.min(b.left, marginL);
      b.firstIndent = b.restIndent = 0;
      b.left = nl;
      b.width = r - nl;
    } else if (b.align === "left") {
      // Grow to the right margin (pages usually have equal side margins), but stop before
      // text that sits to the right on the same lines (the other column, table cells).
      const col = all.filter((o) => o.raw === b.raw || Math.abs(o.left - b.left) < 6);
      const colRight = Math.max(...col.filter((o) => o.left < b.left + b.width).map((o) => o.left + o.width));
      const pageRight = Math.max(marginR, pageBounds[2] - (marginL - pageBounds[0]));
      const blockers = all.filter((o) => o !== b && o.left > b.left + b.width - 1 && o.bbox[1] < b.bbox[3] + b.lineHeight && o.bbox[3] > b.bbox[1] - b.lineHeight);
      const limit = blockers.length ? Math.min(...blockers.map((o) => o.left)) - 6 : pageRight;
      const slack = Math.max(...b.styles.map((x) => x.size)) * 0.15; // substitute widths can differ by a hair
      // a wrapped paragraph already shows where its margin is; a single line may grow
      const right = b.lines.length >= 2 ? Math.min(Math.max(b.left + b.width, colRight), limit) : Math.min(Math.max(colRight, pageRight), limit);
      b.width = Math.max(b.width, right - b.left) + slack;
    }
  }

  st.destroy();
  return { blocks, fonts, samples };
}

export interface FontSource {
  /** A bundled font by file name, or undefined if not loaded yet. */
  get(file: string): MuPDF.Font | undefined;
}

interface Plan {
  block: EditBlock;
  fontFor: MuPDF.Font[]; // per style index
  missingFiles: string[];
  substituted: boolean;
  runs: Run[];
}

function plan(page: MuPDF.PDFPage, blockId: number, runsIn: Run[], fonts: FontSource): Plan {
  const ex = extractBlocks(page);
  const block = ex.blocks[blockId];
  if (!block) throw new Error("That paragraph changed. Click it again.");
  if (!block.editable) throw new Error(block.reason ?? "This text can't be edited.");
  const runs = normalizeRuns(runsIn.map((r) => ({ text: r.text, style: Math.min(Math.max(0, r.style | 0), block.styles.length - 1) })));
  const byStyle = new Map<number, string>();
  for (const r of runs) byStyle.set(r.style, (byStyle.get(r.style) ?? "") + r.text);
  const fontFor: MuPDF.Font[] = [];
  const missing = new Set<string>();
  let substituted = false;
  block.styles.forEach((st, i) => {
    const text = byStyle.get(i) ?? "";
    // Always a bundled font: re-embedding a PDF's own (subset) font can draw the wrong
    // letters with some producers (codes shifted), so it isn't safe to reuse.
    const sub = fonts.get(st.file);
    if (!sub) {
      if (text.trim()) missing.add(st.file);
      return;
    }
    // only mention it when the replacement looks different (not for metric twins like Carlito for Calibri)
    if (text.trim() && !st.exact) substituted = true;
    fontFor[i] = sub;
  });
  return { block, fontFor, missingFiles: [...missing], substituted, runs };
}

/** Bundled font files needed to edit this paragraph with this text. */
export function fontsNeeded(page: MuPDF.PDFPage, blockId: number, runs: Run[], fonts: FontSource): string[] {
  return plan(page, blockId, runs, fonts).missingFiles;
}

/** Replace a paragraph's text. Call inside an undoable operation. */
export function replaceBlock(mupdf: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, blockId: number, runsIn: Run[], fonts: FontSource): EditResult {
  const p = plan(page, blockId, runsIn, fonts);
  if (p.missingFiles.length) throw new Error(`Font not loaded: ${p.missingFiles.join(", ")}`);
  const { block, fontFor, runs } = p;
  const warnings: string[] = [];

  const measure = (style: number, text: string) => {
    const f = fontFor[style];
    const size = block.styles[style].size;
    if (!f) return text.length * size * 0.5;
    let w = 0;
    for (const ch of text) {
      const gid = f.encodeCharacter(ch.codePointAt(0)!);
      w += gid ? f.advanceGlyph(gid) : 0.5;
    }
    return w * size;
  };
  const laid = layoutParagraph(runs, { width: block.width, align: block.align, measure, firstIndent: block.firstIndent, restIndent: block.restIndent });
  const nonEmpty = laid.some((l) => l.pieces.length);

  // 1) really remove the old glyphs (each line, trimmed vertically so neighbours survive)
  for (const ln of block.lines) {
    const [x0, y0, x1, y1] = ln.bbox;
    const h = y1 - y0;
    const a = page.createAnnotation("Redact");
    a.setRect([x0 - 0.5, y0 + h * 0.25, x1 + 0.5, y1 - h * 0.25]);
    a.update();
  }
  page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);

  // 2) draw the new text
  if (nonEmpty) {
    const pageObj = page.getObject();
    const res = ownResources(doc, pageObj);
    let fontDict = res.get("Font");
    if (!fontDict.isDictionary()) {
      fontDict = doc.newDictionary();
      res.put("Font", fontDict);
    }
    const names = new Map<MuPDF.Font, string>();
    const resName = (f: MuPDF.Font) => {
      let n = names.get(f);
      if (n) return n;
      let k = 1;
      while (!fontDict.get(`PapgiF${k}`).isNull()) k++;
      n = `PapgiF${k}`;
      fontDict.put(n, doc.addFont(f));
      names.set(f, n);
      return n;
    };
    const inv = mupdf.Matrix.invert(page.getTransform());
    const num = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(+v.toFixed(4)));
    let ops = "q\n";
    let missingGlyph = false;
    laid.forEach((line, i) => {
      const y = block.firstBaseline + i * block.lineHeight;
      for (const piece of line.pieces) {
        const st = block.styles[piece.style];
        const f = fontFor[piece.style];
        if (!f) continue;
        let hex = "";
        for (const ch of piece.text) {
          const gid = f.encodeCharacter(ch.codePointAt(0)!);
          if (!gid) missingGlyph = true;
          hex += gid.toString(16).padStart(4, "0");
        }
        const tm = mupdf.Matrix.concat([1, 0, 0, -1, block.left + piece.x, y], inv);
        ops += `BT /${resName(f)} ${num(st.size)} Tf ${st.color.map(num).join(" ")} rg ${tm.map(num).join(" ")} Tm <${hex}> Tj ET\n`;
      }
    });
    ops += "Q\n";
    appendContent(doc, pageObj, ops);
    if (missingGlyph) warnings.push("Some characters aren't available in the font and were left blank.");
  }

  if (p.substituted) warnings.push("papgi doesn't have this exact font, so the new text uses the closest match.");
  const oldLines = block.lines.length;
  const lastBaseline = block.firstBaseline + (laid.length - 1) * block.lineHeight;
  const oldBottom = block.lines[block.lines.length - 1]?.bbox[3] ?? block.bbox[3];
  const maxSize = Math.max(...block.styles.map((s) => s.size));
  const bottom = lastBaseline + maxSize * 0.3;
  const overflow = laid.length > oldLines && bottom > oldBottom + 0.5;
  if (overflow) warnings.push("The paragraph got longer than before, so it may overlap what's below it.");
  return {
    lines: laid.length,
    bbox: [block.left, block.bbox[1], block.left + block.width, Math.max(bottom, block.bbox[1])],
    overflow,
    warnings,
  };
}

/** The page's own Resources dictionary (copied from the parent if it was inherited). */
function ownResources(doc: MuPDF.PDFDocument, pageObj: MuPDF.PDFObject): MuPDF.PDFObject {
  const own = pageObj.get("Resources");
  if (own.isDictionary()) return own;
  const inherited = pageObj.getInheritable("Resources");
  const res = doc.newDictionary();
  if (inherited.isDictionary()) inherited.forEach((v, k) => res.put(k as string, v));
  pageObj.put("Resources", res);
  return pageObj.get("Resources");
}

/** Add drawing operators after the page's existing content (keeping its graphics state sealed off). */
function appendContent(doc: MuPDF.PDFDocument, pageObj: MuPDF.PDFObject, ops: string): void {
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
