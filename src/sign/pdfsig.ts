// Digital signatures in a PDF file: the bytes around the signature. The engine writes a
// signature dictionary with room for the signature (/Contents, all zeros) and a placeholder
// /ByteRange; here the placeholder is filled in with the parts of the file that are signed
// (everything but the room itself) and the signature is written into the room.

/** Bytes kept for the signature (CMS with the certificates; plenty for RSA 4096 and a chain). */
export const SIG_ROOM = 16384;
/** What the engine writes as /ByteRange until it is known. */
export const RANGE_PLACEHOLDER = [0, 999999999, 999999999, 999999999];

export interface Placeholder {
  /** The /ByteRange array: from "[" to after "]". */
  rangeStart: number;
  rangeEnd: number;
  /** The room for the signature: from "<" to after ">". */
  contentsStart: number;
  contentsEnd: number;
}

const ascii = (s: string) => new TextEncoder().encode(s);

function indexOf(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  const last = hay.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== first) continue;
    for (let k = 1; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

function lastIndexOf(hay: Uint8Array, needle: Uint8Array, before: number): number {
  for (let i = Math.min(before, hay.length - needle.length); i >= 0; i--) {
    let ok = true;
    for (let k = 0; k < needle.length && ok; k++) ok = hay[i + k] === needle[k];
    if (ok) return i;
  }
  return -1;
}

/** Find the signature's placeholders in a freshly written file. */
export function findPlaceholder(b: Uint8Array): Placeholder {
  const at = indexOf(b, ascii(RANGE_PLACEHOLDER.slice(1).join(" ")));
  if (at < 0) throw new Error("The signature's place wasn't found in the file");
  const rangeStart = lastIndexOf(b, ascii("["), at);
  const rangeEnd = indexOf(b, ascii("]"), at) + 1;
  // the room: in the same object, "<" and a long run of zeros
  const objStart = Math.max(0, lastIndexOf(b, ascii(" obj"), at));
  const contentsStart = indexOf(b, ascii("<" + "0".repeat(64)), objStart);
  const contentsEnd = contentsStart + 2 + 2 * SIG_ROOM;
  if (rangeStart < 0 || rangeEnd <= 0 || contentsStart < 0 || b[contentsEnd - 1] !== 0x3e) throw new Error("The signature's place wasn't found in the file");
  return { rangeStart, rangeEnd, contentsStart, contentsEnd };
}

/** Write the real /ByteRange (same length, padded with spaces); returns it. */
export function fillByteRange(b: Uint8Array, p: Placeholder): number[] {
  const range = [0, p.contentsStart, p.contentsEnd, b.length - p.contentsEnd];
  const width = p.rangeEnd - p.rangeStart;
  const text = `[${range.join(" ")}`;
  if (text.length + 1 > width) throw new Error("The file is too big to sign");
  b.set(ascii(text.padEnd(width - 1, " ") + "]"), p.rangeStart);
  return range;
}

/** The signed parts of the file (everything but the signature's room). */
export function signedBytes(b: Uint8Array, range: number[]): Uint8Array {
  const out = new Uint8Array(range[1] + range[3]);
  out.set(b.subarray(range[0], range[0] + range[1]), 0);
  out.set(b.subarray(range[2], range[2] + range[3]), range[1]);
  return out;
}

/** Write the signature (DER) into its room, as hex. */
export function fillContents(b: Uint8Array, p: Placeholder, der: Uint8Array): void {
  if (der.length > SIG_ROOM) throw new Error("The signature is too big for its place in the file");
  const hex = Array.from(der, (x) => x.toString(16).padStart(2, "0")).join("");
  b.set(ascii(hex), p.contentsStart + 1);
}
