// In-place editor for one paragraph of existing PDF text. It shows the paragraph in
// (nearly) the same font, size, colour and line spacing, keeps each run's style while
// you type, and hands back styled runs for the engine to lay out and write into the PDF.
import type { EditBlock, PageInfo } from "../engine/engine";
import type { StyleVariant } from "../engine/textedit";
import type { Run } from "../core/textlayout";
import { normalizeRuns } from "../core/textlayout";
import { styleVariant } from "../core/fontmatch";

const loaded = new Map<string, Promise<void>>();

/** Load a bundled font as a web font so the editor looks like the page. */
export function loadEditorFont(base: string, family: string, file: string, bold: boolean, italic: boolean): Promise<void> {
  const key = `${family}|${file}`;
  let p = loaded.get(key);
  if (!p) {
    const face = new FontFace(family, `url(${new URL(file, base).href})`, { weight: bold ? "700" : "400", style: italic ? "italic" : "normal" });
    p = face.load().then((f) => void document.fonts.add(f)).catch(() => {});
    loaded.set(key, p);
  }
  return p;
}

const rgbCss = (c: [number, number, number]) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;

/** Placeholder that holds the style for what's typed next (Bold / Italic with nothing selected). */
const HOLD = "\u200B";

export class ParagraphEditor {
  readonly el: HTMLDivElement;
  private original: string;
  /** (a copy: bold / italic add styles to it while editing) */
  readonly block: EditBlock;
  /** The paragraph's own styles; the ones after them are bold / italic variants. */
  private readonly own: number;
  private readonly variantList: StyleVariant[] = [];
  private readonly variantAt = new Map<string, number>();

