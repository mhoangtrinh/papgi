// The document view: pages, rendering, zoom, tools and form fields.
import type { DocInfo, PageInfo, AnnotInfo, WidgetInfo, SearchHit, EditBlock, ClipInfo } from "../engine/engine";
import { fromPasteEvent, pictureBytes, readClipboard, writeClipboardText, type ClipboardContent } from "./clipboard";
import { editorRaise, loadTextBoxFont } from "./textbox-metrics";
import { ParagraphEditor } from "./text-editor";
import type { Engine } from "../engine/client";
import type { Settings, Tool, SavedSignature } from "../storage";
import { hexToRgb, rgbToHex } from "../storage";
import {
  type Point, type Quad, type Rect, normRect, inRect, simplifyStroke, placeStrokes, clampZoom, rectWidth, rectHeight,
} from "../core/geometry";
import { icon } from "./icons";
import { toast } from "./dialogs";
import { dataUrlBytes } from "./signature-dialog";

export interface ViewerHost {
  engine: Engine;
  settings: Settings;
  /** After any edit: update undo/redo/dirty state and thumbnails. */
  edited(info: DocInfo | null, pages: number[]): void;
  currentPageChanged(index: number): void;
  zoomChanged(zoom: number): void;
  needSignature(): Promise<boolean>;
  activeSignature(): SavedSignature | null;
  busy<T>(p: Promise<T>): Promise<T>;
  /** Offer text recognition (scanned pages). */
  recognize(): void;
  /** Something was copied (or the clipboard emptied). */
  clipChanged(info: ClipInfo | null): void;
  /** The view scrolled. */
  scrolled?(): void;
  saveSettings(): void;
}

interface PageView {
  index: number;
  info: PageInfo;
  el: HTMLDivElement;
  canvas: HTMLCanvasElement;
  svg: SVGSVGElement;
  forms: HTMLDivElement;
  renderedScale: number;
  version: number; // bumps on every edit, so stale renders are redone
  renderedVersion: number;
  near: boolean;
  annots: AnnotInfo[] | null;
  widgets: WidgetInfo[] | null;
  lines: Rect[] | null;
  dataVersion: number;
  blocks: EditBlock[] | null; // paragraphs, loaded while the Edit text tool is on
  blocksVersion: number;
}

const SVGNS = "http://www.w3.org/2000/svg";
const PAGE_GAP = 16;
const MAX_PIXELS = 24e6;
export const PALETTE = ["#ffd400", "#5fd068", "#2f6fed", "#e5484d", "#8e4ec6", "#1c1c1c"];

type Drag =
  | { kind: "move"; pv: PageView; annot: AnnotInfo; start: Point; last: Point; x: number; y: number; moved: boolean; ghost: HTMLCanvasElement | null }
  | { kind: "select"; pv: PageView; start: Point; last: Point }
  | { kind: "pan"; startX: number; startY: number; left: number; top: number }
  | { kind: "mark"; pv: PageView; start: Point; last: Point; onText: boolean }
  | { kind: "pen"; pv: PageView; points: Point[] }
  | { kind: "shape"; pv: PageView; start: Point; last: Point }
  | { kind: "click"; pv: PageView; start: Point; x: number; y: number }
  | { kind: "area"; pv: PageView; start: Point; last: Point }
  | { kind: "areamove"; pv: PageView; rect: Rect; start: Point; last: Point; x: number; y: number; moved: boolean; ghost: HTMLCanvasElement | null }
  | { kind: "erase"; pv: PageView; points: Point[] };

export class Viewer {
  readonly el: HTMLDivElement;
  private pagesEl: HTMLDivElement;
  private pages: PageView[] = [];
  private info: DocInfo | null = null;
  zoom = 1;
  fitWidth = true;
  private tool: Tool = "select";
  private observer: IntersectionObserver;
  private rendering = false;
  private drag: Drag | null = null;
  private selection: { page: number; start: Point; end: Point; quads: Quad[] } | null = null;
  private selBusy = false;
  private selQueued = false;
  private selected: { page: number; index: number } | null = null;
  private hits: SearchHit[] = [];
  private hitIndex = -1;
  private current = 0;
  private editor: HTMLTextAreaElement | null = null;
  private floating: HTMLDivElement;
  private ghost: SVGGElement | null = null;

