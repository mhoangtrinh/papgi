// Copy, cut, paste and erase. A copied thing lives in its own little PDF (so it survives
// opening another file) as annotation dictionaries ready to graft into any document:
// - added items (text boxes, drawings, signatures...) are copied as they are;
// - a part of the page itself becomes a stamp whose appearance is that part of the page
//   (vector, text kept), marked /PapgiArea. It can be moved like any added item, and is
//   baked into the page content when the file is saved.
import type * as MuPDF from "mupdf";
import type { Point, Quad, Rect } from "../core/geometry";
import { arrowHeadPoints } from "../core/shapes";
import { brushRects, brushTouchesOutline, brushTouchesRect, brushTouchesSegment, eraseStroke, inRects, quadCenter } from "../core/erase";
import { appendContent, ownResources } from "./ocr";

type M = typeof MuPDF;

export const AREA_KEY = "PapgiArea";

export interface ClipItem {
  obj: MuPDF.PDFObject; // annotation dictionary in the clip document
  rect: Rect; // where it was, in the source page's space
  area: boolean;
  /** A form field's box: the field's name, and the field it belongs to when it's one of several boxes (radio buttons). */
  field?: { name: string; group: number | null };
}

export interface Clip {
  doc: MuPDF.PDFDocument;
  text: string;
  items: ClipItem[];
  rect: Rect; // bounds of all items
  ctm: MuPDF.Matrix; // source page: PDF space -> page space
  label: string;
  /** Fields that own several copied boxes (radio groups), by their number in the source. */
  parents?: Map<number, MuPDF.PDFObject>;
  /** The source form's fonts (/DR), for fields. */
  dr?: MuPDF.PDFObject | null;
}

export interface ClipInfo {
  label: string;
  w: number;
  h: number;
  /** Its text, for the system clipboard (other apps get this). */
  text: string;
}

/** Keys that tie an annotation to its page or document (not copied). */
const DROP_KEYS = new Set(["P", "Popup", "IRT", "Parent", "NM", "StructParent"]);
/** Glyphs are removed with a tiny box at their centre: MuPDF removes every glyph a box touches. */
const DOT = 0.05;

const num = (v: number) => (Math.abs(v) < 1e-6 ? "0" : String(+v.toFixed(4)));

export function isArea(a: MuPDF.PDFAnnotation | MuPDF.PDFObject): boolean {
  const o = "getObject" in a ? a.getObject() : a;
  const v = o.get(AREA_KEY);
  return v.isBoolean() && v.asBoolean();
}

function pdfRect(m: M, r: Rect, ctm: MuPDF.Matrix): Rect {
  return m.Rect.transform(r, m.Matrix.invert(ctm)) as Rect;
}

function rectQuad(r: Rect): Quad {
  return [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]];
}

