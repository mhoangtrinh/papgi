// The document view: pages, rendering, zoom, tools and form fields.
import type { DocInfo, PageInfo, AnnotInfo, WidgetInfo, SearchHit, EditBlock } from "../engine/engine";
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
  | { kind: "click"; pv: PageView; start: Point; x: number; y: number };

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
    }, { passive: true });
    this.el.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    this.pagesEl.addEventListener("pointerdown", (e) => this.onDown(e));
    this.pagesEl.addEventListener("pointermove", (e) => this.onMove(e));
    this.pagesEl.addEventListener("pointerup", (e) => this.onUp(e));
    this.pagesEl.addEventListener("pointercancel", () => this.cancelDrag());
    this.pagesEl.addEventListener("pointerleave", () => this.hideGhost());
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
    svg.innerHTML = `<g class="g-hits"></g><g class="g-sel"></g><g class="g-hover"></g><g class="g-annsel"></g><g class="g-preview"></g>`;
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

  scrollToPage(index: number, smooth = true): void {
    const pv = this.pages[index];
    if (!pv) return;
    this.el.scrollTo({ top: pv.el.offsetTop - PAGE_GAP, behavior: smooth ? "smooth" : "auto" });
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

  // ---------- tools ----------

  setTool(tool: Tool): void {
    this.tool = tool;
    this.closeEditor(true);
    void this.closeParagraph(true);
    this.hideGhost();
    for (const pv of this.pages) pv.svg.querySelector(".g-hover")?.replaceChildren();
    if (tool === "edit") for (const pv of this.pages) if (pv.near) void this.ensureBlocks(pv).catch(() => {});
    if (tool !== "select") {
      this.clearSelection();
      this.selectAnnot(null);
    }
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

    switch (this.tool) {
      case "select": {
        const a = this.annotAt(pv, p);
        if (a) {
          this.clearSelection();
          this.selectAnnot({ page: pv.index, index: a.index });
          const drag: Drag = { kind: "move", pv, annot: a, start: p, last: p, x: e.clientX, y: e.clientY, moved: false, ghost: null };
          this.drag = drag;
          capture();
          e.preventDefault();
          void this.makeGhost(drag);
        } else if (this.onText(pv, p)) {
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
    if (!d) {
      if (this.tool === "sign") this.moveGhost(e);
      else if (this.tool === "edit") this.hoverBlock(e);
      else if (this.tool === "select") this.hoverCursor(e);
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
    }
  }

  private async onUp(e: PointerEvent): Promise<void> {
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
          d.ghost?.remove();
          if (!d.moved) {
            if (this.selected) this.drawAnnotSelection();
            return;
          }
          const target = this.pageAt(e.clientX, e.clientY) ?? d.pv;
          if (target === d.pv) {
            const dx = d.last[0] - d.start[0];
            const dy = d.last[1] - d.start[1];
            this.afterAnnotEdit(d.pv, await eng.moveAnnot(d.pv.index, d.annot.index, dx, dy));
            return;
          }
          // dropped on another page: keep the same grab point under the pointer
          const p = this.toPagePoint(target, e);
          const topLeft: Point = [p[0] - (d.start[0] - d.annot.rect[0]), p[1] - (d.start[1] - d.annot.rect[1])];
          const res = await eng.moveAnnotToPage(d.pv.index, d.annot.index, target.index, topLeft);
          this.selectAnnot(null);
          this.afterAnnotEdit(d.pv, res.from);
          this.afterAnnotEdit(target, res.to);
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
          this.afterAnnotEdit(d.pv, await eng.addMarkup(d.pv.index, kind, quads, color));
          break;
        }
        case "pen": {
          this.clearPreview(d.pv, false);
          const stroke = simplifyStroke(d.points, 0.25 / this.zoom + 0.1);
          this.afterAnnotEdit(d.pv, await eng.addInk(d.pv.index, [stroke], hexToRgb(s.colors.pen), s.penWidth));
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
          const annots =
            s.shapeKind === "Arrow"
              ? await eng.addArrow(d.pv.index, d.start, d.last, color, s.shapeWidth)
              : await eng.addShape(d.pv.index, s.shapeKind, r, color, s.shapeWidth);
          this.afterAnnotEdit(d.pv, annots, false);
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
    const d = this.drag;
    this.drag = null;
    this.pagesEl.classList.remove("panning");
    if (d && "pv" in d) {
      this.clearPreview(d.pv);
      d.pv.el.classList.remove("moving");
      if (d.kind === "move") d.ghost?.remove();
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

  private afterAnnotEdit(pv: PageView, annots: AnnotInfo[], clearPreviewLater = true): void {
    pv.annots = annots;
    pv.version++;
    pv.dataVersion = pv.version;
    pv.blocks = null;
    // Keep the live preview until the new render lands, so nothing flickers.
    const v = pv.version;
    const waitAndClear = () => {
      if (pv.renderedVersion >= v || this.pages[pv.index] !== pv) this.clearPreview(pv);
      else requestAnimationFrame(waitAndClear);
    };
    if (clearPreviewLater) waitAndClear();
    else requestAnimationFrame(waitAndClear);
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
    const annots = await this.host.engine.addMarkup(s.page, kind, s.quads, hexToRgb(this.host.settings.colors.highlight));
    this.clearSelection();
    this.afterAnnotEdit(pv, annots);
  }

  // ---------- previews ----------

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
    const s = this.host.settings;
    const sig = this.host.activeSignature();
    if (!pv || !sig) return this.hideGhost();
    const p = this.toPagePoint(pv, e);
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
    this.hideGhost();
    if (sig.kind === "image") {
      const r = this.imageSignatureRect(sig, p);
      this.afterAnnotEdit(pv, await this.host.engine.addImageStamp(pv.index, r, dataUrlBytes(sig.image.src)));
      return;
    }
    const strokes = placeStrokes(sig.strokes, p[0], p[1], s.signatureWidth);
    const w = (1.6 * s.signatureWidth) / 150;
    this.afterAnnotEdit(pv, await this.host.engine.addInk(pv.index, strokes, hexToRgb(s.colors.sign), w));
  }

  // ---------- annotation selection ----------

  selectedAnnot(): { page: number; annot: AnnotInfo } | null {
    if (!this.selected) return null;
    const a = this.pages[this.selected.page]?.annots?.find((x) => x.index === this.selected!.index);
    return a ? { page: this.selected.page, annot: a } : null;
  }

  selectAnnot(sel: { page: number; index: number } | null): void {
    if (this.selected) this.pages[this.selected.page]?.svg.querySelector(".g-annsel")?.replaceChildren();
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

  private showFloatingAt(pv: PageView, r: Rect, kind: "text" | "annot" | "edit", html: string): void {
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
      `${a.kind === "Stamp" ? "" : PALETTE.map((c) => `<button class="swatch ${c === current ? "on" : ""}" data-color="${c}" style="--c:${c}" title="Colour"></button>`).join("") + `<span class="sep"></span>`}
       ${a.kind === "FreeText" ? `<button data-act="edit" title="Edit text">${icon("edit")}</button>` : ""}
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
      } catch (err) {
        toast((err as Error).message, "error");
      }
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
    ta.remove();
    if (!commit) return;
    const pv = this.pages[Number(ta.dataset.page)];
    if (!pv) return;
    const text = ta.value.replace(/\s+$/, "");
    const size = Number(ta.dataset.size);
    const color = hexToRgb(ta.dataset.color!);
    const eng = this.host.engine;
    const job = ta.dataset.annot
      ? eng.editFreeText(pv.index, Number(ta.dataset.annot), text, size, color)
      : text
        ? eng.addFreeText(pv.index, [Number(ta.dataset.x), Number(ta.dataset.y)], text, size, color)
        : null;
    job?.then((annots) => this.afterAnnotEdit(pv, annots)).catch((err) => toast(err.message, "error"));
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
