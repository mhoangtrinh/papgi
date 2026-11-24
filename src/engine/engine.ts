// PdfEngine: everything that touches the PDF, on top of MuPDF (WebAssembly).
// No DOM here, so it runs in a Web Worker in the app and directly in Node for tests.
// All coordinates are page space: PDF points, origin top-left, y down, rotation applied.

import type * as MuPDF from "mupdf";
import type { Point, Quad, Rect } from "../core/geometry";
import { rectHeight, rectWidth } from "../core/geometry";
import type { Run } from "../core/textlayout";
import { extractBlocks, fontsNeeded, replaceBlock, type EditBlock, type EditResult, type EditOptions } from "./textedit";
import { addOcrWords, isOcrPage, OCR_FONT_FILE, type OcrWord } from "./ocr";
import {
  compressPdf, graftPages, imagesToPdf, mergePages, mergePdfs, pageToImage, pagesToImages, pdfPageCount, splitPdf,
  type CompressOptions, type CompressResult, type ImageInput, type ImagesToPdfOptions, type OutFile, type PageRef, type PdfInput, type RenderOptions, type SplitPage,
} from "./tools";
import { pdfToWord, WordJob, type WordOptions, type WordResult } from "./toword";
import { arrowAppearance, bakeAreas, copyAnnots, copyArea, eraseBrush, eraseRects, hasAreas, isArea, itemsIn, moveObjects, pasteClip, removeItemsIn, resizable, resizeAnnot, shiftAnnot, type Clip, type ClipInfo } from "./clip";

export type { EditBlock, EditResult, EditStyle, EditOptions } from "./textedit";
export type { OcrWord } from "./ocr";
export type { ClipInfo } from "./clip";
import type { TextLine, TocItem } from "../core/toc";
import { addField, uniqueName, dateFormatOf, deleteWidget, isRequired, placeWidget, redrawWidget, setFieldProps, type FieldProps, type NewFieldKind } from "./forms";
import { addHeaderFooter, addWatermark, pickFont, type HeaderFooterOptions, type WatermarkOptions } from "./stamp";
export type { HeaderFooterOptions, WatermarkOptions, Corner } from "./stamp";
export type { FieldProps, NewFieldKind } from "./forms";
import { dashPattern, isLineKind, shapeGeometry, type LineStyle, type ShapeKind, type ShapeStyle } from "../core/shapes";

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

export type AnnotKind = "Highlight" | "Underline" | "StrikeOut" | "Squiggly" | "Ink" | "FreeText" | "Square" | "Circle" | "Line" | "Polygon" | "Text" | "Stamp" | "Other";

export interface AnnotInfo {
  index: number; // index into page.getAnnotations()
  /** The annotation's object number (stays the same while other items come and go). */
  num: number;
  kind: AnnotKind;
  rect: Rect;
  color: number[];
  contents: string;
  fontSize?: number;
  /** A pasted part of a page (becomes page content when saved). */
  area?: boolean;
  /** Shapes: what kind and how they're drawn. */
  shape?: { kind: ShapeKind } & ShapeStyle;
  /** Can be resized by its corners. */
  resizable?: boolean;
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
  /** Must be filled in. */
  required: boolean;
  /** Date fields: how the date is written (e.g. "dd.mm.yyyy"); "" for other fields. */
  dateFormat: string;
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
  private helvBold: MuPDF.Font | null = null;
  /** Password protection to apply when saving: new passwords, "none" to remove, null to keep as it is. */
  private protect: { user: string; owner: string } | "none" | null = null;
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
  /** From this size (bytes) a file is handled with its memory in mind. */
  static readonly BIG_FILE = 100e6;
  /** Something the person should know after a save (e.g. undo steps given up for memory). */
  private note: string | null = null;

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
    this.fileSerial++;
    this.protect = null;
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
  /**
   * The file's bytes. `flat`: a copy for sending, with every annotation and form field made
   * part of the pages (some viewers, e.g. Apple's in Mail and Preview, draw annotations as
   * blurry pictures; page content is sharp everywhere, and can't be moved or changed).
   */
  save(markSaved = true, flat = false): Uint8Array {
    const doc = this.requireDoc();
    // pasted parts of pages become page content in the file (they stay movable here)
    const baked = hasAreas(doc) || flat ? this.copyOfDoc() : null;
    if (baked) bakeAreas(baked);
    if (baked && flat) baked.bake(true, true);
    let out: Uint8Array;
    try {
      out = this.writeOut(baked ?? doc);
    } finally {
      baked?.destroy();
    }
    if (markSaved && !flat) this.markSaved();
    return out;
  }

  /**
   * The document as file bytes. Tidied up (unused and duplicate objects dropped) when memory
   * allows; a big file can run out of the engine's memory (2 GB at most) while being tidied,
   * so then the cache is emptied and it's written more plainly.
   */
  private writeOut(doc: MuPDF.PDFDocument): Uint8Array {
    // (big files: start without the cache of decoded pictures)
    if (this.docSize > PdfEngine.BIG_FILE) this.mupdf.emptyStore();
    const enc = this.encryptOptions();
    const tries = ["garbage=deduplicate,compress", "garbage,compress", "", ""].map((o) => [o, enc].filter(Boolean).join(","));
    let last: unknown;
    for (const [k, opt] of tries.entries()) {
      if (k === 3) {
        // last try: give up the undo steps that keep whole documents in the engine's memory
        // (undo steps go oldest first, so undo still goes back one step at a time)
        const lastDoc = this.undoStack.map((st) => !!st.doc).lastIndexOf(true);
        if (lastDoc < 0 && !this.redoStack.some((st) => st.doc)) break;
        this.dropSteps(this.undoStack.splice(0, lastDoc + 1));
        this.dropSteps(this.redoStack);
        this.redoStack = [];
        this.mupdf.emptyStore();
        this.note = "This file is very big: to save it, some undo steps had to be given up.";
      }
      try {
        const buf = doc.saveToBuffer(opt);
        try {
          return buf.asUint8Array().slice();
        } finally {
          buf.destroy();
        }
      } catch (e) {
        last = e;
        if (!/alloc|memory/i.test(String((e as Error)?.message ?? e))) throw e;
        this.mupdf.emptyStore();
      }
    }
    throw last;
  }