/** The page's content streams, decoded and joined. */
function contentBytes(pageObj: MuPDF.PDFObject): Uint8Array {
  const c = pageObj.get("Contents");
  const parts: Uint8Array[] = [];
  const add = (s: MuPDF.PDFObject) => {
    if (s.isStream()) {
      const b = s.readStream();
      parts.push(b.asUint8Array().slice(), new Uint8Array([10]));
      b.destroy();
    }
  };
  if (c.isArray()) c.forEach((s) => add(s));
  else add(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

/** Remove exactly the glyphs whose centre passes the test. Returns how many. */
function removeGlyphs(m: M, page: MuPDF.PDFPage, test: (c: Point) => boolean): number {
  const quads: Quad[] = [];
  const st = page.toStructuredText("");
  try {
    st.walk({
      onChar(_c, _o, _f, _s, q) {
        const [x, y] = quadCenter(q);
        if (test([x, y])) quads.push(rectQuad([x - DOT, y - DOT, x + DOT, y + DOT]));
      },
    });
  } finally {
    st.destroy();
  }
  if (!quads.length) return 0;
  const a = page.createAnnotation("Redact");
  a.setQuadPoints(quads);
  a.update();
  page.applyRedactions(false, m.PDFPage.REDACT_IMAGE_NONE, m.PDFPage.REDACT_LINE_ART_NONE, m.PDFPage.REDACT_TEXT_REMOVE);
  return quads.length;
}

/** Remove pictures' pixels and drawings fully inside these areas (and with `text`, every glyph touching them). */
function clearGraphics(m: M, page: MuPDF.PDFPage, rects: Rect[], text = false): void {
  if (!rects.length) return;
  const a = page.createAnnotation("Redact");
  a.setQuadPoints(rects.map(rectQuad));
  a.update();
  page.applyRedactions(false, m.PDFPage.REDACT_IMAGE_PIXELS, m.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, text ? m.PDFPage.REDACT_TEXT_REMOVE : m.PDFPage.REDACT_TEXT_NONE);
}

/**
 * Really erase what's printed in these areas: glyphs centred inside, pictures' pixels and
 * drawings inside are removed, then the areas are painted white (so parts of lines and
 * letters reaching in are rubbed out too).
 */
export function eraseRects(m: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, rects: Rect[], opts: { fields?: boolean; annots?: boolean; fill?: number[] } = {}): void {
  if (!rects.length) return;
  // the colour around the erased part (paper, or a coloured band it sits in), or the one given (redaction: black)
  const [r, g, b] = opts.fill ? opts.fill.map((v) => v * 255) : surroundColor(m, page, rects);
  const mid = (f: Rect) => inRects(rects, (f[0] + f[2]) / 2, (f[1] + f[3]) / 2);
  // form fields (and added items) whose middle is in the erased part go too
  if (opts.fields !== false) removeFields(page, mid);
  if (opts.annots) for (const rr of rects) for (const a of itemsIn(page, rr).annots) page.deleteAnnotation(a);
  clearGraphics(m, page, rects);
  removeGlyphs(m, page, (c) => inRects(rects, c[0], c[1]));
  const inv = m.Matrix.invert(page.getTransform());
  const pt = (x: number, y: number) => `${num(x * inv[0] + y * inv[2] + inv[4])} ${num(x * inv[1] + y * inv[3] + inv[5])}`;
  let ops = `q ${num(r / 255)} ${num(g / 255)} ${num(b / 255)} rg\n`;
  for (const r of rects) ops += `${pt(r[0], r[1])} m ${pt(r[2], r[1])} l ${pt(r[2], r[3])} l ${pt(r[0], r[3])} l h f\n`;
  appendContent(doc, page.getObject(), ops + "Q\n");
}

/**
 * The colour just around these areas: the most common colour on a ring around them, if
 * most of the ring has it (a plain background); otherwise white.
 */
export function surroundColor(m: M, page: MuPDF.PDFPage, rects: Rect[]): [number, number, number] {
  const pad = 2.5;
  const ub = bounds(rects);
  const area: Rect = [ub[0] - pad - 1, ub[1] - pad - 1, ub[2] + pad + 1, ub[3] + pad + 1];
  const s = Math.min(1.5, 400 / Math.max(area[2] - area[0], area[3] - area[1], 1));
  const w = Math.max(1, Math.ceil((area[2] - area[0]) * s));
  const h = Math.max(1, Math.ceil((area[3] - area[1]) * s));
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], false);
  try {
    pix.clear(255);
    const dev = new m.DrawDevice(m.Matrix.identity, pix);
    page.runPageContents(dev, m.Matrix.concat(m.Matrix.translate(-area[0], -area[1]), m.Matrix.scale(s, s)));
    dev.close();
    dev.destroy();
    const px = pix.getPixels();
    const stride = pix.getStride();
    const pb = page.getBounds() as Rect;
    const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
    let total = 0;
    const sample = (x: number, y: number) => {
      if (x < pb[0] || y < pb[1] || x > pb[2] || y > pb[3] || inRects(rects, x, y)) return;
      const ix = Math.floor((x - area[0]) * s);
      const iy = Math.floor((y - area[1]) * s);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return;
      const o = iy * stride + ix * 3;
      const r = px[o], g = px[o + 1], b = px[o + 2];
      const k = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      const c = counts.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      c.n++;
      c.r += r;
      c.g += g;
      c.b += b;
      counts.set(k, c);
      total++;
    };
    for (const r of rects) {
      const [x0, y0, x1, y1] = [r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad];
      const step = Math.max(0.75, Math.max(x1 - x0, y1 - y0) / 200);
      for (let x = x0; x <= x1; x += step) {
        sample(x, y0);
        sample(x, y1);
      }
      for (let y = y0; y <= y1; y += step) {
        sample(x0, y);
        sample(x1, y);
      }
    }
    let best: { n: number; r: number; g: number; b: number } | null = null;
    for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    if (!best || best.n < total * 0.5) return [255, 255, 255];
    return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
  } finally {
    pix.destroy();
  }
}

/** Remove form fields (their boxes on this page) that pass the test. Returns how many. */
export function removeFields(page: MuPDF.PDFPage, test: (r: Rect) => boolean): number {
  const gone = page.getWidgets().filter((w) => {
    try {
      return test(w.getBounds() as Rect);
    } catch {
      return false; // (already removed)
    }
  });
  // (MuPDF also takes them off the form's list of fields)
  for (const w of gone) page.deleteAnnotation(w);
  return gone.length;
}

/** Remove just the added items and form fields in an area (the page itself stays). */
export function removeItemsIn(page: MuPDF.PDFPage, rect: Rect): boolean {
  const inside = itemsIn(page, rect);
  for (const a of inside.annots) page.deleteAnnotation(a);
  for (const w of inside.widgets) page.deleteAnnotation(w);
  return inside.annots.length + inside.widgets.length > 0;
}

