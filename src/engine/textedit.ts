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

/** MuPDF sometimes splits one visual line into several (big gaps); join lines on the same baseline. */
function mergeLines(lines: RawLine[]): RawLine[] {
  const out: RawLine[] = [];
  const base = (l: RawLine) => {
    const cs = l.chars.filter((c) => !/\s/.test(c.c));
    return cs.length ? median(cs.map((c) => c.origin[1])) : (l.bbox[1] + l.bbox[3]) / 2;
  };
  for (const l of lines) {
    const prev = out[out.length - 1];
    const size = Math.max(1, ...l.chars.map((c) => c.size));
    if (prev && prev.wmode === l.wmode && Math.abs(base(prev) - base(l)) < size * 0.3 && l.bbox[0] >= prev.bbox[0] - 1) {
      // keep reading order left to right, with a space between the pieces
      const gap = l.bbox[0] - prev.bbox[2];
      const sp = prev.chars[prev.chars.length - 1];
      if (sp && gap > 0.5 && !/\s/.test(sp.c) && !/\s/.test(l.chars[0]?.c ?? " ")) prev.chars.push({ ...sp, c: " " });
      prev.chars.push(...l.chars);
      prev.bbox = [Math.min(prev.bbox[0], l.bbox[0]), Math.min(prev.bbox[1], l.bbox[1]), Math.max(prev.bbox[2], l.bbox[2]), Math.max(prev.bbox[3], l.bbox[3])];
    } else out.push({ ...l, chars: l.chars.slice() });
  }
  return out;
}

