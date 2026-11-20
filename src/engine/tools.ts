// The stand-alone tools (merge, split, images <-> PDF, compress). Each works on copies of the
// files it is given and never touches the document open in the editor.
import type * as MuPDF from "mupdf";
import { jpegOrientation } from "../core/exif";

type M = typeof MuPDF;

export interface PdfInput {
  name: string;
  bytes: Uint8Array;
  password?: string;
}

export interface OutFile {
  name: string;
  bytes: Uint8Array;
  type: string;
}

function openPdf(mupdf: M, f: PdfInput): MuPDF.PDFDocument {
  let doc: MuPDF.PDFDocument | null = null;
  try {
    doc = mupdf.Document.openDocument(f.bytes, "application/pdf").asPDF();
  } catch {
    doc = null;
  }
  if (!doc) throw new Error(`“${f.name}” isn't a PDF file that can be read`);
  if (doc.needsPassword() && !(f.password && doc.authenticatePassword(f.password))) {
    doc.destroy();
    throw new PasswordError(f.name);
  }
  return doc;
}

export class PasswordError extends Error {
  constructor(readonly file: string) {
    super(`“${file}” is password-protected`);
    this.name = "PasswordError";
  }
}

function save(doc: MuPDF.PDFDocument, opts = "garbage=compact,compress"): Uint8Array {
  const buf = doc.saveToBuffer(opts);
  const out = buf.asUint8Array().slice();
  buf.destroy();
  return out;
}

/**
 * Copy pages of `src` into `doc` before page `at`, with their annotations and (fillable) form
 * fields. graftPage alone leaves annotations behind.
 */
export function graftPages(doc: MuPDF.PDFDocument, src: MuPDF.PDFDocument, pages: number[], at: number): void {
  const map = doc.newGraftMap();
  pages.forEach((p, i) => {
    // annotations point back to their page (/P), which would drag the old page tree along
    const srcAnnots = src.findPage(p).get("Annots");
    if (srcAnnots.isArray()) srcAnnots.forEach((a) => a.delete("P"));
    map.graftPage(at + i, src, p);
    if (srcAnnots.isArray()) {
      const page = doc.findPage(at + i);
      const arr = doc.newArray();
      srcAnnots.forEach((a) => {
        const g = map.graftObject(a);
        g.put("P", page);
        arr.push(g);
      });
      page.put("Annots", arr);
    }
  });
  mergeForm(doc, src, map, at, pages.length);
}

/** Grafted pages keep their widget annotations; register their fields so they stay fillable. */
function mergeForm(doc: MuPDF.PDFDocument, src: MuPDF.PDFDocument, map: MuPDF.PDFGraftMap, at: number, n: number): void {
  const srcForm = src.getTrailer().get("Root").get("AcroForm");
  if (!srcForm.isDictionary()) return;
  const root = doc.getTrailer().get("Root");
  let form = root.get("AcroForm");
  if (!form.isDictionary()) {
    form = doc.addObject(doc.newDictionary());
    root.put("AcroForm", form);
  }
  let fields = form.get("Fields");
  if (!fields.isArray()) {
    fields = doc.newArray();
    form.put("Fields", fields);
  }
  for (const key of ["DR", "DA", "NeedAppearances"]) {
    const v = srcForm.get(key);
    if (!v.isNull() && form.get(key).isNull()) form.put(key, map.graftObject(v));
  }
  const have = new Set<number>();
  fields.forEach((f) => {
    if (f.isIndirect()) have.add(f.asIndirect());
  });
  for (let i = at; i < at + n; i++) {
    const annots = doc.findPage(i).get("Annots");
    if (!annots.isArray()) continue;
    annots.forEach((a) => {
      if (a.get("Subtype").isNull() || a.get("Subtype").asName() !== "Widget") return;
      let top = a;
      for (let guard = 0; guard < 32 && top.get("Parent").isDictionary(); guard++) top = top.get("Parent");
      if (top.isIndirect() && !have.has(top.asIndirect())) {
        have.add(top.asIndirect());
        fields.push(top);
      }
    });
  }
}

/** Page count of a PDF (for file lists). */
export function pdfPageCount(mupdf: M, f: PdfInput): number {
  const doc = openPdf(mupdf, f);
  try {
    return doc.countPages();
  } finally {
    doc.destroy();
  }
}

