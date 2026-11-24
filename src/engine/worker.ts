// Web Worker that owns the MuPDF engine, so heavy work never blocks the UI.
import * as mupdf from "mupdf";
import { PdfEngine, type AnnotInfo, type EditResult, type EditOptions, type OcrWord } from "./engine";
import type { Run } from "../core/textlayout";

export class WorkerEngine extends PdfEngine {
  /** Render straight to an ImageBitmap that can be transferred to the page. */
  async renderBitmap(index: number, scale: number): Promise<ImageBitmap> {
    const img = this.render(index, scale);
    return createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
  }

  /** Replace a paragraph, first fetching any bundled fonts it needs from `fontBase`. */
  /** Write recognised text onto pages (fetches the font for the hidden text first). */
  async addOcr(pages: { index: number; words: OcrWord[] }[], fontBase: string): Promise<number> {
    await this.loadFonts([this.ocrFontFile], fontBase);
    return this.addOcrPages(pages);
  }

  private async loadFonts(files: string[], fontBase: string): Promise<void> {
    await Promise.all(
      files
        .filter((file) => !this.hasFont(file))
        .map(async (file) => {
          let res: Response;
          try {
            res = await fetch(new URL(file, fontBase));
          } catch {
            throw new Error("Couldn't download a font papgi needs. Are you offline?");
          }
          if (!res.ok) throw new Error(`Couldn't load the font ${file} (${res.status})`);
          this.registerFont(file, new Uint8Array(await res.arrayBuffer()));
        }),
    );
  }

  async editText(index: number, block: number, runs: Run[], fontBase: string, opts: EditOptions = {}): Promise<{ result: EditResult; annots: AnnotInfo[] }> {
    for (let round = 0; round < 3; round++) {
      const need = this.fontsForEdit(index, block, runs, opts);
      if (!need.length) break;
      await this.loadFonts(need, fontBase);
    }
    return this.replaceText(index, block, runs, opts);
  }

  /** A watermark, first fetching a font if Helvetica lacks some of its letters. */
  async addWatermark(o: import("./stamp").WatermarkOptions, fontBase: string): Promise<void> {
    const failed = await this.stampFontReady([o.text], o.bold, fontBase);
    try {
      this.watermark(o);
    } catch (e) {
      throw failed && /can't write/.test((e as Error).message) ? new Error("Couldn't download the font for these letters. Check the connection and try again.") : e;
    }
  }

  /** Fetch the bundled font these texts need, if any. True: it was needed and couldn't be loaded. */
  private async stampFontReady(texts: string[], bold: boolean, fontBase: string): Promise<boolean> {
    const file = this.stampFontFile(texts, bold);
    if (!file) return false;
    try {
      await this.loadFonts([file], fontBase);
      return false;
    } catch {
      return true;
    }
  }

  /** Page numbers, header and footer (fetching a font when needed). */
  async addHeaderFooter(o: import("./stamp").HeaderFooterOptions, fontBase: string): Promise<number> {
    const failed = await this.stampFontReady(Object.values(o.items).filter((t): t is string => !!t), false, fontBase);
    try {
      return this.headerFooter(o);
    } catch (e) {
      throw failed && /can't write/.test((e as Error).message) ? new Error("Couldn't download the font for these letters. Check the connection and try again.") : e;
    }
  }

  /** What's printed in a part of a page on a transparent background (drag preview). */
  async renderAreaBitmap(index: number, rect: [number, number, number, number], scale: number, content = true): Promise<ImageBitmap> {
    const img = this.renderArea(index, rect, scale, content);
    return createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
  }

  /** One annotation on a transparent background (drag preview). */
  async renderAnnotBitmap(index: number, annot: number, scale: number): Promise<ImageBitmap | null> {
    const img = this.renderAnnot(index, annot, scale);
    if (!img || !img.width || !img.height) return null;
    return createImageBitmap(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height));
  }
}

const engine = new WorkerEngine(mupdf);
mupdf.setLog(null);

interface Call {
  id: number;
  method: string;
  args: unknown[];
}

// When nothing has been asked for a moment, prepare the undo copy for the next change,
// so the change itself (a stroke, a text box...) shows up sooner.
let idle = 0;
let pending = 0;
const whenIdle = () => {
  clearTimeout(idle);
  idle = self.setTimeout(() => {
    if (pending) return;
    try {
      engine.prepareUndo();
    } catch {
      // (only an optimisation)
    }
  }, 250);
};

self.onmessage = async (ev: MessageEvent<Call>) => {
  const { id, method, args } = ev.data;
  pending++;
  clearTimeout(idle);
  try {
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== "function") throw new Error(`Unknown method ${method}`);
    const result = await fn.apply(engine, args);
    const transfer: Transferable[] = [];
    if (result instanceof ImageBitmap) transfer.push(result);
    else if (result instanceof Uint8Array) transfer.push(result.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  } finally {
    pending--;
    whenIdle();
  }
};

(self as unknown as Worker).postMessage({ ready: true });
