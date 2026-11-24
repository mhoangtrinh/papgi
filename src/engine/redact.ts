// Removing parts of a page goes through MuPDF's redaction, which rewrites the page's
// content. MuPDF 1.28 forgets the line width (and joins, caps, miter limit) for text that is
// drawn with an outline ("2 Tr"): many PDFs make a bold look that way (a thin outline around
// ordinary letters), and after the rewrite those letters got a 1 pt outline: much too bold.
// (Fixed in MuPDF after 1.28.6.) Workaround: before the rewrite, such settings are turned
// into graphics-state resources ("/Name gs"), which MuPDF always keeps where they are.
import type * as MuPDF from "mupdf";

type M = typeof MuPDF;

/** Operators whose one number becomes an ExtGState entry. */
const STROKE_OPS: Record<string, string> = { w: "LW", J: "LC", j: "LJ", M: "ML" };
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const isSpace = (c: string) => c === " " || c === "\n" || c === "\r" || c === "\t" || c === "\f" || c === "\0";

interface Tok {
  start: number;
  end: number;
  kind: "num" | "op" | "other";
  text: string;
}

/** The tokens of a content stream (strings, names, arrays and inline pictures are skipped over). */
export function* tokens(s: string): Generator<Tok> {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (isSpace(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (c === "(") {
      let depth = 0;
      for (; i < n; i++) {
        if (s[i] === "\\") i++;
        else if (s[i] === "(") depth++;
        else if (s[i] === ")" && --depth === 0) break;
      }
      i++;
      yield { start, end: i, kind: "other", text: "" };
      continue;
    }
    if (c === "<" && s[i + 1] !== "<") {
      while (i < n && s[i] !== ">") i++;
      i++;
      yield { start, end: i, kind: "other", text: "" };
      continue;
    }
    if (c === "<" || c === ">" || c === "[" || c === "]" || c === "{" || c === "}") {
      i += c === "<" || c === ">" ? 2 : 1;
      yield { start, end: i, kind: "other", text: c };
      continue;
    }
    if (c === "/") {
      i++;
      while (i < n && !isSpace(s[i]) && !DELIM.has(s[i])) i++;
      yield { start, end: i, kind: "other", text: s.slice(start, i) };
      continue;
    }
    while (i < n && !isSpace(s[i]) && !DELIM.has(s[i])) i++;
    if (i === start) {
      i++;
      continue;
    }
    const text = s.slice(start, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) {
      yield { start, end: i, kind: "num", text };
      continue;
    }
    yield { start, end: i, kind: "op", text };
    if (text === "ID") {
      // an inline picture: its bytes run until "EI" on its own
      i++;
      const m = /\sEI(?=[\s]|$)/g;
      m.lastIndex = i;
      const found = m.exec(s);
      i = found ? found.index + 3 : n;
    }
  }
}

/** Does this content draw text with an outline (render modes 1, 2, 5, 6)? */
export function strokesText(s: string): boolean {
  let last: Tok | null = null;
  for (const t of tokens(s)) {
    if (t.kind === "op" && t.text === "Tr" && last?.kind === "num" && [1, 2, 5, 6].includes(Number(last.text))) return true;
    last = t;
  }
  return false;
}

/**
 * Turn "0.3 w" (and J, j, M) into "/Name gs". `name(key, value)` gives the resource name
 * of an ExtGState that sets it. Returns null when there's nothing to change.
 */
export function strokeOpsToGs(s: string, name: (key: string, value: number) => string): string | null {
  const parts: string[] = [];
  let at = 0;
  let prev: Tok | null = null;
  let operands = 0;
  for (const t of tokens(s)) {
    if (t.kind === "op") {
      const key = STROKE_OPS[t.text];
      if (key && operands === 1 && prev?.kind === "num") {
        parts.push(s.slice(at, prev.start), `/${name(key, Number(prev.text))} gs`);
        at = t.end;
      }
      operands = 0;
    } else operands++;
    prev = t;
  }
  if (!parts.length) return null;
  parts.push(s.slice(at));
  return parts.join("");
}

const latin1 = (b: Uint8Array) => {
  let out = "";
  for (let i = 0; i < b.length; i += 8192) out += String.fromCharCode(...b.subarray(i, i + 8192));
  return out;
};
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

/** Make outlined text keep its outline width through MuPDF's rewrite of this page. */
export function protectTextStroke(page: MuPDF.PDFPage): void {
  const doc = page._doc;
  const seen = new Set<number>();
  const fix = (content: string, res: MuPDF.PDFObject): string | null => {
    if (!strokesText(content) || !res.isDictionary()) return null;
    if (!res.get("ExtGState").isDictionary()) res.put("ExtGState", doc.newDictionary());
    const gs = res.get("ExtGState");
    const made = new Map<string, string>();
    return strokeOpsToGs(content, (key, value) => {
      const id = `${key}:${value}`;
      let nm = made.get(id);
      if (!nm) {
        let k = made.size + 1;
        while (!gs.get(`papgiS${k}`).isNull()) k++;
        nm = `papgiS${k}`;
        gs.put(nm, doc.addObject({ Type: doc.newName("ExtGState"), [key]: key === "LC" || key === "LJ" ? Math.round(value) : value }));
        made.set(id, nm);
      }
      return nm;
    });
  };
  // the forms (XObjects) the page uses, and theirs
  const forms = (res: MuPDF.PDFObject, depth: number) => {
    const xo = res.isDictionary() ? res.get("XObject") : null;
    if (!xo?.isDictionary() || depth > 8) return;
    xo.forEach((f) => {
      if (!f.isStream() || !f.get("Subtype").isName() || f.get("Subtype").asName() !== "Form") return;
      const num = f.isIndirect() ? f.asIndirect() : -1;
      if (seen.has(num)) return;
      seen.add(num);
      const fres = f.get("Resources");
      try {
        const out = fix(latin1(f.readStream().asUint8Array()), fres);
        if (out !== null) f.writeStream(bytes(out));
      } catch {
        /* (left as it is) */
      }
      forms(fres, depth + 1);
    });
  };
  const po = page.getObject();
  const res = po.getInheritable("Resources");
  const contents = po.get("Contents");
  const streams: MuPDF.PDFObject[] = contents.isArray() ? [...Array(contents.length).keys()].map((i) => contents.get(i)) : contents.isStream() ? [contents] : [];
  if (streams.length) {
    try {
      // (the page's streams are one content, in order)
      const out = fix(streams.map((st) => latin1(st.readStream().asUint8Array())).join("\n"), res);
      if (out !== null) po.put("Contents", doc.addStream(bytes(out), {}));
    } catch {
      /* (left as it is) */
    }
  }
  forms(res, 0);
}

/** MuPDF's redaction of the page's redact annotations, keeping outlined text as it was. */
export function applyRedactions(m: M, page: MuPDF.PDFPage, image: number, lineArt: number, text: number): void {
  protectTextStroke(page);
  page.applyRedactions(false, image, lineArt, text);
  void m;
}
