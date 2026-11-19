// PdfEngine: everything that touches the PDF, on top of MuPDF (WebAssembly).
// No DOM here, so it runs in a Web Worker in the app and directly in Node for tests.
// All coordinates are page space: PDF points, origin top-left, y down, rotation applied.

import type * as MuPDF from "mupdf";
import type { Point, Quad, Rect } from "../core/geometry";
import type { Run } from "../core/textlayout";
import { extractBlocks, fontsNeeded, replaceBlock, type EditBlock, type EditResult, type EditOptions } from "./textedit";
import { addOcrWords, isOcrPage, OCR_FONT_FILE, type OcrWord } from "./ocr";

export type { EditBlock, EditResult, EditStyle, EditOptions } from "./textedit";
export type { OcrWord } from "./ocr";

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
  private bundled = new Map<string, MuPDF.Font>();
  private title = "";
  // Each journal step gets a unique id, so "dirty" survives undo + new edit sequences.
  // Undo history as document snapshots. (MuPDF's own journal leaves its font/image caches
  // pointing at objects that undo deleted, which garbles later edits.)
  /** Undo steps: the document before the step, and which pages' contents the step changed. */
  private undoStack: UndoStep[] = [];
  private redoStack: UndoStep[] = [];
  private stateId = 0;
  private nextStateId = 1;
  private savedId = 0;
  private password = "";
  /** About how big the open document is (for the undo memory budget). */
  private docSize = 0;
  static readonly MAX_UNDO = 60;
  static readonly MAX_UNDO_BYTES = 400 * 1024 * 1024;

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
    this.docSize = bytes.length;
    this.title = title;
    this.password = "";
    if (pdf.needsPassword()) return null;
    return this.afterOpen();
  }

  authenticate(password: string): DocInfo | null {
    if (!this.requireDoc().authenticatePassword(password)) return null;
    this.password = password;
    return this.afterOpen();
  }

  private afterOpen(): DocInfo {
    this.dropSteps([...this.undoStack, ...this.redoStack]);
    this.undoStack = [];
    this.redoStack = [];
    this.stateId = 0;
    this.savedId = 0;
    return this.info();
  }

  close(): void {
    this.ready = null;
    this.clearText();
    this.dropContent();
    this.dropSteps([...this.undoStack, ...this.redoStack]);
    this.undoStack = [];
    this.redoStack = [];
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
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
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
    this.requireDoc();
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      dirty: this.isDirty(),
      undoName: this.undoStack[this.undoStack.length - 1]?.name ?? "",
      redoName: this.redoStack[this.redoStack.length - 1]?.name ?? "",
    };
  }

  isDirty(): boolean {
    return this.stateId !== this.savedId;
  }

  /** Serialize the current document; by default this also marks it as saved. */
  save(markSaved = true): Uint8Array {
    const doc = this.requireDoc();
    const buf = doc.saveToBuffer("garbage=deduplicate,compress");
    const out = buf.asUint8Array().slice();
    buf.destroy();
    if (markSaved) this.markSaved();
    return out;
  }

  markSaved(): void {
    this.savedId = this.stateId;
  }

  undo(): DocInfo {
    const prev = this.undoStack.pop();
    if (prev) {
      // the current document itself is kept for redo (no copy needed)
      const cur = this.currentStep(prev.name, prev.content);
      try {
        this.switchTo(prev);
      } catch (e) {
        this.doc = cur.doc!;
        this.undoStack.push(prev);
        throw e;
      }
      this.redoStack.push(cur);
    }
    return this.info();
  }

  redo(): DocInfo {
    const next = this.redoStack.pop();
    if (next) {
      const cur = this.currentStep(next.name, next.content);
      try {
        this.switchTo(next);
      } catch (e) {
        this.doc = cur.doc!;
        this.redoStack.push(next);
        throw e;
      }
      this.undoStack.push(cur);
      this.trimHistory();
    }
    return this.info();
  }

  /** Undo in one call: null if there's nothing to undo, else the document info and the step's name. */
  undoStep(): { info: DocInfo; name: string } | null {
    const name = this.undoStack[this.undoStack.length - 1]?.name;
    return name === undefined ? null : { info: this.undo(), name };
  }

  redoStep(): { info: DocInfo; name: string } | null {
    const name = this.redoStack[this.redoStack.length - 1]?.name;
    return name === undefined ? null : { info: this.redo(), name };
  }

  /** The open document as an undo/redo step (handed over as is, not copied). */
  private currentStep(name: string, content: number[] | "all"): UndoStep {
    const doc = this.requireDoc();
    this.doc = null;
    return { name, id: this.stateId, content, doc, size: this.docSize };
  }

  /** Make a step's document the open one. */
  private switchTo(step: UndoStep): void {
    let doc = step.doc;
    if (!doc) {
      const d = this.mupdf.Document.openDocument(step.bytes!, "application/pdf");
      doc = d.asPDF() ?? undefined;
      if (!doc) throw new Error("Undo failed");
      if (doc.needsPassword() && !doc.authenticatePassword(this.password)) throw new Error("Undo failed (password)");
    }
    this.clearText();
    this.ready = null;
    // drawn page contents stay for pages the step didn't change
    this.dropContent(step.content);
    this.doc?.destroy();
    this.doc = doc;
    this.docSize = step.size;
    this.stateId = step.id;
  }

  private dropSteps(steps: UndoStep[]): void {
    for (const st of steps) st.doc?.destroy();
  }

  /** Keep the history within MAX_UNDO steps and MAX_UNDO_BYTES (oldest undo steps go first). */
  private trimHistory(): void {
    let total = [...this.undoStack, ...this.redoStack].reduce((n, st) => n + st.size, 0);
    while (this.undoStack.length > PdfEngine.MAX_UNDO || (total > PdfEngine.MAX_UNDO_BYTES && this.undoStack.length > 1)) {
      const st = this.undoStack.shift()!;
      total -= st.size;
      this.dropSteps([st]);
    }
  }

  /**
   * A copy of the document made ahead of time (when idle), so the next change doesn't have to
   * wait for it. Only valid while the document hasn't changed since (it's dropped by every
   * change, undo, redo, open and close).
   */
  private ready: { doc: MuPDF.PDFDocument; bytes: Uint8Array } | null = null;

  /** Make the undo copy for the next change now (the worker calls this when idle). */
  prepareUndo(): void {
    if (this.doc && (!this.ready || this.ready.doc !== this.doc)) this.ready = { doc: this.doc, bytes: this.snapshot() };
  }

  /** The document as it is right now (fast, uncompressed; only used for undo). */
  private snapshot(): Uint8Array {
    const buf = this.requireDoc().saveToBuffer("");
    const out = buf.asUint8Array().slice();
    buf.destroy();
    return out;
  }

  /** Put the document back as it was in `bytes` (after a failed change). */
  private restore(bytes: Uint8Array): void {
    const d = this.mupdf.Document.openDocument(bytes, "application/pdf");
    const pdf = d.asPDF();
    if (!pdf) throw new Error("Undo failed");
    if (pdf.needsPassword() && !pdf.authenticatePassword(this.password)) throw new Error("Undo failed (password)");
    this.clearText();
    this.ready = null;
    this.dropContent();
    this.doc?.destroy();
    this.doc = pdf;
  }

  // ---------- rendering & text ----------

  /**
   * Page contents drawn at a scale, kept so that a change to annotations or form fields
   * only redraws those on top (a scanned page takes 100-300 ms to draw, annotations ~20 ms).
   * Newest last; dropped whenever page contents may have changed.
   */
  private contentCache = new Map<string, MuPDF.Pixmap>();
  private contentBytes = 0;
  static readonly CONTENT_CACHE_BYTES = 160e6;

  /** Forget drawn page contents: of some pages, or of all (also after undo, page changes...). */
  private dropContent(pages: number[] | "all" = "all"): void {
    for (const [k, pix] of this.contentCache)
      if (pages === "all" || pages.includes(Number(k.split("|")[0]))) {
        this.contentBytes -= pix.getStride() * pix.getHeight();
        pix.destroy();
        this.contentCache.delete(k);
      }
  }

  /** Render page contents, annotations and form widgets (RGBA). */
  render(index: number, scale: number): RGBAImage {
    const m = this.mupdf;
    return this.withPage(index, (page) => {
      const b = page.getBounds();
      const mat = m.Matrix.concat(m.Matrix.translate(-b[0], -b[1]), m.Matrix.scale(scale, scale));
      const w = Math.max(1, Math.ceil((b[2] - b[0]) * scale));
      const h = Math.max(1, Math.ceil((b[3] - b[1]) * scale));
      const key = `${index}|${scale.toFixed(5)}|${b.join(",")}`;
      let base = this.contentCache.get(key);
      if (base) {
        this.contentCache.delete(key); // (most recently used goes last)
        this.contentCache.set(key, base);
      } else {
        // an opaque white RGBA pixmap: blend modes work as on paper, and the bytes are ImageData-ready
        base = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true);
        base.clear(255);
        const dev = new m.DrawDevice(m.Matrix.identity, base);
        page.runPageContents(dev, mat);
        dev.close();
        dev.destroy();
        const size = base.getStride() * h;
        if (size <= PdfEngine.CONTENT_CACHE_BYTES / 2) {
          this.contentCache.set(key, base);
          this.contentBytes += size;
          for (const [k, old] of this.contentCache) {
            if (this.contentBytes <= PdfEngine.CONTENT_CACHE_BYTES || k === key) break;
            this.contentBytes -= old.getStride() * old.getHeight();
            old.destroy();
            this.contentCache.delete(k);
          }
        }
      }
      const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true);
      pix.getPixels().set(base.getPixels());
      if (!this.contentCache.has(key)) base.destroy();
      const dev = new m.DrawDevice(m.Matrix.identity, pix);
      page.runPageAnnots(dev, mat);
      page.runPageWidgets(dev, mat);
      dev.close();
      dev.destroy();
      const stride = pix.getStride();
      const px = pix.getPixels();
      let data: Uint8ClampedArray;
      if (stride === w * 4) data = new Uint8ClampedArray(px);
      else {
        data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) data.set(px.subarray(y * stride, y * stride + w * 4), y * w * 4);
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
      shiftAnnot(a, dx, dy);
    });
  }

  /**
   * Move an annotation to another page so that its top-left corner lands at `topLeft`
   * (page space of the target page). One undo step. Returns both pages' annotations
   * and the annotation's index on the target page.
   */
  moveAnnotToPage(from: number, annot: number, to: number, topLeft: Point): { from: AnnotInfo[]; to: AnnotInfo[]; index: number } {
    if (from === to) throw new Error("Same page");
    const doc = this.requireDoc();
    let newIndex = -1;
    this.journaled("Move to page", () => {
      let movedId = -1;
      const srcPage = doc.loadPage(from);
      try {
        const a = srcPage.getAnnotations()[annot];
        if (!a) throw new Error("No such annotation");
        const obj = a.getObject();
        if (!obj.isIndirect()) throw new Error("Can't move this annotation");
        movedId = obj.asIndirect();
        const popup = obj.get("Popup");
        const moving = [obj, ...(popup.isDictionary() && popup.isIndirect() ? [popup] : [])];
        const ids = new Set(moving.map((o) => o.asIndirect()));
        // take the annotation (and its popup) off the source page...
        const srcAnnots = srcPage.getObject().get("Annots");
        for (let i = srcAnnots.length - 1; i >= 0; i--) {
          const it = srcAnnots.get(i);
          if (it.isIndirect() && ids.has(it.asIndirect())) srcAnnots.delete(i);
        }
        // ...and put it on the target page
        const dstObj = doc.findPage(to);
        let dstAnnots = dstObj.get("Annots");
        if (!dstAnnots.isArray()) {
          dstAnnots = doc.newArray();
          dstObj.put("Annots", dstAnnots);
        }
        for (const o of moving) {
          o.put("P", dstObj);
          dstAnnots.push(o);
        }
      } finally {
        srcPage.destroy();
      }
      // position it on the target page (in that page's coordinates)
      this.withPage(to, (page) => {
        const list = page.getAnnotations();
        newIndex = list.findIndex((x) => x.getObject().asIndirect() === movedId);
        const a = list[newIndex];
        if (!a) throw new Error("Move failed");
        const r = a.getBounds();
        shiftAnnot(a, topLeft[0] - r[0], topLeft[1] - r[1]);
      });
    }, []);
    this.clearText();
    return { from: this.listAnnots(from), to: this.listAnnots(to), index: newIndex };
  }

  /** Render one annotation on its own (transparent background), for drag previews. */
  renderAnnot(index: number, annot: number, scale: number): RGBAImage | null {
    const m = this.mupdf;
    return this.withPage(index, (page) => {
      const a = page.getAnnotations()[annot];
      if (!a) return null;
      const pix = a.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, true);
      try {
        const w = pix.getWidth();
        const h = pix.getHeight();
        const src = pix.getPixels();
        const stride = pix.getStride();
        const data = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const s = y * stride + x * 4;
            const d = (y * w + x) * 4;
            const al = src[s + 3];
            // MuPDF pixmaps are premultiplied; ImageData is not
            const k = al ? 255 / al : 0;
            data[d] = src[s] * k;
            data[d + 1] = src[s + 1] * k;
            data[d + 2] = src[s + 2] * k;
            data[d + 3] = al;
          }
        return { width: w, height: h, data };
      } finally {
        pix.destroy();
      }
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

  // ---------- live text editing ----------

  /** Paragraphs on a page, with their text and styles, for the text editor. */
  textBlocks(index: number): EditBlock[] {
    return this.withPage(index, (page) => extractBlocks(page).blocks);
  }

  /** Register a bundled font file (from public/fonts). */
  registerFont(file: string, bytes: Uint8Array): void {
    if (!this.bundled.has(file)) this.bundled.set(file, new this.mupdf.Font(file.replace(/\.[a-z]+$/, ""), bytes));
  }

  hasFont(file: string): boolean {
    return this.bundled.has(file);
  }

  /** Bundled font files that must be registered before replaceText can run. */
  fontsForEdit(index: number, block: number, runs: Run[], opts: EditOptions = {}): string[] {
    return this.withPage(index, (page) => fontsNeeded(page, block, runs, this.bundled, opts));
  }

  // ---------- text recognition (scans) ----------

  /** Does the page have any real (or already recognised) text? */
  pageHasText(index: number): boolean {
    return this.pageText(index).trim().length > 0;
  }

  isRecognized(index: number): boolean {
    return this.withPage(index, (p) => isOcrPage(p));
  }

  /** Font file the recognised text is written with (register it before addOcrText). */
  readonly ocrFontFile = OCR_FONT_FILE;

  /** Add recognised words as an invisible, selectable text layer on one page (one undo step). */
  addOcrText(index: number, words: OcrWord[]): number {
    return this.addOcrPages([{ index, words }]);
  }

  /** The same for several pages at once, as one undo step. Returns the number of words written. */
  addOcrPages(pages: { index: number; words: OcrWord[] }[]): number {
    const doc = this.requireDoc();
    const font = this.bundled.get(OCR_FONT_FILE);
    if (!font) throw new Error(`Font ${OCR_FONT_FILE} not loaded`);
    let n = 0;
    this.journaled("Recognize text", () => {
      for (const { index, words } of pages)
        this.withPage(index, (page) => {
          n += addOcrWords(this.mupdf, doc, page, words, font);
        });
      return pages.length > 0;
    }, pages.map((p) => p.index));
    this.clearText();
    return n;
  }

  /**
   * Replace a paragraph with new text (one undo step). Highlights, underlines and
   * strike-outs on the paragraph follow their words to the new position, or are
   * removed if those words are gone.
   */
  replaceText(index: number, block: number, runs: Run[], opts: EditOptions = {}): { result: EditResult; annots: AnnotInfo[] } {
    const doc = this.requireDoc();
    let result!: EditResult;
    this.journaled("Edit text", () => {
      this.withPage(index, (page) => {
        const blk = extractBlocks(page).blocks[block];
        // markup annotations sitting on this paragraph, with the words they cover
        const marks: { annot: MuPDF.PDFAnnotation; text: string }[] = [];
        if (blk) {
          const st = page.toStructuredText("preserve-whitespace");
          for (const a of page.getAnnotations()) {
            if (!["Highlight", "Underline", "StrikeOut", "Squiggly"].includes(a.getType())) continue;
            const qs = a.getQuadPoints();
            const inside = qs.some((q) => blk.lines.some((l) => q[1] < l.bbox[3] && q[5] > l.bbox[1] && q[2] > blk.left - 1 && q[0] < blk.left + blk.width + 1));
            if (!inside || !qs.length) continue;
            const first = qs[0];
            const last = qs[qs.length - 1];
            const text = st.copy([first[0] + 0.5, (first[1] + first[5]) / 2], [last[2] - 0.5, (last[3] + last[7]) / 2]).replace(/\s+/g, " ").trim();
            marks.push({ annot: a, text });
          }
          st.destroy();
        }
        result = replaceBlock(this.mupdf, doc, page, block, runs, this.bundled, opts);
        if (!marks.length) return;
        // put each mark back on its words inside the new paragraph
        const area = result.bbox;
        const used = new Set<string>();
        let lost = 0;
        for (const m of marks) {
          const hits = m.text ? (page.search(m.text, undefined) as Quad[][]) : [];
          const hit = hits.find((h) => {
            const key = h.map((q) => q.map((v) => v.toFixed(1)).join()).join("|");
            const inArea = h.every((q) => {
              const cy = (q[1] + q[5]) / 2;
              return q[0] >= area[0] - 1 && q[2] <= area[2] + 1 && cy >= area[1] - 2 && cy <= area[3] + 2;
            });
            return inArea && !used.has(key) && used.add(key) !== undefined;
          });
          if (hit) {
            m.annot.setQuadPoints(hit);
            m.annot.update();
          } else {
            page.deleteAnnotation(m.annot);
            lost++;
          }
        }
        if (lost) result.warnings.push(`${lost} highlight${lost > 1 ? "s were" : " was"} removed because the marked words changed.`);
      });
    }, [index]);
    this.clearText();
    return { result, annots: this.listAnnots(index) };
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
      if (!w || w.getValue() === value) return false;
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

  /**
   * Run a change as one undo step. If `fn` returns false nothing changed and no step is
   * recorded; if it throws, the document is put back exactly as it was.
   */
  private journaled(name: string, fn: () => void | boolean, content: number[] | "all" = "all"): void {
    const before = this.ready?.doc === this.doc ? this.ready!.bytes : this.snapshot();
    this.ready = null;
    let changed: void | boolean;
    try {
      changed = fn();
    } catch (e) {
      this.restore(before);
      throw e;
    }
    if (changed === false) return;
    // pages whose contents (not just annotations or fields) may look different now
    this.dropContent(content);
    this.undoStack.push({ name, bytes: before, id: this.stateId, content, size: before.length });
    this.docSize = before.length;
    this.stateId = this.nextStateId++;
    this.dropSteps(this.redoStack);
    this.redoStack = [];
    // keep memory in check: drop the oldest steps
    this.trimHistory();
  }

  /** Run an undoable change on one page; returns that page's annotations afterwards. */
  private op(name: string, index: number, fn: (p: MuPDF.PDFPage) => void | boolean): AnnotInfo[] {
    // (annotations and form fields only: the page contents stay as drawn)
    this.journaled(name, () => this.withPage(index, fn), []);
    this.stext.get(index)?.destroy();
    this.stext.delete(index);
    this.lines.delete(index);
    return this.listAnnots(index);
  }

  private docOp(name: string, fn: (doc: MuPDF.PDFDocument) => void): DocInfo {
    this.journaled(name, () => fn(this.requireDoc()));
    this.clearText();
    return this.info();
  }
}

interface UndoStep {
  name: string;
  /** The document then: saved bytes, or (for redo, and undo after redo) the document itself. */
  bytes?: Uint8Array;
  doc?: MuPDF.PDFDocument;
  id: number;
  /** Pages whose contents (not just annotations) the step changed. */
  content: number[] | "all";
  size: number;
}

/** Translate any kind of annotation by (dx, dy) in page space. */
function shiftAnnot(a: MuPDF.PDFAnnotation, dx: number, dy: number): void {
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
}
