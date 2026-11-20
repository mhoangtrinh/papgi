// "Organize pages": all pages of the open document as a grid over the editor.
// Drag to reorder, turn, remove, insert another PDF, add a blank page; every change is a
// normal (undoable) page operation of the editor.
import type { Engine } from "../engine/client";
import type { DocInfo } from "../engine/engine";
import { PageGrid } from "../hub/pagegrid";
import type { PageSlot } from "../hub/flows";
import { icon } from "./icons";

export interface OrganizeHost {
  engine: Engine;
  info(): DocInfo | null;
  reorder(order: number[]): Promise<void>;
  rotate(pages: number[], deg: 90): Promise<void>;
  remove(pages: number[]): Promise<void>;
  insertPdf(at: number): Promise<void>;
  insertBlank(at: number): Promise<void>;
  split(): void;
  /** Leave, optionally showing a page in the editor. */
  closed(page?: number): void;
}

export class Organize {
  readonly el: HTMLElement;
  private grid: PageGrid;
  private slots: PageSlot[] = [];
  private thumbs: string[] = [];
  /** How the thumbnails map after the change that is under way (null: draw them all again). */
  private expect: ((t: string[]) => string[]) | null = null;
  private busy = false;
  private gen = 0;

  constructor(
    private host: OrganizeHost,
    parent: HTMLElement,
  ) {
    this.el = document.createElement("div");
    this.el.className = "organize";
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="org-bar">
        <div class="org-title"><b>Organize pages</b><span class="muted small org-count"></span></div>
        <div class="org-actions">
          <button class="btn" data-org="insert" title="Add the pages of other PDFs at the end">${icon("insert")}<span>Insert PDF</span></button>
          <button class="btn" data-org="blank" title="Add an empty page at the end">${icon("blank")}<span>Blank page</span></button>
          <button class="btn" data-org="split" title="Cut this PDF into several files">${icon("split")}<span>Split…</span></button>
          <button class="btn primary" data-org="done">${icon("check")}<span>Done</span></button>
        </div>
      </div>
      <p class="muted small org-hint">Drag pages to reorder (on a phone: press and hold, then drag). Hover a page to turn or remove it; double-click to open it. Ctrl+Z undoes.</p>
      <div class="org-grid"></div>`;
    parent.append(this.el);
    this.grid = new PageGrid({
      order: () => this.slots,
      setOrder: (o) => void this.changed(o),
      file: () => ({ id: "doc", name: "", color: "var(--accent)", letter: "" }),
      thumb: (s) => this.thumbs[s.page] ?? "",
      scroller: this.el,
      open: (i) => this.close(i),
    });
    this.el.querySelector(".org-grid")!.append(this.grid.el);
    this.el.querySelector(".org-actions")!.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-org]");
      if (!b) return;
      const n = this.host.info()?.pageCount ?? 0;
      if (b.dataset.org === "insert") void this.host.insertPdf(n);
      if (b.dataset.org === "blank") void this.host.insertBlank(n);
      if (b.dataset.org === "split") this.host.split();
      if (b.dataset.org === "done") this.close();
    });
  }

  isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    const info = this.host.info();
    if (!info) return;
    this.el.hidden = false;
    document.body.classList.add("organizing");
    this.docChanged(info);
    this.el.scrollTop = 0;
  }

  close(page?: number): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    document.body.classList.remove("organizing");
    this.gen++;
    for (const u of this.thumbs) if (u) URL.revokeObjectURL(u);
    this.thumbs = [];
    this.slots = [];
    this.grid.render();
    this.host.closed(page);
  }

  /** The document changed (here, in the sidebar, or by undo/redo): show it as it is now. */
  docChanged(info: DocInfo): void {
    if (this.el.hidden || this.busy) return;
    const map = this.expect;
    this.expect = null;
    if (map) this.thumbs = map(this.thumbs);
    else {
      for (const u of this.thumbs) if (u) URL.revokeObjectURL(u);
      this.thumbs = [];
    }
    this.thumbs.length = info.pageCount;
    this.slots = [...Array(info.pageCount).keys()].map((page) => ({ item: "doc", page, rotate: 0 }));
    const n = info.pageCount;
    this.el.querySelector(".org-count")!.textContent = `${n} ${n === 1 ? "page" : "pages"}`;
    const focused = document.activeElement?.closest?.(".ptile") as HTMLElement | null;
    this.grid.render(focused ? Number(focused.dataset.pos) : undefined);
    void this.loadThumbs(info);
  }

  /** Thumbnails for pages that don't have one yet, a page at a time. */
  private async loadThumbs(info: DocInfo): Promise<void> {
    const gen = ++this.gen;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    for (let i = 0; i < info.pageCount; i++) {
      if (this.thumbs[i]) continue;
      const p = info.pages[i];
      let bmp: ImageBitmap;
      try {
        bmp = await this.host.engine.renderBitmap(i, (130 * dpr) / Math.max(p.w, p.h * 0.75));
      } catch {
        return;
      }
      if (gen !== this.gen) return bmp.close();
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      canvas.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.8));
      if (gen !== this.gen || !blob) return;
      this.thumbs[i] = URL.createObjectURL(blob);
      this.grid.setThumb(`doc:${i}`, this.thumbs[i]);
    }
  }

  /** The grid changed: a page moved, was turned or removed. */
  private async changed(o: PageSlot[]): Promise<void> {
    const before = this.slots;
    this.slots = o;
    const info = this.host.info();
    if (!info) return;
    this.busy = true;
    try {
      if (o.length < before.length) {
        const gone = before.findIndex((s) => !o.some((x) => x.page === s.page));
        this.expect = (t) => (t[gone] && URL.revokeObjectURL(t[gone]), t.filter((_, i) => i !== gone));
        await this.host.remove([gone]);
      } else if (o.some((s) => s.rotate)) {
        const i = o.findIndex((s) => s.rotate);
        this.expect = (t) => (t[i] && URL.revokeObjectURL(t[i]), t.map((u, k) => (k === i ? "" : u)));
        await this.host.rotate([i], 90);
      } else {
        const order = o.map((s) => s.page);
        this.expect = (t) => order.map((k) => t[k]);
        await this.host.reorder(order);
      }
    } finally {
      this.busy = false;
    }
    const now = this.host.info();
    // (if nothing happened, e.g. removing the only page, the full redraw puts the grid back)
    if (!now || now.pageCount !== o.length) this.expect = null;
    if (now) this.docChanged(now);
  }
}
