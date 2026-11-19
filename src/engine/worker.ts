// Web Worker that owns the MuPDF engine, so heavy work never blocks the UI.
import * as mupdf from "mupdf";
import { PdfEngine } from "./engine";

export class WorkerEngine extends PdfEngine {
  /** Render straight to an ImageBitmap that can be transferred to the page. */
  async renderBitmap(index: number, scale: number): Promise<ImageBitmap> {
    const img = this.render(index, scale);
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

self.onmessage = async (ev: MessageEvent<Call>) => {
  const { id, method, args } = ev.data;
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
  }
};

(self as unknown as Worker).postMessage({ ready: true });
