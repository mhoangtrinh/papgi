// The page view of the Merge tool: every page of every added file as a thumbnail.
// Pages can be dragged into any order (mouse: drag; touch: long-press, then drag), turned and
// removed; from the keyboard: Ctrl/Alt + arrows move, R turns, Delete removes.
import type { PageSlot } from "./flows";
import { icon } from "../ui/icons";

/** Colours that tell the files apart (also shown on the file list). */
export const FILE_COLORS = ["#2f6fed", "#e5484d", "#12a594", "#f76b15", "#8e4ec6", "#d6409f", "#0090ff", "#978365"];

export interface GridFile {
  id: string;
  name: string;
  color: string;
  letter: string;
}

const LONG_PRESS_MS = 320;
const MOVE_TOLERANCE = 8;

/** Move the element at `from` so it ends up at index `to` (as counted before the move). */
export function moveTo<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  const [x] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, x);
  return out;
}

export class PageGrid {
  readonly el: HTMLElement;
  private drag: {
    from: number;
    pointer: number;
    x0: number;
    y0: number;
    started: boolean;
    timer: number;
    ghost: HTMLElement | null;
    target: number;
  } | null = null;

  constructor(
    private host: {
      order(): PageSlot[];
      setOrder(o: PageSlot[]): void;
      file(id: string): GridFile | undefined;
      thumb(slot: PageSlot): string;
      scroller: HTMLElement;
      /** Double-click / Enter on a page (e.g. show it in the editor). */
      open?(index: number): void;
    },
  ) {
    this.el = document.createElement("div");
    this.el.className = "page-grid";
    this.el.setAttribute("role", "list");
    this.el.addEventListener("pointerdown", (e) => this.down(e));
    this.el.addEventListener("click", (e) => this.click(e));
    this.el.addEventListener("keydown", (e) => this.key(e));
    this.el.addEventListener("dblclick", (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>(".ptile");
      if (t && !(e.target as HTMLElement).closest("button")) this.host.open?.(Number(t.dataset.pos));
    });
    // (stop the page from scrolling while a page is being dragged with a finger)
    this.el.addEventListener("touchmove", (e) => this.drag?.started && e.preventDefault(), { passive: false });
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  render(focus?: number): void {
    const order = this.host.order();
    this.el.innerHTML = order
      .map((s, i) => {
        const f = this.host.file(s.item);
        if (!f) return "";
        const src = this.host.thumb(s);
        const turned = s.rotate % 180 !== 0;
        return `
        <div class="ptile" role="listitem" tabindex="0" data-pos="${i}" style="--file:${f.color}" aria-label="Page ${i + 1}: ${f.name.replace(/"/g, "")}, page ${s.page + 1}">
          <div class="pthumb${turned ? " turned" : ""}">${src ? `<img src="${src}" alt="" draggable="false" style="transform: rotate(${s.rotate}deg)">` : `<span class="pload"></span>`}</div>
          <div class="pmeta"><span class="pnum">${i + 1}</span>${f.letter ? `<span class="psrc" title="${f.name.replace(/"/g, "")}, page ${s.page + 1}">${f.letter}·${s.page + 1}</span>` : ""}</div>
          <div class="ptools">
            <button class="icon-btn sm" data-turn="${i}" title="Turn right (R)">${icon("rotR")}</button>
            <button class="icon-btn sm" data-del="${i}" title="Remove this page (Delete)">${icon("close")}</button>
          </div>
        </div>`;
      })
      .join("");
    if (focus !== undefined) this.el.querySelector<HTMLElement>(`[data-pos="${Math.min(focus, order.length - 1)}"]`)?.focus();
  }

  /** A thumbnail arrived. */
  setThumb(slotKey: string, url: string): void {
    const order = this.host.order();
    order.forEach((s, i) => {
      if (`${s.item}:${s.page}` !== slotKey) return;
      const box = this.el.querySelector(`[data-pos="${i}"] .pthumb`);
      if (box && !box.querySelector("img")) box.innerHTML = `<img src="${url}" alt="" draggable="false" style="transform: rotate(${s.rotate}deg)">`;
    });
  }

  private turn(i: number): void {
    const o = this.host.order().slice();
    o[i] = { ...o[i], rotate: (o[i].rotate + 90) % 360 };
    this.host.setOrder(o);
    this.render(i);
  }

  private remove(i: number): void {
    const o = this.host.order().slice();
    o.splice(i, 1);
    this.host.setOrder(o);
    this.render(i);
  }

  private move(from: number, to: number): void {
    const o = this.host.order();
    if (to < 0 || to > o.length || to === from || to === from + 1) return;
    this.host.setOrder(moveTo(o, from, to));
    this.render(to > from ? to - 1 : to);
  }

  private click(e: MouseEvent): void {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    if (b.dataset.turn) this.turn(Number(b.dataset.turn));
    if (b.dataset.del) this.remove(Number(b.dataset.del));
  }

  private key(e: KeyboardEvent): void {
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".ptile");
    if (!tile || e.target !== tile) return;
    const i = Number(tile.dataset.pos);
    const n = this.host.order().length;
    const cols = Math.max(1, Math.round(this.el.clientWidth / tile.offsetWidth));
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : e.key === "ArrowDown" ? cols : 0;
    if (step) {
      e.preventDefault();
      const j = Math.max(0, Math.min(n - 1, i + step));
      if (e.ctrlKey || e.metaKey || e.altKey) this.move(i, step > 0 ? j + 1 : j);
      else this.el.querySelector<HTMLElement>(`[data-pos="${j}"]`)?.focus();
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      this.turn(i);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      this.remove(i);
    } else if (e.key === "Enter" && this.host.open) {
      e.preventDefault();
      this.host.open(i);
    }
  }

  // ---------- dragging ----------

  private down(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const tile = (e.target as HTMLElement).closest<HTMLElement>(".ptile");
    if (!tile) return;
    const from = Number(tile.dataset.pos);
    const touch = e.pointerType !== "mouse";
    this.drag = { from, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, started: false, timer: 0, ghost: null, target: from };
    if (touch) {
      tile.classList.add("pressing");
      this.drag.timer = window.setTimeout(() => this.start(tile, e.clientX, e.clientY), LONG_PRESS_MS);
    }
    const move = (ev: PointerEvent) => this.moveDrag(ev, tile, touch);
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      this.end(ev.type === "pointerup");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  private moveDrag(e: PointerEvent, tile: HTMLElement, touch: boolean): void {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointer) return;
    const dist = Math.hypot(e.clientX - d.x0, e.clientY - d.y0);
    if (!d.started) {
      if (touch) {
        // moved before the long-press: it's a scroll, not a drag
        if (dist > MOVE_TOLERANCE) this.cancelPress(tile);
        return;
      }
      if (dist < 4) return;
      this.start(tile, e.clientX, e.clientY);
    }
    e.preventDefault();
    if (d.ghost) d.ghost.style.transform = `translate(${e.clientX - d.x0}px, ${e.clientY - d.y0}px) rotate(2deg)`;
    this.autoScroll(e.clientY);
    this.hover(e.clientX, e.clientY);
  }

  private cancelPress(tile: HTMLElement): void {
    if (!this.drag) return;
    clearTimeout(this.drag.timer);
    tile.classList.remove("pressing");
    this.drag = null;
  }

  private start(tile: HTMLElement, x: number, y: number): void {
    const d = this.drag;
    if (!d) return;
    d.started = true;
    d.x0 = x;
    d.y0 = y;
    tile.classList.remove("pressing");
    tile.classList.add("lifted");
    const r = tile.getBoundingClientRect();
    const ghost = tile.cloneNode(true) as HTMLElement;
    ghost.classList.add("pghost");
    ghost.classList.remove("lifted");
    Object.assign(ghost.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.append(ghost);
    d.ghost = ghost;
    document.body.classList.add("dragging-page");
  }

  /** Where the page would go: before or after the tile under the pointer. */
  private hover(x: number, y: number): void {
    const d = this.drag!;
    this.el.querySelectorAll(".ins-before, .ins-after").forEach((t) => t.classList.remove("ins-before", "ins-after"));
    const under = document.elementFromPoint(x, y)?.closest<HTMLElement>(".ptile");
    if (!under || !this.el.contains(under)) return;
    const r = under.getBoundingClientRect();
    const after = x > r.left + r.width / 2;
    under.classList.add(after ? "ins-after" : "ins-before");
    d.target = Number(under.dataset.pos) + (after ? 1 : 0);
  }

  private scrollTimer = 0;

  private autoScroll(y: number): void {
    const sc = this.host.scroller;
    const r = sc.getBoundingClientRect();
    const edge = 70;
    const v = y < r.top + edge + 50 ? -1 : y > r.bottom - edge ? 1 : 0;
    cancelAnimationFrame(this.scrollTimer);
    if (!v) return;
    const tick = () => {
      if (!this.drag?.started) return;
      sc.scrollTop += v * 12;
      this.scrollTimer = requestAnimationFrame(tick);
    };
    this.scrollTimer = requestAnimationFrame(tick);
  }

  private end(drop: boolean): void {
    const d = this.drag;
    this.drag = null;
    cancelAnimationFrame(this.scrollTimer);
    if (!d) return;
    clearTimeout(d.timer);
    d.ghost?.remove();
    document.body.classList.remove("dragging-page");
    this.el.querySelectorAll(".pressing, .lifted, .ins-before, .ins-after").forEach((t) => t.classList.remove("pressing", "lifted", "ins-before", "ins-after"));
    if (d.started && drop) this.move(d.from, d.target);
  }
}
