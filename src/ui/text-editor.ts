// In-place editor for one paragraph of existing PDF text. It shows the paragraph in
// (nearly) the same font, size, colour and line spacing, keeps each run's style while
// you type, and hands back styled runs for the engine to lay out and write into the PDF.
import type { EditBlock, PageInfo } from "../engine/engine";
import type { Run } from "../core/textlayout";
import { normalizeRuns } from "../core/textlayout";

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

export class ParagraphEditor {
  readonly el: HTMLDivElement;
  private original: string;

  constructor(
    readonly page: number,
    readonly block: EditBlock,
    info: PageInfo,
    fontBase: string,
    private onDone: (commit: boolean) => void,
  ) {
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
      }
    });
    el.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n");
      document.execCommand("insertText", false, text);
    });
    // keep formatting tags out (Ctrl+B etc. would create elements the PDF side doesn't know)
    el.addEventListener("beforeinput", (e) => {
      if (e.inputType.startsWith("format")) e.preventDefault();
    });
    this.el = el;
    this.original = this.text();
  }

  private span(style: number, text: string): HTMLSpanElement {
    const st = this.block.styles[style];
    const s = document.createElement("span");
    s.dataset.s = String(style);
    s.textContent = text;
    s.style.fontFamily = st.css;
    s.style.fontWeight = st.bold ? "700" : "400";
    s.style.fontStyle = st.italic ? "italic" : "normal";
    s.style.color = rgbCss(st.color);
    s.style.setProperty("--fs", String(st.size));
    return s;
  }

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
        out.push({ text: (node.textContent ?? "").replace(/ /g, " "), style });
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