/** All pages of the files, in order, in one PDF. `pages` optionally picks pages per file. */
export function mergePdfs(mupdf: M, files: (PdfInput & { pages?: number[] })[]): Uint8Array {
  if (!files.length) throw new Error("No files to merge");
  const out = new mupdf.PDFDocument();
  try {
    let at = 0;
    for (const f of files) {
      const src = openPdf(mupdf, f);
      try {
        const pages = f.pages ?? [...Array(src.countPages()).keys()];
        graftPages(out, src, pages, at);
        at += pages.length;
      } finally {
        src.destroy();
      }
    }
    return save(out);
  } finally {
    out.destroy();
  }
}

/** One PDF per group of pages (0-based page numbers). */
export function splitPdf(mupdf: M, f: PdfInput, groups: number[][], baseName: string): OutFile[] {
  const src = openPdf(mupdf, f);
  try {
    const n = src.countPages();
    const width = String(n).length;
    const pad = (v: number) => String(v).padStart(width, "0");
    return groups
      .filter((g) => g.length)
      .map((g) => {
        if (g.some((p) => p < 0 || p >= n)) throw new Error(`Page ${Math.max(...g) + 1} doesn't exist (the file has ${n})`);
        const out = new mupdf.PDFDocument();
        try {
          graftPages(out, src, g, 0);
          const range = g.length === 1 ? `p${pad(g[0] + 1)}` : isRun(g) ? `p${pad(g[0] + 1)}-${pad(g[g.length - 1] + 1)}` : `part`;
          return { name: `${baseName}-${range}.pdf`, bytes: save(out), type: "application/pdf" };
        } finally {
          out.destroy();
        }
      })
      .map((o, i, all) => (all.filter((x) => x.name === o.name).length > 1 ? { ...o, name: o.name.replace(/\.pdf$/, `-${i + 1}.pdf`) } : o));
  } finally {
    src.destroy();
  }
}

const isRun = (g: number[]) => g.every((v, i) => i === 0 || v === g[i - 1] + 1);

export interface ImageInput {
  name: string;
  bytes: Uint8Array;
}

export interface ImagesToPdfOptions {
  /** "fit": each page the size of its image; otherwise a paper size. */
  page: "fit" | "a4" | "letter";
  /** Margin in points (paper sizes only). */
  margin: number;
}

const PAPER: Record<"a4" | "letter", [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };

/** Each image on its own page (photos keep their camera orientation). */
export function imagesToPdf(mupdf: M, images: ImageInput[], opts: ImagesToPdfOptions): Uint8Array {
  if (!images.length) throw new Error("No images");
  const out = new mupdf.PDFDocument();
  try {
    for (const im of images) {
      let img: MuPDF.Image;
      try {
        img = new mupdf.Image(im.bytes);
      } catch {
        throw new Error(`“${im.name}” isn't an image papgi can read`);
      }
      const orient = jpegOrientation(im.bytes);
      const turned = orient >= 5; // 90° or 270°: width and height swap
      const pw = img.getWidth();
      const ph = img.getHeight();
      // size of the picture as shown, in points (at its own resolution, or 96 dpi if it has none)
      const dpiX = img.getXResolution() > 1 ? img.getXResolution() : 96;
      const dpiY = img.getYResolution() > 1 ? img.getYResolution() : 96;
      let w = (pw * 72) / dpiX;
      let h = (ph * 72) / dpiY;
      if (turned) [w, h] = [h, w];
      let pageW: number;
      let pageH: number;
      let scale: number;
      if (opts.page === "fit") {
        pageW = w;
        pageH = h;
        scale = 1;
      } else {
        [pageW, pageH] = PAPER[opts.page];
        if (w > h !== pageW > pageH && w !== h) [pageW, pageH] = [pageH, pageW]; // landscape pictures on landscape pages
        const m = Math.min(opts.margin, pageW / 4, pageH / 4);
        scale = Math.min((pageW - 2 * m) / w, (pageH - 2 * m) / h);
      }
      const dw = w * scale;
      const dh = h * scale;
      const x = (pageW - dw) / 2;
      const y = (pageH - dh) / 2;
      const res = out.newDictionary();
      const xo = out.newDictionary();
      xo.put("Im0", out.addImage(img));
      res.put("XObject", xo);
      const cm = orientationMatrix(orient, dw, dh, x, y).map((v) => +v.toFixed(4)).join(" ");
      out.insertPage(-1, out.addPage([0, 0, pageW, pageH], 0, res, `q ${cm} cm /Im0 Do Q`));
    }
    return save(out);
  } finally {
    out.destroy();
  }
}

