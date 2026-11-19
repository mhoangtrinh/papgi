// Turn text-recognition output (pixels of a rendered page) into words in page space.
import type { Rect } from "./geometry";

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface TessWord {
  text: string;
  confidence: number;
  bbox: Box;
}
export interface TessLine {
  bbox: Box;
  baseline: Box; // x0,y0 -> x1,y1
  words: TessWord[];
}
export interface TessBlock {
  paragraphs: { lines: TessLine[] }[];
}

export interface PageWord {
  text: string;
  bbox: Rect;
  /** Baseline y at the word's left edge. */
  baseline: number;
  /** Slope of the baseline (dy/dx, y pointing down): the page's skew. */
  slope: number;
  /** Continues the line of the word before (not the first word, nor across a column gutter). */
  join?: boolean;
  /** Font size (em) in points, shared by all words of a line. */
  size: number;
}

/** Words worth keeping: real text, not specks read as punctuation. */
export function keepWord(w: TessWord): boolean {
  const t = w.text.trim();
  if (!t) return false;
  const hasLetter = /[\p{L}\p{N}]/u.test(t);
  if (!hasLetter) return w.confidence >= 60 && t.length <= 3; // e.g. "-", "§", "&"
  const chars = [...t];
  // a real word read with low confidence is still better than a hole in the text
  if (chars.length >= 3 && chars.filter((c) => /\p{L}/u.test(c)).length >= chars.length * 0.7) return true;
  return w.confidence >= (chars.length === 1 ? 50 : 25);
}

const ALNUM = /[\p{L}\p{N}]/u;
// letters reaching up to the ascender / cap height, and down to the descender
const TALL = /[A-Zbdfhkl0-9ÄÖÜß]/;
const DEEP = /[gjpqy,;()[\]{}|/]/;

/**
 * Size of the type on one line, from the word boxes (in pixels): words with tall letters and
 * nothing below the baseline span about 0.7 em; with descenders too about 0.92 em.
 */
function lineSize(words: TessWord[]): number {
  const med = (v: number[]) => (v.sort((a, b) => a - b), v[v.length >> 1]);
  const h = (w: TessWord) => w.bbox.y1 - w.bbox.y0;
  const asc = words.filter((w) => TALL.test(w.text) && !DEEP.test(w.text)).map(h);
  if (asc.length) return med(asc) / 0.7;
  const both = words.filter((w) => TALL.test(w.text) && DEEP.test(w.text)).map(h);
  if (both.length) return med(both) / 0.92;
  return Math.max(...words.map(h)) / 0.92;
}

/**
 * Map words from an image rendered at `scale` (px per point) of a page whose top-left
 * corner is (originX, originY) into page coordinates.
 *
 * Recognised lines can run across columns, so each line is cut at column gutters (gaps that are
 * white on the lines nearby too; a wide gap after a sentence is not). Every piece gets one font
 * size and one baseline; sizes close to the page's body size snap to it, so the lines of a
 * paragraph look alike and the editor can group them.
 */
