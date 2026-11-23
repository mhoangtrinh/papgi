// The system clipboard, as far as browsers let a web app use it.

/**
 * Put text on the system clipboard. The text may still be on its way (a copy in the
 * engine): Safari only allows writing during the click or key press, so the write starts
 * now with the text as a promise. Resolves to whether it worked.
 */
export async function writeClipboardText(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return true;
    }
  } catch {
    /* fall through to writeText */
  }
  try {
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    return false;
  }
}

export interface ClipboardContent {
  text: string;
  image: Blob | null;
}

/** What a paste event carries. */
export function fromPasteEvent(e: ClipboardEvent): ClipboardContent {
  const dt = e.clipboardData;
  const file = [...(dt?.items ?? [])].find((it) => it.kind === "file" && it.type.startsWith("image/"))?.getAsFile() ?? null;
  return { text: dt?.getData("text/plain") ?? "", image: file };
}

/** Read the clipboard on request (a Paste button). Null if the browser doesn't allow it. */
export async function readClipboard(): Promise<ClipboardContent | null> {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      let text = "";
      let image: Blob | null = null;
      for (const it of items) {
        const img = it.types.find((t) => t.startsWith("image/"));
        if (img && !image) image = await it.getType(img);
        if (it.types.includes("text/plain") && !text) text = await (await it.getType("text/plain")).text();
      }
      return { text, image };
    }
    if (navigator.clipboard?.readText) return { text: await navigator.clipboard.readText(), image: null };
  } catch {
    /* not allowed */
  }
  return null;
}

/** PNG or JPEG bytes of a picture (other formats are converted to PNG), with its pixel size. */
export async function pictureBytes(blob: Blob): Promise<{ bytes: Uint8Array; w: number; h: number }> {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width;
  const h = bmp.height;
  if (blob.type === "image/png" || blob.type === "image/jpeg") {
    bmp.close();
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const png = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Couldn't read the picture"))), "image/png"));
  return { bytes: new Uint8Array(await png.arrayBuffer()), w, h };
}
