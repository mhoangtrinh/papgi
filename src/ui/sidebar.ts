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
}

interface Thumb {
  el: HTMLButtonElement;
  canvas: HTMLCanvasElement;
  version: number;
  renderedVersion: number;
  near: boolean;
}

const THUMB_W = 132;

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
      <div class="side-hint muted"></div>
      <div class="thumbs" tabindex="0" aria-label="Pages"></div>`;
    this.list = this.el.querySelector(".thumbs")!;
    mount.append(this.el);

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
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = Math.max(0, Math.min(this.info.pageCount - 1, this.current + (e.key === "ArrowDown" ? 1 : -1)));
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
      this.setDropIndicator(this.dropIndex(e.clientY));
    });
    this.list.addEventListener("dragleave", (e) => {
      if (!this.list.contains(e.relatedTarget as Node)) this.setDropIndicator(-1);
    });
    this.list.addEventListener("drop", (e) => {
      if (!this.dragging || !this.info) return;
      e.preventDefault();
      const at = this.dropIndex(e.clientY);
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

  private dropIndex(clientY: number): number {
    for (let i = 0; i < this.thumbs.length; i++) {
      const r = this.thumbs[i].el.getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return this.thumbs.length;
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
      this.thumbs.push({ el, canvas, version: 1, renderedVersion: 0, near: false });
      this.observer.observe(el);
    });
    this.updateHint();
    this.paintSelection();
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
      if (r.top < lr.top || r.bottom > lr.bottom) t.el.scrollIntoView({ block: "nearest" });
    }
  }

  private paintSelection(): void {
    this.thumbs.forEach((t, i) => t.el.classList.toggle("selected", this.sel.selected.includes(i)));
    this.updateHint();
  }

  private updateHint(): void {
    const hint = this.el.querySelector(".side-hint")!;
    const n = this.sel.selected.length;
    hint.textContent = n > 1 ? `${n} pages selected` : n === 1 ? `Page ${this.sel.selected[0] + 1} selected` : "Ctrl/Shift-click to select pages";
  }

  private schedule(): void {
    if (this.rendering || !this.info || this.el.hidden) return;
    const i = this.thumbs.findIndex((t) => t.near && t.renderedVersion !== t.version);
    if (i < 0) return;
    const t = this.thumbs[i];
    const p = this.info.pages[i];
    const scale = ((THUMB_W * (window.devicePixelRatio || 1)) / Math.max(p.w, p.h * 0.75)) * 1;
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
    if (on) this.schedule();
  }
}
