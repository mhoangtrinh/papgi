// PdfEngine: everything that touches the PDF, on top of MuPDF (WebAssembly).
// No DOM here, so it runs in a Web Worker in the app and directly in Node for tests.
// All coordinates are page space: PDF points, origin top-left, y down, rotation applied.

import type * as MuPDF from "mupdf";
import type { Point, Quad, Rect } from "../core/geometry";

type M = typeof MuPDF;
export type RGB = [number, number, number];

export interface PageInfo {
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
}

export interface DocInfo {
  pageCount: number;
  pages: PageInfo[];
  title: string;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
}

export type AnnotKind = "Highlight" | "Underline" | "StrikeOut" | "Squiggly" | "Ink" | "FreeText" | "Square" | "Circle" | "Line" | "Text" | "Stamp" | "Other";

export interface AnnotInfo {
  index: number; // index into page.getAnnotations()
  kind: AnnotKind;
  rect: Rect;
  color: number[];
  contents: string;
  fontSize?: number;
}

export type WidgetKind = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "button" | "signature";

export interface WidgetInfo {
  index: number; // index into page.getWidgets()
  kind: WidgetKind;
  name: string;
  rect: Rect;
  value: string;
  checked: boolean;
  options: string[];
  multiline: boolean;
  readOnly: boolean;
  maxLen: number;
  fontSize: number;
}

export interface SearchHit {
  page: number;
  quads: Quad[];
}

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

const SKIP_TYPES = new Set(["Widget", "Popup", "Link"]);
export const FREETEXT_PAD = 2;
export const LINE_HEIGHT = 1.2;

export class PdfEngine {
  protected doc: MuPDF.PDFDocument | null = null;
  private stext = new Map<number, MuPDF.StructuredText>();
  private lines = new Map<number, Rect[]>();
  private helv: MuPDF.Font | null = null;
  private title = "";
  // Each journal step gets a unique id, so "dirty" survives undo + new edit sequences.
  private stepIds: number[] = [];
  private nextStepId = 1;
  private savedId = 0;

  constructor(protected mupdf: M) {}

  // ---------- document ----------

  /** Open a PDF. Returns null if it needs a password (call authenticate next). */
  open(bytes: Uint8Array, title = ""): DocInfo | null {
    // Parse first, so a broken file leaves the current document open.
    const d = this.mupdf.Document.openDocument(bytes, "application/pdf");
    const pdf = d.asPDF();
    if (!pdf) {
      d.destroy();
      throw new Error("Not a PDF file");
    }
    this.close();
    this.doc = pdf;
    this.title = title;
    if (pdf.needsPassword()) return null;
    return this.afterOpen();
  }

  authenticate(password: string): DocInfo | null {
    if (!this.requireDoc().authenticatePassword(password)) return null;
    return this.afterOpen();
  }

  private afterOpen(): DocInfo {
    const doc = this.requireDoc();
    doc.enableJournal();
    this.stepIds = [];
    this.savedId = 0;
    return this.info();
  }

  close(): void {
    this.clearText();
    this.doc?.destroy();
    this.doc = null;
  }

  info(): DocInfo {
    const doc = this.requireDoc();
    const n = doc.countPages();
    const pages: PageInfo[] = [];
    for (let i = 0; i < n; i++) pages.push(this.pageInfo(i));
    return {
      pageCount: n,
      pages,
      title: doc.getMetaData("info:Title") || this.title,
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
      dirty: this.isDirty(),
    };
  }