  constructor(
    readonly page: number,
    blockIn: EditBlock,
    info: PageInfo,
    private fontBase: string,
    private onDone: (commit: boolean) => void,
    private onStyle: () => void = () => {},
  ) {
    const block = (this.block = { ...blockIn, styles: [...blockIn.styles] });
    this.own = block.styles.length;
    const b = block;
    const top = Math.min(...b.lines.map((l) => l.bbox[1]));
    const bottom = Math.max(...b.lines.map((l) => l.bbox[3]));
    const el = document.createElement("div");
    el.className = "para-editor";
    el.contentEditable = "true";
    el.spellcheck = true;
    el.setAttribute("role", "textbox");
    el.setAttribute("aria-multiline", "true");
    el.setAttribute("aria-label", "Edit text");
    el.style.left = `${((b.left - info.x) / info.w) * 100}%`;
    el.style.top = `${((top - info.y) / info.h) * 100}%`;
    el.style.width = `${(b.width / info.w) * 100}%`;
    el.style.minHeight = `${((bottom - top) / info.h) * 100}%`;
    el.style.setProperty("--lh", String(b.lineHeight));
    // line boxes centred on the original baselines: shift so the first baseline matches
    const main = Math.max(...b.styles.map((s) => s.size));
    el.style.setProperty("--pad-top", String(Math.max(0, b.firstBaseline - top - main * 0.8 - (b.lineHeight - main) / 2)));
    el.style.textAlign = b.align;
    const first = b.styles[b.runs[0]?.style ?? 0];
    if (first) {
      el.style.fontFamily = first.css;
      el.style.setProperty("--fs", String(first.size));
    }

    for (const r of b.runs) el.append(this.span(r.style, r.text));
    for (const st of b.styles) void loadEditorFont(fontBase, st.family, st.file, st.bold, st.italic);

    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.onDone(false);
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.onDone(true);
      } else if (e.key === "Enter") {
        // a plain line break, not a new <div>
        e.preventDefault();
        document.execCommand("insertText", false, "\n");
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "b" || e.key.toLowerCase() === "i")) {
        e.preventDefault();
        this.toggle(e.key.toLowerCase() === "b" ? "bold" : "italic");
      }
    });
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      document.execCommand("insertText", false, text);
    });
    // keep the browser's formatting tags out (the PDF side doesn't know them): papgi's own
    // bold / italic instead (e.g. from the iPhone's B I U menu)
    el.addEventListener("beforeinput", (e) => {
      if (!e.inputType.startsWith("format")) return;
      e.preventDefault();
      if (e.inputType === "formatBold") this.toggle("bold");
      else if (e.inputType === "formatItalic") this.toggle("italic");
    });
    this.el = el;
    this.original = this.text();
  }

  private span(style: number, text: string): HTMLSpanElement {
    const st = this.block.styles[style];
    const s = document.createElement("span");
    s.dataset.s = String(style);
    s.textContent = text;
    s.style.fontFamily = st.ocr && this.serifCss ? this.serifCss : st.css;
    s.style.fontWeight = st.bold ? "700" : "400";
    s.style.fontStyle = st.italic ? "italic" : "normal";
    s.style.color = rgbCss(st.color);
    s.style.setProperty("--fs", String(st.size));
    return s;
  }

  /** Recognised text: show the new words in papgi's serif or sans font (what will be written). */
  setSerif(serif: boolean): void {
    const css = serif ? "'papgi Serif', 'Times New Roman', serif" : "'papgi Sans', Arial, sans-serif";
    if (serif) void loadEditorFont(this.fontBase, "papgi Serif", "LiberationSerif-Regular.ttf", false, false);
    this.el.style.fontFamily = css;
    this.el.querySelectorAll<HTMLSpanElement>("span[data-s]").forEach((s) => {
      if (this.block.styles[Number(s.dataset.s)]?.ocr) s.style.fontFamily = css;
    });
    this.serifCss = serif ? css : null;
  }
  private serifCss: string | null = null;

  focus(atEnd = true): void {
    this.el.focus();
    if (!atEnd) return;
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(this.el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** Put the caret near a screen point (where the user clicked). */
  placeCaret(x: number, y: number): void {
    this.el.focus();
    const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
    const range = document.createRange();
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos && this.el.contains(pos.offsetNode)) {
      range.setStart(pos.offsetNode, pos.offset);
    } else {
      const r = document.caretRangeFromPoint?.(x, y);
      if (!r || !this.el.contains(r.startContainer)) return this.focus(true);
      range.setStart(r.startContainer, r.startOffset);
    }
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** The edited text as styled runs (style = index into block.styles). */
  runs(): Run[] {
    const out: Run[] = [];
    let last = this.block.runs[0]?.style ?? 0;
    const walk = (node: Node, inherited: number | null) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const style = inherited ?? last;
        last = style;
        out.push({ text: (node.textContent ?? "").replace(/\u00a0/g, " ").replaceAll(HOLD, ""), style });
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === "BR") {
        out.push({ text: "\n", style: inherited ?? last });
        return;
      }
      const s = node.dataset.s !== undefined ? Number(node.dataset.s) : inherited;
      const blockish = node !== this.el && /^(DIV|P)$/.test(node.tagName);
      if (blockish && out.length && !out[out.length - 1].text.endsWith("\n")) out.push({ text: "\n", style: s ?? last });
      node.childNodes.forEach((c) => walk(c, s));
    };
    walk(this.el, null);
    const runs = normalizeRuns(out);
    // a trailing line break that the browser keeps for the caret isn't content
    const tail = runs[runs.length - 1];
    if (tail && tail.text.endsWith("\n")) tail.text = tail.text.replace(/\n+$/, "");
    return normalizeRuns(runs);
  }

  /** The bold / italic styles used (for the engine: run styles from block.styles.length on). */
  variants(): StyleVariant[] {
    return this.variantList;
  }

  /** Is the selection (or the caret's spot) bold / italic? For the toolbar buttons. */
  state(): { bold: boolean; italic: boolean } {
    const at = this.selectionOffsets();
    const chars = this.chars();
    if (!at || !chars.length) return { bold: false, italic: false };
    const [a, b] = at;
    const pick = a === b ? [chars[Math.max(0, a - 1)] ?? chars[0]] : chars.slice(a, b).filter((c) => c.c !== "\n" && c.c !== HOLD);
    const sts = (pick.length ? pick : [chars[a] ?? chars[0]]).map((c) => this.block.styles[c.s]);
    return { bold: sts.every((st) => st.bold), italic: sts.every((st) => st.italic) };
  }

  /**
   * Bold or italic on / off for the selected text (on when not all of it is already, like
   * Word); with nothing selected, for the next letters typed.
   */
  toggle(kind: "bold" | "italic"): void {
    const at = this.selectionOffsets();
    if (!at) return;
    const [a, b] = at;
    const chars = this.chars();
    if (!chars.length) return;
    const has = (s: number) => this.block.styles[s][kind];
    if (a === b) {
      // nothing selected: the next letters typed get the style
      const s = (chars[a - 1] ?? chars[a]).s;
      const held = chars[a - 1]?.c === HOLD ? a - 1 : -1;
      const next = this.variant(s, kind, !has(s));
      if (held >= 0) chars[held].s = next;
      else chars.splice(a, 0, { c: HOLD, s: next });
      const caret = held >= 0 ? a : a + 1;
      this.rebuild(chars, caret, caret);
    } else {
      const part = chars.slice(a, b).filter((c) => c.c !== "\n" && c.c !== HOLD);
      const on = !part.every((c) => has(c.s));
      for (let i = a; i < b; i++) chars[i].s = this.variant(chars[i].s, kind, on);
      this.rebuild(chars, a, b);
    }
    this.onStyle();
  }

  /** Style index for `s` with bold or italic set (a variant of the paragraph's own style, made once). */
  private variant(s: number, kind: "bold" | "italic", on: boolean): number {
    const cur = this.block.styles[s];
    const of = s < this.own ? s : this.variantList[s - this.own].of;
    const bold = kind === "bold" ? on : cur.bold;
    const italic = kind === "italic" ? on : cur.italic;
    const base = this.block.styles[of];
    if (base.bold === bold && base.italic === italic) return of;
    const key = `${of}|${bold}|${italic}`;
    let i = this.variantAt.get(key);
    if (i === undefined) {
      i = this.block.styles.length;
      this.block.styles.push(styleVariant(base, bold, italic));
      this.variantList.push({ of, bold, italic });
      this.variantAt.set(key, i);
      const st = this.block.styles[i];
      void loadEditorFont(this.fontBase, st.family, st.file, bold, italic);
    }
    return i;
  }

  /** Every letter with its style, as the runs read them (a <br> is a line break). */
  private chars(): { c: string; s: number }[] {
    const out: { c: string; s: number }[] = [];
    let last = this.block.runs[0]?.style ?? 0;
    const walk = (node: Node, inherited: number | null) => {
      if (node.nodeType === Node.TEXT_NODE) {
        last = inherited ?? last;
        for (const c of node.textContent ?? "") out.push({ c, s: last });
      } else if (node instanceof HTMLElement) {
        if (node.tagName === "BR") return void out.push({ c: "\n", s: inherited ?? last });
        const s = node.dataset.s !== undefined ? Number(node.dataset.s) : inherited;
        node.childNodes.forEach((ch) => walk(ch, s));
      }
    };
    walk(this.el, null);
    return out;
  }

  /** Where a DOM position is, counted in letters as chars() counts them. */
  private offsetOf(target: Node, offset: number): number {
    let n = 0;
    const walk = (node: Node): boolean => {
      if (node === target) {
        if (node.nodeType === Node.TEXT_NODE) {
          n += [...(node.textContent ?? "").slice(0, offset)].length;
          return true;
        }
        for (let i = 0; i < node.childNodes.length && i < offset; i++) walk(node.childNodes[i]);
        return true;
      }
      if (node.nodeType === Node.TEXT_NODE) n += [...(node.textContent ?? "")].length;
      else if (node instanceof HTMLElement && node.tagName === "BR") n += 1;
      else for (const ch of node.childNodes) if (walk(ch)) return true;
      return false;
    };
    walk(this.el);
    return n;
  }

  private selectionOffsets(): [number, number] | null {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!this.el.contains(r.startContainer) || !this.el.contains(r.endContainer)) return null;
    const a = this.offsetOf(r.startContainer, r.startOffset);
    const b = this.offsetOf(r.endContainer, r.endOffset);
    return a <= b ? [a, b] : [b, a];
  }

  /** Redraw the letters as one span per style, and select from `a` to `b` again. */
  private rebuild(chars: { c: string; s: number }[], a: number, b: number): void {
    const spans: HTMLSpanElement[] = [];
    for (let i = 0; i < chars.length; ) {
      let j = i;
      while (j < chars.length && chars[j].s === chars[i].s) j++;
      spans.push(this.span(chars[i].s, chars.slice(i, j).map((c) => c.c).join("")));
      i = j;
    }
    this.el.replaceChildren(...spans);
    const pos = (k: number): [Node, number] => {
      let n = 0;
      for (const sp of spans) {
        const t = sp.firstChild!;
        const len = [...(t.textContent ?? "")].length;
        // (at a style change, a caret belongs to the run before: typing continues its style,
        // except right after the placeholder, which is in its own run)
        if (k <= n + len) {
          const units = [...(t.textContent ?? "")].slice(0, k - n).join("").length;
          return [t, units];
        }
        n += len;
      }
      const t = spans[spans.length - 1]?.firstChild ?? this.el;
      return [t, t.textContent?.length ?? 0];
    };
    const range = document.createRange();
    range.setStart(...pos(a));
    range.setEnd(...pos(b));
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    this.el.focus();
  }

  text(): string {
    return this.runs().map((r) => `${r.style}:${r.text}`).join("|");
  }

  changed(): boolean {
    return this.text() !== this.original;
  }

  destroy(): void {
    this.el.remove();
  }
}
