// Thumbnail sidebar: page selection, drag-to-reorder and page actions.
import type { DocInfo } from "../engine/engine";
import type { Engine } from "../engine/client";
import { type PageSelection, clickPage, emptySelection, moveOrder } from "../core/pages";
import { icon } from "./icons";

export interface SidebarHost {
  engine: Engine;
  goTo(index: number): void;
  rotate(pages: number[], delta: 90 | -90): void;
  remove(pages: number[]): void;
  extract(pages: number[]): void;
  insertPdf(at: number): void;
  insertBlank(at: number): void;
  reorder(order: number[], moved: number[]): void;
  /** The main view is drawing pages in view: thumbnails wait (one engine does both). */
  viewerBusy(): boolean;
  /** The panel was resized by hand (px; 0 = back to the default). */
  resized(width: number): void;
  /** The page size in the panel was zoomed (px). */
  zoomed(size: number): void;
}

interface Thumb {
  el: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  version: number;
  renderedVersion: number;
  /** Width (CSS px) the picture was drawn for. */
  renderedWidth: number;
  near: boolean;
}

export const SIDE_MIN = 120;
/** Page size in the panel (px, zoomable): pages grow with the panel up to this
 *  size, and a new column starts only when it fits at this size. */
export const TILE_DEFAULT = 200;
export const TILE_MIN = 72;
export const TILE_MAX = 640;
const COL_GAP = 8;
const ROW_GAP = 12;
/** Space around the picture in a thumb: padding + number below. */
const THUMB_PAD = 12;
const THUMB_LABEL = 20;

/** Thumb width and columns for the panel: never smaller than before when the panel
 *  gets wider; a few pages grow as big as they can while all of them still fit. */
export function thumbLayout(w: number, h: number, count: number, ratio: number, tile: number): { cols: number; width: number } {
  if (w <= 0) return { cols: 1, width: 0 };
  // biggest width that shows every page without scrolling
  let fit = 0;
  for (let n = 1; n <= Math.max(1, count); n++) {
    const rows = Math.ceil(count / n);
    const byW = (w - COL_GAP * (n - 1)) / n;
    const byH = ((h - ROW_GAP * (rows - 1)) / rows - THUMB_PAD - THUMB_LABEL) / ratio + THUMB_PAD;
    fit = Math.max(fit, Math.min(byW, byH));
    if (byW < TILE_MIN) break;
  }
  const width = Math.floor(Math.min(w, Math.max(Math.min(w, tile), fit)));
  const cols = Math.max(1, Math.floor((w + COL_GAP) / (width + COL_GAP)));
  return { cols, width };
}

export class Sidebar {
  readonly el: HTMLElement;
  private list: HTMLDivElement;
  private thumbs: Thumb[] = [];
  private info: DocInfo | null = null;
  private sel: PageSelection = emptySelection();
  private current = 0;
  private rendering = false;
  private observer: IntersectionObserver;
  private dragging: number[] | null = null;
  private cols = 1;
  private tile = TILE_DEFAULT;
  private dropAt = -1;