/** Added items and form field boxes whose middle is inside `rect`. */
export function itemsIn(page: MuPDF.PDFPage, rect: Rect): { annots: MuPDF.PDFAnnotation[]; widgets: MuPDF.PDFWidget[] } {
  const mid = (b: Rect) => inRects([rect], (b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  const annots = page.getAnnotations().filter((a) => {
    const t = a.getType();
    return t !== "Widget" && t !== "Link" && t !== "Popup" && mid(a.getBounds() as Rect);
  });
  const widgets = page.getWidgets().filter((w) => {
    try {
      return mid(w.getBounds() as Rect);
    } catch {
      return false;
    }
  });
  return { annots, widgets };
}

/** An annotation as a clip item: its dictionary without the ties to its page. */
function annotItem(doc: MuPDF.PDFDocument, map: MuPDF.PDFGraftMap, cd: MuPDF.PDFDocument, a: MuPDF.PDFAnnotation): ClipItem {
  const o = a.getObject();
  const d = doc.newDictionary();
  o.forEach((v, k) => {
    if (!DROP_KEYS.has(String(k))) d.put(String(k), v);
  });
  return { obj: cd.addObject(map.graftObject(d)), rect: a.getBounds() as Rect, area: isArea(o) };
}

/** Field settings that a box can inherit from the fields above it. */
const INHERITED = ["FT", "Ff", "V", "DV", "DA", "Q", "Opt", "MaxLen", "TU"];

/**
 * Form field boxes as clip items. A box that is a field of its own is copied with what it
 * inherits; boxes of a field with several (radio buttons) keep a copy of that field.
 */
function fieldItems(doc: MuPDF.PDFDocument, map: MuPDF.PDFGraftMap, cd: MuPDF.PDFDocument, widgets: MuPDF.PDFWidget[], parents: Map<number, MuPDF.PDFObject>): ClipItem[] {
  const items: ClipItem[] = [];
  const own = (o: MuPDF.PDFObject, skip: string[]) => {
    const d = doc.newDictionary();
    o.forEach((v, k) => {
      if (!skip.includes(String(k))) d.put(String(k), v);
    });
    for (const k of INHERITED) if (d.get(k).isNull()) {
      const v = o.getInheritable(k);
      if (!v.isNull()) d.put(k, v);
    }
    return d;
  };
  for (const w of widgets) {
    const o = w.getObject();
    const parent = o.get("Parent");
    const name = w.getName().replace(/\./g, "_") || "Field";
    const rect = w.getBounds() as Rect;
    if (o.get("T").isNull() && parent.isDictionary() && parent.isIndirect()) {
      // one box of a field with several
      const key = parent.asIndirect();
      if (!parents.has(key)) parents.set(key, cd.addObject(map.graftObject(own(parent, ["Kids", "Parent", "P"]))));
      items.push({ obj: cd.addObject(map.graftObject(own(o, [...DROP_KEYS, "Parent"]))), rect, area: false, field: { name, group: key } });
    } else {
      const d = own(o, [...DROP_KEYS, "Parent", "Kids"]);
      items.push({ obj: cd.addObject(map.graftObject(d)), rect, area: false, field: { name, group: null } });
    }
  }
  return items;
}

/** Copy added items (annotations) of a page. */
export function copyAnnots(m: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, indices: number[]): Clip {
  const cd = new m.PDFDocument();
  const map = cd.newGraftMap();
  const list = page.getAnnotations();
  const items: ClipItem[] = [];
  for (const i of indices) {
    const a = list[i];
    if (a) items.push(annotItem(doc, map, cd, a));
  }
  if (!items.length) {
    cd.destroy();
    throw new Error("Nothing to copy");
  }
  const kinds = new Set(indices.map((i) => list[i]?.getType()));
  const label = items.length > 1 ? `${items.length} items` : items[0].area ? "part of a page" : kinds.has("FreeText") ? "text box" : kinds.has("Ink") ? "drawing" : kinds.has("Stamp") ? "picture" : "item";
  const text = indices.map((i) => list[i]).filter((a) => a && (a.getType() === "FreeText" || isArea(a))).map((a) => a.getContents()).join("\n");
  return { doc: cd, text, items, rect: bounds(items.map((x) => x.rect)), ctm: page.getTransform(), label };
}

/**
 * Copy what's printed in a part of a page, as vector content (text stays text). Glyphs
 * count as inside when their centre is; the copy grows to hold them whole.
 * Returns null if there's nothing there.
 */
export function copyArea(m: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, rect: Rect, withItems = true, content = true): Clip | null {
  const src = page.getObject();
  const cd = new m.PDFDocument();
  try {
    const map = cd.newGraftMap();
    // added items and form fields in the area come along (not when they're moved as they are)
    const items: ClipItem[] = [];
    const parents = new Map<number, MuPDF.PDFObject>();
    let dr: MuPDF.PDFObject | null = null;
    if (withItems) {
      const inside = itemsIn(page, rect);
      for (const a of inside.annots) items.push(annotItem(doc, map, cd, a));
      items.push(...fieldItems(doc, map, cd, inside.widgets, parents));
      const d = doc.getTrailer().get("Root", "AcroForm", "DR");
      if (inside.widgets.length && d.isDictionary()) dr = cd.addObject(map.graftObject(d));
    }
    const pageCtm = page.getTransform();
    const itemsOnly = (): Clip | null => {
      if (!items.length) {
        cd.destroy();
        return null;
      }
      return { doc: cd, text: "", items, rect: bounds(items.map((x) => x.rect)), ctm: pageCtm, label: "part of the page", parents, dr };
    };
    if (!content) return itemsOnly();
    const res = src.getInheritable("Resources");
    const box = (k: string) => {
      const v = src.getInheritable(k);
      return v.isArray() && v.length === 4 ? ([0, 1, 2, 3].map((i) => v.get(i).asNumber()) as Rect) : null;
    };
    const rot = src.getInheritable("Rotate");
    const pobj = cd.addPage(box("MediaBox") ?? [0, 0, 612, 792], (rot.isNumber() ? rot.asNumber() : 0) as MuPDF.Rotate, res.isDictionary() ? map.graftObject(res) : {}, contentBytes(src));
    const crop = box("CropBox");
    if (crop) pobj.put("CropBox", crop);
    const uu = src.get("UserUnit");
    if (uu.isNumber()) pobj.put("UserUnit", uu.asNumber());
    cd.insertPage(-1, pobj);
    const cp = cd.loadPage(0);
    try {
      // glyphs centred inside stay (and the copy grows to hold them whole); all others go
      let keep: Rect = [...rect];
      let text = "";
      const st = cp.toStructuredText("");
      st.walk({
        onChar(c, _o, _f, _s, q) {
          const [x, y] = quadCenter(q);
          if (!inRects([rect], x, y)) return;
          text += c;
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          keep = [Math.min(keep[0], ...xs), Math.min(keep[1], ...ys), Math.max(keep[2], ...xs), Math.max(keep[3], ...ys)];
        },
        endLine() {
          text += "\n";
        },
      });
      st.destroy();
      // everything outside goes (letters reaching in from outside too: they touch the bands)
      keep = [keep[0] - 0.5, keep[1] - 0.5, keep[2] + 0.5, keep[3] + 0.5];
      const b = cp.getBounds() as Rect;
      const big = 1e4;
      const out: Rect[] = [
        [b[0] - big, b[1] - big, b[2] + big, keep[1]],
        [b[0] - big, keep[3], b[2] + big, b[3] + big],
        [b[0] - big, keep[1], keep[0], keep[3]],
        [keep[2], keep[1], b[2] + big, keep[3]],
      ];
      clearGraphics(m, cp, out.filter((r) => r[2] > r[0] && r[3] > r[1]), true);
      if (isBlank(m, cp, keep)) return itemsOnly();
      const ctm = cp.getTransform();
      const cpo = cp.getObject();
      const form = cd.addStream(contentBytes(cpo), {});
      form.put("Type", cd.newName("XObject"));
      form.put("Subtype", cd.newName("Form"));
      form.put("BBox", pdfRect(m, keep, ctm));
      const r2 = cpo.getInheritable("Resources");
      if (r2.isDictionary()) form.put("Resources", r2);
      const annot = cd.addObject(cd.newDictionary());
      annot.put("Type", cd.newName("Annot"));
      annot.put("Subtype", cd.newName("Stamp"));
      annot.put("F", 4);
      annot.put(AREA_KEY, true);
      const ap = cd.newDictionary();
      ap.put("N", form);
      annot.put("AP", ap);
      annot.put("Rect", pdfRect(m, keep, ctm));
      const t = text.replace(/\s+\n/g, "\n").trim();
      if (t) annot.put("Contents", cd.newString(t));
      const all = [{ obj: annot, rect: keep, area: true }, ...items];
      return { doc: cd, text: t, items: all, rect: bounds(all.map((x) => x.rect)), ctm, label: "part of the page", parents, dr };
    } finally {
      cp.destroy();
    }
  } catch (e) {
    cd.destroy();
    throw e;
  }
}

/** Nothing drawn in this part of the page? */
function isBlank(m: M, page: MuPDF.PDFPage, r: Rect): boolean {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  if (w <= 0 || h <= 0) return true;
  const s = Math.min(1, 300 / Math.max(w, h));
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, Math.ceil(w * s), Math.ceil(h * s)], true);
  try {
    pix.clear();
    const dev = new m.DrawDevice(m.Matrix.identity, pix);
    page.runPageContents(dev, m.Matrix.concat(m.Matrix.translate(-r[0], -r[1]), m.Matrix.scale(s, s)));
    dev.close();
    dev.destroy();
    const px = pix.getPixels();
    for (let i = 3; i < px.length; i += 4) if (px[i] > 8) return false;
    return true;
  } finally {
    pix.destroy();
  }
}