/**
 * PDF matrix drawing the unit-square image into the box (x, y, w, h) (PDF coordinates, y up),
 * turned/flipped by the EXIF orientation (1-8).
 */
export function orientationMatrix(o: number, w: number, h: number, x: number, y: number): number[] {
  switch (o) {
    case 2: return [-w, 0, 0, h, x + w, y]; // mirrored
    case 3: return [-w, 0, 0, -h, x + w, y + h]; // 180°
    case 4: return [w, 0, 0, -h, x, y + h]; // mirrored vertically
    case 5: return [0, -h, -w, 0, x + w, y + h]; // mirrored + 90°
    case 6: return [0, -h, w, 0, x, y + h]; // 90° clockwise
    case 7: return [0, h, w, 0, x, y]; // mirrored + 270°
    case 8: return [0, h, -w, 0, x + w, y]; // 90° counter-clockwise
    default: return [w, 0, 0, h, x, y];
  }
}

export interface RenderOptions {
  format: "png" | "jpeg";
  dpi: number;
  /** JPEG quality 1-100. */
  quality: number;
}

/** Pages as pictures (opens the file once for all of them). */
export function pagesToImages(mupdf: M, f: PdfInput, pages: number[], opts: RenderOptions): Uint8Array[] {
  const doc = openPdf(mupdf, f);
  try {
    return pages.map((index) => {
      const page = doc.loadPage(index);
      try {
        const b = page.getBounds();
        // (keep within ~60 megapixels)
        const s = Math.min(opts.dpi / 72, Math.sqrt(60e6 / Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))));
        const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          pix.setResolution(Math.round(s * 72), Math.round(s * 72));
          return (opts.format === "png" ? pix.asPNG() : pix.asJPEG(opts.quality, false)).slice();
        } finally {
          pix.destroy();
        }
      } finally {
        page.destroy();
      }
    });
  } finally {
    doc.destroy();
  }
}

/** One page as a picture. */
export function pageToImage(mupdf: M, f: PdfInput, index: number, opts: RenderOptions): Uint8Array {
  return pagesToImages(mupdf, f, [index], opts)[0];
}

export interface CompressOptions {
  /** Pictures shown sharper than this get scaled down; 0 keeps pictures as they are. */
  dpi: number;
  /** JPEG quality for pictures that are re-saved. */
  quality: number;
}

export interface CompressResult {
  bytes: Uint8Array;
  images: number;
  before: number;
  after: number;
}

/**
 * Make a PDF smaller: drop unused and duplicate objects, compress everything, and re-save
 * pictures that are sharper than needed (`dpi`) as JPEG.
 */
export function compressPdf(mupdf: M, f: PdfInput, opts: CompressOptions): CompressResult {
  const doc = openPdf(mupdf, f);
  try {
    let images = 0;
    if (opts.dpi > 0) images = downsampleImages(mupdf, doc, opts);
    let bytes = save(doc, "garbage=deduplicate,compress,compress-images,compress-fonts,objstms=yes");
    // never hand back something bigger
    if (bytes.length >= f.bytes.length) bytes = f.bytes.slice();
    return { bytes, images, before: f.bytes.length, after: bytes.length };
  } finally {
    doc.destroy();
  }
}

/** Largest size each picture is shown at on any page, in points (keyed by object number). */
function shownSizes(mupdf: M, doc: MuPDF.PDFDocument): Map<number, number> {
  const sizes = new Map<number, number>();
  const n = doc.countPages();
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i);
    const xobjects = collectImageRefs(page.getObject());
    if (!xobjects.size) {
      page.destroy();
      continue;
    }
    // the device reports each drawn picture with its matrix; match it to its object by pixel size
    const drawn: { w: number; h: number; side: number }[] = [];
    const dev = new mupdf.Device({
      fillImage(image: MuPDF.Image, ctm: MuPDF.Matrix) {
        const side = Math.max(Math.hypot(ctm[0], ctm[1]), Math.hypot(ctm[2], ctm[3]));
        drawn.push({ w: image.getWidth(), h: image.getHeight(), side });
      },
    } as never);
    page.run(dev, mupdf.Matrix.identity);
    dev.close();
    for (const [num, ref] of xobjects) {
      const w = ref.get("Width").asNumber();
      const h = ref.get("Height").asNumber();
      for (const d of drawn) if (d.w === w && d.h === h) sizes.set(num, Math.max(sizes.get(num) ?? 0, d.side));
    }
    page.destroy();
  }
  return sizes;
}

