// Line breaking for edited paragraphs: styled runs in, positioned words out.
// Pure (the caller supplies text measurement), so it is unit-tested.

export interface Run {
  text: string;
  style: number;
}

export type Align = "left" | "justify" | "center" | "right";

export interface LayoutOptions {
  width: number;
  align: Align;
  /** Offset of the first line of each paragraph (after a hard break), e.g. a paragraph indent. */
  firstIndent?: number;
  /** Offset of the other lines, e.g. the hanging indent of a list item. */
  restIndent?: number;
  /** Width of `text` drawn in `style`. */
  measure: (style: number, text: string) => number;
}

export interface Piece {
  x: number; // from the left edge of the paragraph
  text: string;
  style: number;
}

export interface Line {
  pieces: Piece[];
  width: number; // natural width (before justification)
  /** True when this line ends a paragraph (hard break or end of text). */
  last: boolean;
}

interface Seg {
  text: string;
  style: number;
}

type Token = { kind: "word"; segs: Seg[] } | { kind: "space"; style: number } | { kind: "break" } | { kind: "join" };

/** Split runs into words (which may span several styles), spaces and hard breaks. */
export function tokenize(runs: Run[]): Token[] {
  const out: Token[] = [];
  let word: Seg[] | null = null;
  const flush = () => {
    if (word && word.length) out.push({ kind: "word", segs: word });
    word = null;
  };
  for (const r of runs) {
    for (const ch of r.text.replace(/\r\n?/g, "\n")) {
      if (ch === "\n") {
        flush();
        out.push({ kind: "break" });
      } else if (ch === " " || ch === "\t" || ch === " ") {
        flush();
        out.push({ kind: "space", style: r.style });
      } else {
        word ??= [];
        const last = word[word.length - 1];
        if (last && last.style === r.style) last.text += ch;
        else word.push({ text: ch, style: r.style });
        // a line may also break after a hyphen inside a word ("full-|scale")
        if ((ch === "-" || ch === "\u2010") && word.map((s) => s.text).join("").length > 1) {
          flush();
          out.push({ kind: "join" });
        }
      }
    }
  }
  flush();
  return out;
}

export function layoutParagraph(runs: Run[], o: LayoutOptions): Line[] {
  const tokens = tokenize(runs);
  const lines: Line[] = [];
  const wordWidth = (segs: Seg[]) => segs.reduce((w, s) => w + o.measure(s.style, s.text), 0);

  // Each line: list of words with the space width that precedes them.
  type W = { segs: Seg[]; width: number; spaceBefore: number; joined: boolean };
  let cur: W[] = [];
  let curWidth = 0;
  let pendingSpace = 0;
  let pendingSpaceCount = 0;
  let pendingJoin = false;

  // first line of a paragraph = the first line, or a line right after a hard break
  let firstOfPara = true;
  const indent = () => (firstOfPara ? (o.firstIndent ?? 0) : (o.restIndent ?? 0));
  const avail = () => Math.max(1, o.width - indent());
  const finish = (last: boolean) => {
    lines.push(place(cur, curWidth, last));
    firstOfPara = last;
    cur = [];
    curWidth = 0;
    pendingSpace = 0;
    pendingSpaceCount = 0;
    pendingJoin = false;
  };

  const place = (words: W[], natural: number, last: boolean): Line => {
    const gaps = words.filter((w, i) => i > 0 && !w.joined).length;
    const width = avail();
    let extra = 0;
    let offset = indent();
    if (o.align === "justify" && !last && gaps > 0) extra = Math.max(0, (width - natural) / gaps);
    else if (o.align === "center") offset += Math.max(0, (width - natural) / 2);
    else if (o.align === "right") offset += Math.max(0, width - natural);
    const pieces: Piece[] = [];
    let x = offset;
    words.forEach((w, i) => {
      if (i > 0) x += w.spaceBefore + (w.joined ? 0 : extra);
      for (const s of w.segs) {
        pieces.push({ x, text: s.text, style: s.style });
        x += o.measure(s.style, s.text);
      }
    });
    return { pieces, width: natural, last };
  };

  const pushWord = (segs: Seg[]) => {
    const w = wordWidth(segs);
    const joined = cur.length > 0 && pendingJoin && pendingSpaceCount === 0;
    const space = cur.length && !joined ? pendingSpace : 0;
    if (cur.length && curWidth + space + w > avail() + 0.01) {
      finish(false);
      return pushWord(segs);
    }
    if (!cur.length && w > avail() + 0.01) {
      // a single word longer than the line: break it by characters
      const [head, tail] = splitToFit(segs, avail(), o.measure);
      if (!tail.length) {
        cur.push({ segs, width: w, spaceBefore: 0, joined: false });
        curWidth = w;
        return;
      }
      cur.push({ segs: head, width: wordWidth(head), spaceBefore: 0, joined: false });
      curWidth = wordWidth(head);
      finish(false);
      return pushWord(tail);
    }
    cur.push({ segs, width: w, spaceBefore: space, joined });
    curWidth += space + w;
    pendingSpace = 0;
    pendingSpaceCount = 0;
    pendingJoin = false;
  };

  for (const t of tokens) {
    if (t.kind === "break") finish(true);
    else if (t.kind === "join") pendingJoin = true;
    else if (t.kind === "space") {
      // collapse runs of spaces to one (like the original layout)
      if (pendingSpaceCount === 0) pendingSpace = o.measure(t.style, " ");
      pendingSpaceCount++;
    } else pushWord(t.segs);
  }
  if (cur.length || lines.length === 0 || tokens[tokens.length - 1]?.kind === "break") finish(true);
  return lines;
}

function splitToFit(segs: Seg[], width: number, measure: LayoutOptions["measure"]): [Seg[], Seg[]] {
  const head: Seg[] = [];
  let w = 0;
  const chars: Seg[] = segs.flatMap((s) => [...s.text].map((c) => ({ text: c, style: s.style })));
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = measure(chars[i].style, chars[i].text);
    if (i > 0 && w + cw > width) break;
    w += cw;
    const last = head[head.length - 1];
    if (last && last.style === chars[i].style) last.text += chars[i].text;
    else head.push({ ...chars[i] });
  }
  const tail: Seg[] = [];
  for (; i < chars.length; i++) {
    const last = tail[tail.length - 1];
    if (last && last.style === chars[i].style) last.text += chars[i].text;
    else tail.push({ ...chars[i] });
  }
  return [head, tail];
}

/** Text of runs, for "did anything change?" checks. */
export function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

/** Merge neighbouring runs with the same style and drop empty ones. */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && last.style === r.style) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}
