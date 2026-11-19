// Printing the document (with all edits, annotations, signatures and filled forms).
// Chrome and Edge on a computer: the saved PDF goes to the browser's own PDF viewer in a hidden
// frame and prints from there, as sharp vector output with the usual print options.
// Elsewhere (iPhone/iPad, Firefox, Safari): the pages are rendered as images into a print-only
// layer and the page itself is printed.
import type { Engine } from "../engine/client";
import type { DocInfo } from "../engine/engine";

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Chrome / Edge on a desktop, with the built-in PDF viewer switched on. */
export function canPrintPdfNatively(): boolean {
  return !isIOS() && navigator.pdfViewerEnabled === true && /Chrome\//.test(navigator.userAgent) && !/Mobile|Android/.test(navigator.userAgent);
}

let frame: HTMLIFrameElement | null = null;
let frameUrl = "";

function clearFrame(): void {
  frame?.remove();
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frame = null;
  frameUrl = "";
}

/** Print the PDF bytes through the browser's PDF viewer. Resolves when the print dialog was asked for. */
export function printPdfBytes(bytes: Uint8Array): Promise<void> {
  clearFrame();
  frameUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }));
  const f = document.createElement("iframe");
  f.className = "print-frame";
  f.setAttribute("aria-hidden", "true");
  f.tabIndex = -1;
  frame = f;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("The PDF viewer didn't load")), 20000);
    f.onload = () => {
      // the viewer needs a moment after load before it can print
      window.setTimeout(() => {
        clearTimeout(timer);
        try {
          f.contentWindow!.print();
          // keep the keyboard on papgi, not on the hidden frame (shortcuts would stop working)
          window.focus();
          (document.activeElement as HTMLElement | null)?.blur?.();
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      }, 250);
    };
    f.src = frameUrl;
    document.body.append(f);
  });
}

/** Render every page into the print layer and print the page. */
export async function printAsImages(engine: Engine, info: DocInfo, onProgress?: (done: number, total: number) => void): Promise<void> {
  let root = document.querySelector<HTMLDivElement>("#print-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "print-root";
    root.setAttribute("aria-hidden", "true");
    document.body.append(root);
  }
  root.querySelectorAll("img").forEach((im) => URL.revokeObjectURL(im.src));
  root.replaceChildren();
  const canvas = document.createElement("canvas");
  for (let i = 0; i < info.pageCount; i++) {
    onProgress?.(i, info.pageCount);
    const p = info.pages[i];
    // about 200 dpi, capped so huge pages don't run out of memory (phones especially)
    const scale = Math.min(200 / 72, (isIOS() ? 2400 : 4000) / Math.max(p.w, p.h));
    const bmp = await engine.renderBitmap(i, scale);
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    canvas.getContext("2d")!.drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't render page"))), "image/png"));
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    img.alt = "";
    await img.decode();
    // one sheet per page, the page scaled to fit the paper
    const sheet = document.createElement("div");
    sheet.className = "print-sheet";
    sheet.append(img);
    root.append(sheet);
  }
  canvas.width = canvas.height = 0;
  onProgress?.(info.pageCount, info.pageCount);
  // Free the images a while after printing (Safari on iPhone may report "after print" before
  // its print sheet has used them); the next print replaces them anyway.
  const cleanup = () => {
    window.removeEventListener("afterprint", later);
    root!.querySelectorAll("img").forEach((im) => URL.revokeObjectURL(im.src));
    root!.replaceChildren();
  };
  const later = () => window.setTimeout(cleanup, 60000);
  window.addEventListener("afterprint", later, { once: true });
  // (the print stylesheet shows only #print-root)
  window.print();
}