export function wordsToPage(blocks: TessBlock[], scale: number, originX: number, originY: number): PageWord[] {
  const X = (px: number) => originX + px / scale;
  const Y = (px: number) => originY + px / scale;
  const lines: { line: TessLine; words: TessWord[]; size: number }[] = [];
  for (const b of blocks)
    for (const p of b.paragraphs)
      for (const l of p.lines) {
        let words = l.words.filter(keepWord).sort((a, b) => a.bbox.x0 - b.bbox.x0);
        if (!words.length) continue;
        const size = lineSize(words);
        // a lone symbol away from any word is a speck, not punctuation
        const near = (w: TessWord, o: TessWord | undefined) => !!o && Math.max(o.bbox.x0 - w.bbox.x1, w.bbox.x0 - o.bbox.x1) < size * 0.3;
        words = words.filter((w, i) => ALNUM.test(w.text) || near(w, words[i - 1]) || near(w, words[i + 1]));
        // an unsure word can come with a box that also covers noise next to it: at the start or end
        // of a line, trim it to the width its letters take on the rest of the line
        const sure = words.filter((w) => w.confidence >= 60 && w.text.length >= 2).map((w) => (w.bbox.x1 - w.bbox.x0) / [...w.text].length);
        if (sure.length >= 3) {
          sure.sort((a, b) => a - b);
          const perChar = sure[sure.length >> 1];
          words = words.map((w, i) => {
            const want = [...w.text].length * perChar;
            if (w.confidence >= 60 || w.bbox.x1 - w.bbox.x0 < want * 1.4) return w;
            if (i === 0) return { ...w, bbox: { ...w.bbox, x0: w.bbox.x1 - want } };
            if (i === words.length - 1) return { ...w, bbox: { ...w.bbox, x1: w.bbox.x0 + want } };
            return w;
          });
        }
        if (words.length) lines.push({ line: l, words, size });
      }

  const mid = (w: TessWord) => (w.bbox.y0 + w.bbox.y1) / 2;
  const isGutter = (li: number, a: TessWord, b: TessWord) => {
    const size = lines[li].size;
    const w = b.bbox.x0 - a.bbox.x1;
    if (w > size * 1.5) return true;
    if (w < size * 0.5) return false;
    const m0 = a.bbox.x1 + w * 0.3;
    const m1 = b.bbox.x0 - w * 0.3;
    const y = (mid(a) + mid(b)) / 2;
    let across = 0;
    let clear = 0;
    lines.forEach((o, oi) => {
      if (oi === li) return;
      const oy = (o.line.bbox.y0 + o.line.bbox.y1) / 2;
      const dy = Math.abs(oy - y);
      if (dy < size * 0.5 || dy > size * 6) return;
      if (o.words[0].bbox.x0 > m0 || o.words[o.words.length - 1].bbox.x1 < m1) return;
      across++;
      if (!o.words.some((x) => x.bbox.x1 > m0 && x.bbox.x0 < m1)) clear++;
    });
    if (across < 2) return w > size * 0.8;
    return clear >= 2 && clear >= across * 0.6;
  };

  interface Piece { words: TessWord[]; line: TessLine; size: number }
  const pieces: Piece[] = [];
  lines.forEach(({ line, words }, li) => {
    let cur: TessWord[] = [];
    const push = () => {
      // a piece of lone symbols or a stray letter is scanner noise
      const letters = cur.reduce((n, w) => n + [...w.text].filter((c) => ALNUM.test(c)).length, 0);
      if (letters >= 2 || (letters === 1 && cur.some((w) => w.confidence >= 90 && /\p{N}/u.test(w.text))))
        pieces.push({ words: cur, line, size: lineSize(cur) });
      cur = [];
    };
    for (const w of words) {
      const prev = cur[cur.length - 1];
      if (prev && isGutter(li, prev, w)) push();
      cur.push(w);
    }
    if (cur.length) push();
  });

  // body size of the page: the size most characters are set in
  const bySize = pieces.map((p) => ({ s: p.size, n: p.words.reduce((n, w) => n + w.text.length, 0) })).sort((a, b) => a.s - b.s);
  const total = bySize.reduce((n, x) => n + x.n, 0);
  let acc = 0;
  const body = bySize.find((x) => (acc += x.n) >= total / 2)?.s ?? 0;
  // the page's skew: all lines run at about the same slope
  const slopes = lines
    .map((l) => l.line.baseline)
    .filter((b) => b.x1 - b.x0 > 50)
    .map((b) => (b.y1 - b.y0) / (b.x1 - b.x0))
    .sort((a, b) => a - b);
  const slope = slopes[slopes.length >> 1] ?? 0;
  const pick = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];

  const out: PageWord[] = [];
  for (const pc of pieces) {
    // short pieces ("(CTAT).") give a rough size: let them snap from further away
    const letters = pc.words.reduce((n, w) => n + w.text.length, 0);
    const size = body && Math.abs(pc.size - body) < body * (letters < 8 ? 0.45 : 0.15) ? body : pc.size;
    // one baseline at the page's slope, through the bottoms of the words without descenders
    const cx = (w: TessWord) => (w.bbox.x0 + w.bbox.x1) / 2;
    const at = (x: number) => x * slope;
    const bl = pc.line.baseline;
    const flat = pc.words.filter((w) => !DEEP.test(w.text)).map((w) => w.bbox.y1 - at(cx(w)));
    const tess = pc.words.map((w) => bl.y0 + (cx(w) - bl.x0) * ((bl.y1 - bl.y0) / Math.max(1, bl.x1 - bl.x0)) - at(cx(w)));
    // without such words: the bottoms of descenders, parentheses and commas sit about 0.22 em lower
    const deep = pc.words.map((w) => w.bbox.y1 - size * 0.22 - at(cx(w)));
    const t = pick(tess);
    const off = flat.length ? pick(flat) : Math.abs(t - pick(deep)) < size * 0.15 ? t : pick(deep);
    pc.words.forEach((w, i) =>
      out.push({
        join: i > 0,
        text: w.text.trim(),
        bbox: [X(w.bbox.x0), Y(w.bbox.y0), X(w.bbox.x1), Y(w.bbox.y1)],
        baseline: Y(off + at(w.bbox.x0)),
        slope,
        size: Math.max(size, 1) / scale,
      }),
    );
  }
  return out;
}

/** Render scale for recognition: about 300 dpi, but never a huge image. */
export function ocrScale(w: number, h: number, maxSide = 3500): number {
  return Math.min(300 / 72, maxSide / Math.max(w, h));
}
