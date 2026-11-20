// Recognising dropped files, and turning pictures papgi's engine can't read (HEIC from
// iPhones, WebP, AVIF) into JPEG using the browser's own decoder.

export const isPdf = (b: Uint8Array): boolean => {
  // "%PDF-" near the start (some files have junk before it)
  const n = Math.min(b.length, 1024);
  for (let i = 0; i + 4 < n; i++) if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  return false;
};

/** Formats the engine reads directly. */
export function imageType(b: Uint8Array): "jpeg" | "png" | "gif" | "bmp" | "tiff" | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tiff";
  return null;
}

export function looksLikeImage(name: string, b: Uint8Array): boolean {
  return !!imageType(b) || /\.(jpe?g|png|gif|bmp|tiff?|heic|heif|webp|avif)$/i.test(name);
}

const MIME = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", bmp: "image/bmp", tiff: "image/tiff" } as const;

/** A picture the engine can read, keeping the original bytes when possible. */
export async function normalizeImage(name: string, bytes: Uint8Array): Promise<{ name: string; bytes: Uint8Array; type: string }> {
  const t = imageType(bytes);
  if (t) return { name, bytes, type: MIME[t] };
  // let the browser decode it (Safari reads HEIC; most browsers read WebP/AVIF)
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]));
  } catch {
    throw new Error(/\.hei[cf]$/i.test(name) ? "this browser can't read HEIC photos (Safari can); save it as JPG first" : "not a picture this browser can read");
  }
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", 0.92));
  canvas.width = canvas.height = 0;
  if (!blob) throw new Error("couldn't convert the picture");
  return { name: name.replace(/\.[^.]+$/, "") + ".jpg", bytes: new Uint8Array(await blob.arrayBuffer()), type: "image/jpeg" };
}