/** Image XObjects used by a page (directly or in forms), by object number. */
function collectImageRefs(pageObj: MuPDF.PDFObject): Map<number, MuPDF.PDFObject> {
  const out = new Map<number, MuPDF.PDFObject>();
  const seen = new Set<number>();
  const walk = (res: MuPDF.PDFObject, depth: number) => {
    if (!res.isDictionary() || depth > 6) return;
    const xo = res.get("XObject");
    if (!xo.isDictionary()) return;
    xo.forEach((v) => {
      if (!v.isIndirect()) return;
      const num = v.asIndirect();
      if (seen.has(num)) return;
      seen.add(num);
      const sub = v.get("Subtype");
      if (sub.isName() && sub.asName() === "Image") out.set(num, v);
      else if (sub.isName() && sub.asName() === "Form") walk(v.get("Resources"), depth + 1);
    });
  };
  walk(pageObj.get("Resources"), 0);
  return out;
}

function downsampleImages(mupdf: M, doc: MuPDF.PDFDocument, opts: CompressOptions): number {
  const sizes = shownSizes(mupdf, doc);
  let changed = 0;
  for (const [num, side] of sizes) {
    const obj = doc.newIndirect(num);
    const filters = filterNames(obj.get("Filter"));
    // leave alone: masks, pictures with transparency, black-and-white scans (already tiny)
    if (obj.get("ImageMask").isBoolean() && obj.get("ImageMask").asBoolean()) continue;
    if (!obj.get("SMask").isNull() || !obj.get("Mask").isNull()) continue;
    if (filters.some((x) => x === "JBIG2Decode" || x === "CCITTFaxDecode" || x === "JPXDecode")) continue;
    const bpc = obj.get("BitsPerComponent");
    if (bpc.isNumber() && bpc.asNumber() < 8) continue;
    const w = obj.get("Width").asNumber();
    const h = obj.get("Height").asNumber();
    const longest = Math.max(w, h);
    // shown size of the longest side in points -> pixels it needs at the target dpi
    const need = Math.max(16, Math.ceil(((side || 1) / 72) * opts.dpi));
    const isJpeg = filters.includes("DCTDecode");
    if (longest <= need * 1.15 && isJpeg) continue; // sharp enough and already JPEG
    const k = Math.min(1, need / longest);
    let image: MuPDF.Image;
    try {
      image = doc.loadImage(obj);
    } catch {
      continue;
    }
    const cs = image.getColorSpace();
    const gray = !!cs && cs.isGray();
    if (!gray && !(cs && cs.isRGB())) {
      // (CMYK, indexed, Lab...: keep, to stay faithful)
      continue;
    }
    const nw = Math.max(1, Math.round(w * k));
    const nh = Math.max(1, Math.round(h * k));
    const pix = new mupdf.Pixmap(gray ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB, [0, 0, nw, nh], false);
    pix.clear(255);
    const dev = new mupdf.DrawDevice(mupdf.Matrix.identity, pix);
    dev.fillImage(image, [nw, 0, 0, nh, 0, 0], 1);
    dev.close();
    const jpeg = pix.asJPEG(opts.quality, false);
    pix.destroy();
    const old = obj.readRawStream();
    const oldLen = old.getLength();
    old.destroy();
    if (jpeg.length >= oldLen * 0.9) continue; // not worth it
    obj.put("Width", nw);
    obj.put("Height", nh);
    obj.put("BitsPerComponent", 8);
    obj.put("ColorSpace", doc.newName(gray ? "DeviceGray" : "DeviceRGB"));
    obj.put("Filter", doc.newName("DCTDecode"));
    obj.delete("DecodeParms");
    obj.delete("Decode");
    obj.delete("Interpolate");
    obj.writeRawStream(jpeg);
    changed++;
  }
  return changed;
}

function filterNames(f: MuPDF.PDFObject): string[] {
  if (f.isName()) return [f.asName()];
  const out: string[] = [];
  if (f.isArray()) f.forEach((v) => v.isName() && out.push(v.asName()));
  return out;
}