  constructor(private host: ViewerHost, mount: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "viewer";
    this.el.tabIndex = -1;
    this.pagesEl = document.createElement("div");
    this.pagesEl.className = "pages";
    this.el.append(this.pagesEl);
    this.floating = document.createElement("div");
    this.floating.className = "floating";
    this.floating.hidden = true;
    mount.append(this.el);

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pv = this.pages[Number((e.target as HTMLElement).dataset.index)];
          if (!pv) continue;
          pv.near = e.isIntersecting;
          if (pv.near) this.loadPageData(pv);
          else this.dropPage(pv);
        }
        this.schedule();
      },
      { root: this.el, rootMargin: "150% 0px" },
    );

    this.el.addEventListener("scroll", () => {
      this.updateCurrent();
      this.schedule();
      this.host.scrolled?.();
    }, { passive: true });
    this.el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.pagesEl.addEventListener("pointerdown", (e) => this.onDown(e));
    this.pagesEl.addEventListener("pointermove", (e) => this.onMove(e));
    this.pagesEl.addEventListener("pointerup", (e) => this.onUp(e));
    this.pagesEl.addEventListener("pointercancel", () => this.cancelDrag());
    this.pagesEl.addEventListener("pointerleave", () => {
      this.hideGhost();
      this.pointer = null;
      for (const pv of this.pages) pv.svg.querySelector(".erase-cursor")?.remove();
    });
    this.pagesEl.addEventListener("contextmenu", (e) => this.onContextMenu(e));
    this.pagesEl.addEventListener("dblclick", (e) => this.onDblClick(e));
    new ResizeObserver(() => {
      if (this.fitWidth && this.info) this.setZoom(this.fitZoom(), false);
    }).observe(this.el);
  }

  // ---------- document ----------

  hasDoc(): boolean {
    return this.info !== null;
  }

  setDocument(info: DocInfo | null, keepPosition = false): void {
    const keep = keepPosition ? this.current : 0;
    this.closeEditor(false);
    if (this.para) {
      this.para.ed.destroy();
      this.para = null;
    }
    this.clearSelection();
    this.selectAnnot(null);
    this.setArea(null);
    this.observer.disconnect();
    this.pagesEl.replaceChildren();
    this.pages = [];
    this.info = info;
    if (!info) return;
    info.pages.forEach((pi, i) => this.pages.push(this.createPage(i, pi)));
    if (!keepPosition) this.fitWidth = true;
    this.setZoom(this.fitWidth ? this.fitZoom() : this.zoom, false);
    for (const pv of this.pages) this.observer.observe(pv.el);
    this.scrollToPage(Math.min(keep, info.pageCount - 1), false);
    this.current = Math.min(keep, info.pageCount - 1);
    this.host.currentPageChanged(this.current);
    this.updateCurrent();
  }

  /**
   * Refresh after undo/redo or page operations. Rebuilds when the page structure changed,
   * otherwise just re-renders and reloads page data.
   */
  refresh(info: DocInfo, pages: number[] | "all" = "all"): void {
    const old = this.info;
    const same =
      old &&
      old.pageCount === info.pageCount &&
      old.pages.every((p, i) => p.w === info.pages[i].w && p.h === info.pages[i].h && p.rotation === info.pages[i].rotation);
    if (!same) {
      this.setDocument(info, true);
      return;
    }
    this.info = info;
    const list = pages === "all" ? this.pages : pages.map((i) => this.pages[i]).filter(Boolean);
    for (const pv of list) this.invalidate(pv);
    if (this.selected && !this.pages[this.selected.page]) this.selectAnnot(null);
    if (this.area && !this.pages[this.area.page]) this.setArea(null);
    this.schedule();
  }

  private createPage(index: number, info: PageInfo): PageView {
    const el = document.createElement("div");
    el.className = "page";
    el.dataset.index = String(index);
    const canvas = document.createElement("canvas");
    canvas.className = "page-canvas";
    const svg = document.createElementNS(SVGNS, "svg");
    svg.classList.add("page-overlay");
    svg.setAttribute("viewBox", `${info.x} ${info.y} ${info.w} ${info.h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = `<g class="g-hits"></g><g class="g-sel"></g><g class="g-hover"></g><g class="g-annsel"></g><g class="g-area"></g><g class="g-preview"></g>`;
    const forms = document.createElement("div");
    forms.className = "page-forms";
    const label = document.createElement("div");
    label.className = "page-num";
    label.textContent = String(index + 1);
    el.append(canvas, svg, forms, label);
    this.pagesEl.append(el);
    return {
      index, info, el, canvas, svg: svg as SVGSVGElement, forms,
      renderedScale: 0, version: 1, renderedVersion: 0, near: false,
      annots: null, widgets: null, lines: null, dataVersion: 0, blocks: null, blocksVersion: 0,
    };
  }

  private invalidate(pv: PageView): void {
    pv.version++;
    pv.annots = pv.widgets = pv.lines = null;
    pv.blocks = null;
    if (pv.near) this.loadPageData(pv);
  }

  /** Paragraph list for the Edit text tool (cached per page version). */
  private async ensureBlocks(pv: PageView): Promise<EditBlock[]> {
    if (pv.blocks && pv.blocksVersion === pv.version) return pv.blocks;
    const v = pv.version;
    const blocks = await this.host.engine.textBlocks(pv.index);
    if (pv.version === v) {
      pv.blocks = blocks;
      pv.blocksVersion = v;
    }
    return blocks;
  }

  private blockAt(pv: PageView, p: Point): EditBlock | null {
    const pad = 2;
    for (const b of pv.blocks ?? []) {
      if (!b.lines.length) continue;
      if (b.lines.some((l) => inRect([b.left, l.bbox[1], b.left + b.width, l.bbox[3]], p[0], p[1], pad))) return b;
    }
    return null;
  }

  private async loadPageData(pv: PageView): Promise<void> {
    if (pv.annots && pv.dataVersion === pv.version) return;
    const v = pv.version;
    pv.dataVersion = v;
    try {
      const [annots, widgets, lines] = await Promise.all([
        this.host.engine.listAnnots(pv.index),
        this.host.engine.listWidgets(pv.index),
        this.host.engine.lineBoxes(pv.index),
      ]);
      if (pv.version !== v || this.pages[pv.index] !== pv) return;
      pv.annots = annots;
      pv.lines = lines;
      this.setWidgets(pv, widgets);
      this.drawHits(pv);
      if (this.selected?.page === pv.index) this.drawAnnotSelection();
    } catch {
      pv.dataVersion = 0;
    }
  }

  private dropPage(pv: PageView): void {
    if (pv.renderedScale) {
      pv.canvas.width = pv.canvas.height = 0;
      pv.renderedScale = 0;
      pv.el.classList.remove("rendered");
    }
  }

  // ---------- rendering ----------

  private targetScale(pv: PageView): number {
    const dpr = window.devicePixelRatio || 1;
    let s = this.zoom * dpr;
    const px = pv.info.w * pv.info.h * s * s;
    if (px > MAX_PIXELS) s *= Math.sqrt(MAX_PIXELS / px);
    return Math.round(s * 1000) / 1000;
  }

  /** Pages in view still waiting to be drawn (thumbnails wait for these). */
  busyWithVisible(): boolean {
    return this.rendering || this.visiblePages().some((pv) => pv.renderedScale !== this.targetScale(pv) || pv.renderedVersion !== pv.version);
  }

  private visiblePages(): PageView[] {
    const vr = this.el.getBoundingClientRect();
    return this.pages.filter((pv) => {
      if (!pv.near) return false;
      const r = pv.el.getBoundingClientRect();
      return r.bottom > vr.top && r.top < vr.bottom;
    });
  }

  private schedule(): void {
    if (this.rendering || !this.info) return;
    const needs = (pv: PageView) => pv.renderedScale !== this.targetScale(pv) || pv.renderedVersion !== pv.version;
    const visible = this.visiblePages();
    // pages coming into view first get a quick, low-resolution picture (big scans take a few
    // hundred ms to draw sharply), then the sharp one
    const blank = visible.find((pv) => pv.renderedScale === 0);
    const next = blank ?? visible.find(needs) ?? this.pages.find((pv) => pv.near && needs(pv));
    if (!next) return;
    this.rendering = true;
    const full = this.targetScale(next);
    const scale = blank && full > 1.2 ? Math.round(Math.max(0.6, full / 3) * 1000) / 1000 : full;
    const version = next.version;
    this.host.engine
      .renderBitmap(next.index, scale)
      .then((bmp) => {
        if (this.pages[next.index] === next && next.near) {
          next.canvas.width = bmp.width;
          next.canvas.height = bmp.height;
          next.canvas.getContext("2d")!.drawImage(bmp, 0, 0);
          next.renderedScale = scale;
          next.renderedVersion = version;
          next.el.classList.add("rendered");
        }
        bmp.close();
      })
      .catch((e) => {
        next.renderedScale = scale;
        next.renderedVersion = version;
        // (a page of a document that was closed meanwhile is expected to fail)
        if (this.pages[next.index] === next) console.warn("Couldn't render page", next.index + 1, e);
      })
      .finally(() => {
        this.rendering = false;
        this.schedule();
      });
  }

  // ---------- zoom & navigation ----------

  private fitZoom(): number {
    if (!this.info) return 1;
    const maxW = Math.max(...this.info.pages.map((p) => p.w));
    const avail = this.el.clientWidth - 2 * PAGE_GAP - 8;
    // Fit the width, but don't blow pages up past a comfortable reading size.
    return clampZoom(Math.min(avail / maxW, 1.6));
  }

  setFitWidth(): void {
    this.fitWidth = true;
    this.setZoom(this.fitZoom());
  }

  setZoom(z: number, userAction = true, anchor?: { x: number; y: number }): void {
    z = clampZoom(z);
    if (userAction) this.fitWidth = false;
    const el = this.el;
    const ax = anchor?.x ?? el.clientWidth / 2;
    const ay = anchor?.y ?? el.clientHeight / 2;
    const fx = (el.scrollLeft + ax) / Math.max(1, el.scrollWidth);
    const fy = (el.scrollTop + ay) / Math.max(1, el.scrollHeight);
    this.zoom = z;
    this.pagesEl.style.setProperty("--z", String(z));
    for (const pv of this.pages) {
      pv.el.style.width = `${pv.info.w * z}px`;
      pv.el.style.height = `${pv.info.h * z}px`;
    }
    el.scrollLeft = fx * el.scrollWidth - ax;
    el.scrollTop = fy * el.scrollHeight - ay;
    this.positionFloating();
    this.host.zoomChanged(z);
    this.schedule();
  }

  private onWheel(e: WheelEvent): void {
    if (!(e.ctrlKey || e.metaKey) || !this.info) return;
    e.preventDefault();
    const r = this.el.getBoundingClientRect();
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
    this.setZoom(this.zoom * factor, true, { x: e.clientX - r.left, y: e.clientY - r.top });
  }

  /** Scroll to a page (and a height on it, page space). */
  scrollToPage(index: number, smooth = true, y: number | null = null): void {
    const pv = this.pages[index];
    if (!pv) return;
    const off = y === null ? -PAGE_GAP : Math.max(0, (y - pv.info.y) * this.zoom - 24);
    this.el.scrollTo({ top: pv.el.offsetTop + off, behavior: smooth ? "smooth" : "auto" });
  }

  private updateCurrent(): void {
    if (!this.pages.length) return;
    const vr = this.el.getBoundingClientRect();
    const mid = vr.top + vr.height * 0.35;
    let best = this.current;
    for (const pv of this.pages) {
      const r = pv.el.getBoundingClientRect();
      if (r.top <= mid && r.bottom + PAGE_GAP >= mid) {
        best = pv.index;
        break;
      }
    }
    if (best !== this.current) {
      this.current = best;
      this.host.currentPageChanged(best);
    }
  }

  currentPage(): number {
    return this.current;
  }

  /** Where the reader is: the page and height (page space) a third of the way down the view. */
  readingPlace(): { page: number; y: number } {
    const pv = this.pages[this.current];
    if (!pv) return { page: 0, y: 0 };
    const vr = this.el.getBoundingClientRect();
    return { page: pv.index, y: this.toPagePoint(pv, { clientX: vr.left, clientY: vr.top + vr.height * 0.35 })[1] };
  }

  // ---------- tools ----------

  setTool(tool: Tool): void {
    this.tool = tool;
    this.closeEditor(true);
    void this.closeParagraph(true);
    this.hideGhost();
    for (const pv of this.pages) pv.svg.querySelector(".g-hover")?.replaceChildren();
    if (tool === "edit") for (const pv of this.pages) if (pv.near) void this.ensureBlocks(pv).catch(() => {});
    if (tool !== "select") this.clearSelection();
    if (tool !== "select" && tool !== "area") this.selectAnnot(null);
    if (tool !== "area") this.setArea(null);
    for (const pv of this.pages) pv.svg.querySelector(".erase-cursor")?.remove();
    this.pagesEl.dataset.tool = tool;
  }

  private pageFromEvent(e: Event): PageView | null {
    const el = (e.target as Element).closest?.(".page") as HTMLElement | null;
    return el ? this.pages[Number(el.dataset.index)] ?? null : null;
  }

  private toPagePoint(pv: PageView, e: { clientX: number; clientY: number }): Point {
    const r = pv.el.getBoundingClientRect();
    return [pv.info.x + ((e.clientX - r.left) / r.width) * pv.info.w, pv.info.y + ((e.clientY - r.top) / r.height) * pv.info.h];
  }

  private annotAt(pv: PageView, p: Point): AnnotInfo | null {
    const pad = 4 / this.zoom;
    let best: AnnotInfo | null = null;
    for (const a of pv.annots ?? []) {
      if (!inRect(a.rect, p[0], p[1], pad)) continue;
      if (!best || rectWidth(a.rect) * rectHeight(a.rect) < rectWidth(best.rect) * rectHeight(best.rect)) best = a;
    }
    return best;
  }

  private onText(pv: PageView, p: Point): boolean {
    const pad = 1;
    return (pv.lines ?? []).some((r) => inRect(r, p[0], p[1], pad));
  }

  /** Select tool: I-beam over text, move cursor over annotations, arrow elsewhere. */
  private hoverCursor(e: PointerEvent): void {
    const pv = this.pageFromEvent(e);
    let kind = "";
    if (pv && !(e.target as Element).closest(".page-forms > *, .floating")) {
      const p = this.toPagePoint(pv, e);
      if (this.annotAt(pv, p)) kind = "over-annot";
      else if (this.onText(pv, p)) kind = "over-text";
    }
    if (this.cursorPage && (this.cursorPage !== pv || this.cursorKind !== kind)) this.cursorPage.el.classList.remove("over-text", "over-annot");
    if (pv && kind) pv.el.classList.add(kind);
    this.cursorPage = pv;
    this.cursorKind = kind;
  }

  private cursorPage: PageView | null = null;
  private cursorKind = "";

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if ((e.target as Element).closest(".page-forms > *, .text-editor, .para-editor, .floating")) return;
    if (this.para) {
      // clicking anywhere else finishes the paragraph being edited
      void this.closeParagraph(true);
      return;
    }
    const pv = this.pageFromEvent(e);
    if (!pv) {
      if (this.tool === "select") {
        this.clearSelection();
        this.selectAnnot(null);
      }
      return;
    }
    if (this.editor) {
      this.closeEditor(true);
      if (this.tool !== "text") return;
    }
    const p = this.toPagePoint(pv, e);
    const capture = () => (e.target as Element).setPointerCapture?.(e.pointerId);

    const grabAnnot = (a: AnnotInfo) => {
      this.clearSelection();
      this.selectAnnot({ page: pv.index, index: a.index });
      const drag: Drag = { kind: "move", pv, annot: a, start: p, last: p, x: e.clientX, y: e.clientY, moved: false, ghost: null };
      this.drag = drag;
      capture();
      e.preventDefault();
      void this.makeGhost(drag);
    };
    switch (this.tool) {
      case "area": {
        const a = this.annotAt(pv, p);
        if (this.area?.page === pv.index && inRect(this.area.rect, p[0], p[1])) {
          const drag: Drag = { kind: "areamove", pv, rect: this.area.rect, start: p, last: p, x: e.clientX, y: e.clientY, moved: false, ghost: null };
          this.drag = drag;
          capture();
          e.preventDefault();
          void this.makeAreaGhost(drag);
        } else if (a) grabAnnot(a);
        else {
          this.setArea(null);
          this.selectAnnot(null);
          this.drag = { kind: "area", pv, start: p, last: p };
          capture();
          e.preventDefault();
        }
        break;
      }
      case "eraser":
        this.drag = { kind: "erase", pv, points: [p] };
        capture();
        e.preventDefault();
        this.previewErase(pv, [p]);
        break;
      case "select": {
        const a = this.annotAt(pv, p);
        if (a) grabAnnot(a);
        else if (this.onText(pv, p)) {
          this.selectAnnot(null);
          this.clearSelection();
          this.drag = { kind: "select", pv, start: p, last: p };
          capture();
          e.preventDefault();
        } else {
          this.clearSelection();
          this.selectAnnot(null);
          if (e.pointerType === "mouse") {
            this.drag = { kind: "pan", startX: e.clientX, startY: e.clientY, left: this.el.scrollLeft, top: this.el.scrollTop };
            capture();
            this.pagesEl.classList.add("panning");
          } else {
            // a long press on an empty spot offers Paste
            const at = { x: e.clientX, y: e.clientY };
            this.cancelLongPress();
            this.longPress = { x: at.x, y: at.y, timer: setTimeout(() => {
              this.longPress = null;
              this.showPasteMenu(pv, p);
            }, 480) };
          }
        }
        break;
      }
      case "highlight":
        this.drag = { kind: "mark", pv, start: p, last: p, onText: this.onText(pv, p) };
        capture();
        e.preventDefault();
        break;
      case "pen":
        this.drag = { kind: "pen", pv, points: [p] };
        capture();
        e.preventDefault();
        break;
      case "shape":
        this.drag = { kind: "shape", pv, start: p, last: p };
        capture();
        e.preventDefault();
        break;
      case "text":
      case "sign":
      case "edit":
        this.drag = { kind: "click", pv, start: p, x: e.clientX, y: e.clientY };
        break;
    }
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (this.longPress && Math.hypot(e.clientX - this.longPress.x, e.clientY - this.longPress.y) > 8) this.cancelLongPress();
    if (e.pointerType === "mouse") {
      const pv = this.pageFromEvent(e);
      this.pointer = pv ? { page: pv.index, p: this.toPagePoint(pv, e) } : null;
    }
    if (!d) {
      if (this.tool === "sign") this.moveGhost(e);
      else if (this.tool === "edit") this.hoverBlock(e);
      else if (this.tool === "select") this.hoverCursor(e);
      else if (this.tool === "eraser" && e.pointerType === "mouse") this.hoverEraser(e);
      return;
    }
    if (d.kind === "pan") {
      this.el.scrollLeft = d.left - (e.clientX - d.startX);
      this.el.scrollTop = d.top - (e.clientY - d.startY);
      return;
    }
    if (d.kind === "click") return;
    const p = this.toPagePoint(d.pv, e);
    switch (d.kind) {
      case "move": {
        d.last = p;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) break;
        d.moved = true;
        d.pv.el.classList.add("moving");
        this.hideFloating();
        this.positionGhost(d, e);
        break;
      }
      case "select":
        d.last = p;
        this.updateTextSelection(d.pv, d.start, p, "sel");
        break;
      case "mark":
        d.last = p;
        if (d.onText) this.updateTextSelection(d.pv, d.start, p, "mark");
        else this.previewRect(d.pv, normRect(d.start[0], d.start[1], p[0], p[1]), "mark");
        break;
      case "pen": {
        const pts = (e.getCoalescedEvents?.() ?? [e]).map((ce) => this.toPagePoint(d.pv, ce));
        d.points.push(...pts);
        this.previewPen(d.pv, d.points);
        break;
      }
      case "shape":
        d.last = p;
        this.previewShape(d.pv, d.start, p);
        break;
      case "area":
        d.last = p;
        this.drawArea(d.pv, normRect(d.start[0], d.start[1], p[0], p[1]), true);
        break;
      case "areamove": {
        d.last = p;
        if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 3) break;
        d.moved = true;
        this.hideFloating();
        this.positionAreaGhost(d, e);
        break;
      }
      case "erase": {
        const pts = (e.getCoalescedEvents?.() ?? [e]).map((ce) => this.toPagePoint(d.pv, ce));
        d.points.push(...pts);
        this.previewErase(d.pv, d.points);
        if (e.pointerType === "mouse") this.hoverEraser(e);
        break;
      }
    }
  }

  private async onUp(e: PointerEvent): Promise<void> {
    this.cancelLongPress();
    const d = this.drag;
    this.drag = null;
    this.pagesEl.classList.remove("panning");
    if (!d) return;
    const s = this.host.settings;
    const eng = this.host.engine;
    try {
      switch (d.kind) {
        case "move": {
          d.pv.el.classList.remove("moving");
          if (!d.moved) {
            d.ghost?.remove();
            if (this.selected) this.drawAnnotSelection();
            return;
          }
          const target = this.pageAt(e.clientX, e.clientY) ?? d.pv;
          // the picture being dragged stays where it was dropped until the page shows the move
          const ghost = d.ghost;
          ghost?.classList.add("dropped");
          if (target === d.pv) {
            const dx = d.last[0] - d.start[0];
            const dy = d.last[1] - d.start[1];
            try {
              this.afterAnnotEdit(d.pv, await eng.moveAnnot(d.pv.index, d.annot.index, dx, dy));
            } finally {
              if (ghost) this.keepUntilRendered(d.pv, ghost);
            }
            return;
          }
          // dropped on another page: keep the same grab point under the pointer
          const p = this.toPagePoint(target, e);
          const topLeft: Point = [p[0] - (d.start[0] - d.annot.rect[0]), p[1] - (d.start[1] - d.annot.rect[1])];
          let res: Awaited<ReturnType<typeof eng.moveAnnotToPage>>;
          try {
            res = await eng.moveAnnotToPage(d.pv.index, d.annot.index, target.index, topLeft);
          } catch (err) {
            ghost?.remove();
            throw err;
          }
          this.selectAnnot(null);
          this.afterAnnotEdit(d.pv, res.from);
          this.afterAnnotEdit(target, res.to);
          if (ghost) this.keepUntilRendered(target, ghost);
          this.selectAnnot({ page: target.index, index: res.index });
          break;
        }
        case "select": {
          if (Math.hypot(d.last[0] - d.start[0], d.last[1] - d.start[1]) * this.zoom < 2) {
            this.clearSelection();
            return;
          }
          await this.updateTextSelection(d.pv, d.start, d.last, "sel", true);
          if (this.selection?.quads.length) this.showSelectionMenu();
          break;
        }
        case "mark": {
          const kind = s.markKind;
          const color = hexToRgb(s.colors.highlight);
          let quads: Quad[];
          if (d.onText) {
            quads = await eng.selectText(d.pv.index, d.start, d.last);
          } else {
            const r = normRect(d.start[0], d.start[1], d.last[0], d.last[1]);
            if (rectWidth(r) * this.zoom < 4 || rectHeight(r) * this.zoom < 4) {
              this.clearPreview(d.pv);
              return;
            }
            quads = [[r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]];
          }
          this.clearPreview(d.pv);
          this.clearSelection();
          if (!quads.length) return;
          const held = this.holdQuads(d.pv, quads, kind, s.colors.highlight);
          try {
            this.afterAnnotEdit(d.pv, await eng.addMarkup(d.pv.index, kind, quads, color));
            held.release(true);
          } catch (err) {
            held.release(false);
            throw err;
          }
          break;
        }
        case "pen": {
          const held = this.holdPreview(d.pv);
          const stroke = simplifyStroke(d.points, 0.25 / this.zoom + 0.1);
          try {
            this.afterAnnotEdit(d.pv, await eng.addInk(d.pv.index, [stroke], hexToRgb(s.colors.pen), s.penWidth));
            held.release(true);
          } catch (err) {
            held.release(false);
            throw err;
          }
          break;
        }
        case "shape": {
          const r = normRect(d.start[0], d.start[1], d.last[0], d.last[1]);
          const tiny = Math.hypot(rectWidth(r), rectHeight(r)) * this.zoom < 6;
          if (tiny) {
            this.clearPreview(d.pv);
            return;
          }
          const color = hexToRgb(s.colors.shape);
          const held = this.holdPreview(d.pv);
          try {
            const annots =
              s.shapeKind === "Arrow"
                ? await eng.addArrow(d.pv.index, d.start, d.last, color, s.shapeWidth)
                : await eng.addShape(d.pv.index, s.shapeKind, r, color, s.shapeWidth);
            this.afterAnnotEdit(d.pv, annots);
            held.release(true);
          } catch (err) {
            held.release(false);
            throw err;
          }
          break;
        }
        case "area": {
          const r = normRect(d.start[0], d.start[1], d.last[0], d.last[1]);
          if (rectWidth(r) * this.zoom < 6 || rectHeight(r) * this.zoom < 6) {
            this.setArea(null);
            return;
          }
          this.setArea({ page: d.pv.index, rect: r });
          break;
        }
        case "areamove": {
          if (!d.moved) {
            d.ghost?.remove();
            if (this.area) this.showAreaMenu();
            return;
          }
          const target = this.pageAt(e.clientX, e.clientY) ?? d.pv;
          const p = this.toPagePoint(target, e);
          const topLeft: Point = [p[0] - (d.start[0] - d.rect[0]), p[1] - (d.start[1] - d.rect[1])];
          const ghost = d.ghost;
          ghost?.classList.add("dropped");
          this.setArea(null);
          let res: Awaited<ReturnType<typeof eng.moveArea>>;
          try {
            res = await this.host.busy(eng.moveArea(d.pv.index, d.rect, target.index, topLeft));
          } catch (err) {
            ghost?.remove();
            throw err;
          }
          if (!res) {
            ghost?.remove();
            return void toast("There's nothing in that area to move", "info");
          }
          if (target !== d.pv) this.afterAnnotEdit(d.pv, res.from);
          this.afterAnnotEdit(target, res.to);
          if (ghost) this.keepUntilRendered(target, ghost);
          this.selectAnnot({ page: target.index, index: res.index });
          break;
        }
        case "erase": {
          const held = this.holdPreview(d.pv);
          const path = d.points.length > 2 ? simplifyStroke(d.points, 0.4 / this.zoom + 0.1) : d.points;
          try {
            this.afterAnnotEdit(d.pv, await eng.erase(d.pv.index, path, s.eraserSize / 2, s.eraserAll));
            held.release(true);
          } catch (err) {
            held.release(false);
            throw err;
          }
          break;
        }
        case "click": {
          if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
          if (this.tool === "text") {
            const a = this.annotAt(d.pv, d.start);
            if (a?.kind === "FreeText") this.openEditor(d.pv, a);
            else this.openEditor(d.pv, null, d.start);
          } else if (this.tool === "sign") {
            await this.placeSignature(d.pv, d.start);
          } else if (this.tool === "edit") {
            await this.openParagraph(d.pv, d.start, e.clientX, e.clientY);
          }
          break;
        }
      }
    } catch (err) {
      toast((err as Error).message, "error");
      if ("pv" in d) this.clearPreview(d.pv);
    }
  }

  private cancelDrag(): void {
    this.cancelLongPress();
    const d = this.drag;
    this.drag = null;
    this.pagesEl.classList.remove("panning");
    if (d && "pv" in d) {
      this.clearPreview(d.pv);
      d.pv.el.classList.remove("moving");
      if (d.kind === "move" || d.kind === "areamove") d.ghost?.remove();
      if (d.kind === "area") this.drawArea(d.pv, null);
    }
  }

  /** The page under a screen point, or the nearest one if the point is in a gap. */
  private pageAt(x: number, y: number): PageView | null {
    let best: PageView | null = null;
    let bestDist = Infinity;
    for (const pv of this.pages) {
      const r = pv.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return pv;
      const dist = Math.max(r.top - y, 0, y - r.bottom) + Math.max(r.left - x, 0, x - r.right);
      if (dist < bestDist) {
        bestDist = dist;
        best = pv;
      }
    }
    return bestDist < 80 ? best : null;
  }

  /** A picture of the annotation that follows the pointer while dragging (even across pages). */
  private async makeGhost(d: Extract<Drag, { kind: "move" }>): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await this.host.engine.renderAnnotBitmap(d.pv.index, d.annot.index, this.zoom * dpr);
    } catch {
      /* fall back to an outline */
    }
    if (this.drag !== d) {
      bmp?.close();
      return;
    }
    const c = document.createElement("canvas");
    c.className = "drag-ghost";
    c.style.width = `${rectWidth(d.annot.rect) * this.zoom}px`;
    c.style.height = `${rectHeight(d.annot.rect) * this.zoom}px`;
    if (bmp) {
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
    } else c.classList.add("outline");
    d.ghost = c;
    this.pagesEl.append(c);
    if (!d.moved) c.style.display = "none";
  }

  private positionGhost(d: Extract<Drag, { kind: "move" }>, e: PointerEvent): void {
    const g = d.ghost;
    if (!g) return;
    g.style.display = "";
    const host = this.pagesEl.getBoundingClientRect();
    // keep the grab point under the pointer
    const offX = (d.start[0] - d.annot.rect[0]) * this.zoom;
    const offY = (d.start[1] - d.annot.rect[1]) * this.zoom;
    g.style.left = `${e.clientX - host.left - offX}px`;
    g.style.top = `${e.clientY - host.top - offY}px`;
    const over = this.pageAt(e.clientX, e.clientY);
    g.classList.toggle("nowhere", !over);
  }

  private onDblClick(e: MouseEvent): void {
    if (this.tool !== "select") return;
    const pv = this.pageFromEvent(e);
    if (!pv) return;
    const a = this.annotAt(pv, this.toPagePoint(pv, e));
    if (a?.kind === "FreeText") this.openEditor(pv, a);
  }

  private afterAnnotEdit(pv: PageView, annots: AnnotInfo[]): void {
    pv.annots = annots;
    pv.version++;
    pv.dataVersion = pv.version;
    pv.blocks = null;
    this.host.engine.lineBoxes(pv.index).then((l) => (pv.lines = l)).catch(() => {});
    if (this.selected?.page === pv.index) this.drawAnnotSelection();
    this.schedule();
    this.host.edited(null, [pv.index]);
  }

  // ---------- text selection ----------

  private async updateTextSelection(pv: PageView, a: Point, b: Point, mode: "sel" | "mark", force = false): Promise<void> {
    this.selection = { page: pv.index, start: a, end: b, quads: this.selection?.page === pv.index ? this.selection.quads : [] };
    if (this.selBusy && !force) {
      this.selQueued = true;
      return;
    }
    this.selBusy = true;
    try {
      const quads = await this.host.engine.selectText(pv.index, a, b);
      if (this.selection && this.selection.page === pv.index) {
        this.selection.quads = quads;
        this.drawQuads(pv, quads, mode);
      }
    } finally {
      this.selBusy = false;
      if (this.selQueued && this.selection && this.drag) {
        this.selQueued = false;
        void this.updateTextSelection(pv, this.selection.start, this.selection.end, mode);
      }
    }
  }

  private drawQuads(pv: PageView, quads: Quad[], mode: "sel" | "mark"): void {
    const g = pv.svg.querySelector(mode === "sel" ? ".g-sel" : ".g-preview")!;
    const color = mode === "mark" ? this.host.settings.colors.highlight : "";
    const kind = this.host.settings.markKind;
    g.innerHTML = quads
      .map((q) => {
        const pts = `${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}`;
        if (mode === "mark" && kind !== "Highlight") {
          const y = kind === "Underline" ? q[5] - (q[5] - q[1]) * 0.08 : (q[1] + q[5]) / 2;
          return `<line x1="${q[0]}" y1="${y}" x2="${q[2]}" y2="${y}" stroke="${color}" stroke-width="${Math.max(0.8, (q[5] - q[1]) * 0.07)}"/>`;
        }
        return `<polygon points="${pts}" class="${mode === "sel" ? "selq" : "markq"}" ${color ? `fill="${color}"` : ""}/>`;
      })
      .join("");
  }

  clearSelection(): void {
    if (this.selection) {
      const pv = this.pages[this.selection.page];
      pv?.svg.querySelector(".g-sel")?.replaceChildren();
    }
    this.selection = null;
    if (this.floating.dataset.kind === "text") this.hideFloating();
  }

  hasTextSelection(): boolean {
    return !!this.selection?.quads.length;
  }

  async copySelection(): Promise<boolean> {
    const s = this.selection;
    if (!s?.quads.length) return false;
    const text = await this.host.engine.copyText(s.page, s.start, s.end);
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      toast("Couldn't access the clipboard", "error");
    }
    return true;
  }

  private async markSelection(kind: "Highlight" | "Underline" | "StrikeOut"): Promise<void> {
    const s = this.selection;
    if (!s?.quads.length) return;
    const pv = this.pages[s.page];
    const quads = s.quads;
    this.clearSelection();
    const held = this.holdQuads(pv, quads, kind, this.host.settings.colors.highlight);
    try {
      this.afterAnnotEdit(pv, await this.host.engine.addMarkup(s.page, kind, quads, hexToRgb(this.host.settings.colors.highlight)));
      held.release(true);
    } catch (err) {
      held.release(false);
      throw err;
    }
  }

  // ---------- previews ----------

  /**
   * What you just drew/placed stays on screen until the page image shows it, so nothing
   * blinks while the change is saved and the page redrawn. Moves the live preview into its own
   * group (a new stroke can start meanwhile); call `release` once the change is made.
   */
  private holdPreview(pv: PageView): { el: SVGGElement; release: (ok: boolean) => void } {
    const g = document.createElementNS(SVGNS, "g") as SVGGElement;
    g.classList.add("g-pending");
    const prev = pv.svg.querySelector(".g-preview")!;
    g.append(...Array.from(prev.childNodes));
    pv.svg.insertBefore(g, prev);
    return { el: g, release: (ok) => (ok ? this.keepUntilRendered(pv, g) : g.remove()) };
  }

  /** Remove `el` once the page image includes the latest change. */
  private keepUntilRendered(pv: PageView, el: Element): void {
    const v = pv.version;
    const check = () => {
      if (!el.isConnected) return;
      if (pv.renderedVersion >= v || this.pages[pv.index] !== pv) el.remove();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  /** A held preview of highlight/underline/strike-out quads. */
  private holdQuads(pv: PageView, quads: Quad[], kind: string, color: string): { release: (ok: boolean) => void } {
    const g = pv.svg.querySelector(".g-preview")!;
    g.innerHTML = quads
      .map((q) => {
        const x0 = Math.min(q[0], q[4]), x1 = Math.max(q[2], q[6]), y0 = Math.min(q[1], q[3]), y1 = Math.max(q[5], q[7]);
        if (kind === "Highlight") return `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" class="markq" fill="${color}"/>`;
        const h = y1 - y0;
        const y = kind === "StrikeOut" ? y0 + h * 0.55 : y1 - h * 0.08;
        return `<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${color}" stroke-width="${Math.max(0.6, h * 0.07)}"/>`;
      })
      .join("");
    return this.holdPreview(pv);
  }

  private clearPreview(pv: PageView, all = true): void {
    pv.svg.querySelector(".g-preview")?.replaceChildren();
    if (all) pv.svg.querySelector(".g-sel")?.replaceChildren();
  }

  private previewRect(pv: PageView, r: Rect, mode: "mark"): void {
    const g = pv.svg.querySelector(".g-preview")!;
    if (mode === "mark") {
      g.innerHTML = `<rect x="${r[0]}" y="${r[1]}" width="${rectWidth(r)}" height="${rectHeight(r)}" class="markq" fill="${this.host.settings.colors.highlight}"/>`;
    }
  }

  private previewPen(pv: PageView, pts: Point[]): void {
    const s = this.host.settings;
    pv.svg.querySelector(".g-preview")!.innerHTML = `<polyline points="${pts.map((p) => p.join(",")).join(" ")}" fill="none" stroke="${s.colors.pen}" stroke-width="${s.penWidth}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  private previewShape(pv: PageView, a: Point, b: Point): void {
    const s = this.host.settings;
    const r = normRect(a[0], a[1], b[0], b[1]);
    const st = `fill="none" stroke="${s.colors.shape}" stroke-width="${s.shapeWidth}"`;
    let svg = "";
    if (s.shapeKind === "Square") svg = `<rect x="${r[0]}" y="${r[1]}" width="${rectWidth(r)}" height="${rectHeight(r)}" ${st}/>`;
    else if (s.shapeKind === "Circle")
      svg = `<ellipse cx="${(r[0] + r[2]) / 2}" cy="${(r[1] + r[3]) / 2}" rx="${rectWidth(r) / 2}" ry="${rectHeight(r) / 2}" ${st}/>`;
    else {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const L = Math.max(6, s.shapeWidth * 4);
      const h1: Point = [b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)];
      const h2: Point = [b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)];
      svg = `<path d="M${a.join(",")} L${b.join(",")} M${h1.join(",")} L${b.join(",")} L${h2.join(",")}" ${st} stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    pv.svg.querySelector(".g-preview")!.innerHTML = svg;
  }

  // ---------- signature ----------

  private hideGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }

  /** Page rect for a picture signature centred on p. */
  private imageSignatureRect(sig: Extract<SavedSignature, { kind: "image" }>, p: Point): Rect {
    const w = this.host.settings.signatureWidth;
    const h = (w * sig.image.h) / sig.image.w;
    return [p[0] - w / 2, p[1] - h / 2, p[0] + w / 2, p[1] + h / 2];
  }

  private moveGhost(e: PointerEvent): void {
    const pv = this.pageFromEvent(e);
    if (!pv) return this.hideGhost();
    this.showGhost(pv, this.toPagePoint(pv, e));
  }

  /** The signature preview centred on p. */
  private showGhost(pv: PageView, p: Point): void {
    const s = this.host.settings;
    const sig = this.host.activeSignature();
    if (!sig) return this.hideGhost();
    if (!this.ghost || this.ghost.ownerSVGElement !== pv.svg) {
      this.hideGhost();
      this.ghost = document.createElementNS(SVGNS, "g") as SVGGElement;
      this.ghost.classList.add("ghost");
      pv.svg.append(this.ghost);
    }
    if (sig.kind === "image") {
      const r = this.imageSignatureRect(sig, p);
      this.ghost.innerHTML = `<image href="${sig.image.src}" x="${r[0]}" y="${r[1]}" width="${rectWidth(r)}" height="${rectHeight(r)}" preserveAspectRatio="none"/>`;
      return;
    }
    const strokes = placeStrokes(sig.strokes, p[0], p[1], s.signatureWidth);
    const w = (1.6 * s.signatureWidth) / 150;
    this.ghost.innerHTML = strokes
      .map((st) => `<polyline points="${st.map((q) => q.join(",")).join(" ")}" fill="none" stroke="${s.colors.sign}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("");
  }

  private async placeSignature(pv: PageView, p: Point): Promise<void> {
    const s = this.host.settings;
    if (!this.host.activeSignature() && !(await this.host.needSignature())) return;
    const sig = this.host.activeSignature();
    if (!sig) return;
    // the signature stays where you clicked while it is added
    this.showGhost(pv, p);
    const held = this.ghost ? (this.ghost.cloneNode(true) as SVGGElement) : null;
    if (held) {
      held.classList.remove("ghost");
      held.classList.add("g-pending");
      pv.svg.append(held);
    }
    this.hideGhost();
    try {
      if (sig.kind === "image") {
        const r = this.imageSignatureRect(sig, p);
        this.afterAnnotEdit(pv, await this.host.engine.addImageStamp(pv.index, r, dataUrlBytes(sig.image.src)));
      } else {
        const strokes = placeStrokes(sig.strokes, p[0], p[1], s.signatureWidth);
        const w = (1.6 * s.signatureWidth) / 150;
        this.afterAnnotEdit(pv, await this.host.engine.addInk(pv.index, strokes, hexToRgb(s.colors.sign), w));
      }
      if (held) this.keepUntilRendered(pv, held);
    } catch (err) {
      held?.remove();
      throw err;
    }
  }

  // ---------- annotation selection ----------

  selectedAnnot(): { page: number; annot: AnnotInfo } | null {
    if (!this.selected) return null;
    const a = this.pages[this.selected.page]?.annots?.find((x) => x.index === this.selected!.index);
    return a ? { page: this.selected.page, annot: a } : null;
  }

  selectAnnot(sel: { page: number; index: number } | null): void {
    if (this.selected) this.pages[this.selected.page]?.svg.querySelector(".g-annsel")?.replaceChildren();
    if (sel) this.setArea(null);
    this.selected = sel;
    if (this.floating.dataset.kind === "annot") this.hideFloating();
    if (sel) this.drawAnnotSelection();
  }

  private drawAnnotSelection(): void {
    const cur = this.selectedAnnot();
    if (!cur) {
      if (this.selected && this.pages[this.selected.page]?.annots) this.selected = null;
      return;
    }
    const pv = this.pages[cur.page];
    const r = cur.annot.rect;
    const pad = 3 / this.zoom;
    pv.svg.querySelector(".g-annsel")!.innerHTML = `<rect x="${r[0] - pad}" y="${r[1] - pad}" width="${rectWidth(r) + 2 * pad}" height="${rectHeight(r) + 2 * pad}" class="annsel"/>`;
    this.showAnnotMenu(pv, cur.annot);
  }

  async deleteSelectedAnnot(): Promise<boolean> {
    const cur = this.selectedAnnot();
    if (!cur) return false;
    const pv = this.pages[cur.page];
    this.selectAnnot(null);
    this.afterAnnotEdit(pv, await this.host.engine.deleteAnnot(cur.page, cur.annot.index));
    return true;
  }

  // ---------- floating menus ----------

  private hideFloating(): void {
    this.floating.hidden = true;
    this.floating.dataset.kind = "";
    this.floating.remove();
  }

  private showFloatingAt(pv: PageView, r: Rect, kind: "text" | "annot" | "edit" | "area" | "paste", html: string): void {
    this.floating.innerHTML = html;
    this.floating.onpointerdown = null;
    this.floating.dataset.kind = kind;
    this.floating.dataset.page = String(pv.index);
    this.floating.dataset.rect = r.join(",");
    this.floating.hidden = false;
    pv.el.append(this.floating);
    this.positionFloating();
  }

  private positionFloating(): void {
    if (this.floating.hidden) return;
    const pv = this.pages[Number(this.floating.dataset.page)];
    if (!pv) return;
    const r = this.floating.dataset.rect!.split(",").map(Number);
    const x = ((r[0] + r[2]) / 2 - pv.info.x) * this.zoom;
    const top = (r[1] - pv.info.y) * this.zoom;
    const bottom = (r[3] - pv.info.y) * this.zoom;
    this.floating.style.left = `${x}px`;
    const above = top > 52;
    this.floating.style.top = above ? `${top - 8}px` : `${bottom + 8}px`;
    this.floating.classList.toggle("below", !above);
  }

  private showSelectionMenu(): void {
    const s = this.selection!;
    const pv = this.pages[s.page];
    const r = s.quads.map((q) => [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])] as Rect);
    const u: Rect = [Math.min(...r.map((x) => x[0])), Math.min(...r.map((x) => x[1])), Math.max(...r.map((x) => x[2])), Math.max(...r.map((x) => x[3]))];
    this.showFloatingAt(
      pv,
      u,
      "text",
      `<button data-act="Highlight" title="Highlight">${icon("highlight")}</button>
       <button data-act="Underline" title="Underline">${icon("underline")}</button>
       <button data-act="StrikeOut" title="Strike out">${icon("strike")}</button>
       <span class="sep"></span>
       <button data-act="copy" title="Copy (Ctrl+C)">${icon("copy")}</button>`,
    );
    this.floating.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      const act = b.dataset.act!;
      if (act === "copy") void this.copySelection();
      else void this.markSelection(act as "Highlight").catch((err) => toast(err.message, "error"));
    };
  }

  private showAnnotMenu(pv: PageView, a: AnnotInfo): void {
    const current = rgbToHex(a.color);
    this.showFloatingAt(
      pv,
      a.rect,
      "annot",
      `${a.kind === "Stamp" || a.area ? "" : PALETTE.map((c) => `<button class="swatch ${c === current ? "on" : ""}" data-color="${c}" style="--c:${c}" title="Colour"></button>`).join("") + `<span class="sep"></span>`}
       ${a.kind === "FreeText" ? `<button data-act="edit" title="Edit text">${icon("edit")}</button>` : ""}
       <button data-act="copy" title="Copy (Ctrl+C)">${icon("copy")}</button>
       <button data-act="duplicate" title="Duplicate (Ctrl+D)">${icon("duplicate")}</button>
       <button data-act="delete" title="Delete (Del)">${icon("trash")}</button>`,
    );
    this.floating.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      try {
        if (b.dataset.color) {
          this.afterAnnotEdit(pv, await this.host.engine.setAnnotColor(pv.index, a.index, hexToRgb(b.dataset.color)));
        } else if (b.dataset.act === "delete") await this.deleteSelectedAnnot();
        else if (b.dataset.act === "edit") this.openEditor(pv, a);
        else if (b.dataset.act === "copy") await this.copy(false);
        else if (b.dataset.act === "duplicate") await this.duplicate();
      } catch (err) {
        toast((err as Error).message, "error");
      }
    };
  }

  // ---------- select area ----------

  private area: { page: number; rect: Rect } | null = null;

  hasArea(): boolean {
    return this.area !== null;
  }

  /** Select a part of a page (null: none). */
  setArea(a: { page: number; rect: Rect } | null): void {
    if (this.area) this.drawArea(this.pages[this.area.page], null);
    this.area = a;
    if (this.floating.dataset.kind === "area") this.hideFloating();
    if (!a) return;
    this.selectAnnot(null);
    this.clearSelection();
    this.drawArea(this.pages[a.page], a.rect);
    this.showAreaMenu();
  }

  private drawArea(pv: PageView | undefined, r: Rect | null, drawing = false): void {
    const g = pv?.svg.querySelector(".g-area");
    if (!g) return;
    g.innerHTML = r ? `<rect x="${r[0]}" y="${r[1]}" width="${rectWidth(r)}" height="${rectHeight(r)}" class="areasel ${drawing ? "drawing" : ""}"/>` : "";
  }

  private showAreaMenu(): void {
    const a = this.area;
    if (!a) return;
    const pv = this.pages[a.page];
    this.showFloatingAt(
      pv,
      a.rect,
      "area",
      `<button data-act="copy" title="Copy (Ctrl+C)">${icon("copy")}</button>
       <button data-act="cut" title="Cut (Ctrl+X)">${icon("cut")}</button>
       <button data-act="erase" title="Erase (Del)">${icon("eraser")}</button>
       <span class="sep"></span><span class="float-hint">Drag to move</span>`,
    );
    this.floating.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      try {
        if (b.dataset.act === "copy") await this.copy(false);
        else if (b.dataset.act === "cut") await this.copy(true);
        else if (b.dataset.act === "erase") await this.eraseArea();
      } catch (err) {
        toast((err as Error).message, "error");
      }
    };
  }

  /** Erase what's printed in the selected area. */
  async eraseArea(): Promise<boolean> {
    const a = this.area;
    if (!a) return false;
    const pv = this.pages[a.page];
    this.setArea(null);
    this.afterAnnotEdit(pv, await this.host.busy(this.host.engine.eraseArea(a.page, a.rect)));
    return true;
  }

  /** A picture of the selected area that follows the pointer while it's dragged. */
  private async makeAreaGhost(d: Extract<Drag, { kind: "areamove" }>): Promise<void> {
    const dpr = window.devicePixelRatio || 1;
    let bmp: ImageBitmap | null = null;
    try {
      bmp = await this.host.engine.renderAreaBitmap(d.pv.index, d.rect, this.zoom * dpr);
    } catch {
      /* fall back to an outline */
    }
    if (this.drag !== d) {
      bmp?.close();
      return;
    }
    const c = document.createElement("canvas");
    c.className = "drag-ghost area-ghost";
    c.style.width = `${rectWidth(d.rect) * this.zoom}px`;
    c.style.height = `${rectHeight(d.rect) * this.zoom}px`;
    if (bmp) {
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
    } else c.classList.add("outline");
    d.ghost = c;
    this.pagesEl.append(c);
    if (!d.moved) c.style.display = "none";
  }

  private positionAreaGhost(d: Extract<Drag, { kind: "areamove" }>, e: PointerEvent): void {
    const g = d.ghost;
    if (!g) return;
    g.style.display = "";
    const host = this.pagesEl.getBoundingClientRect();
    g.style.left = `${e.clientX - host.left - (d.start[0] - d.rect[0]) * this.zoom}px`;
    g.style.top = `${e.clientY - host.top - (d.start[1] - d.rect[1]) * this.zoom}px`;
    g.classList.toggle("nowhere", !this.pageAt(e.clientX, e.clientY));
  }

  // ---------- eraser ----------

  private previewErase(pv: PageView, pts: Point[]): void {
    const w = this.host.settings.eraserSize;
    const p = pts.length === 1 ? [pts[0], [pts[0][0] + 0.01, pts[0][1]]] : pts;
    pv.svg.querySelector(".g-preview")!.innerHTML = `<polyline points="${p.map((q) => q.join(",")).join(" ")}" class="erase-trail" stroke-width="${w}"/>`;
  }

  /** The eraser's size, following the mouse. */
  private hoverEraser(e: PointerEvent): void {
    const pv = this.pageFromEvent(e);
    for (const other of this.pages) if (other !== pv) other.svg.querySelector(".erase-cursor")?.remove();
    if (!pv) return;
    const [x, y] = this.toPagePoint(pv, e);
    let c = pv.svg.querySelector<SVGCircleElement>(".erase-cursor");
    if (!c) {
      c = document.createElementNS(SVGNS, "circle") as SVGCircleElement;
      c.classList.add("erase-cursor");
      pv.svg.append(c);
    }
    c.setAttribute("cx", String(x));
    c.setAttribute("cy", String(y));
    c.setAttribute("r", String(this.host.settings.eraserSize / 2));
  }

  // ---------- copy, cut, paste ----------

  /** What was copied last (the engine keeps the thing itself). */
  private clip: ClipInfo | null = null;
  /** The text put on the system clipboard with it, and whether that worked. */
  private clipText: string | null = null;
  private clipOnSystem = false;
  /** Last mouse position over a page (keyboard pastes go there). */
  private pointer: { page: number; p: Point } | null = null;
  private longPress: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private pasteTimer: ReturnType<typeof setTimeout> | null = null;

  private cancelLongPress(): void {
    if (this.longPress) clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  hasClip(): boolean {
    return this.clip !== null;
  }

  /** Is there a selected item or area to copy? */
  canCopy(): boolean {
    return !!this.selectedAnnot() || !!this.area;
  }

  /** Copy (or cut) the selected item or area. Returns false if nothing is selected. */
  async copy(cut: boolean): Promise<boolean> {
    const eng = this.host.engine;
    const cur = this.selectedAnnot();
    let job: Promise<ClipInfo | null>;
    if (cur) {
      const pv = this.pages[cur.page];
      job = cut
        ? eng.cutAnnot(cur.page, cur.annot.index).then((r) => {
            this.selectAnnot(null);
            this.afterAnnotEdit(pv, r.annots);
            return r.clip;
          })
        : eng.copyAnnot(cur.page, cur.annot.index);
    } else if (this.area) {
      const a = this.area;
      const pv = this.pages[a.page];
      job = cut
        ? eng.cutArea(a.page, a.rect).then((r) => {
            if (!r) return null;
            this.setArea(null);
            this.afterAnnotEdit(pv, r.annots);
            return r.clip;
          })
        : eng.copyArea(a.page, a.rect);
    } else return false;
    // (the system clipboard write starts now, while the key press or click still counts)
    const wrote = writeClipboardText(job.then((i) => i?.text ?? ""));
    const info = await this.host.busy(job);
    if (!info) {
      toast("There's nothing in that area to copy", "info");
      return true;
    }
    this.clip = info;
    this.clipText = info.text;
    this.clipOnSystem = false;
    void wrote.then((ok) => {
      if (this.clip === info) this.clipOnSystem = ok;
    });
    this.host.clipChanged(info);
    toast(`${cut ? "Cut" : "Copied"} ${info.label}. Paste with ${navigator.maxTouchPoints > 0 && !matchMedia("(pointer: fine)").matches ? "Paste (or a long press on the page)" : "Ctrl+V"}.`);
    return true;
  }

  /** Copy the selected item and put the copy right next to it. */
  async duplicate(): Promise<boolean> {
    const cur = this.selectedAnnot();
    if (!cur) return false;
    const res = await this.host.busy(this.host.engine.duplicateAnnot(cur.page, cur.annot.index));
    this.afterAnnotEdit(this.pages[cur.page], res.annots);
    this.selectAnnot({ page: cur.page, index: res.index });
    return true;
  }

  /** Ctrl+V was pressed: some browsers send no paste event outside text fields, so paste anyway if none comes. */
  expectPaste(): void {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = setTimeout(() => {
      this.pasteTimer = null;
      void this.pasteButton(null).catch((err) => toast((err as Error).message, "error"));
    }, 250);
  }

  /** A paste event (Ctrl+V): what's on the clipboard decides what gets pasted. */
  async pasteEvent(e: ClipboardEvent): Promise<void> {
    if (this.pasteTimer) clearTimeout(this.pasteTimer);
    this.pasteTimer = null;
    await this.pasteData(fromPasteEvent(e), null);
  }

  /** The Paste button: what papgi copied, otherwise what's on the system clipboard. */
  async pasteButton(at: { page: number; center: Point } | null): Promise<void> {
    if (this.clip) return this.pasteData(null, at);
    const data = await readClipboard();
    if (!data) return void toast("Nothing to paste: copy something first (or press Ctrl+V)", "info");
    await this.pasteData(data, at);
  }

  private async pasteData(data: ClipboardContent | null, at: { page: number; center: Point | null } | null): Promise<void> {
    if (!this.info) return;
    this.hideFloating();
    const place = at ?? (this.pointer ? { page: this.pointer.page, center: this.pointer.p } : { page: this.current, center: null });
    // what papgi copied is on the clipboard when its text is (or the write didn't work)
    const ours = !!this.clip && (!data || (!data.image && (!this.clipOnSystem || data.text === (this.clipText ?? ""))));
    if (data && !ours) {
      if (data.image) return this.pastePicture(data.image, place);
      if (data.text.trim()) return this.pasteText(data.text, place);
    }
    if (!this.clip) return void toast("Nothing to paste: copy something first", "info");
    const pv = this.pages[place.page];
    let topLeft: Point | null = null;
    if (place.center) {
      const w = this.clip.w;
      const h = this.clip.h;
      topLeft = this.clampToPage(pv, [place.center[0] - w / 2, place.center[1] - h / 2], w, h);
    }
    const res = await this.host.busy(this.host.engine.paste(place.page, topLeft));
    this.afterAnnotEdit(pv, res.annots);
    this.selectAnnot({ page: place.page, index: res.index });
  }

  private clampToPage(pv: PageView, p: Point, w: number, h: number): Point {
    const i = pv.info;
    return [Math.max(i.x, Math.min(p[0], i.x + i.w - w)), Math.max(i.y, Math.min(p[1], i.y + i.h - h))];
  }

  /** The middle of the part of a page that's on screen. */
  private visibleCenter(pv: PageView): Point {
    const vr = this.el.getBoundingClientRect();
    const r = pv.el.getBoundingClientRect();
    const top = Math.max(vr.top, r.top);
    const bottom = Math.min(vr.bottom, r.bottom);
    const left = Math.max(vr.left, r.left);
    const right = Math.min(vr.right, r.right);
    const cy = bottom > top ? (top + bottom) / 2 : r.top + r.height / 2;
    const cx = right > left ? (left + right) / 2 : r.left + r.width / 2;
    return this.toPagePoint(pv, { clientX: cx, clientY: cy });
  }

  private async pastePicture(blob: Blob, place: { page: number; center: Point | null }): Promise<void> {
    const pv = this.pages[place.page];
    const { bytes, w, h } = await pictureBytes(blob);
    // screen pixels at their usual size, but never more than most of the page
    let pw = w * 0.75;
    let ph = h * 0.75;
    const k = Math.min(1, (pv.info.w * 0.6) / pw, (pv.info.h * 0.6) / ph);
    pw *= k;
    ph *= k;
    const c = place.center ?? this.visibleCenter(pv);
    const [x, y] = this.clampToPage(pv, [c[0] - pw / 2, c[1] - ph / 2], pw, ph);
    const res = await this.host.busy(this.host.engine.addPicture(place.page, bytes, [x, y, x + pw, y + ph]));
    this.afterAnnotEdit(pv, res.annots);
    this.selectAnnot({ page: place.page, index: res.index });
  }

  private async pasteText(text: string, place: { page: number; center: Point | null }): Promise<void> {
    const pv = this.pages[place.page];
    const s = this.host.settings;
    const c = place.center ?? this.visibleCenter(pv);
    const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").slice(0, 5000);
    const annots = await this.host.busy(this.host.engine.addFreeText(place.page, [c[0], c[1] - s.textSize / 2], clean, s.textSize, hexToRgb(s.colors.text)));
    this.afterAnnotEdit(pv, annots);
    const last = annots[annots.length - 1];
    if (last) this.selectAnnot({ page: place.page, index: last.index });
  }

  /** Right click: Paste here (and the usual menu for an item). */
  private onContextMenu(e: MouseEvent): void {
    if (this.tool !== "select" && this.tool !== "area") return;
    const pv = this.pageFromEvent(e);
    if (!pv || (e.target as Element).closest(".page-forms > *, .floating, .text-editor, .para-editor")) return;
    const p = this.toPagePoint(pv, e);
    if (this.annotAt(pv, p) || (this.area?.page === pv.index && inRect(this.area.rect, p[0], p[1]))) return;
    e.preventDefault();
    this.showPasteMenu(pv, p);
  }

  private showPasteMenu(pv: PageView, p: Point): void {
    this.clearSelection();
    this.selectAnnot(null);
    this.setArea(null);
    this.showFloatingAt(pv, [p[0], p[1], p[0], p[1]], "paste", `<button data-act="paste" class="labelled">${icon("paste")}<span>Paste</span></button>`);
    this.floating.onclick = (e) => {
      if (!(e.target as HTMLElement).closest("button")) return;
      this.hideFloating();
      void this.pasteButton({ page: pv.index, center: p }).catch((err) => toast((err as Error).message, "error"));
    };
  }

  // ---------- live text editing ----------

  private para: { pv: PageView; ed: ParagraphEditor; block: EditBlock } | null = null;
  private paraBusy = false;
  private hoverPage: PageView | null = null;

  private hoverBlock(e: PointerEvent): void {
    const pv = this.pageFromEvent(e);
    if (this.hoverPage && this.hoverPage !== pv) this.hoverPage.svg.querySelector(".g-hover")?.replaceChildren();
    this.hoverPage = pv;
    if (!pv || this.para) return;
    if (!pv.blocks || pv.blocksVersion !== pv.version) {
      void this.ensureBlocks(pv).catch(() => {});
      return;
    }
    const b = this.blockAt(pv, this.toPagePoint(pv, e));
    const g = pv.svg.querySelector(".g-hover")!;
    if (!b) return void g.replaceChildren();
    const top = Math.min(...b.lines.map((l) => l.bbox[1]));
    const bottom = Math.max(...b.lines.map((l) => l.bbox[3]));
    const pad = 2 / this.zoom;
    g.innerHTML = `<rect x="${b.left - pad}" y="${top - pad}" width="${b.width + 2 * pad}" height="${bottom - top + 2 * pad}" class="hover-block ${b.editable ? "" : "locked"}"/>`;
  }

  private async openParagraph(pv: PageView, p: Point, clientX: number, clientY: number): Promise<void> {
    const blocks = await this.ensureBlocks(pv);
    const block = this.blockAt(pv, p);
    if (!block) {
      if (!blocks.some((b) => b.lines.length))
        toast("This page has no text yet. If it's a scan, recognize its text first.", "info", { label: "Recognize text", run: () => this.host.recognize() });
      return;
    }
    if (!block.editable) return void toast(block.reason ?? "This text can't be edited.", "error");
    pv.svg.querySelector(".g-hover")?.replaceChildren();
    const ed = new ParagraphEditor(pv.index, block, pv.info, new URL("fonts/", document.baseURI).href, (commit) => void this.closeParagraph(commit));
    pv.el.append(ed.el);
    this.para = { pv, ed, block };
    ed.placeCaret(clientX, clientY);
    this.showFloatingAt(
      pv,
      [block.left, Math.min(...block.lines.map((l) => l.bbox[1])), block.left + block.width, block.bbox[3]],
      "edit",
      `${block.warn ? `<span class="float-warn" title="${block.warn}">${icon("warn")}<span>Formulas get flattened</span></span><span class="sep"></span>` : ""}
       ${block.ocr ? `<div class="seg mini" title="Font for the new text"><button data-act="sans" class="${this.host.settings.ocrSerif ? "" : "on"}">Sans</button><button data-act="serif" class="${this.host.settings.ocrSerif ? "on" : ""}">Serif</button></div><span class="sep"></span>` : ""}
       <button data-act="done" title="Finish (Ctrl+Enter)">${icon("check")}</button>
       <button data-act="cancel" title="Cancel (Esc)">${icon("close")}</button>`,
    );
    if (block.ocr) ed.setSerif(this.host.settings.ocrSerif);
    this.floating.onclick = (ev) => {
      const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (b.dataset.act === "sans" || b.dataset.act === "serif") {
        const serif = b.dataset.act === "serif";
        this.host.settings.ocrSerif = serif;
        this.host.saveSettings();
        ed.setSerif(serif);
        this.floating.querySelectorAll<HTMLButtonElement>("[data-act=sans],[data-act=serif]").forEach((x) => x.classList.toggle("on", x === b));
        return;
      }
      void this.closeParagraph(b.dataset.act === "done");
    };
    this.floating.onpointerdown = (ev) => ev.preventDefault(); // keep the caret in the editor
    if (block.warn) toast(block.warn);
  }

  /** Finish editing a paragraph: write the new text into the PDF (or throw the changes away). */
  async closeParagraph(commit: boolean): Promise<void> {
    const cur = this.para;
    if (!cur || this.paraBusy) return;
    const { pv, ed, block } = cur;
    if (!commit || !ed.changed()) {
      this.para = null;
      ed.destroy();
      if (this.floating.dataset.kind === "edit") this.hideFloating();
      return;
    }
    this.paraBusy = true;
    ed.el.classList.add("saving");
    try {
      const { result, annots } = await this.host.busy(this.host.engine.editText(pv.index, block.id, ed.runs(), new URL("fonts/", document.baseURI).href, { serif: block.ocr && this.host.settings.ocrSerif }));
      this.para = null;
      if (this.floating.dataset.kind === "edit") this.hideFloating();
      this.afterAnnotEdit(pv, annots);
      // keep the editor visible until the new page image is drawn, so nothing flickers
      const v = pv.version;
      const wait = () => {
        if (pv.renderedVersion >= v || this.pages[pv.index] !== pv) ed.destroy();
        else requestAnimationFrame(wait);
      };
      wait();
      if (result.warnings.length) toast(result.warnings[result.warnings.length - 1]);
    } catch (err) {
      ed.el.classList.remove("saving");
      toast((err as Error).message, "error");
      return;
    } finally {
      this.paraBusy = false;
    }
  }

  isEditingParagraph(): boolean {
    return !!this.para;
  }

  // ---------- text box editor ----------

  private openEditor(pv: PageView, annot: AnnotInfo | null, at?: Point): void {
    this.closeEditor(true);
    this.selectAnnot(null);
    const s = this.host.settings;
    const size = annot?.fontSize || s.textSize;
    const color = annot ? rgbToHex(annot.color) : s.colors.text;
    const pos: Point = annot ? [annot.rect[0], annot.rect[1]] : [at![0], at![1] - size * 0.7];
    const ta = document.createElement("textarea");
    ta.className = "text-editor";
    ta.spellcheck = true;
    ta.value = annot?.contents ?? "";
    // (the CSS moves the editor up/left by its padding, border and baseline offset, so the
    // text you type sits exactly where the finished text box draws it)
    ta.style.setProperty("--x", `${((pos[0] - pv.info.x) / pv.info.w) * 100}%`);
    ta.style.setProperty("--y", `${((pos[1] - pv.info.y) / pv.info.h) * 100}%`);
    ta.style.setProperty("--fs", String(size));
    const raise = () => ta.style.setProperty("--raise", editorRaise().toFixed(4));
    raise();
    loadTextBoxFont(new URL("fonts/", document.baseURI).href, raise);
    ta.style.color = color;
    ta.dataset.page = String(pv.index);
    ta.dataset.annot = annot ? String(annot.index) : "";
    ta.dataset.x = String(pos[0]);
    ta.dataset.y = String(pos[1]);
    ta.dataset.size = String(size);
    ta.dataset.color = color;
    const grow = () => {
      ta.style.width = "0";
      ta.style.height = "0";
      ta.style.width = `${Math.max(ta.scrollWidth + 4, 40)}px`;
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("input", grow);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeEditor(false);
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) this.closeEditor(true);
    });
    ta.addEventListener("blur", () => setTimeout(() => this.editor === ta && this.closeEditor(true), 0));
    pv.el.append(ta);
    this.editor = ta;
    grow();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** Commit (or cancel) the open text box editor. */
  closeEditor(commit: boolean): void {
    const ta = this.editor;
    if (!ta) return;
    this.editor = null;
    const pv = this.pages[Number(ta.dataset.page)];
    const text = ta.value.replace(/\s+$/, "");
    if (!commit || !pv || (!text && !ta.dataset.annot)) {
      ta.remove();
      return;
    }
    // the typed text stays on screen (exactly where the box draws it) until the page shows it
    ta.readOnly = true;
    ta.tabIndex = -1;
    ta.classList.add("pending", ta.dataset.annot ? "covering" : "new");
    ta.blur();
    const size = Number(ta.dataset.size);
    const color = hexToRgb(ta.dataset.color!);
    const eng = this.host.engine;
    const job = ta.dataset.annot
      ? eng.editFreeText(pv.index, Number(ta.dataset.annot), text, size, color)
      : text
        ? eng.addFreeText(pv.index, [Number(ta.dataset.x), Number(ta.dataset.y)], text, size, color)
        : null;
    if (!job) return void ta.remove();
    job
      .then((annots) => {
        this.afterAnnotEdit(pv, annots);
        this.keepUntilRendered(pv, ta);
      })
      .catch((err) => {
        ta.remove();
        toast(err.message, "error");
      });
  }

  // ---------- form fields ----------

  private setWidgets(pv: PageView, widgets: WidgetInfo[]): void {
    pv.widgets = widgets;
    const focused = document.activeElement as HTMLElement | null;
    const focusKey = focused?.closest(".page-forms") === pv.forms ? focused.dataset.key : undefined;
    pv.forms.replaceChildren(
      ...widgets
        .filter((w) => w.kind !== "button" && w.kind !== "signature")
        .map((w) => this.widgetElement(pv, w)),
    );
    if (focusKey) pv.forms.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)?.focus();
  }

  private widgetElement(pv: PageView, w: WidgetInfo): HTMLElement {
    const { x, y, w: pw, h: ph } = pv.info;
    const place = (el: HTMLElement) => {
      el.style.left = `${((w.rect[0] - x) / pw) * 100}%`;
      el.style.top = `${((w.rect[1] - y) / ph) * 100}%`;
      el.style.width = `${(rectWidth(w.rect) / pw) * 100}%`;
      el.style.height = `${(rectHeight(w.rect) / ph) * 100}%`;
      el.style.setProperty("--fs", String(w.fontSize || Math.min(12, rectHeight(w.rect) * 0.62)));
      el.dataset.key = String(w.index);
      el.title = w.name;
      return el;
    };
    const eng = this.host.engine;
    const commit = (job: Promise<WidgetInfo[]>) =>
      job
        .then((ws) => {
          this.setWidgets(pv, ws);
          pv.version++;
          pv.dataVersion = pv.version;
          this.schedule();
          this.host.edited(null, [pv.index]);
        })
        .catch((err) => toast(err.message, "error"));

    if (w.kind === "text") {
      const el = w.multiline ? document.createElement("textarea") : document.createElement("input");
      el.className = "field-input";
      el.value = w.value;
      el.disabled = w.readOnly;
      if (w.maxLen > 0) el.maxLength = w.maxLen;
      el.setAttribute("aria-label", w.name);
      el.addEventListener("change", () => commit(eng.setFieldText(pv.index, w.index, el.value)));
      el.addEventListener("keydown", (e: Event) => {
        if ((e as KeyboardEvent).key === "Enter" && el instanceof HTMLInputElement) el.blur();
      });
      return place(el);
    }
    if (w.kind === "checkbox" || w.kind === "radio") {
      const el = document.createElement("button");
      el.className = `field-check ${w.kind}`;
      el.setAttribute("role", w.kind === "radio" ? "radio" : "checkbox");
      el.setAttribute("aria-checked", String(w.checked));
      el.setAttribute("aria-label", w.name);
      el.disabled = w.readOnly;
      el.addEventListener("click", () => commit(eng.toggleField(pv.index, w.index)));
      return place(el);
    }
    const sel = document.createElement("select");
    sel.className = "field-input";
    sel.disabled = w.readOnly;
    sel.setAttribute("aria-label", w.name);
    if (w.kind === "listbox") sel.size = Math.max(2, Math.min(w.options.length, 6));
    for (const o of w.options) sel.add(new Option(o, o, false, o === w.value));
    if (!w.options.includes(w.value)) sel.selectedIndex = -1;
    sel.addEventListener("change", () => commit(eng.setFieldChoice(pv.index, w.index, sel.value)));
    return place(sel);
  }

  // ---------- search ----------

  setSearchHits(hits: SearchHit[], index: number): void {
    const touched = new Set([...this.hits.map((h) => h.page), ...hits.map((h) => h.page)]);
    this.hits = hits;
    this.hitIndex = index;
    for (const p of touched) if (this.pages[p]) this.drawHits(this.pages[p]);
    const h = hits[index];
    if (h) this.scrollToQuad(h.page, h.quads[0]);
  }

  private drawHits(pv: PageView): void {
    const g = pv.svg.querySelector(".g-hits")!;
    g.innerHTML = this.hits
      .map((h, i) =>
        h.page !== pv.index
          ? ""
          : h.quads
              .map((q) => `<polygon points="${q[0]},${q[1]} ${q[2]},${q[3]} ${q[6]},${q[7]} ${q[4]},${q[5]}" class="hit ${i === this.hitIndex ? "cur" : ""}"/>`)
              .join(""),
      )
      .join("");
  }

  private scrollToQuad(page: number, q: Quad): void {
    const pv = this.pages[page];
    if (!pv) return;
    const y = pv.el.offsetTop + (q[1] - pv.info.y) * this.zoom;
    const x = pv.el.offsetLeft + (q[0] - pv.info.x) * this.zoom;
    const vr = { top: this.el.scrollTop, bottom: this.el.scrollTop + this.el.clientHeight };
    if (y < vr.top + 40 || y > vr.bottom - 60) this.el.scrollTo({ top: y - this.el.clientHeight / 3 });
    if (x < this.el.scrollLeft || x > this.el.scrollLeft + this.el.clientWidth - 40) this.el.scrollLeft = x - 40;
  }
}