  // ---------- password protection ----------

  /** Whether the file needs a password to open (as it will be saved). */
  protection(): { locked: boolean; changed: boolean } {
    const p = this.protect;
    return { locked: p === null ? this.password !== "" || this.requireDoc().needsPassword() : p !== "none", changed: p !== null };
  }

  /** Protect the file with a password when it's saved (owner password: the same unless given), or remove it ("none"). */
  setProtection(p: { user: string; owner?: string } | "none"): void {
    this.requireDoc();
    if (p !== "none" && !p.user) throw new Error("The password is empty");
    // (the save options are a comma-separated list)
    if (p !== "none" && /,/.test(p.user + (p.owner ?? ""))) throw new Error("A password can't contain a comma");
    this.protect = p === "none" ? "none" : { user: p.user, owner: p.owner || p.user };
    // (a change to save, though not one to undo)
    this.stateId = this.nextStateId++;
  }

  private encryptOptions(): string {
    const p = this.protect;
    if (p === null) return "";
    if (p === "none") return "encrypt=none";
    return `encrypt=aes-256,user-password=${p.user},owner-password=${p.owner}`;
  }

  // ---------- watermark, page numbers, header and footer ----------

  /** The bundled font file needed for these texts (when Helvetica lacks some of their letters), or null. */
  stampFontFile(texts: string[], bold = false): string | null {
    const helv = this.stampHelv(bold);
    if (texts.every((t) => pickFont([helv], t))) return null;
    return bold ? "LiberationSans-Bold.ttf" : "LiberationSans-Regular.ttf";
  }

  private stampHelv(bold: boolean): MuPDF.Font {
    return bold ? (this.helvBold ??= new this.mupdf.Font("Helvetica-Bold")) : (this.helv ??= new this.mupdf.Font("Helvetica"));
  }

  private stampFont(text: string, bold: boolean): MuPDF.Font {
    const helv = this.stampHelv(bold);
    if (pickFont([helv], text)) return helv;
    const lib = this.bundled.get(bold ? "LiberationSans-Bold.ttf" : "LiberationSans-Regular.ttf");
    if (lib && pickFont([lib], text)) return lib;
    const missing = [...new Set([...text].filter((c) => c.trim() && helv.encodeCharacter(c.codePointAt(0)!) <= 0 && !(lib && lib.encodeCharacter(c.codePointAt(0)!) > 0)))];
    throw new Error(`papgi can't write these letters yet: ${missing.slice(0, 8).join(" ")}`);
  }

  /** A text watermark on pages (real page content; one undo step). */
  watermark(o: WatermarkOptions): void {
    const doc = this.requireDoc();
    if (!o.text.trim()) throw new Error("The watermark has no text");
    this.journaled("Watermark", () => addWatermark(this.mupdf, doc, o, this.stampFont(o.text, o.bold)), o.pages);
    for (const i of o.pages) this.forgetText(i);
  }

  /** Page numbers, header and footer text (real page content; one undo step). Returns pages changed. */
  headerFooter(o: HeaderFooterOptions): number {
    const doc = this.requireDoc();
    let n = 0;
    this.journaled("Page numbers", () => {
      n = addHeaderFooter(this.mupdf, doc, o, (t) => this.stampFont(t, false));
      return n > 0;
    }, o.pages);
    for (const i of o.pages) this.forgetText(i);
    return n;
  }

  /** Something to tell the person after the last save, once. */
  takeNote(): string | null {
    const n = this.note;
    this.note = null;
    return n;
  }

  /** A separate copy of the open document. */
  private copyOfDoc(): MuPDF.PDFDocument {
    const buf = this.requireDoc().saveToBuffer("");
    const d = this.mupdf.Document.openDocument(buf.asUint8Array().slice(), "application/pdf");
    buf.destroy();
    const pdf = d.asPDF();
    if (!pdf) throw new Error("Copy failed");
    if (pdf.needsPassword() && !pdf.authenticatePassword(this.password)) throw new Error("Copy failed (password)");
    return pdf;
  }

  markSaved(): void {
    this.savedId = this.stateId;
  }

