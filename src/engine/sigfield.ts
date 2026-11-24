// Digital signatures, the PDF side: a signature field gets a signature dictionary with room
// for the signature (filled in afterwards, see src/sign/pdfsig.ts), and the signatures in an
// opened file are listed for checking.
import type * as MuPDF from "mupdf";
import type { Rect } from "../core/geometry";
import { RANGE_PLACEHOLDER, SIG_ROOM } from "../sign/pdfsig";
import { ensureForm } from "./forms";

export interface SignOptions {
  /** The signature box to sign in, or null for a signature not shown on any page. */
  field: { page: number; widget: number } | null;
  name: string;
  reason: string;
  location: string;
  /** When (ms). */
  time: number;
  /** What the box shows (already in the interface's language); the name is the second line. */
  lines: string[];
}

export interface SigInfo {
  /** The field's name, its page and box (-1 and an empty box when not shown). */
  field: string;
  page: number;
  rect: Rect;
  /** As the signature dictionary says. */
  name: string;
  reason: string;
  location: string;
  /** When, per the dictionary (ms), 0 if it doesn't say. */
  time: number;
  subFilter: string;
  byteRange: number[];
  contents: Uint8Array;
}

/** "D:20261124143000+01'00'" */
export function pdfDate(ms: number): string {
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}'${p(Math.abs(off) % 60)}'`;
}

export function parsePdfDate(s: string): number {
  const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s.trim());
  if (!m) return 0;
  const [y, mo = "01", d = "01", h = "00", mi = "00", se = "00", z, oh = "00", om = "00"] = m.slice(1);
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  if (z === "+" || z === "-") t -= (z === "+" ? 1 : -1) * (+oh * 60 + +om) * 60_000;
  else if (!z) t += new Date(t).getTimezoneOffset() * 60_000;
  return t;
}

/** Text the standard Helvetica (WinAnsi) can write: accents it lacks are dropped, the rest becomes "?". */
function winAnsi(s: string): string {
  const ok = (c: string) => {
    const k = c.charCodeAt(0);
    return (k >= 32 && k < 127) || (k >= 160 && k <= 255);
  };
  return [...s].map((c) => (ok(c) ? c : [...c.normalize("NFD")].filter(ok).join("") || "?")).join("");
}

function pdfString(s: string): string {
  // (Latin-1 bytes as written; WinAnsi matches Latin-1 for these)
  return `(${winAnsi(s).replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** The look of a signed box: who signed, when and why, in Helvetica, fitted to the box. */
function signedAppearance(m: typeof MuPDF, doc: MuPDF.PDFDocument, w: number, h: number, lines: string[]): MuPDF.PDFObject {
  const helv = new m.Font("Helvetica");
  const bold = new m.Font("Helvetica-Bold");
  const width = (f: MuPDF.Font, s: string) => [...winAnsi(s)].reduce((a, c) => a + f.advanceGlyph(f.encodeCharacter(c.codePointAt(0)!)), 0);
  const pad = Math.min(6, h * 0.08, w * 0.04);
  // the name twice the size of the other lines, all fitting the box
  const units = lines.reduce((a, _l, i) => a + (i === 1 ? 2 : 1) * 1.25, 0);
  let size = Math.min(10, (h - 2 * pad) / Math.max(units, 1));
  for (const [i, l] of lines.entries()) {
    const f = i === 1 ? bold : helv;
    const k = i === 1 ? 2 : 1;
    const lw = width(f, l) * size * k;
    if (lw > w - 2 * pad) size = Math.min(size, (w - 2 * pad) / (width(f, l) * k));
  }
  size = Math.max(size, 2);
  let ops = `q 0.08 0.25 0.55 RG 0.75 w ${n(0.4)} ${n(0.4)} ${n(w - 0.8)} ${n(h - 0.8)} re S Q\nBT 0.1 0.12 0.16 rg\n`;
  let y = h - pad;
  for (const [i, l] of lines.entries()) {
    const s = size * (i === 1 ? 2 : 1);
    y -= s;
    ops += `/${i === 1 ? "F2" : "F1"} ${n(s)} Tf 1 0 0 1 ${n(pad)} ${n(y)} Tm ${pdfString(l)} Tj\n`;
    y -= s * 0.25;
  }
  ops += "ET\n";
  helv.destroy();
  bold.destroy();
  const font = (base: string) => doc.addObject({ Type: doc.newName("Font"), Subtype: doc.newName("Type1"), BaseFont: doc.newName(base), Encoding: doc.newName("WinAnsiEncoding") });
  const res = doc.newDictionary();
  const fonts = doc.newDictionary();
  fonts.put("F1", font("Helvetica"));
  fonts.put("F2", font("Helvetica-Bold"));
  res.put("Font", fonts);
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Form"));
  dict.put("BBox", [0, 0, w, h]);
  dict.put("Resources", res);
  // (Latin-1 bytes: the strings are WinAnsi)
  return doc.addStream(Uint8Array.from(ops, (c) => c.charCodeAt(0) & 0xff), dict);
}

/** Put a signature dictionary (with room for the signature) into the document. */
export function addSignatureDict(m: typeof MuPDF, doc: MuPDF.PDFDocument, o: SignOptions): void {
  const form = ensureForm(doc);
  const sig = doc.addObject(doc.newDictionary());
  sig.put("Type", doc.newName("Sig"));
  sig.put("Filter", doc.newName("Adobe.PPKLite"));
  sig.put("SubFilter", doc.newName("adbe.pkcs7.detached"));
  sig.put("ByteRange", RANGE_PLACEHOLDER);
  sig.put("Contents", doc.newByteString(new Uint8Array(SIG_ROOM)));
  sig.put("M", doc.newString(pdfDate(o.time)));
  if (o.name) sig.put("Name", doc.newString(o.name));
  if (o.reason) sig.put("Reason", doc.newString(o.reason));
  if (o.location) sig.put("Location", doc.newString(o.location));
  let widget: MuPDF.PDFObject;
  if (o.field) {
    const page = doc.loadPage(o.field.page) as MuPDF.PDFPage;
    const w = page.getWidgets()[o.field.widget];
    if (!w || w.getFieldType() !== "signature") throw new Error("That's not a signature box");
    if (!w.getObject().get("V").isNull()) throw new Error("This box is already signed");
    widget = w.getObject();
    const r = widget.get("Rect");
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => r.get(i).asNumber());
    const ap = doc.newDictionary();
    ap.put("N", signedAppearance(m, doc, Math.abs(x1 - x0), Math.abs(y1 - y0), o.lines));
    widget.put("AP", ap);
    // (print, and locked: nobody moves a signed box)
    widget.put("F", 4 | 128);
  } else {
    // a signature not shown: an empty box on the first page
    const page = doc.findPage(0);
    let n = 1;
    const names = new Set<string>();
    form.get("Fields").forEach((f) => names.add(f.get("T").isString() ? f.get("T").asString() : ""));
    while (names.has(`Signature${n}`)) n++;
    widget = doc.addObject({
      Type: doc.newName("Annot"),
      Subtype: doc.newName("Widget"),
      FT: doc.newName("Sig"),
      T: doc.newString(`Signature${n}`),
      Rect: [0, 0, 0, 0],
      F: 4 | 128,
      P: page,
    });
    if (!page.get("Annots").isArray()) page.put("Annots", doc.newArray());
    page.get("Annots").push(widget);
    form.get("Fields").push(widget);
  }
  widget.put("V", sig);
  form.put("SigFlags", 3);
}

/** Some field in the form is a signed signature field. */
function hasSignedField(doc: MuPDF.PDFDocument): boolean {
  const fields = doc.getTrailer().get("Root", "AcroForm", "Fields");
  if (!fields.isArray()) return false;
  let found = false;
  let budget = 20000;
  const walk = (f: MuPDF.PDFObject, ft: string, depth: number) => {
    if (found || depth > 20 || --budget < 0 || !f.isDictionary()) return;
    const type = f.get("FT").isName() ? f.get("FT").asName() : ft;
    if (type === "Sig" && f.get("V").isDictionary()) found = true;
    const kids = f.get("Kids");
    if (kids.isArray()) for (let i = 0; i < kids.length && !found; i++) walk(kids.get(i), type, depth + 1);
  };
  for (let i = 0; i < fields.length && !found; i++) walk(fields.get(i), "", 0);
  return found;
}

/** The digital signatures in a document (signed signature fields), in page order. */
export function listSignatures(doc: MuPDF.PDFDocument): SigInfo[] {
  // (quick look first: most PDFs have no signed field at all, and big ones have many pages)
  if (!hasSignedField(doc)) return [];
  const out: SigInfo[] = [];
  const seen = new Set<number>();
  const n = doc.countPages();
  const add = (w: MuPDF.PDFObject, page: number, rect: Rect) => {
    const v = w.get("V").isDictionary() ? w.get("V") : w.get("Parent").get("V");
    if (!v.isDictionary() || !v.get("ByteRange").isArray() || !v.get("Contents").isString()) return;
    const num = v.isIndirect() ? v.asIndirect() : -1;
    if (num > 0 && seen.has(num)) return;
    seen.add(num);
    const str = (k: string) => (v.get(k).isString() ? v.get(k).asString() : "");
    const br = v.get("ByteRange");
    const t = w.get("T").isString() ? w.get("T").asString() : w.get("Parent").get("T").isString() ? w.get("Parent").get("T").asString() : "";
    out.push({
      field: t,
      page,
      rect,
      name: str("Name"),
      reason: str("Reason"),
      location: str("Location"),
      time: str("M") ? parsePdfDate(str("M")) : 0,
      subFilter: v.get("SubFilter").isName() ? v.get("SubFilter").asName() : "",
      byteRange: [0, 1, 2, 3].map((i) => br.get(i).asNumber()),
      contents: v.get("Contents").asByteString(),
    });
  };
  for (let i = 0; i < n; i++) {
    const page = doc.loadPage(i) as MuPDF.PDFPage;
    for (const w of page.getWidgets()) {
      if (w.getFieldType() !== "signature") continue;
      const r = w.getBounds() as Rect;
      const empty = Math.abs(r[2] - r[0]) < 1 || Math.abs(r[3] - r[1]) < 1;
      add(w.getObject(), empty ? -1 : i, empty ? [0, 0, 0, 0] : r);
    }
  }
  return out;
}
