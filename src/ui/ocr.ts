// Text recognition (OCR) for scanned pages: a dialog to pick pages and languages, then
// tesseract.js reads each page image in its own worker and the engine writes the words as a
// hidden, selectable text layer. Everything runs on this device; the engine and language data
// come from papgi's own site (public/ocr) and are cached for offline use after the first run.
import type { Engine } from "../engine/client";
import type { OcrWord } from "../engine/engine";
import { wordsToPage, ocrScale, type TessBlock } from "../core/ocrwords";
import { OCR_LANGS, MAX_OCR_LANGS } from "../core/ocrlangs";
import { modal } from "./dialogs";
import { icon } from "./icons";

export interface OcrChoice {
  pages: number[];
  langs: string[];
}

/** Ask what to recognise. Resolves null when cancelled. */
export async function ocrDialog(opts: { pageCount: number; current: number; scanned: number[]; langs: string[] }): Promise<OcrChoice | null> {
  const wrap = document.createElement("div");
  wrap.className = "ocr-dialog";
  const all = opts.scanned;
  const curScanned = all.includes(opts.current);
  wrap.innerHTML = `
    <p class="muted">papgi reads the page images and adds their words as hidden text, so you can select, search, highlight and edit them. It all happens on this device.</p>
    <div class="ocr-row"><span class="ocr-label">Pages</span>
      <div class="seg" role="radiogroup" aria-label="Pages">
        <button data-pages="all" class="on" role="radio">All without text (${all.length})</button>
        <button data-pages="current" role="radio" ${curScanned ? "" : "disabled"}>This page (${opts.current + 1})</button>
      </div>
    </div>
    <div class="ocr-row"><span class="ocr-label">Languages <span class="muted">(up to ${MAX_OCR_LANGS})</span></span>
      <div class="lang-chips" role="group" aria-label="Languages">
        ${OCR_LANGS.map((l) => `<button class="lang-chip" data-lang="${l.code}" aria-pressed="false" title="${l.name}">${l.native}</button>`).join("")}
      </div>
      <p class="muted ocr-note"></p>
    </div>`;
  let pages: "all" | "current" = all.length ? "all" : "current";
  const chosen = opts.langs.slice(0, MAX_OCR_LANGS);
  const note = wrap.querySelector<HTMLElement>(".ocr-note")!;
  const sync = () => {
    wrap.querySelectorAll<HTMLButtonElement>("[data-pages]").forEach((b) => b.classList.toggle("on", b.dataset.pages === pages));
    wrap.querySelectorAll<HTMLButtonElement>("[data-lang]").forEach((b) => {
      const on = chosen.includes(b.dataset.lang!);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.disabled = !on && chosen.length >= MAX_OCR_LANGS;
    });
    const names = chosen.map((c) => OCR_LANGS.find((l) => l.code === c)!.name);
    note.textContent = chosen.length ? `Reading ${names.join(" + ")}. Pick only the languages in the document: each extra one makes it slower.` : "Pick at least one language.";
  };
  wrap.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b || b.disabled) return;
    if (b.dataset.pages) pages = b.dataset.pages as typeof pages;
    if (b.dataset.lang) {
      const i = chosen.indexOf(b.dataset.lang);
      if (i >= 0) chosen.splice(i, 1);
      else if (chosen.length < MAX_OCR_LANGS) chosen.push(b.dataset.lang);
    }
    sync();
  });
  sync();
  const v = await modal({ title: "Recognize text", body: wrap, wide: true, actions: [{ label: "Cancel", value: "" }, { label: "Recognize", value: "ok", primary: true }] });
  if (v !== "ok" || !chosen.length) return null;
  const list = pages === "current" ? [opts.current] : all;
  return list.length ? { pages: list, langs: chosen } : null;
}

/** Progress panel with a Cancel button. */
class Progress {
  readonly el: HTMLDivElement;
  cancelled = false;
  private bar: HTMLElement;
  private label: HTMLElement;
  constructor(onCancel: () => void) {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal ocr-progress" role="dialog" aria-modal="true" aria-label="Recognizing text">
      <div class="modal-head"><h2>${icon("scan")}Recognizing text</h2></div>
      <div class="modal-body"><p class="ocr-status">Starting…</p><div class="meter"><div></div></div></div>
      <div class="modal-actions"><button class="btn" data-v="cancel">Stop</button></div></div>`;
    this.bar = back.querySelector<HTMLElement>(".meter > div")!;
    this.label = back.querySelector<HTMLElement>(".ocr-status")!;
    back.querySelector("button")!.onclick = () => {
      this.cancelled = true;
      this.set("Stopping…", -1);
      onCancel();
    };
    document.body.append(back);
    this.el = back;
  }
  set(text: string, fraction: number): void {
    this.label.textContent = text;
    if (fraction >= 0) this.bar.style.width = `${Math.round(Math.min(1, fraction) * 100)}%`;
  }
  close(): void {
    this.el.remove();
  }
}

/**
 * Recognise the pages and write the text into the document (one undo step).
 * Returns the pages that got text; throws on failure. Pages done before Stop are kept.
 */
export async function runOcr(engine: Engine, choice: OcrChoice, base: string): Promise<{ pages: number[]; words: number; stopped: boolean }> {
  type Worker = import("tesseract.js").Worker;
  let worker: Worker | null = null;
  let stop = () => {};
  const progress = new Progress(() => stop());
  const done: { index: number; words: OcrWord[] }[] = [];
  try {
    progress.set("Loading the text recognition engine…", 0);
    const { createWorker } = await import("tesseract.js");
    const ocrBase = new URL("ocr/", base).href;
    let step = 0;
    const total = choice.pages.length;
    worker = await createWorker(choice.langs, 1, {
      workerPath: `${ocrBase}worker.min.js`,
      corePath: ocrBase,
      langPath: `${ocrBase}lang`,
      gzip: true,
      workerBlobURL: false,
      logger: (m: { status: string; progress: number }) => {
        if (progress.cancelled) return;
        if (m.status === "recognizing text") progress.set(`Reading page ${choice.pages[step] + 1}${total > 1 ? ` (${step + 1} of ${total})` : ""}…`, (step + m.progress) / total);
        else if (m.status.startsWith("loading language")) progress.set("Loading language data…", 0);
      },
    });
    const w = worker;
    stop = () => void w.terminate().catch(() => {});
    const canvas = document.createElement("canvas");
    for (step = 0; step < total && !progress.cancelled; step++) {
      const index = choice.pages[step];
      if (await engine.pageHasText(index)) continue;
      const info = await engine.pageInfo(index);
      const scale = ocrScale(info.w, info.h);
      const bmp = await engine.renderBitmap(index, scale);
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      let blocks: TessBlock[];
      try {
        const r = await w.recognize(canvas, {}, { blocks: true });
        blocks = (r.data.blocks ?? []) as unknown as TessBlock[];
      } catch (e) {
        if (progress.cancelled) break;
        throw e;
      }
      const words = wordsToPage(blocks, scale, info.x, info.y);
      if (words.length) done.push({ index, words });
    }
    canvas.width = canvas.height = 0;
    progress.set("Adding the text to the document…", 1);
    const n = done.length ? await engine.addOcr(done, new URL("fonts/", base).href) : 0;
    return { pages: done.map((d) => d.index), words: n, stopped: progress.cancelled };
  } finally {
    progress.close();
    if (worker && !progress.cancelled) await worker.terminate().catch(() => {});
  }
}