  undo(): DocInfo {
    this.endLive();
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
    this.endLive();
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

  /**
   * The open document as an undo/redo step: handed over as is (no copy needed), except a
   * big file, which is kept as bytes, so the engine's memory (2 GB at most) doesn't hold
   * two big documents at once.
   */
  private currentStep(name: string, content: number[] | "all"): UndoStep {
    const doc = this.requireDoc();
    if (this.docSize > PdfEngine.BIG_FILE) {
      const bytes = this.snapshot();
      this.doc = null;
      doc.destroy();
      return { name, id: this.stateId, content, bytes, size: this.docSize };
    }
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
      runWidgets(page, dev, mat);
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
        const kind = (["Highlight", "Underline", "StrikeOut", "Squiggly", "Ink", "FreeText", "Square", "Circle", "Line", "Polygon", "Text", "Stamp"].includes(type)
          ? type
          : "Other") as AnnotKind;
        const info: AnnotInfo = { index: i, num: a.getObject().asIndirect(), kind, rect: a.getBounds() as Rect, color: [...a.getColor()], contents: a.getContents() };
        if (kind === "Stamp" && isArea(a)) info.area = true;
        if (resizable(type)) info.resizable = true;
        if (kind === "Square" || kind === "Circle" || kind === "Polygon" || kind === "Line") info.shape = shapeInfo(a, kind);
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
    return this.drawShape(index, kind, [rect[0], rect[1]], [rect[2], rect[3]], { color, fill: null, width, line: "solid", opacity: 1 });
  }

  addArrow(index: number, from: Point, to: Point, color: RGB, width: number): AnnotInfo[] {
    return this.drawShape(index, "Arrow", from, to, { color, fill: null, width, line: "solid", opacity: 1 });
  }

  /** Draw a shape dragged from a to b (`square`: keep it square / snap the line). */
  drawShape(index: number, kind: ShapeKind, a: Point, b: Point, style: ShapeStyle, square = false): AnnotInfo[] {
    const g = shapeGeometry(kind, a, b, square);
    return this.op(isLineKind(kind) ? (kind === "Line" ? "Line" : "Arrow") : "Shape", index, (page) => {
      const type = kind === "Square" || kind === "Circle" ? kind : kind === "Cloud" ? "Square" : isLineKind(kind) ? "Line" : "Polygon";
      const an = page.createAnnotation(type);
      if (kind === "Cloud") {
        // a cloud: a box drawn with scalloped edges
        an.setBorderEffect("Cloudy");
        an.setBorderEffectIntensity(1);
      }
      if (type === "Line") {
        an.setLine(g.points[0], g.points[1]);
        an.setLineEndingStyles(kind === "DoubleArrow" ? "OpenArrow" : "None", kind === "Line" ? "None" : "OpenArrow");
      } else if (type === "Polygon") an.setVertices(g.points);
      else an.setRect(g.rect);
      applyShapeStyle(an, style);
      an.update();
      arrowAppearance(this.mupdf, page, an);
    });
  }

  /** Resize an item so its box becomes `rect` (page space). */
  resizeAnnot(index: number, annot: number, rect: Rect): AnnotInfo[] {
    return this.op("Resize", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (!a) throw new Error("No such annotation");
      resizeAnnot(this.mupdf, page, a, rect);
    });
  }