function bounds(rects: Rect[]): Rect {
  return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
}

/**
 * Paste the clip on a page so that its top-left corner lands at `topLeft` (page space).
 * Returns the new annotations' object numbers.
 */
export function pasteClip(m: M, doc: MuPDF.PDFDocument, index: number, clip: Clip, topLeft: Point): number[] {
  const pobj = doc.findPage(index);
  const map = doc.newGraftMap();
  let annots = pobj.get("Annots");
  if (!annots.isArray()) {
    annots = doc.newArray();
    pobj.put("Annots", annots);
  }
  const dx = topLeft[0] - clip.rect[0];
  const dy = topLeft[1] - clip.rect[1];
  const placed: { num: number; it: ClipItem }[] = [];
  const page = doc.loadPage(index);
  const hasFields = clip.items.some((it) => it.field);
  const form = hasFields ? acroForm(doc, clip.dr ?? null, map) : null;
  const names = hasFields ? fieldNames(doc) : new Set<string>();
  // a pasted field is a new field: its own name, so it doesn't share its value with the original
  const unique = (name: string) => {
    let n = name;
    for (let k = 2; names.has(n); k++) n = `${name} (${k})`;
    names.add(n);
    return n;
  };
  const groups = new Map<number, MuPDF.PDFObject>();
  try {
    const ctm = page.getTransform();
    for (const it of clip.items) {
      const g = map.graftObject(it.obj);
      g.put("P", pobj);
      annots.push(g);
      placed.push({ num: g.asIndirect(), it });
      if (it.field && form) {
        g.put("Rect", pdfRect(m, translate(it.rect, dx, dy), ctm));
        const fields = form.get("Fields");
        if (it.field.group !== null && clip.parents?.has(it.field.group)) {
          let par = groups.get(it.field.group);
          if (!par) {
            par = map.graftObject(clip.parents.get(it.field.group)!);
            par.put("T", doc.newString(unique(it.field.name)));
            par.put("Kids", doc.newArray());
            fields.push(par);
            groups.set(it.field.group, par);
          }
          g.put("Parent", par);
          par.get("Kids").push(g);
        } else {
          g.put("T", doc.newString(unique(it.field.name)));
          fields.push(g);
        }
      }
      if (it.area) {
        g.put("Rect", pdfRect(m, [it.rect[0] + dx, it.rect[1] + dy, it.rect[2] + dx, it.rect[3] + dy], ctm));
        // turn the content as needed when the pages are turned differently
        const lin = m.Matrix.concat(clip.ctm, m.Matrix.invert(ctm));
        g.get("AP").get("N").put("Matrix", [lin[0], lin[1], lin[2], lin[3], 0, 0]);
      }
    }
  } finally {
    page.destroy();
  }
  // move the other items into place (they keep their own coordinates when grafted)
  const fresh = doc.loadPage(index);
  try {
    const list = fresh.getAnnotations();
    for (const { num: n, it } of placed) {
      if (it.area || it.field) continue;
      const a = list.find((x) => x.getObject().asIndirect() === n);
      if (!a) continue;
      const b = a.getBounds();
      shiftAnnot(m, fresh, a, it.rect[0] + dx - b[0], it.rect[1] + dy - b[1]);
    }
  } finally {
    fresh.destroy();
  }
  return placed.map((p) => p.num);
}