  pageInfo(index: number): PageInfo {
    return this.withPage(index, (p) => {
      const [x0, y0, x1, y1] = p.getBounds();
      const rot = p.getObject().getInheritable("Rotate");
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rotation: rot.isNumber() ? ((rot.asNumber() % 360) + 360) % 360 : 0 };
    });
  }

  /** Cheap status for the toolbar (no page walk). */
  state(): { canUndo: boolean; canRedo: boolean; dirty: boolean; undoName: string; redoName: string } {
    const doc = this.requireDoc();
    let undoName = "";
    let redoName = "";
    try {
      const j = doc.getJournal();
      undoName = j.steps[j.position - 1] ?? "";
      redoName = j.steps[j.position] ?? "";
    } catch {
      /* journal unavailable */
    }
    return { canUndo: doc.canUndo(), canRedo: doc.canRedo(), dirty: this.isDirty(), undoName, redoName };
  }

  isDirty(): boolean {
    return this.currentStepId() !== this.savedId;
  }

  /** Serialize the current document; by default this also marks it as saved. */
  save(markSaved = true): Uint8Array {
    const doc = this.requireDoc();
    const buf = doc.saveToBuffer("garbage=compact,compress");
    const out = buf.asUint8Array().slice();
    buf.destroy();
    if (markSaved) this.markSaved();
    return out;
  }

  markSaved(): void {
    this.savedId = this.currentStepId();
  }

  undo(): DocInfo {
    const doc = this.requireDoc();
    if (doc.canUndo()) doc.undo();
    this.clearText();
    return this.info();
  }

  redo(): DocInfo {
    const doc = this.requireDoc();
    if (doc.canRedo()) doc.redo();
    this.clearText();
    return this.info();
  }

  // ---------- rendering & text ----------

  /** Render page contents, annotations and form widgets. */
  render(index: number, scale: number): RGBAImage {
    const m = this.mupdf;
    return this.withPage(index, (page) => {
      const b = page.getBounds();
      const mat = m.Matrix.concat(m.Matrix.translate(-b[0], -b[1]), m.Matrix.scale(scale, scale));
      const w = Math.max(1, Math.ceil((b[2] - b[0]) * scale));
      const h = Math.max(1, Math.ceil((b[3] - b[1]) * scale));
      const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], false);
      pix.clear(255);
      const dev = new m.DrawDevice(m.Matrix.identity, pix);
      page.runPageContents(dev, mat);
      page.runPageAnnots(dev, mat);
      page.runPageWidgets(dev, mat);
      dev.close();
      dev.destroy();
      const rgb = pix.getPixels();
      const stride = pix.getStride();
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        let s = y * stride;
        let d = y * w * 4;
        for (let x = 0; x < w; x++) {
          data[d] = rgb[s];
          data[d + 1] = rgb[s + 1];
          data[d + 2] = rgb[s + 2];
          data[d + 3] = 255;
          s += 3;
          d += 4;
        }
      }
      pix.destroy();
      return { width: w, height: h, data };
    });
  }

  /** Quads covering the text between two points (for selection and highlighting). */
  selectText(index: number, p: Point, q: Point): Quad[] {
    return this.text(index).highlight(p, q, 500) as Quad[];
  }

  copyText(index: number, p: Point, q: Point): string {
    return this.text(index).copy(p, q);
  }

  /** Whether there is text under a point (decides between text selection and other actions). */
  hasTextAt(index: number, p: Point, pad = 1): boolean {
    return this.lineBoxes(index).some((r) => p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad);
  }

  /** Bounding boxes of the text lines on a page (cached). */
  lineBoxes(index: number): Rect[] {
    let boxes = this.lines.get(index);
    if (!boxes) {
      const out: Rect[] = [];
      this.text(index).walk({ beginLine: (bbox) => out.push([...bbox] as Rect) });
      boxes = out.filter((r) => r[2] > r[0] && r[3] > r[1]);
      this.lines.set(index, boxes);
    }
    return boxes;
  }

  pageText(index: number): string {
    return this.text(index).asText();
  }

  search(needle: string, maxHitsPerPage = 200): SearchHit[] {
    const doc = this.requireDoc();
    const hits: SearchHit[] = [];
    if (!needle.trim()) return hits;
    const n = doc.countPages();
    for (let i = 0; i < n; i++) {
      const res = this.text(i).search(needle, undefined) as Quad[][];
      for (const quads of res.slice(0, maxHitsPerPage)) hits.push({ page: i, quads });
    }
    return hits;
  }

  // ---------- annotations ----------

  listAnnots(index: number): AnnotInfo[] {
    return this.withPage(index, (page) => {
      const out: AnnotInfo[] = [];
      page.getAnnotations().forEach((a, i) => {
        const type = a.getType();
        if (SKIP_TYPES.has(type)) return;
        const kind = (["Highlight", "Underline", "StrikeOut", "Squiggly", "Ink", "FreeText", "Square", "Circle", "Line", "Text", "Stamp"].includes(type)
          ? type
          : "Other") as AnnotKind;
        const info: AnnotInfo = { index: i, kind, rect: a.getBounds() as Rect, color: [...a.getColor()], contents: a.getContents() };
        if (kind === "FreeText") {
          try {
            info.fontSize = a.getDefaultAppearance().size;
            const c = a.getDefaultAppearance().color;
            if (c.length) info.color = [...c];
          } catch {
            /* malformed DA */
          }
        }
        out.push(info);
      });
      return out;
    });
  }

  addMarkup(index: number, kind: "Highlight" | "Underline" | "StrikeOut" | "Squiggly", quads: Quad[], color: RGB): AnnotInfo[] {
    if (!quads.length) return this.listAnnots(index);
    return this.op("Mark text", index, (page) => {
      const a = page.createAnnotation(kind);
      a.setColor(color);
      a.setQuadPoints(quads);
      a.update();
    });
  }

  addInk(index: number, strokes: Point[][], color: RGB, width: number): AnnotInfo[] {
    const clean = strokes.filter((s) => s.length > 0).map((s) => (s.length === 1 ? [s[0], [s[0][0] + 0.1, s[0][1] + 0.1] as Point] : s));
    if (!clean.length) return this.listAnnots(index);
    return this.op("Draw", index, (page) => {
      const a = page.createAnnotation("Ink");
      a.setColor(color);
      a.setBorderWidth(width);
      a.setInkList(clean);
      a.update();
    });
  }

  addShape(index: number, kind: "Square" | "Circle", rect: Rect, color: RGB, width: number): AnnotInfo[] {
    return this.op("Shape", index, (page) => {
      const a = page.createAnnotation(kind);
      a.setRect(rect);
      a.setColor(color);
      a.setInteriorColor([]);
      a.setBorderWidth(width);
      a.update();
    });
  }

  addArrow(index: number, from: Point, to: Point, color: RGB, width: number): AnnotInfo[] {
    return this.op("Arrow", index, (page) => {
      const a = page.createAnnotation("Line");
      a.setLine(from, to);
      a.setLineEndingStyles("None", "OpenArrow");
      a.setColor(color);
      a.setBorderWidth(width);
      a.update();
    });
  }

  /** Place an image (PNG/JPEG bytes, transparency kept) as a stamp, e.g. a signature picture. */
  addImageStamp(index: number, rect: Rect, imageBytes: Uint8Array): AnnotInfo[] {
    return this.op("Signature", index, (page) => {
      const img = new this.mupdf.Image(imageBytes);
      try {
        const a = page.createAnnotation("Stamp");
        a.setRect(rect);
        a.setStampImage(img);
        a.update();
      } finally {
        img.destroy();
      }
    });
  }

  /** Text box with its top-left corner at `at`. Size follows the text. */
  addFreeText(index: number, at: Point, text: string, size: number, color: RGB): AnnotInfo[] {
    if (!text.trim()) return this.listAnnots(index);
    return this.op("Text box", index, (page) => {
      const a = page.createAnnotation("FreeText");
      this.styleFreeText(a, at, text, size, color);
    });
  }

  /** Change the text (and size/colour) of an existing text box, keeping its top-left corner. */
  editFreeText(index: number, annot: number, text: string, size: number, color: RGB): AnnotInfo[] {
    return this.op("Edit text box", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (!a || a.getType() !== "FreeText") throw new Error("Not a text box");
      if (!text.trim()) {
        page.deleteAnnotation(a);
        return;
      }
      const r = a.getRect();
      this.styleFreeText(a, [r[0], r[1]], text, size, color);
    });
  }

  private styleFreeText(a: MuPDF.PDFAnnotation, at: Point, text: string, size: number, color: RGB): void {
    const lines = text.split("\n");
    const w = Math.max(...lines.map((l) => this.measure(l, size)), size) + 2 * FREETEXT_PAD + 1;
    const h = lines.length * size * LINE_HEIGHT + 2 * FREETEXT_PAD;
    a.setContents(text);
    a.setDefaultAppearance("Helv", size, color);
    a.setBorderWidth(0);
    a.setRect([at[0], at[1], at[0] + w, at[1] + h]);
    a.update();
  }

  /** Width of a string in Helvetica at `size` points. */
  measure(text: string, size: number): number {
    this.helv ??= new this.mupdf.Font("Helvetica");
    let w = 0;
    for (const ch of text) w += this.helv.advanceGlyph(this.helv.encodeCharacter(ch.codePointAt(0)!));
    return w * size;
  }

  moveAnnot(index: number, annot: number, dx: number, dy: number): AnnotInfo[] {
    return this.op("Move", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (!a) throw new Error("No such annotation");
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
    });
  }

  setAnnotColor(index: number, annot: number, color: RGB): AnnotInfo[] {
    return this.op("Colour", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (!a) throw new Error("No such annotation");
      if (a.getType() === "FreeText") {
        const da = a.getDefaultAppearance();
        a.setDefaultAppearance("Helv", da.size || 12, color);
      } else a.setColor(color);
      a.update();
    });
  }

  deleteAnnot(index: number, annot: number): AnnotInfo[] {
    return this.op("Delete", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (a) page.deleteAnnotation(a);
    });
  }

  // ---------- forms ----------

  listWidgets(index: number): WidgetInfo[] {
    return this.withPage(index, (page) => page.getWidgets().map((w, i) => this.widgetInfo(w, i)));
  }

  private widgetInfo(w: MuPDF.PDFWidget, index: number): WidgetInfo {
    const t = w.getFieldType();
    const kind: WidgetKind = t === "radiobutton" ? "radio" : (["text", "checkbox", "combobox", "listbox", "button", "signature"].includes(t) ? t : "button") as WidgetKind;
    const as = w.getObject().get("AS");
    const checked = as.isName() ? as.asName() !== "Off" : false;
    let fontSize = 0;
    try {
      fontSize = w.getDefaultAppearance().size;
    } catch {
      /* no DA */
    }
    return {
      index,
      kind,
      name: w.getName(),
      rect: w.getBounds() as Rect,
      value: w.getValue(),
      checked,
      options: kind === "combobox" || kind === "listbox" ? w.getOptions() : [],
      multiline: kind === "text" && w.isMultiline(),
      readOnly: w.isReadOnly(),
      maxLen: kind === "text" ? w.getMaxLen() : 0,
      fontSize,
    };
  }

  setFieldText(index: number, widget: number, value: string): WidgetInfo[] {
    this.op("Fill field", index, (page) => {
      const w = page.getWidgets()[widget];
      if (!w || w.getValue() === value) return;
      w.setTextValue(value);
      w.update();
    });
    return this.listWidgets(index);
  }

  setFieldChoice(index: number, widget: number, value: string): WidgetInfo[] {
    this.op("Fill field", index, (page) => {
      const w = page.getWidgets()[widget];
      if (!w) return;
      w.setChoiceValue(value);
      w.update();
    });
    return this.listWidgets(index);
  }

  toggleField(index: number, widget: number): WidgetInfo[] {
    this.op("Tick", index, (page) => {
      const w = page.getWidgets()[widget];
      if (!w) return;
      w.toggle();
      w.update();
    });
    return this.listWidgets(index);
  }

  /** Burn annotations and form fields into the page content (no longer editable). */
  flatten(): DocInfo {
    return this.docOp("Flatten", (doc) => doc.bake(true, true));
  }

  // ---------- pages ----------

  rotatePages(pages: number[], delta: 90 | -90 | 180): DocInfo {
    return this.docOp("Rotate pages", (doc) => {
      for (const i of pages) {
        const obj = doc.findPage(i);
        const cur = obj.getInheritable("Rotate");
        const r = cur.isNumber() ? cur.asNumber() : 0;
        obj.put("Rotate", (((r + delta) % 360) + 360) % 360);
      }
    });
  }

  deletePages(pages: number[]): DocInfo {
    const doc = this.requireDoc();
    if (new Set(pages).size >= doc.countPages()) throw new Error("A PDF needs at least one page");
    return this.docOp("Delete pages", (d) => {
      for (const i of [...new Set(pages)].sort((a, b) => b - a)) d.deletePage(i);
    });
  }

  /** order[newIndex] = oldIndex; must be a permutation of all pages. */
  reorderPages(order: number[]): DocInfo {
    const n = this.requireDoc().countPages();
    if (order.length !== n || new Set(order).size !== n) throw new Error("Bad page order");
    if (order.every((v, i) => v === i)) return this.info();
    return this.docOp("Move pages", (doc) => doc.rearrangePages(order));
  }

  /** Insert all pages of another PDF before page `at` (at = pageCount appends). */
  insertPdf(bytes: Uint8Array, at: number): DocInfo {
    const src = this.mupdf.Document.openDocument(bytes, "application/pdf").asPDF();
    if (!src) throw new Error("Not a PDF file");
    if (src.needsPassword()) {
      src.destroy();
      throw new Error("That PDF is password-protected");
    }
    try {
      return this.docOp("Insert pages", (doc) => {
        const map = doc.newGraftMap();
        const n = src.countPages();
        for (let i = 0; i < n; i++) {
          // graftPage leaves annotations behind; copy them over without their
          // back-pointer to the old page (which would drag the old page tree along).
          const srcAnnots = src.findPage(i).get("Annots");
          if (srcAnnots.isArray()) srcAnnots.forEach((a) => a.delete("P"));
          map.graftPage(at + i, src, i);
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
        }
        this.mergeForm(doc, src, map, at, n);
      });
    } finally {
      src.destroy();
    }
  }

  /** Grafted pages keep their widget annotations; register their fields so they stay fillable. */
  private mergeForm(doc: MuPDF.PDFDocument, src: MuPDF.PDFDocument, map: MuPDF.PDFGraftMap, at: number, n: number): void {
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

  insertBlankPage(at: number, w = 595.28, h = 841.89): DocInfo {
    return this.docOp("Insert page", (doc) => {
      const page = doc.addPage([0, 0, w, h], 0, {}, "");
      doc.insertPage(at, page);
    });
  }

  /** A new PDF containing just these pages. */
  extractPages(pages: number[]): Uint8Array {
    const doc = this.requireDoc();
    // Work on a copy so annotations and form fields come along.
    const tmp = doc.saveToBuffer("");
    const out = new this.mupdf.PDFDocument(tmp);
    tmp.destroy();
    out.rearrangePages(pages);
    const buf = out.saveToBuffer("garbage=compact,compress");
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    out.destroy();
    return bytes;
  }

  // ---------- internals ----------

  protected requireDoc(): MuPDF.PDFDocument {
    if (!this.doc) throw new Error("No document open");
    return this.doc;
  }

  protected withPage<T>(index: number, fn: (p: MuPDF.PDFPage) => T): T {
    const page = this.requireDoc().loadPage(index);
    try {
      return fn(page);
    } finally {
      page.destroy();
    }
  }

  private text(index: number): MuPDF.StructuredText {
    let t = this.stext.get(index);
    if (!t) {
      t = this.withPage(index, (p) => p.toStructuredText("preserve-whitespace"));
      this.stext.set(index, t);
    }
    return t;
  }

  private clearText(): void {
    for (const t of this.stext.values()) t.destroy();
    this.stext.clear();
    this.lines.clear();
  }

  private journalPos(): number {
    try {
      return this.doc ? this.doc.getJournal().position : 0;
    } catch {
      return 0;
    }
  }

  private currentStepId(): number {
    const pos = this.journalPos();
    return pos > 0 ? (this.stepIds[pos - 1] ?? -pos) : 0;
  }

  /** Wrap a change in one journal step (one undo step). */
  private journaled(name: string, fn: () => void): void {
    const doc = this.requireDoc();
    const before = this.journalPos();
    doc.beginOperation(name);
    try {
      fn();
      doc.endOperation();
    } catch (e) {
      doc.abandonOperation();
      throw e;
    }
    const after = this.journalPos();
    if (after > before) {
      this.stepIds.length = before;
      this.stepIds.push(this.nextStepId++);
    }
  }

  /** Run an undoable change on one page; returns that page's annotations afterwards. */
  private op(name: string, index: number, fn: (p: MuPDF.PDFPage) => void): AnnotInfo[] {
    this.journaled(name, () => this.withPage(index, fn));
    this.stext.get(index)?.destroy();
    this.stext.delete(index);
    this.lines.delete(index);
    return this.listAnnots(index);
  }

  private docOp(name: string, fn: (doc: MuPDF.PDFDocument) => void): DocInfo {
    const doc = this.requireDoc();
    this.journaled(name, () => fn(doc));
    this.clearText();
    return this.info();
  }
}