  constructor(private host: SidebarHost, mount: HTMLElement) {
    this.el = document.createElement("aside");
    this.el.className = "sidebar";
    this.el.innerHTML = `
      <div class="side-actions" role="toolbar" aria-label="Page actions">
        <button class="icon-btn" data-act="rotL" title="Rotate left">${icon("rotL")}</button>
        <button class="icon-btn" data-act="rotR" title="Rotate right">${icon("rotR")}</button>
        <button class="icon-btn" data-act="delete" title="Delete pages (Del)">${icon("trash")}</button>
        <button class="icon-btn" data-act="extract" title="Save pages as new PDF">${icon("extract")}</button>
        <button class="icon-btn" data-act="insert" title="Insert PDF after">${icon("insert")}</button>
        <button class="icon-btn" data-act="blank" title="Insert blank page after">${icon("blank")}</button>
      </div>
      <div class="side-sub"><span class="side-hint muted"></span><span class="side-zoom"><button class="icon-btn sm" data-zoom="-1" title="Smaller pages (Ctrl + scroll)">${icon("zoomOut")}</button><button class="icon-btn sm" data-zoom="1" title="Bigger pages (Ctrl + scroll)">${icon("zoomIn")}</button></span></div>
      <div class="thumbs" tabindex="0" aria-label="Pages"></div>
      <div class="side-resize" role="separator" aria-orientation="vertical" aria-label="Resize the pages panel" tabindex="0" title="Drag to resize (wider shows pages side by side). Double-click: back to normal"></div>`;
    this.list = this.el.querySelector(".thumbs")!;
    mount.append(this.el);
    this.bindResize(this.el.querySelector(".side-resize")!);
    // (a smaller window squeezes the panel; the chosen width comes back when there's room)
    addEventListener("resize", () => this.wanted && this.setWidth(this.wanted, false));
    new ResizeObserver(() => this.layout()).observe(this.list);
    // page size: buttons, Ctrl + wheel / trackpad pinch over the panel
    this.el.querySelector(".side-zoom")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom]");
      if (b) this.zoomBy(Number(b.dataset.zoom) > 0 ? 1.25 : 0.8);
    });
    let wheelAt = 0;
    this.list.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        // (a pinch sends many small steps; a mouse wheel few big ones)
        const now = performance.now();
        if (Math.abs(e.deltaY) < 20 && now - wheelAt < 40) return this.zoomBy(Math.exp(-e.deltaY / 100));
        wheelAt = now;
        this.zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false },
    );

    this.el.querySelector(".side-actions")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b || !this.info) return;
      const pages = this.targetPages();
      const after = Math.max(...pages) + 1;
      switch (b.dataset.act) {
        case "rotL": return host.rotate(pages, -90);
        case "rotR": return host.rotate(pages, 90);
        case "delete": return host.remove(pages);
        case "extract": return host.extract(pages);
        case "insert": return host.insertPdf(after);
        case "blank": return host.insertBlank(after);
      }
    });

    this.list.addEventListener("click", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".thumb");
      if (!t) return;
      const i = Number(t.dataset.index);
      this.sel = clickPage(this.sel, i, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
      this.paintSelection();
      if (!e.shiftKey && !(e.ctrlKey || e.metaKey)) host.goTo(i);
    });
    this.list.addEventListener("keydown", (e) => {
      if (!this.info) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();
        host.remove(this.targetPages());
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "+" || e.key === "=" || e.key === "-")) {
        e.preventDefault();
        e.stopPropagation();
        this.zoomBy(e.key === "-" ? 0.8 : 1.25);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || (this.isGrid() && (e.key === "ArrowLeft" || e.key === "ArrowRight"))) {
        e.preventDefault();
        const step = e.key === "ArrowLeft" || e.key === "ArrowRight" ? 1 : this.columns();
        const dir = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1;
        const i = Math.max(0, Math.min(this.info.pageCount - 1, this.current + dir * step));
        this.sel = clickPage(this.sel, i, { shift: e.shiftKey });
        this.paintSelection();
        host.goTo(i);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        e.stopPropagation();
        this.sel = { selected: this.info.pages.map((_, i) => i), anchor: 0 };
        this.paintSelection();
      }
    });

    // Drag & drop reordering
    this.list.addEventListener("dragstart", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".thumb");
      if (!t) return;
      const i = Number(t.dataset.index);
      if (!this.sel.selected.includes(i)) {
        this.sel = clickPage(this.sel, i, {});
        this.paintSelection();
      }
      this.dragging = this.sel.selected.slice();
      e.dataTransfer!.effectAllowed = "move";
      e.dataTransfer!.setData("text/plain", "pages");
      this.list.classList.add("dragging");
    });
    this.list.addEventListener("dragover", (e) => {
      if (!this.dragging) return;
      e.preventDefault();
      this.setDropIndicator(this.dropIndex(e.clientX, e.clientY));
    });
    this.list.addEventListener("dragleave", (e) => {
      if (!this.list.contains(e.relatedTarget as Node)) this.setDropIndicator(-1);
    });
    this.list.addEventListener("drop", (e) => {
      if (!this.dragging || !this.info) return;
      e.preventDefault();
      const at = this.dropIndex(e.clientX, e.clientY);
      const moving = this.dragging;
      this.endDrag();
      const order = moveOrder(this.info.pageCount, moving, at);
      if (!order.every((v, i) => v === i)) host.reorder(order, moving);
    });
    this.list.addEventListener("dragend", () => this.endDrag());

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const th = this.thumbs[Number((en.target as HTMLElement).dataset.index)];
          if (th) th.near = en.isIntersecting;
        }
        this.schedule();
      },
      { root: this.list, rootMargin: "300px 0px" },
    );
  }

  private endDrag(): void {
    this.dragging = null;
    this.setDropIndicator(-1);
    this.list.classList.remove("dragging");
  }

  /** Where dropped pages go: in reading order (rows left to right when the panel is wide). */
  private dropIndex(clientX: number, clientY: number): number {
    const grid = this.isGrid();
    for (let i = 0; i < this.thumbs.length; i++) {
      const r = this.thumbs[i].el.getBoundingClientRect();
      if (!grid) {
        if (clientY < r.top + r.height / 2) return i;
      } else if (clientY < r.top || (clientY <= r.bottom && clientX < r.left + r.width / 2)) return i;
    }
    return this.thumbs.length;
  }

  isGrid(): boolean {
    return this.cols > 1;
  }

  /** Pages per row (1 in the list). */
  private columns(): number {
    return this.cols;
  }

  // ---------- page size ----------

  /** Page size in px (0: default). */
  setTile(px: number): void {
    this.tile = px > 0 ? Math.round(Math.max(TILE_MIN, Math.min(TILE_MAX, px))) : TILE_DEFAULT;
    this.layout();
  }

  private zoomBy(f: number): void {
    // zoom from what is shown (a few pages may be shown bigger than the size set)
    const shown = this.thumbs[0]?.el.offsetWidth || this.tile;
    const from = f > 1 ? Math.max(shown, this.tile) : Math.min(shown, this.tile);
    const w = this.contentWidth();
    const next = Math.round(Math.max(TILE_MIN, Math.min(TILE_MAX, w || TILE_MAX, from * f)));
    if (next === this.tile) return;
    this.tile = next;
    this.layout();
    clearTimeout(this.zoomSave);
    this.zoomSave = window.setTimeout(() => this.host.zoomed(this.tile), 300);
  }
  private zoomSave = 0;

  private contentWidth(): number {
    const cs = getComputedStyle(this.list);
    return this.list.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  }

  /** Columns and thumb width for the panel's size, the page count and the page size. */
  private layout(): void {
    if (this.el.hidden || !this.list.clientWidth) return;
    const cs = getComputedStyle(this.list);
    const w = this.contentWidth();
    const h = this.list.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const pages = this.info?.pages ?? [];
    // tallest page shape (the first 200), so the "all pages fit" size really fits
    let ratio = 1.294;
    if (pages.length) ratio = Math.max(...pages.slice(0, 200).map((p) => p.h / Math.max(1, p.w)));
    const { cols, width } = thumbLayout(w, h, pages.length, ratio, this.tile);
    if (cols === this.cols && this.list.style.getPropertyValue("--tw") === `${width}px`) return;
    this.cols = cols;
    this.list.style.setProperty("--tw", `${width}px`);
    this.list.style.gridTemplateColumns = `repeat(${cols}, ${width}px)`;
    this.el.classList.toggle("grid", cols > 1);
    const zoom = this.el.querySelector(".side-zoom") as HTMLElement;
    zoom.querySelector<HTMLButtonElement>('[data-zoom="1"]')!.disabled = width >= w - 1;
    zoom.querySelector<HTMLButtonElement>('[data-zoom="-1"]')!.disabled = this.tile <= TILE_MIN;
    // pictures drawn for a smaller size get drawn again, sharper
    for (const t of this.thumbs) if (t.renderedWidth && width - THUMB_PAD > t.renderedWidth * 1.25) t.version++;
    this.schedule();
  }

  // ---------- width ----------

  /** Panel width in px (0: the default from the stylesheet). */
  private wanted = 0;
  setWidth(px: number, remember = true): void {
    if (remember) this.wanted = px > 0 ? px : 0;
    const max = this.maxWidth();
    const w = px > 0 ? Math.round(Math.max(SIDE_MIN, Math.min(max, px))) : 0;
    this.el.style.width = w ? `${w}px` : "";
    this.el.classList.toggle("wide", w > 0);
    this.layout();
  }

  private maxWidth(): number {
    const main = this.el.parentElement?.clientWidth || innerWidth;
    // keep room for the page itself (on phones the panel covers it, so nearly all of it)
    return innerWidth <= 760 ? main - 40 : Math.max(SIDE_MIN, main - 320);
  }

  private bindResize(handle: HTMLElement): void {
    let startX = 0;
    let startW = 0;
    let id = -1;
    const end = () => {
      if (id < 0) return;
      id = -1;
      document.body.classList.remove("side-resizing");
      this.host.resized(this.el.classList.contains("wide") ? this.el.offsetWidth : 0);
    };
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      id = e.pointerId;
      handle.setPointerCapture(id);
      startX = e.clientX;
      startW = this.el.offsetWidth;
      document.body.classList.add("side-resizing");
    });
    handle.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      this.setWidth(startW + e.clientX - startX);
    });
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
    handle.addEventListener("dblclick", () => {
      this.setWidth(0);
      this.host.resized(0);
    });
    handle.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      this.setWidth(this.el.offsetWidth + (e.key === "ArrowRight" ? 40 : -40));
      this.host.resized(this.el.offsetWidth);
    });
  }

  private setDropIndicator(at: number): void {
    if (at === this.dropAt) return;
    this.dropAt = at;
    this.thumbs.forEach((t, i) => {
      t.el.classList.toggle("drop-before", i === at);
      t.el.classList.toggle("drop-after", at === this.thumbs.length && i === this.thumbs.length - 1);
    });
  }

  /** Pages the actions apply to: the selection, or the current page. */
  targetPages(): number[] {
    return this.sel.selected.length ? this.sel.selected.slice() : [this.current];
  }

  hasSelection(): boolean {
    return this.sel.selected.length > 0;
  }

  focused(): boolean {
    return this.el.contains(document.activeElement);
  }

  setDocument(info: DocInfo | null, select: number[] = []): void {
    this.observer.disconnect();
    this.info = info;
    this.list.replaceChildren();
    this.thumbs = [];
    this.sel = { selected: select, anchor: select[0] ?? -1 };
    if (!info) return;
    info.pages.forEach((p, i) => {
      const el = document.createElement("button");
      el.className = "thumb";
      el.draggable = true;
      el.dataset.index = String(i);
      el.title = `Page ${i + 1}`;
      const box = document.createElement("div");
      box.className = "thumb-box";
      box.style.aspectRatio = `${p.w} / ${p.h}`;
      const canvas = document.createElement("canvas");
      box.append(canvas);
      const label = document.createElement("span");
      label.textContent = String(i + 1);
      el.append(box, label);
      this.list.append(el);
      this.thumbs.push({ el, canvas, version: 1, renderedVersion: 0, renderedWidth: 0, near: false });
      this.observer.observe(el);
    });
    this.updateHint();
    this.paintSelection();
    this.layout();
    this.setCurrent(Math.min(this.current, info.pageCount - 1));
  }

  /** Re-render thumbnails for these pages (after an edit). */
  refresh(pages: number[] | "all"): void {
    const list = pages === "all" ? this.thumbs : pages.map((i) => this.thumbs[i]).filter(Boolean);
    for (const t of list) t.version++;
    this.schedule();
  }

  setCurrent(i: number): void {
    this.current = i;
    this.thumbs.forEach((t, k) => t.el.classList.toggle("current", k === i));
    const t = this.thumbs[i];
    if (t && !this.el.hidden) {
      const lr = this.list.getBoundingClientRect();
      const r = t.el.getBoundingClientRect();
      if (r.top < lr.top || r.bottom > lr.bottom) t.el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }

  private paintSelection(): void {
    this.thumbs.forEach((t, i) => t.el.classList.toggle("selected", this.sel.selected.includes(i)));
    this.updateHint();
  }

  private updateHint(): void {
    const hint = this.el.querySelector(".side-hint")!;
    const n = this.sel.selected.length;
    hint.textContent = n > 1 ? `${n} pages selected` : n === 1 ? `Page ${this.sel.selected[0] + 1} selected` : "Ctrl/Shift-click: select";
  }

  private waiting = 0;

  private schedule(): void {
    if (this.rendering || !this.info || this.el.hidden) return;
    if (this.host.viewerBusy()) {
      clearTimeout(this.waiting);
      this.waiting = window.setTimeout(() => this.schedule(), 120);
      return;
    }
    const i = this.thumbs.findIndex((t) => t.near && t.renderedVersion !== t.version);
    if (i < 0) return;
    const t = this.thumbs[i];
    const p = this.info.pages[i];
    // drawn for the box's width (list: the panel's width; wide panel: one cell)
    const boxW = Math.max(100, t.el.querySelector<HTMLElement>(".thumb-box")?.clientWidth || 132);
    const scale = (Math.min(480, boxW) * (window.devicePixelRatio || 1)) / Math.max(p.w, p.h * 0.75);
    const version = t.version;
    this.rendering = true;
    this.host.engine
      .renderBitmap(i, scale)
      .then((bmp) => {
        if (this.thumbs[i] === t) {
          t.canvas.width = bmp.width;
          t.canvas.height = bmp.height;
          t.canvas.getContext("2d")!.drawImage(bmp, 0, 0);
          t.renderedVersion = version;
          t.renderedWidth = boxW;
        }
        bmp.close();
      })
      .catch(() => (t.renderedVersion = version))
      .finally(() => {
        this.rendering = false;
        this.schedule();
      });
  }

  show(on: boolean): void {
    this.el.hidden = !on;
    if (on) {
      this.layout();
      this.schedule();
    }
  }
}