/**
 * Move annotations and form field boxes (by object number) by (dx, dy) in page space,
 * onto page `to` if that's another page. Fields stay the same fields.
 */
export function moveObjects(m: M, doc: MuPDF.PDFDocument, from: number, to: number, nums: number[], dx: number, dy: number): void {
  if (!nums.length) return;
  const want = new Set(nums);
  const targets = new Map<number, Rect>();
  const src = doc.loadPage(from);
  try {
    for (const a of [...src.getAnnotations(), ...src.getWidgets()]) {
      const n = a.getObject().asIndirect();
      if (want.has(n)) targets.set(n, translate(a.getBounds() as Rect, dx, dy));
    }
  } finally {
    src.destroy();
  }
  if (from !== to) {
    const sObj = doc.findPage(from);
    const dObj = doc.findPage(to);
    const sAnn = sObj.get("Annots");
    let dAnn = dObj.get("Annots");
    if (!dAnn.isArray()) {
      dAnn = doc.newArray();
      dObj.put("Annots", dAnn);
      dAnn = dObj.get("Annots");
    }
    if (sAnn.isArray())
      for (let i = sAnn.length - 1; i >= 0; i--) {
        const o = sAnn.get(i);
        if (!o.isIndirect() || !(want.has(o.asIndirect()) || (o.get("Parent").isIndirect() && want.has(o.get("Parent").asIndirect()) && o.get("Subtype").asName() === "Popup"))) continue;
        sAnn.delete(i);
        o.put("P", dObj);
        dAnn.push(o);
      }
  }
  const dst = doc.loadPage(to);
  try {
    const ctm = dst.getTransform();
    for (const a of dst.getAnnotations()) {
      const t = targets.get(a.getObject().asIndirect());
      if (!t) continue;
      const b = a.getBounds();
      shiftAnnot(m, dst, a, t[0] - b[0], t[1] - b[1]);
    }
    // field boxes keep their own look: just their place changes
    for (const w of dst.getWidgets()) {
      const t = targets.get(w.getObject().asIndirect());
      if (t) w.getObject().put("Rect", pdfRect(m, t, ctm));
    }
  } finally {
    dst.destroy();
  }
}