  /** Change how a shape looks (only the parts given). */
  styleAnnot(index: number, annot: number, style: Partial<ShapeStyle>): AnnotInfo[] {
    return this.op("Style", index, (page) => {
      const an = page.getAnnotations()[annot];
      if (!an) throw new Error("No such annotation");
      applyShapeStyle(an, style);
      an.update();
      arrowAppearance(this.mupdf, page, an);
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
      shiftAnnot(this.mupdf, page, a, dx, dy);
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
        shiftAnnot(this.mupdf, page, a, topLeft[0] - r[0], topLeft[1] - r[1]);
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
        return unpremultiply(pix);
      } finally {
        pix.destroy();
      }
    });
  }

  /** Render what's printed in a part of a page (transparent background), for drag previews. */
  renderArea(index: number, rect: Rect, scale: number, content = true): RGBAImage {
    const m = this.mupdf;
    return this.withPage(index, (page) => {
      const w = Math.max(1, Math.ceil((rect[2] - rect[0]) * scale));
      const h = Math.max(1, Math.ceil((rect[3] - rect[1]) * scale));
      const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], true);
      try {
        pix.clear();
        const dev = new m.DrawDevice(m.Matrix.identity, pix);
        const mat = m.Matrix.concat(m.Matrix.translate(-rect[0], -rect[1]), m.Matrix.scale(scale, scale));
        if (content) page.runPageContents(dev, mat);
        page.runPageAnnots(dev, mat);
        runWidgets(page, dev, mat);
        dev.close();
        dev.destroy();
        return unpremultiply(pix);
      } finally {
        pix.destroy();
      }
    });
  }

  /** A sticky note (comment) at a point: an icon on the page with the text in it. */
  addNote(index: number, at: Point, text: string, color: RGB): AnnotInfo[] {
    return this.op("Note", index, (page) => {
      const a = page.createAnnotation("Text");
      // (the icon's box: 22 pt, its top-left corner where it was put)
      a.setRect([at[0], at[1], at[0] + 22, at[1] + 22]);
      a.setIcon("Comment");
      a.setColor(color);
      a.setContents(text);
      a.update();
      arrowAppearance(this.mupdf, page, a);
      // (on a turned page the viewer draws an upright icon from another corner: put it where asked)
      const b = a.getBounds();
      if (Math.abs(b[0] - at[0]) > 0.5 || Math.abs(b[1] - at[1]) > 0.5) shiftAnnot(this.mupdf, page, a, at[0] - b[0], at[1] - b[1]);
    });
  }

  /** Change the text of a note (or any annotation's comment). */
  setNoteText(index: number, annot: number, text: string): AnnotInfo[] {
    return this.op("Note", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (!a) throw new Error("No such annotation");
      if (a.getContents() === text) return false;
      a.setContents(text);
      a.update();
      arrowAppearance(this.mupdf, page, a);
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
      arrowAppearance(this.mupdf, page, a);
    });
  }

  deleteAnnot(index: number, annot: number): AnnotInfo[] {
    return this.op("Delete", index, (page) => {
      const a = page.getAnnotations()[annot];
      if (a) page.deleteAnnotation(a);
    });
  }

  // ---------- table of contents ----------

  /** The PDF's own bookmarks, flattened with levels; null if it has none. */
  outline(): TocItem[] | null {
    const doc = this.requireDoc();
    let tree: ReturnType<MuPDF.PDFDocument["loadOutline"]>;
    try {
      tree = doc.loadOutline();
    } catch {
      return null;
    }
    if (!tree?.length) return null;
    const out: TocItem[] = [];
    const walk = (items: NonNullable<typeof tree>, level: number) => {
      for (const it of items) {
        let page = it.page ?? -1;
        let y: number | null = null;
        if (it.uri) {
          try {
            const d = doc.resolveLinkDestination(it.uri);
            if (page < 0) page = d.page;
            if (Number.isFinite(d.y) && (d.type === "XYZ" || d.type === "FitH" || d.type === "FitBH" || d.type === "FitR")) y = d.y;
          } catch {
            /* an outside link */
          }
        }
        if (out.length < 5000) out.push({ title: (it.title ?? "").trim() || "(untitled)", page, y, level });
        if (it.down?.length) walk(it.down, level + 1);
      }
    };
    walk(tree, 0);
    return out.length ? out : null;
  }

  /** Lines of text with their font size and weight (for finding headings). */
  textLines(pages: number[]): TextLine[] {
    const out: TextLine[] = [];
    for (const index of pages) {
      this.withPage(index, (page) => {
        const st = page.toStructuredText("");
        try {
          const j = JSON.parse(st.asJSON()) as { blocks: { type: string; lines?: { text: string; bbox: { y: number }; font: { size: number; weight: string; name: string } }[] }[] };
          j.blocks.forEach((b, bi) => {
            const lines = b.lines ?? [];
            lines.forEach((l, li) => {
              if (!l.text.trim()) return;
              const bold = l.font.weight === "bold" || /bold|black|heavy|semibold/i.test(l.font.name);
              out.push({ page: index, y: l.bbox.y, size: l.font.size, bold, text: l.text, block: bi, first: li === 0, lines: lines.length });
            });
          });
        } finally {
          st.destroy();
        }
      });
    }
    return out;
  }

  // ---------- copy, cut, paste, erase ----------

  /** What was copied last (kept when another file is opened). */
  private clip: Clip | null = null;
  /** Pastes in a row without a position go a little further down each time. */
  private pasteRun = { page: -1, n: 0 };
  /** Where the clip came from: pasting there again offsets it so it doesn't hide the original. */
  private clipFrom = { file: -1, page: -1 };
  private fileSerial = 0;

  private setClip(c: Clip | null, page = -1): ClipInfo | null {
    if (this.clip && this.clip !== c) this.clip.doc.destroy();
    this.clip = c;
    this.pasteRun = { page: -1, n: 0 };
    this.clipFrom = { file: this.fileSerial, page };
    return this.clipInfo();
  }

  clipInfo(): ClipInfo | null {
    const c = this.clip;
    return c ? { label: c.label, w: c.rect[2] - c.rect[0], h: c.rect[3] - c.rect[1], text: c.text } : null;
  }

  copyAnnot(index: number, annot: number): ClipInfo {
    return this.withPage(index, (page) => this.setClip(copyAnnots(this.mupdf, this.requireDoc(), page, [annot]), index))!;
  }

  cutAnnot(index: number, annot: number): { clip: ClipInfo; annots: AnnotInfo[] } {
    const clip = this.copyAnnot(index, annot);
    return { clip, annots: this.op("Cut", index, (page) => void page.deleteAnnotation(page.getAnnotations()[annot])) };
  }

  /** Copy what's printed in a part of a page; null if there's nothing there. */
  copyArea(index: number, rect: Rect, content = true): ClipInfo | null {
    const c = this.withPage(index, (page) => copyArea(this.mupdf, this.requireDoc(), page, rect, true, content));
    return c ? this.setClip(c, index) : null;
  }

  /** Copy a part of a page and erase it there (one undo step); null if there's nothing there. */
  cutArea(index: number, rect: Rect, content = true): { clip: ClipInfo; annots: AnnotInfo[] } | null {
    const clip = this.copyArea(index, rect, content);
    if (!clip) return null;
    return { clip, annots: this.eraseArea(index, rect, "Cut", content) };
  }

  /** Erase what's printed in a part of a page. */
  eraseArea(index: number, rect: Rect, name = "Erase", content = true): AnnotInfo[] {
    const doc = this.requireDoc();
    if (!content) {
      // a moved box: just what was moved goes
      this.journaled(name, () => this.withPage(index, (page) => removeItemsIn(page, rect)), []);
      return this.listAnnots(index);
    }
    this.journaled(name, () => this.withPage(index, (page) => eraseRects(this.mupdf, doc, page, [rect], { fields: true, annots: true })), [index]);
    this.forgetText(index);
    return this.listAnnots(index);
  }

  /**
   * Redact a part of a page: everything in it is really removed (text, pictures, drawings,
   * form fields, added items) and a black box put in its place.
   */
  redactArea(index: number, rect: Rect): AnnotInfo[] {
    const doc = this.requireDoc();
    this.journaled("Redact", () => this.withPage(index, (page) => eraseRects(this.mupdf, doc, page, [rect], { fields: true, annots: true, fill: [0, 0, 0] })), [index]);
    this.forgetText(index);
    return this.listAnnots(index);
  }

  /**
   * Where a text appears besides the page itself: comments and text boxes, form fields,
   * the file's details (title, author…) and bookmarks. `apply`: replace it there by "[redacted]".
   */
  private redactElsewhere(needle: string, apply: boolean): { count: number; pages: number[] } {
    const doc = this.requireDoc();
    const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const hits = (t: string | undefined) => (t ? (t.match(re) ?? []).length : 0);
    const clean = (t: string) => t.replace(re, "[redacted]");
    let count = 0;
    const pages: number[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const here = this.withPage(i, (page) => {
        let n = 0;
        for (const a of page.getAnnotations()) {
          const k = hits(a.getContents());
          if (!k) continue;
          n += k;
          if (apply) {
            a.setContents(clean(a.getContents()));
            // (rich text keeps its own copy of the words)
            a.getObject().delete("RC");
            a.update();
          }
        }
        for (const w of page.getWidgets()) {
          if (w.getFieldType() !== "text") continue;
          const k = hits(w.getValue());
          if (!k) continue;
          n += k;
          if (apply) {
            w.setTextValue(clean(w.getValue()));
            w.update();
          }
        }
        return n;
      });
      if (here) {
        count += here;
        pages.push(i);
      }
    }
    for (const key of ["info:Title", "info:Author", "info:Subject", "info:Keywords"]) {
      const v = doc.getMetaData(key);
      const k = hits(v);
      count += k;
      if (k && apply) doc.setMetaData(key, clean(v!));
    }
    const it = doc.outlineIterator();
    const walk = (): void => {
      for (let guard = 0; guard < 100000; guard++) {
        const item = it.item();
        if (item) {
          const k = hits(item.title);
          count += k;
          if (k && apply) it.update({ ...item, title: clean(item.title!) });
          if (it.down() === this.mupdf.OutlineIterator.ITERATOR_AT_ITEM) {
            walk();
            it.up();
          } else it.up();
        }
        if (it.next() !== this.mupdf.OutlineIterator.ITERATOR_AT_ITEM) return;
      }
    };
    try {
      if (it.item()) walk();
    } finally {
      it.destroy();
    }
    return { count, pages };
  }

  /** How many places redactText would black out or replace. */
  redactCount(needle: string): number {
    if (!needle.trim()) return 0;
    return this.search(needle, 10000).length + this.redactElsewhere(needle, false).count;
  }

  /**
   * Redact every place a text appears (one undo step): blacked out on the pages, and
   * replaced by "[redacted]" in comments, text boxes, form fields, the file's details and
   * bookmarks. Returns the pages changed and how many places.
   */
  redactText(needle: string): { pages: number[]; count: number } {
    const doc = this.requireDoc();
    if (!needle.trim()) return { pages: [], count: 0 };
    const hits = this.search(needle, 10000);
    const byPage = new Map<number, Rect[]>();
    for (const h of hits) {
      // a hit can span lines: one box per line piece, a little bigger than the letters
      for (const q of h.quads) {
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const pad = 0.5;
        const r: Rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
        byPage.set(h.page, [...(byPage.get(h.page) ?? []), r]);
      }
    }
    let other = { count: 0, pages: [] as number[] };
    this.journaled("Redact", () => {
      for (const [i, rects] of byPage) this.withPage(i, (page) => eraseRects(this.mupdf, doc, page, rects, { fields: false, annots: false, fill: [0, 0, 0] }));
      other = this.redactElsewhere(needle, true);
      return byPage.size > 0 || other.count > 0;
    }, [...byPage.keys()]);
    const pages = [...new Set([...byPage.keys(), ...other.pages])].sort((x, y) => x - y);
    for (const i of pages) this.forgetText(i);
    return { pages, count: hits.length + other.count };
  }

  /**
   * Move a part of a page (cut + paste in one step) so its top-left lands at `topLeft` on
   * page `to`. The moved part can then be moved again like an added item.
   */
  moveArea(index: number, rect: Rect, to: number, topLeft: Point, content = true): { from: AnnotInfo[]; to: AnnotInfo[]; index: number } | null {
    const doc = this.requireDoc();
    // what's printed is copied and erased; added items and form fields move as they are.
    // (A box that was moved before holds only what was moved: the page under it stays.)
    const c = content ? this.withPage(index, (page) => copyArea(this.mupdf, doc, page, rect, false)) : null;
    const nums = this.withPage(index, (page) => {
      const inside = itemsIn(page, rect);
      return [...inside.annots, ...inside.widgets].map((a) => a.getObject().asIndirect());
    });
    if (!c && !nums.length) return null;
    const dx = topLeft[0] - rect[0];
    const dy = topLeft[1] - rect[1];
    let pasted: number[] = [];
    try {
      this.journaled("Move", () => {
        if (c) {
          this.withPage(index, (page) => eraseRects(this.mupdf, doc, page, [rect], { fields: false, annots: false }));
          pasted = pasteClip(this.mupdf, doc, to, c, [c.rect[0] + dx, c.rect[1] + dy]);
        }
        moveObjects(this.mupdf, doc, index, to, nums, dx, dy);
      }, c ? [index, to] : []);
    } finally {
      c?.doc.destroy();
    }
    this.forgetText(index);
    this.forgetText(to);
    const first = pasted[0] ?? nums.find((n) => this.annotIndex(to, n) >= 0);
    return { from: this.listAnnots(index), to: this.listAnnots(to), index: this.annotIndex(to, first) };
  }

  /**
   * Paste what was copied on a page. Without a position it goes where it was copied from
   * (a little lower each time when pasted again on the same page). Returns the page's
   * annotations and the index of the first pasted one.
   */
  paste(index: number, topLeft: Point | null = null): { annots: AnnotInfo[]; index: number } {
    const c = this.clip;
    if (!c) throw new Error("Nothing copied yet");
    return this.pasteOn(index, c, topLeft, "Paste");
  }

  /** Copy an added item and paste it right next to itself (the clipboard stays as it was). */
  duplicateAnnot(index: number, annot: number): { annots: AnnotInfo[]; index: number } {
    const c = this.withPage(index, (page) => copyAnnots(this.mupdf, this.requireDoc(), page, [annot]));
    try {
      const off = 12;
      return this.pasteOn(index, c, [c.rect[0] + off, c.rect[1] + off], "Duplicate");
    } finally {
      c.doc.destroy();
    }
  }

  private pasteOn(index: number, c: Clip, topLeft: Point | null, name: string): { annots: AnnotInfo[]; index: number } {
    const doc = this.requireDoc();
    let at = topLeft;
    if (!at) {
      const home = this.clipFrom.file === this.fileSerial && this.clipFrom.page === index ? 1 : 0;
      this.pasteRun = this.pasteRun.page === index ? { page: index, n: this.pasteRun.n + 1 } : { page: index, n: home };
      const off = 12 * this.pasteRun.n;
      const b = this.pageInfo(index);
      const w = c.rect[2] - c.rect[0];
      const h = c.rect[3] - c.rect[1];
      // keep it on the page
      at = [Math.max(b.x, Math.min(c.rect[0] + off, b.x + b.w - w)), Math.max(b.y, Math.min(c.rect[1] + off, b.y + b.h - h))];
    }
    let nums: number[] = [];
    this.journaled(name, () => {
      nums = pasteClip(this.mupdf, doc, index, c, at!);
    }, []);
    this.forgetText(index);
    return { annots: this.listAnnots(index), index: this.annotIndex(index, nums[0]) };
  }

  /** Place a picture (PNG/JPEG bytes) with its top-left at `at`, `w` × `h` points. */
  addPicture(index: number, imageBytes: Uint8Array, rect: Rect): { annots: AnnotInfo[]; index: number } {
    const annots = this.op("Paste picture", index, (page) => {
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
    return { annots, index: annots.length ? annots[annots.length - 1].index : -1 };
  }

  /** The eraser: rub out along a brush path (radius r); `everything` also erases the page's own content. */
  erase(index: number, path: Point[], r: number, everything: boolean): AnnotInfo[] {
    const doc = this.requireDoc();
    let content = false;
    this.journaled("Erase", () => {
      const res = eraseBrush(this.mupdf, doc, index, path, r, everything);
      content = res.content;
      return res.changed;
    }, everything ? [index] : []);
    if (content || everything) this.forgetText(index);
    return this.listAnnots(index);
  }

  private annotIndex(index: number, objNum: number | undefined): number {
    if (objNum === undefined) return -1;
    return this.withPage(index, (page) => page.getAnnotations().findIndex((a) => a.getObject().asIndirect() === objNum));
  }

  private forgetText(index: number): void {
    this.stext.get(index)?.destroy();
    this.stext.delete(index);
    this.lines.delete(index);
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
      required: isRequired(w.getObject()),
      dateFormat: kind === "text" ? dateFormatOf(w.getObject()) : "",
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

  // ---------- making form fields ----------

  /** Add a form field (rect in page space). Returns the page's fields and the new one's index. */
  addField(index: number, kind: NewFieldKind, rect: Rect, opts: FieldProps & { group?: string | null; baseName?: string } = {}): { widgets: WidgetInfo[]; index: number; name: string } {
    const doc = this.requireDoc();
    let made = { num: 0, name: "" };
    this.journaled("Add field", () => {
      made = this.withPage(index, (page) => addField(this.mupdf, doc, page, kind, rect, opts));
    }, []);
    const widgets = this.listWidgets(index);
    const at = this.withPage(index, (page) => page.getWidgets().findIndex((x) => x.getObject().asIndirect() === made.num));
    return { widgets, index: at, name: made.name };
  }

  /** Move or resize a field (rect in page space). */
  setFieldRect(index: number, widget: number, rect: Rect): WidgetInfo[] {
    const doc = this.requireDoc();
    if (rectWidth(rect) < 4 || rectHeight(rect) < 4) throw new Error("That's too small for a field");
    this.op("Move field", index, (page) => {
      const w = page.getWidgets()[widget];
      if (!w) return false;
      placeWidget(this.mupdf, doc, page, w, rect);
    });
    return this.listWidgets(index);
  }

  /** Change a field's name, choices, date format, required… */
  setFieldProps(index: number, widget: number, props: FieldProps): WidgetInfo[] {
    const doc = this.requireDoc();
    this.op("Field settings", index, (page) => {
      const w = page.getWidgets()[widget];
      if (!w) return false;
      if (!setFieldProps(doc, w, props)) return false;
      redrawWidget(doc, w);
    });
    return this.listWidgets(index);
  }

  deleteField(index: number, widget: number): WidgetInfo[] {
    const doc = this.requireDoc();
    this.op("Delete field", index, (page) => {
      const w = page.getWidgets()[widget];
      if (!w) return false;
      deleteWidget(doc, page, w);
    });
    return this.listWidgets(index);
  }

  /** A copy of a field just below (or beside) it, with a new name; radio buttons join their group. */
  duplicateField(index: number, widget: number): { widgets: WidgetInfo[]; index: number; name: string } {
    const info = this.listWidgets(index)[widget];
    if (!info) throw new Error("No such field");
    const kind: NewFieldKind | null =
      info.kind === "text" ? (info.dateFormat ? "date" : info.multiline ? "multiline" : "text") : info.kind === "checkbox" || info.kind === "radio" || info.kind === "combobox" || info.kind === "signature" ? info.kind : null;
    if (!kind) throw new Error("This kind of field can't be copied");
    const page = this.pageInfo(index);
    const h = rectHeight(info.rect);
    const w = rectWidth(info.rect);
    const gap = 6;
    let r: Rect = [info.rect[0], info.rect[3] + gap, info.rect[2], info.rect[3] + gap + h];
    if (r[3] > page.y + page.h) r = [info.rect[2] + gap, info.rect[1], info.rect[2] + gap + w, info.rect[3]];
    return this.addField(index, kind, r, {
      group: kind === "radio" ? info.name : null,
      options: info.options,
      required: info.required,
      dateFormat: info.dateFormat || undefined,
      fontSize: info.fontSize,
      name: kind === "radio" ? undefined : uniqueName(this.requireDoc(), info.name.replace(/\s*\d+$/, "") || "Field"),
    });
  }

  /** Burn annotations and form fields into the page content (no longer editable). */
  flatten(): DocInfo {
    return this.docOp("Flatten", (doc) => doc.bake(true, true));
  }

  // ---------- crop ----------

  /** A page's visible part and its whole sheet, both as seen (page space). */
  pageBoxes(index: number): { crop: Rect; media: Rect; cropped: boolean } {
    const m = this.mupdf;
    return this.withPage(index, (page) => {
      const obj = page.getObject();
      const mb = boxOf(obj.getInheritable("MediaBox")) ?? [0, 0, 612, 792];
      const media = normRect(m.Rect.transform(mb, page.getTransform()) as Rect);
      const crop = page.getBounds() as Rect;
      const cb = boxOf(obj.getInheritable("CropBox"));
      return { crop, media, cropped: !!cb && Math.abs(rectWidth(crop) * rectHeight(crop) - rectWidth(media) * rectHeight(media)) > 1 };
    });
  }

  /** Where something is printed on a page, as seen (null: the page is blank). */
  contentBox(index: number): Rect | null {
    const m = this.mupdf;
    return this.withPage(index, (page) => {
      const b = page.getBounds();
      const scale = Math.min(1, 1200 / Math.max(rectWidth(b as Rect), rectHeight(b as Rect)));
      const pix = page.toPixmap(m.Matrix.concat(m.Matrix.translate(-b[0], -b[1]), m.Matrix.scale(scale, scale)), m.ColorSpace.DeviceRGB, false, true);
      try {
        const w = pix.getWidth();
        const h = pix.getHeight();
        const n = pix.getNumberOfComponents() + (pix.getAlpha() ? 1 : 0);
        const stride = pix.getStride();
        const px = pix.getPixels();
        let x0 = w;
        let y0 = h;
        let x1 = -1;
        let y1 = -1;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i = y * stride + x * n;
            if (px[i] < 240 || px[i + 1] < 240 || px[i + 2] < 240) {
              if (x < x0) x0 = x;
              if (x > x1) x1 = x;
              if (y < y0) y0 = y;
              if (y > y1) y1 = y;
            }
          }
        if (x1 < 0) return null;
        return [b[0] + x0 / scale, b[1] + y0 / scale, b[0] + (x1 + 1) / scale, b[1] + (y1 + 1) / scale];
      } finally {
        pix.destroy();
      }
    });
  }

  /**
   * Crop pages (one undo step). `margins`: [left, top, right, bottom] in points to cut off
   * each page as seen; `trim`: cut each page to what's printed on it plus this much space;
   * `reset`: show the whole sheet again.
   */
  cropPages(pages: number[], spec: { margins: [number, number, number, number] } | { trim: number } | { reset: true }): DocInfo & { changed: number } {
    const m = this.mupdf;
    const doc = this.requireDoc();
    const list = [...new Set(pages)].filter((i) => i >= 0 && i < doc.countPages());
    if (!list.length) throw new Error("Choose the pages to crop");
    const name = "reset" in spec ? "Remove crop" : "Crop";
    let changed = 0;
    this.journaled(name, () => {
      for (const i of list) {
        const page = doc.loadPage(i);
        try {
          const obj = page.getObject();
          if ("reset" in spec) {
            if (!obj.get("CropBox").isNull() || !obj.getInheritable("CropBox").isNull()) {
              const mb = boxOf(obj.getInheritable("MediaBox"));
              if (mb) obj.put("CropBox", mb);
              changed++;
            }
            continue;
          }
          const b = page.getBounds() as Rect;
          let seen: Rect;
          if ("trim" in spec) {
            const c = this.contentBox(i);
            if (!c) continue;
            seen = [Math.max(b[0], c[0] - spec.trim), Math.max(b[1], c[1] - spec.trim), Math.min(b[2], c[2] + spec.trim), Math.min(b[3], c[3] + spec.trim)];
          } else {
            const [l, t, r, bo] = spec.margins.map((v) => Math.max(0, v));
            seen = [b[0] + l, b[1] + t, b[2] - r, b[3] - bo];
          }
          if (rectWidth(seen) < 36 || rectHeight(seen) < 36) throw new Error(`Page ${i + 1} would be too small (less than about 1 cm)`);
          if (Math.abs(seen[0] - b[0]) + Math.abs(seen[1] - b[1]) + Math.abs(seen[2] - b[2]) + Math.abs(seen[3] - b[3]) < 0.01) continue;
          // as seen -> PDF space, inside the sheet
          const pdf = normRect(m.Rect.transform(seen, m.Matrix.invert(page.getTransform())) as Rect);
          const mb = boxOf(obj.getInheritable("MediaBox")) ?? pdf;
          const r: Rect = [Math.max(pdf[0], mb[0]), Math.max(pdf[1], mb[1]), Math.min(pdf[2], mb[2]), Math.min(pdf[3], mb[3])];
          obj.put("CropBox", r.map((v) => Math.round(v * 100) / 100));
          // (boxes that must lie inside the crop box)
          for (const k of ["TrimBox", "ArtBox", "BleedBox"]) obj.delete(k);
          changed++;
        } finally {
          page.destroy();
        }
      }
      return changed > 0;
    });
    this.clearText();
    return { ...this.info(), changed };
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
      return this.docOp("Insert pages", (doc) => graftPages(doc, src, [...Array(src.countPages()).keys()], at));
    } finally {
      src.destroy();
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
    bakeAreas(out);
    const buf = out.saveToBuffer("garbage=compact,compress");
    const bytes = buf.asUint8Array().slice();
    buf.destroy();
    out.destroy();
    return bytes;
  }

  // ---------- stand-alone tools (they don't touch the open document) ----------

  toolPageCount(f: PdfInput): number {
    return pdfPageCount(this.mupdf, f);
  }

  toolMerge(files: (PdfInput & { pages?: number[] })[]): Uint8Array {
    return mergePdfs(this.mupdf, files);
  }

  toolMergePages(files: PdfInput[], order: PageRef[]): Uint8Array {
    return mergePages(this.mupdf, files, order);
  }

  toolSplit(f: PdfInput, groups: SplitPage[][], baseName: string): OutFile[] {
    return splitPdf(this.mupdf, f, groups, baseName);
  }

  toolImagesToPdf(images: ImageInput[], opts: ImagesToPdfOptions): Uint8Array {
    return imagesToPdf(this.mupdf, images, opts);
  }

  toolPageToImage(f: PdfInput, index: number, opts: RenderOptions): Uint8Array {
    return pageToImage(this.mupdf, f, index, opts);
  }

  toolPagesToImages(f: PdfInput, pages: number[], opts: RenderOptions, turns?: number[]): Uint8Array[] {
    return pagesToImages(this.mupdf, f, pages, opts, turns);
  }

  toolPdfToWord(f: PdfInput, pages: number[], opts: WordOptions, turns?: number[]): WordResult {
    return pdfToWord(this.mupdf, f, pages, opts, turns);
  }

  // PDF -> Word a few pages at a time (progress): start, add pages, finish
  private wordJob: WordJob | null = null;
  toolWordStart(f: PdfInput, opts: WordOptions): void {
    this.wordJob?.close();
    this.wordJob = new WordJob(this.mupdf, f, opts);
  }
  toolWordAdd(pages: number[], turns?: number[]): void {
    if (!this.wordJob) throw new Error("No conversion running");
    this.wordJob.add(pages, turns);
  }
  toolWordFinish(): WordResult {
    const job = this.wordJob;
    if (!job) throw new Error("No conversion running");
    try {
      return job.finish();
    } finally {
      job.close();
      this.wordJob = null;
    }
  }
  toolWordCancel(): void {
    this.wordJob?.close();
    this.wordJob = null;
  }

  toolCompress(f: PdfInput, opts: CompressOptions): CompressResult {
    return compressPdf(this.mupdf, f, opts);
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
    this.endLive();
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
    this.pushStep(name, before, content);
  }

  /** A live change (e.g. a slider being dragged): shown as it goes, one undo step in the end. */
  private live: { name: string; before: Uint8Array; index: number } | null = null;

  /** Restyle a shape while its slider moves: no undo step yet (endLive makes one). */
  liveStyle(index: number, annot: number, style: Partial<ShapeStyle>): AnnotInfo[] {
    if (!this.live) {
      this.live = { name: "Style", before: this.ready?.doc === this.doc ? this.ready!.bytes : this.snapshot(), index };
      this.ready = null;
    }
    this.withPage(index, (page) => {
      const an = page.getAnnotations()[annot];
      if (!an) throw new Error("No such annotation");
      applyShapeStyle(an, style);
      an.update();
      arrowAppearance(this.mupdf, page, an);
    });
    return this.listAnnots(index);
  }

  /** The live change is done: it becomes one undo step. */
  endLive(): void {
    const l = this.live;
    if (!l) return;
    this.live = null;
    this.pushStep(l.name, l.before, []);
  }

  private pushStep(name: string, before: Uint8Array, content: number[] | "all"): void {
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

/** Set (parts of) a shape's style on an annotation. */
function applyShapeStyle(a: MuPDF.PDFAnnotation, st: Partial<ShapeStyle>): void {
  const type = a.getType();
  const fillable = type === "Square" || type === "Circle" || type === "Polygon";
  // (read before the width changes: the dashes say dashed or dotted relative to it)
  const lineBefore = lineStyleOf(a);
  if (st.width !== undefined) a.setBorderWidth(st.width);
  if (st.color !== undefined) {
    // (a line can't be without its line)
    const c = st.color ?? (fillable ? null : [0, 0, 0]);
    a.setColor((c ?? []) as MuPDF.AnnotColor);
  }
  if (st.fill !== undefined && fillable) a.setInteriorColor((st.fill ?? []) as MuPDF.AnnotColor);
  if (st.opacity !== undefined) a.setOpacity(Math.max(0.1, Math.min(1, st.opacity)));
  if (st.line !== undefined || st.width !== undefined) {
    const line = st.line ?? lineBefore;
    const dash = dashPattern(line, a.getBorderWidth());
    if (dash) {
      a.setBorderStyle("Dashed");
      a.setBorderDashPattern(dash);
    } else {
      a.setBorderStyle("Solid");
      a.clearBorderDash();
    }
  }
  // fill only: no outline drawn
  if (fillable && !a.getColor().length && !a.getInteriorColor().length) a.setInteriorColor([0.5, 0.5, 0.5]);
}

function lineStyleOf(a: MuPDF.PDFAnnotation): LineStyle {
  if (a.getBorderStyle() !== "Dashed") return "solid";
  const d = a.getBorderDashPattern() as number[];
  const w = a.getBorderWidth();
  return d.length && d[0] <= Math.max(w, 0.5) * 1.01 ? "dotted" : "dashed";
}

function shapeInfo(a: MuPDF.PDFAnnotation, type: string): { kind: ShapeKind } & ShapeStyle {
  let kind: ShapeKind = type as ShapeKind;
  if (type === "Polygon") kind = a.getVertices().length === 3 ? "Triangle" : "Diamond";
  else if (type === "Square" && a.hasBorderEffect() && a.getBorderEffect() === "Cloudy") kind = "Cloud";
  else if (type === "Line") {
    const e = a.getLineEndingStyles();
    kind = e.start !== "None" && e.end !== "None" ? "DoubleArrow" : e.start !== "None" || e.end !== "None" ? "Arrow" : "Line";
  }
  const c = a.getColor();
  const f = a.hasInteriorColor() ? a.getInteriorColor() : [];
  return { kind, color: c.length ? [...c] : null, fill: f.length ? [...f] : null, width: a.getBorderWidth(), line: lineStyleOf(a), opacity: a.getOpacity() };
}

/** RGBA ImageData-ready pixels from a MuPDF pixmap with alpha (which is premultiplied). */
function unpremultiply(pix: MuPDF.Pixmap): RGBAImage {
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
      const k = al ? 255 / al : 0;
      data[d] = src[s] * k;
      data[d + 1] = src[s + 1] * k;
      data[d + 2] = src[s + 2] * k;
      data[d + 3] = al;
    }
  return { width: w, height: h, data };
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

/** A PDF box ([x0 y0 x1 y1]) as a normalized rect, or null. */
function boxOf(o: MuPDF.PDFObject): Rect | null {
  if (!o.isArray() || o.length !== 4) return null;
  const v = [0, 1, 2, 3].map((i) => o.get(i).asNumber());
  return v.every(Number.isFinite) ? normRect(v as Rect) : null;
}

function normRect(r: Rect | number[]): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
}

/**
 * Draw a page's form fields. An empty signature box is left out: MuPDF would draw its own
 * red "SIGN" tag over it (the viewer shows a "Sign here" box instead).
 */
function runWidgets(page: MuPDF.PDFPage, dev: MuPDF.Device, mat: MuPDF.Matrix): void {
  for (const w of page.getWidgets()) {
    const flags = w.getFlags();
    if (flags & (2 | 32)) continue; // hidden, not shown on screen
    if (w.getFieldType() === "signature" && w.getObject().get("V").isNull()) continue;
    w.run(dev, mat);
  }
}