export function extractBlocks(page: MuPDF.PDFPage): Extracted {
  const st = page.toStructuredText("preserve-whitespace");
  const raw = walk(st).map((b) => ({ ...b, lines: mergeLines(b.lines) }));
  const fonts = new Map<string, MuPDF.Font>();
  const samples = new Map<string, { c: string; w: number; size: number }[]>();
  const pageBounds = page.getBounds();
  const pageCenter = (pageBounds[0] + pageBounds[2]) / 2;

  const blocks: EditBlock[] = raw.map((rb, id) => {
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
        });
        styleIndex.set(key, i);
      }
      return i;
    };

    const runs: Run[] = [];
    const lines: EditLine[] = [];
    let editable = true;
    let reason: string | undefined;
    let math = false;
    let shifted = false;

    rb.lines.forEach((ln, li) => {
      if (ln.wmode !== 0 || Math.abs(ln.dir[0] - 1) > 0.02 || Math.abs(ln.dir[1]) > 0.02) {
        editable = false;
        reason = "Rotated or vertical text can't be edited yet.";
      }
      const chars = ln.chars;
      // trim surrounding whitespace of the line
      let s = 0;
      let e = chars.length - 1;
      while (s <= e && /\s/.test(chars[s].c)) s++;
      while (e >= s && /\s/.test(chars[e].c)) e--;
      const used = chars.slice(s, e + 1);
      if (!used.length) return;
      const sizes = used.map((c) => c.size);
      const main = Math.max(...sizes);
      const baseline = median(used.filter((c) => c.size >= main - 0.01).map((c) => c.origin[1]));
      lines.push({ bbox: ln.bbox, baseline });
      for (const ch of used) {
        const name = ch.font.getName();
        if (MATH_FONT.test(name)) math = true;
        if (Math.abs(ch.origin[1] - baseline) > ch.size * 0.15) shifted = true;
        if (!fonts.has(name)) fonts.set(name, ch.font);
        if (!/\s/.test(ch.c)) {
          const list = samples.get(name) ?? [];
          if (list.length < 40) list.push({ c: ch.c, w: Math.abs(ch.quad[2] - ch.quad[0]), size: ch.size });
          samples.set(name, list);
        }
      }
      // join with the previous line: drop a soft hyphen, otherwise add a space
      if (li > 0 && runs.length) {
        const prev = runs[runs.length - 1];
        const first = used[0].c;
        // "achiev-" + "able" was hyphenated by the typesetter; "analog-to-" + "digital" keeps its hyphen
        const word = /\S*$/.exec(prev.text)?.[0] ?? "";
        if (word.endsWith("-") && /\p{L}/u.test(first)) {
          // hyphen at the line end: a typesetter's break inside a word is removed, a compound's hyphen stays
          if (/\p{Ll}/u.test(first) && !word.slice(0, -1).includes("-") && /\p{L}{2}-$/u.test(word)) prev.text = prev.text.slice(0, -1);
        } else runs.push({ text: " ", style: prev.style });
      }
      for (const ch of used) {
        const st = styleOf(ch);
        const last = runs[runs.length - 1];
        if (last && last.style === st) last.text += ch.c;
        else runs.push({ text: ch.c, style: st });
      }
    });

    const nonEmpty = lines.length > 0;
    const lefts = rb.lines.map((l) => l.bbox[0]);
    const rights = rb.lines.map((l) => l.bbox[2]);
    const left = nonEmpty ? Math.min(...lefts) : rb.bbox[0];
    const right = nonEmpty ? Math.max(...rights) : rb.bbox[2];
    const mainSize = styles.length ? Math.max(...styles.map((s) => s.size)) : 10;
    const gaps = lines.slice(1).map((l, i) => l.baseline - lines[i].baseline).filter((g) => g > 0);
    const lineHeight = gaps.length ? median(gaps) : mainSize * 1.2;

    // alignment from the line edges (last line excluded)
    let align: Align = "left";
    const tol = Math.max(1.5, mainSize * 0.2);
    if (lines.length >= 2) {
      const body = rb.lines.slice(0, -1);
      const fullL = body.filter((l) => Math.abs(l.bbox[0] - left) < tol).length / body.length;
      const fullR = body.filter((l) => Math.abs(l.bbox[2] - right) < tol).length / body.length;
      const centre = (left + right) / 2;
      const centred = rb.lines.every((l) => Math.abs((l.bbox[0] + l.bbox[2]) / 2 - centre) < tol);
      if (fullL >= 0.7 && fullR >= 0.7) align = "justify";
      else if (centred && fullL < 0.7) align = "center";
      else if (fullR >= 0.9 && fullL < 0.5) align = "right";
    } else if (nonEmpty && Math.abs((left + right) / 2 - pageCenter) < 3 && right - left < (pageBounds[2] - pageBounds[0]) * 0.8) {
      align = "center";
    }

    if (!nonEmpty) {
      editable = false;
      reason = "No text here.";
    }

    return {
      id,
      bbox: rb.bbox,
      lines,
      runs: normalizeRuns(runs),
      styles,
      align,
      lineHeight,
      firstBaseline: lines[0]?.baseline ?? rb.bbox[3],
      left,
      width: right - left,
      editable,
      reason,
      warn: math || shifted ? "This paragraph has formulas or sub/superscripts. Editing puts all text on one baseline in plain style." : undefined,
    };
  });

  // Room to grow: a short or single line may use the column width it sits in.
  const marginL = Math.min(...blocks.filter((b) => b.lines.length).map((b) => b.left), pageBounds[2]);
  const marginR = Math.max(...blocks.filter((b) => b.lines.length).map((b) => b.left + b.width), pageBounds[0]);
  for (const b of blocks) {
    if (!b.lines.length) continue;
    if (b.align === "center") {
      const c = b.left + b.width / 2;
      const half = Math.max(b.width / 2, Math.min(c - marginL, marginR - c));
      b.left = c - half;
      b.width = 2 * half;
    } else if (b.align === "right") {
      const r = b.left + b.width;
      b.left = Math.min(b.left, marginL);
      b.width = r - b.left;
    } else if (b.align === "left") {
      // same column = other blocks starting at the same x
      const col = blocks.filter((o) => o.lines.length && Math.abs(o.left - b.left) < 6);
      const colRight = Math.max(...col.map((o) => o.left + o.width));
      b.width = Math.max(b.width, colRight - b.left);
    }
  }

  st.destroy();
  return { blocks, fonts, samples };
}

/** Does the font's advance width match how the glyphs are actually laid out in the PDF? */
function fontTrusted(font: MuPDF.Font, samples: { c: string; w: number; size: number }[]): boolean {
  if (!samples.length) return true;
  let ok = 0;
  let n = 0;
  for (const s of samples) {
    const gid = font.encodeCharacter(s.c.codePointAt(0)!);
    if (!gid) continue;
    n++;
    const w = font.advanceGlyph(gid) * s.size;
    if (Math.abs(w - s.w) <= Math.max(0.6, s.w * 0.15)) ok++;
  }
  return n > 0 && ok / n >= 0.8;
}

function covers(font: MuPDF.Font, text: string): boolean {
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (!font.encodeCharacter(ch.codePointAt(0)!)) return false;
  }
  return true;
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
    const orig = ex.fonts.get(st.font);
    if (orig && covers(orig, text) && fontTrusted(orig, ex.samples.get(st.font) ?? [])) {
      fontFor[i] = orig;
      return;
    }
    const sub = fonts.get(st.file);
    if (!sub) {
      if (text.trim()) missing.add(st.file);
      return;
    }
    // Latin Modern is the same design as the TeX fonts it replaces, so that's not worth a mention
    if (text.trim() && !st.file.startsWith("lm")) substituted = true;
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
  const laid = layoutParagraph(runs, { width: block.width, align: block.align, measure });
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

  if (p.substituted) warnings.push("The original font doesn't contain all the letters you typed, so papgi used the closest matching font.");
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