const translate = (r: Rect, dx: number, dy: number): Rect => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy];

/** All field names in a document (full names). */
function fieldNames(doc: MuPDF.PDFDocument): Set<string> {
  const out = new Set<string>();
  const walk = (list: MuPDF.PDFObject, prefix: string, depth: number) => {
    if (!list.isArray() || depth > 20) return;
    list.forEach((f) => {
      const t = f.get("T");
      const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix;
      if (name) out.add(name);
      walk(f.get("Kids"), name, depth + 1);
    });
  };
  walk(doc.getTrailer().get("Root", "AcroForm", "Fields"), "", 0);
  return out;
}

/** The document's form (made if there's none yet), with the fonts fields need. */
function acroForm(doc: MuPDF.PDFDocument, dr: MuPDF.PDFObject | null, map: MuPDF.PDFGraftMap): MuPDF.PDFObject {
  const root = doc.getTrailer().get("Root");
  let form = root.get("AcroForm");
  if (!form.isDictionary()) {
    root.put("AcroForm", doc.addObject(doc.newDictionary()));
    form = root.get("AcroForm");
  }
  if (!form.get("Fields").isArray()) form.put("Fields", doc.newArray());
  if (dr?.isDictionary()) {
    const g = map.graftObject(dr);
    let own = form.get("DR");
    if (!own.isDictionary()) form.put("DR", g);
    else {
      // add the fonts (and other resources) this form doesn't have yet
      g.forEach((sub, kind) => {
        if (!sub.isDictionary()) return;
        let mine = own.get(String(kind));
        if (!mine.isDictionary()) {
          own.put(String(kind), sub);
          return;
        }
        sub.forEach((v, k) => {
          if (mine.get(String(k)).isNull()) mine.put(String(k), v);
        });
      });
      own = form.get("DR");
    }
  }
  return form;
}

/**
 * Arrows get their own appearance: MuPDF draws arrowheads about 9× the line width, far
 * too big for thick lines. Call after every update() of a Line annotation (an update
 * redraws it MuPDF's way). Plain lines are left to MuPDF.
 */
export function arrowAppearance(m: M, page: MuPDF.PDFPage, a: MuPDF.PDFAnnotation): void {
  if (a.getType() !== "Line") return;
  const le = a.getLineEndingStyles();
  if (le.start === "None" && le.end === "None") return;
  const doc = page._doc;
  const [p, q] = a.getLine() as [Point, Point];
  const w = a.getBorderWidth() || 1;
  const c = a.getColor();
  const inv = m.Matrix.invert(page.getTransform());
  const pdf = ([x, y]: Point): Point => [x * inv[0] + y * inv[2] + inv[4], x * inv[1] + y * inv[3] + inv[5]];
  const pt = (v: Point) => pdf(v).map(num).join(" ");
  const heads: Point[][] = [];
  if (le.end !== "None") heads.push([...arrowHeadPoints(p, q, w).slice(0, 1), q, arrowHeadPoints(p, q, w)[1]]);
  if (le.start !== "None") heads.push([arrowHeadPoints(q, p, w)[0], p, arrowHeadPoints(q, p, w)[1]]);
  const col = c.length === 3 ? `${c.map(num).join(" ")} RG` : c.length === 1 ? `${num(c[0])} G` : c.length === 4 ? `${c.map(num).join(" ")} K` : "0 G";
  const dash = a.getBorderStyle() === "Dashed" ? `[${(a.getBorderDashPattern() as number[]).map(num).join(" ")}] 0 d` : "";
  const op = a.getOpacity();
  let ops = `q ${op < 1 ? "/G0 gs " : ""}${num(w)} w ${col} 1 J 1 j ${dash}\n${pt(p)} m ${pt(q)} l S\n[] 0 d\n`;
  for (const h of heads) ops += `${pt(h[0])} m ${pt(h[1])} l ${pt(h[2])} l S\n`;
  ops += "Q\n";
  // the box: everything drawn, with room for the line width
  const all = [p, q, ...heads.flat()].map(pdf);
  const pad = w;
  const bbox: Rect = [Math.min(...all.map((v) => v[0])) - pad, Math.min(...all.map((v) => v[1])) - pad, Math.max(...all.map((v) => v[0])) + pad, Math.max(...all.map((v) => v[1])) + pad];
  const form = doc.addStream(ops, {});
  form.put("Type", doc.newName("XObject"));
  form.put("Subtype", doc.newName("Form"));
  form.put("BBox", bbox);
  if (op < 1) {
    const res = doc.newDictionary();
    const gs = doc.newDictionary();
    const g0 = doc.newDictionary();
    g0.put("CA", op);
    g0.put("ca", op);
    gs.put("G0", g0);
    res.put("ExtGState", gs);
    form.put("Resources", res);
  }
  const ap = doc.newDictionary();
  ap.put("N", form);
  const o = a.getObject();
  o.put("AP", ap);
  o.put("Rect", bbox);
}

/** Can this kind of item be resized by its corners? */
export function resizable(type: string): boolean {
  return ["Stamp", "Square", "Circle", "Polygon", "Ink", "Line"].includes(type);
}

