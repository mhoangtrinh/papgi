// Table of contents from headings, for PDFs without bookmarks (pure).

/** One line of text on a page, as the engine reports it. */
export interface TextLine {
  page: number;
  y: number; // top, page space
  size: number; // font size (points)
  bold: boolean;
  text: string;
  block: number; // block number on its page
  first: boolean; // the first line of its block
  lines: number; // lines in its block
}

export interface TocItem {
  title: string;
  page: number;
  y: number | null;
  level: number; // 0 = top
}

const NUMBERED = /^(\d{1,2}(\.\d{1,2}){0,3}\.?|[A-Z]\.|[IVXLC]{1,5}\.|(Chapter|Kapitel|Section|Abschnitt|Part|Teil|Appendix|Anhang)\s+\w+)\s+\S/;

const SECTION_WORDS = /^(abstract|summary|introduction|contents|table of contents|preface|foreword|overview|background|zusammenfassung|einleitung|inhalt|inhaltsverzeichnis|vorwort|kurzfassung|tóm tắt|giới thiệu|mục lục)\b/i;

const roundSize = (s: number) => Math.round(s * 2) / 2;

/** The size most text is set in (weighted by length). */
export function bodySize(lines: TextLine[]): number {
  const w = new Map<number, number>();
  for (const l of lines) w.set(roundSize(l.size), (w.get(roundSize(l.size)) ?? 0) + l.text.length);
  let best = 0;
  let bestW = -1;
  for (const [s, n] of w) if (n > bestW) [best, bestW] = [s, n];
  return best || 10;
}

/**
 * Text repeated on many pages (running headers and footers): the same text, or (for text
 * no bigger than the body) the same text apart from numbers ("Page 3", "Report · 3").
 */
function furniture(lines: TextLine[], pageCount: number): { same: Set<string>; pattern: Set<string> } {
  const min = Math.max(3, Math.ceil(pageCount * 0.3));
  const count = (k: (t: string) => string) => {
    const pages = new Map<string, Set<number>>();
    for (const l of lines) {
      const kk = k(l.text);
      if (!pages.has(kk)) pages.set(kk, new Set());
      pages.get(kk)!.add(l.page);
    }
    return new Set([...pages].filter(([, p]) => p.size >= min).map(([kk]) => kk));
  };
  return { same: count(exact), pattern: count(key) };
}

const exact = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
const key = (t: string) => exact(t).replace(/\d+/g, "#");

/**
 * Pick the headings: lines clearly bigger than the body text, short bold lines that stand
 * alone, and numbered headings ("2.3 Results"). Levels follow the sizes (bigger = higher).
 */
export function headingsToc(all: TextLine[], pageCount: number): TocItem[] {
  const lines = all.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
  if (!lines.length) return [];
  const body = bodySize(lines);
  const skip = furniture(lines, pageCount);
  const isHeading = (l: TextLine) => {
    const t = l.text;
    if (t.length < 2 || t.length > 120 || !/\p{L}/u.test(t)) return false;
    // (numbered headings in the same pattern on many pages are chapters, not a running header)
    if (skip.same.has(exact(t)) || (skip.pattern.has(key(t)) && l.size <= body * 1.15)) return false;
    if (/^(page|seite)\s+\d+(\s+(of|von)\s+\d+)?$/i.test(t)) return false;
    if (l.lines > 4) return false; // a paragraph, however big
    const sentence = /[.,;:]$/.test(t) && !NUMBERED.test(t);
    if (l.size >= body * 1.18) return !sentence || t.length < 60;
    if (sentence || t.length > 90 || l.lines > 2) return false;
    if (l.bold && l.size >= body * 0.97 && l.first) return true;
    return NUMBERED.test(t) && (l.bold || l.size > body * 1.05);
  };
  let cands = lines.filter(isHeading);
  // a row of bold labels at the same height is a table's header, not headings
  const row = (l: TextLine) => `${l.page}:${Math.round(l.y / 3)}`;
  const perRow = new Map<string, number>();
  for (const l of cands) perRow.set(row(l), (perRow.get(row(l)) ?? 0) + 1);
  cands = cands.filter((l) => (perRow.get(row(l)) ?? 0) < 3);
  // join the lines of a heading set over two lines
  const picked: { line: TextLine; title: string; last: TextLine }[] = [];
  for (const l of cands) {
    const prev = picked[picked.length - 1];
    if (
      prev && prev.last.page === l.page && Math.abs(prev.last.size - l.size) < 0.6 && !NUMBERED.test(l.text) &&
      (prev.last.block === l.block || (l.y > prev.last.y && l.y - prev.last.y < l.size * 1.6))
    ) {
      prev.title += " " + l.text;
      prev.last = l;
      continue;
    }
    picked.push({ line: l, title: l.text, last: l });
  }
  // (a line starting in lower case only continues a heading)
  for (let i = picked.length - 1; i >= 0; i--) if (/^\p{Ll}/u.test(picked[i].title)) picked.splice(i, 1);
  if (picked.length < 2) return [];
  // front matter: between the title and the first real section on page 1 (authors, dates...)
  const firstReal = picked.findIndex((p) => /^(\d{1,2}(\.\d{1,2}){0,3}\.?|[IVXLC]{1,5}\.)\s+\S/.test(p.title) || SECTION_WORDS.test(p.title) || p.line.page > 0);
  if (firstReal > 1) picked.splice(1, firstReal - 1);
  // levels: one per heading size, biggest first (at most 3)
  let sizes = [...new Set(picked.map((p) => roundSize(p.line.size)))].sort((a, b) => b - a);
  // a lone biggest heading on the first page is the document's title: it doesn't make a level
  const lone = picked.filter((p) => roundSize(p.line.size) === sizes[0]);
  const title = sizes.length > 1 && lone.length === 1 && lone[0].line.page === 0 ? lone[0] : null;
  if (title) sizes = sizes.slice(1);
  const levelOf = (p: (typeof picked)[number]) => {
    if (p === title) return 0;
    const i = sizes.findIndex((s) => roundSize(p.line.size) >= s);
    return Math.min(i < 0 ? sizes.length - 1 : i, 2);
  };
  let items: TocItem[] = picked.map((p) => ({ title: p.title, page: p.line.page, y: p.line.y, level: levelOf(p) }));
  // all the same size but numbered: the numbering tells the level
  if (new Set(items.map((i) => i.level)).size === 1) {
    items = items.map((it) => {
      const m = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s/.exec(it.title);
      return m ? { ...it, level: Math.min(m[1].split(".").length - 1, 2) } : it;
    });
  }
  // far too many: drop the lowest level until it reads like a table of contents
  const max = Math.max(60, pageCount * 8);
  while (items.length > max) {
    const low = Math.max(...items.map((i) => i.level));
    if (low === 0) break;
    items = items.filter((i) => i.level < low);
  }
  return items.length >= 2 ? items : [];
}

/**
 * Index of the item for a reading position: going through the items in reading order,
 * the last one before the first that comes after the position (on a page with two
 * columns, a heading at the top of the right column hasn't been reached yet).
 */
export function currentItem(items: TocItem[], page: number, y = Infinity): number {
  let cur = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.page > page || (it.page === page && (it.y ?? 0) > y)) break;
    cur = i;
  }
  return cur;
}
