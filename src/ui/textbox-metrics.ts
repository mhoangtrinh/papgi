// Keeps the text box editor's text exactly where the finished text box will draw it.
// MuPDF draws a text box (FreeText) in Helvetica with the first baseline 0.8 em below the top
// of the box, lines 1.2 em apart and no inner padding. The editor types in Liberation Sans (same
// letter widths as Helvetica/Arial, and the same on every system); its baseline is measured in
// the browser, and the editor is shifted so both line up.
import { loadEditorFont } from "./text-editor";

// (its own family name: the paragraph editor may load other weights under "papgi Sans")
export const TEXTBOX_FAMILY = "papgi TextBox";
export const TEXTBOX_FONT_FILE = "LiberationSans-Regular.ttf";
/** Where MuPDF puts the first baseline, in em below the top of the box. */
export const TEXTBOX_BASELINE = 0.8;
export const TEXTBOX_LINE_HEIGHT = 1.2;

let cached: number | null = null;
let fontState: "none" | "loading" | "ready" = "none";

/** Baseline of the first line, in em below the line box top, for the editor font. */
export function editorBaseline(): number {
  if (cached !== null) return cached;
  const box = document.createElement("div");
  box.style.cssText = `position:absolute;visibility:hidden;left:-9999px;top:0;margin:0;padding:0;border:0;font:400 100px/${TEXTBOX_LINE_HEIGHT} "${TEXTBOX_FAMILY}",Arial,Helvetica,sans-serif;white-space:pre`;
  const mark = document.createElement("span");
  mark.style.cssText = "display:inline-block;width:1px;height:0;vertical-align:baseline";
  box.append("H", mark);
  document.body.append(box);
  const b = (mark.getBoundingClientRect().top - box.getBoundingClientRect().top) / 100;
  box.remove();
  // (a sane value even if layout isn't ready)
  const v = b > 0.5 && b < 1.3 ? b : 0.946;
  if (fontState === "ready") cached = v;
  return v;
}

/** Load the editor font (once); calls back when it arrived and the metrics changed. */
export function loadTextBoxFont(base: string, onReady: () => void): void {
  if (fontState === "ready") return;
  const p = loadEditorFont(base, TEXTBOX_FAMILY, TEXTBOX_FONT_FILE, false, false);
  fontState = "loading";
  void p.then(() => {
    fontState = document.fonts.check(`400 16px "${TEXTBOX_FAMILY}"`) ? "ready" : "none";
    cached = null;
    onReady();
  });
}

/** How far to raise the editor (in em) so its first baseline sits where MuPDF will draw it. */
export function editorRaise(): number {
  return editorBaseline() - TEXTBOX_BASELINE;
}