/** Fit an item into `r` (page space): its outline box is stretched onto r. */
export function resizeAnnot(m: M, page: MuPDF.PDFPage, a: MuPDF.PDFAnnotation, r: Rect): void {
  const b = a.getBounds() as Rect;
  const type = a.getType();
  if (type === "Stamp") {
    // a picture keeps its look: only its box changes
    a.getObject().put("Rect", pdfRect(m, r, page.getTransform()));
    return;
  }
  // the margin around the geometry (line width, arrow heads) stays as it is: only the geometry stretches
  const pts: Point[] = a.hasInkList()
    ? a.getInkList().flat().map((p) => p as Point)
    : a.hasVertices()
      ? a.getVertices().map((p) => p as Point)
      : a.hasLine()
        ? a.getLine().map((p) => p as Point)
        : (() => {
            const rr = a.getRect();
            return [[rr[0], rr[1]], [rr[2], rr[3]]] as Point[];
          })();
  const inner: Rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
  const target: Rect = [r[0] + (inner[0] - b[0]), r[1] + (inner[1] - b[1]), r[2] - (b[2] - inner[2]), r[3] - (b[3] - inner[3])];
  const sx = (target[2] - target[0]) / Math.max(inner[2] - inner[0], 0.01);
  const sy = (target[3] - target[1]) / Math.max(inner[3] - inner[1], 0.01);
  const map = ([x, y]: Point): Point => [target[0] + (x - inner[0]) * sx, target[1] + (y - inner[1]) * sy];
  if (a.hasInkList()) a.setInkList(a.getInkList().map((st) => st.map((p) => map(p as Point))));
  else if (a.hasVertices()) a.setVertices(a.getVertices().map((p) => map(p as Point)));
  else if (a.hasLine()) {
    const [p, q] = a.getLine();
    a.setLine(map(p as Point), map(q as Point));
  } else {
    const rr = a.getRect();
    const p0 = map([rr[0], rr[1]]);
    const p1 = map([rr[2], rr[3]]);
    a.setRect([p0[0], p0[1], p1[0], p1[1]]);
  }
  a.update();
  arrowAppearance(m, page, a);
}

/** Translate any kind of annotation by (dx, dy) in page space. */
export function shiftAnnot(m: M, page: MuPDF.PDFPage, a: MuPDF.PDFAnnotation, dx: number, dy: number): void {
  if (a.getType() === "Stamp" || a.getType() === "Widget") {
    // stamps keep their own appearance: move the box only (an update would redraw it as "Draft")
    const r = a.getBounds() as Rect;
    a.getObject().put("Rect", pdfRect(m, [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy], page.getTransform()));
    return;
  }
  if (a.hasInkList()) {
    a.setInkList(a.getInkList().map((s) => s.map(([x, y]) => [x + dx, y + dy] as Point)));
  } else if (a.hasQuadPoints()) {
    a.setQuadPoints(a.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 ? dy : dx)) as Quad));
  } else if (a.hasLine()) {
    const [p, q] = a.getLine();
    a.setLine([p[0] + dx, p[1] + dy], [q[0] + dx, q[1] + dy]);
  } else if (a.hasVertices()) {
    a.setVertices(a.getVertices().map(([x, y]) => [x + dx, y + dy] as Point));
  } else if (a.hasRect()) {
    const r = a.getRect();
    a.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  }
  a.update();
  arrowAppearance(m, page, a);
}

/**
 * Turn pasted parts of pages (area stamps) into page content. With `only`, just those
 * annotations (object numbers). Returns the pages changed.
 */
export function bakeAreas(doc: MuPDF.PDFDocument, pages?: number[], only?: Set<number>): number[] {
  const changed: number[] = [];
  const list = pages ?? [...Array(doc.countPages()).keys()];
  for (const i of list) {
    const pobj = doc.findPage(i);
    const annots = pobj.get("Annots");
    if (!annots.isArray()) continue;
    let ops = "";
    for (let j = annots.length - 1; j >= 0; j--) {
      const a = annots.get(j);
      if (!a.isDictionary() || !isArea(a)) continue;
      if (only && !(a.isIndirect() && only.has(a.asIndirect()))) continue;
      const form = a.get("AP").get("N");
      annots.delete(j);
      if (!form.isStream()) continue;
      const nums = (o: MuPDF.PDFObject, n: number) => [...Array(n).keys()].map((k) => o.get(k).asNumber());
      const bb = nums(form.get("BBox"), 4);
      const fmObj = form.get("Matrix");
      const fm = fmObj.isArray() ? nums(fmObj, 6) : [1, 0, 0, 1, 0, 0];
      // the BBox as the form's matrix turns it (what gets fitted into the Rect)
      const cs = [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]].map(([x, y]) => [x * fm[0] + y * fm[2] + fm[4], x * fm[1] + y * fm[3] + fm[5]]);
      const tb = [Math.min(...cs.map((c) => c[0])), Math.min(...cs.map((c) => c[1])), Math.max(...cs.map((c) => c[0])), Math.max(...cs.map((c) => c[1]))];
      const rr = nums(a.get("Rect"), 4);
      const r = [Math.min(rr[0], rr[2]), Math.min(rr[1], rr[3]), Math.max(rr[0], rr[2]), Math.max(rr[1], rr[3])];
      const sx = (r[2] - r[0]) / (tb[2] - tb[0] || 1);
      const sy = (r[3] - r[1]) / (tb[3] - tb[1] || 1);
      const res = ownResources(doc, pobj);
      let xo = res.get("XObject");
      if (!xo.isDictionary()) {
        xo = doc.newDictionary();
        res.put("XObject", xo);
        xo = res.get("XObject");
      }
      let k = 1;
      while (!xo.get(`PapgiA${k}`).isNull()) k++;
      xo.put(`PapgiA${k}`, form);
      // drawn first-to-last in the order they were on the page
      ops = `q ${[sx, 0, 0, sy, r[0] - tb[0] * sx, r[1] - tb[1] * sy].map(num).join(" ")} cm /PapgiA${k} Do Q\n` + ops;
    }
    if (ops) {
      appendContent(doc, pobj, ops);
      changed.push(i);
    }
  }
  return changed;
}

/** Are there pasted parts of pages that still need baking? */
export function hasAreas(doc: MuPDF.PDFDocument): boolean {
  for (let i = 0; i < doc.countPages(); i++) {
    const annots = doc.findPage(i).get("Annots");
    if (!annots.isArray()) continue;
    for (let j = 0; j < annots.length; j++) if (isArea(annots.get(j))) return true;
  }
  return false;
}

/**
 * The eraser: rub out added items where the brush passes (drawings partly, other items
 * whole), and with `everything` also what's printed on the page. Returns whether
 * anything changed and whether the page content did.
 */
export function eraseBrush(m: M, doc: MuPDF.PDFDocument, index: number, path: Point[], r: number, everything: boolean): { changed: boolean; content: boolean } {
  let changed = false;
  let page = doc.loadPage(index);
  try {
    // pasted parts of pages under the brush become page content first, so they can be rubbed out partly
    if (everything) {
      const hit = new Set<number>();
      for (const a of page.getAnnotations()) if (isArea(a) && brushTouchesRect(path, r, a.getBounds() as Rect)) hit.add(a.getObject().asIndirect());
      if (hit.size) {
        bakeAreas(doc, [index], hit);
        page.destroy();
        page = doc.loadPage(index);
        changed = true;
      }
    }
    const gone: MuPDF.PDFAnnotation[] = [];
    for (const a of page.getAnnotations()) {
      const type = a.getType();
      if (type === "Widget" || type === "Link" || type === "Popup") continue;
      const b = a.getBounds() as Rect;
      if (!brushTouchesRect(path, r, b)) continue;
      const w = a.hasBorder() ? a.getBorderWidth() : 1;
      if (type === "Ink") {
        const strokes = a.getInkList();
        let touched = false;
        const pieces = strokes.flatMap((s) => {
          const out = eraseStroke(s, path, r, w);
          if (out.length !== 1 || out[0] !== s) touched = true;
          return out;
        });
        if (!touched) continue;
        changed = true;
        if (!pieces.length) gone.push(a);
        else {
          a.setInkList(pieces);
          a.update();
        }
      } else if (a.hasQuadPoints()) {
        const qs = a.getQuadPoints();
        const keep = qs.filter((q) => {
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          return !brushTouchesRect(path, r, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
        });
        if (keep.length === qs.length) continue;
        changed = true;
        if (!keep.length) gone.push(a);
        else {
          a.setQuadPoints(keep);
          a.update();
        }
      } else if (type === "Square" || type === "Circle" || type === "Polygon") {
        // a filled shape is touched anywhere on it, an empty one only on its outline
        const filled = a.hasInteriorColor() && a.getInteriorColor().length > 0;
        let hit = filled;
        if (!filled && type === "Polygon") {
          const v = a.getVertices();
          hit = v.some((p, i) => brushTouchesSegment(path, r + w / 2, p, v[(i + 1) % v.length]));
        } else if (!filled) hit = brushTouchesOutline(path, r, b, type === "Circle", w);
        if (!hit) continue;
        changed = true;
        gone.push(a);
      } else if (a.hasLine()) {
        const [p, q] = a.getLine();
        if (!brushTouchesSegment(path, r + w / 2, p, q)) continue;
        changed = true;
        gone.push(a);
      } else {
        changed = true;
        gone.push(a);
      }
    }
    for (const a of gone) page.deleteAnnotation(a);
    let content = false;
    if (everything) {
      // form fields the brush touches
      if (removeFields(page, (f) => brushTouchesRect(path, r, f))) changed = true;
      const rects = brushRects(path, r);
      if (rects.length) {
        eraseRects(m, doc, page, rects);
        changed = content = true;
      }
    }
    return { changed, content };
  } finally {
    page.destroy();
  }
}
