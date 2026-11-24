// Shape controls in the toolbar: kind, outline (colour, width, line), fill (colour, opacity).
// For a selected shape they show and change that shape; otherwise the next one drawn.
import type { AnnotInfo } from "../engine/engine";
import { isLineKind, type LineStyle, type ShapeKind, type ShapeStyle } from "../core/shapes";
import { hexToRgb, rgbToHex, shapeStyle, type Settings } from "../storage";
import { icon } from "./icons";

export interface ShapeOptionsHost {
  settings: Settings;
  save(): void;
  /** The selected shape, if any. */
  selected(): AnnotInfo | null;
  /** Change the selected shape. */
  restyle(style: Partial<ShapeStyle>): void;
  /** Change it while a slider or colour picker moves (shown at once, one undo step at the end). */
  live(style: Partial<ShapeStyle>): void;
  /** The slider or picker was let go. */
  commit(): void;
  rerender(): void;
}

const PALETTE = ["#e5484d", "#f5a524", "#ffd400", "#5fd068", "#2f6fed", "#8e4ec6", "#1c1c1c", "#ffffff"];
const KINDS: [ShapeKind, string, string][] = [
  ["Square", "square", "Rectangle"],
  ["Circle", "circle", "Ellipse"],
  ["Triangle", "triangle", "Triangle"],
  ["Diamond", "diamond", "Diamond"],
  ["Cloud", "lcloud", "Cloud"],
  ["Line", "line", "Line"],
  ["Arrow", "arrow", "Arrow"],
  ["DoubleArrow", "arrow2", "Double arrow"],
];
const LINES: [LineStyle, string, string][] = [
  ["solid", "lsolid", "Solid"],
  ["dashed", "ldash", "Dashed"],
  ["dotted", "ldot", "Dotted"],
];

export class ShapeOptions {
  /** The open panel. */
  pop: "outline" | "fill" | null = null;
  private popEl: HTMLDivElement;

  constructor(private host: ShapeOptionsHost) {
    this.popEl = document.createElement("div");
    this.popEl.className = "opt-pop";
    this.popEl.hidden = true;
    document.body.append(this.popEl);
    for (const ev of ["click", "input", "change"]) this.popEl.addEventListener(ev, (e) => this.handle(e));
    // a click anywhere else closes the panel
    document.addEventListener(
      "pointerdown",
      (e) => {
        const t = e.target as Element;
        if (this.pop && !this.popEl.contains(t) && !t.closest?.("[data-pop]")) this.close();
      },
      true,
    );
  }

  /** What the controls show: the selected shape's look, or the next shape's. */
  private current(): { kind: ShapeKind; st: ShapeStyle; selected: boolean } {
    const a = this.host.selected()?.shape;
    if (a) return { kind: a.kind, st: a, selected: true };
    const s = this.host.settings;
    return { kind: s.shapeKind, st: shapeStyle(s), selected: false };
  }

  /** Controls for the toolbar (with the kinds when drawing). */
  html(withKinds: boolean): string {
    const { kind, st } = this.current();
    const line = isLineKind(kind);
    const dot = (c: number[] | null) => `<span class="pop-dot ${c ? "" : "none"}" style="--c:${c ? rgbToHex(c) : "transparent"}"></span>`;
    const kinds = withKinds
      ? `<div class="seg" role="radiogroup" aria-label="Shape">${KINDS.map(([k, ic, label]) => `<button data-shape="${k}" class="${k === kind ? "on" : ""}" title="${label}">${icon(ic)}</button>`).join("")}</div>`
      : "";
    return (
      kinds +
      `<button class="pop-btn ${this.pop === "outline" ? "on" : ""}" data-pop="outline" title="Outline: colour, width, dashes">${dot(st.color)}<span>${line ? "Line" : "Outline"}</span>${icon("down", "caret")}</button>` +
      (line ? "" : `<button class="pop-btn ${this.pop === "fill" ? "on" : ""}" data-pop="fill" title="Fill colour and opacity">${dot(st.fill)}<span>Fill</span>${icon("down", "caret")}</button>`) +
      (withKinds ? `<span class="muted hint">Shift: square, circle, straight lines</span>` : `<span class="muted hint">Changes apply to the selected shape</span>`)
    );
  }

  /** After the toolbar was drawn: put the open panel under its button. */
  place(optionsEl: HTMLElement): void {
    const btn = this.pop && optionsEl.querySelector<HTMLElement>(`[data-pop="${this.pop}"]`);
    if (!btn) {
      this.popEl.hidden = true;
      if (this.pop) this.pop = null;
      return;
    }
    this.popEl.innerHTML = this.panel(this.pop!);
    this.popEl.hidden = false;
    const r = btn.getBoundingClientRect();
    const w = this.popEl.offsetWidth;
    this.popEl.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
    this.popEl.style.top = `${r.bottom + 6}px`;
  }

  close(): void {
    if (!this.pop) return;
    this.pop = null;
    this.popEl.hidden = true;
    this.host.rerender();
  }

  private panel(which: "outline" | "fill"): string {
    const { kind, st } = this.current();
    const line = isLineKind(kind);
    const sw = (attr: string, hex: string, on: boolean) => `<button class="swatch ${on ? "on" : ""}" data-${attr}="${hex}" style="--c:${hex}" title="${hex}"></button>`;
    const range = (name: string, min: number, max: number, step: number, value: number, label: string, unit: string) =>
      `<label class="range"><span class="muted">${label}</span><input type="range" data-srange="${name}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}${unit}</output></label>`;
    if (which === "outline") {
      const cur = st.color ? rgbToHex(st.color) : null;
      return (
        `<div class="pop-row swatches">${PALETTE.map((c) => sw("scolor", c, c === cur)).join("")}<label class="swatch custom" title="Custom colour" style="--c:${cur ?? "#1c1c1c"}"><input type="color" data-scolor-input value="${cur ?? "#1c1c1c"}"></label></div>` +
        (line ? "" : `<button class="pop-check ${st.color ? "" : "on"}" data-snooutline>${icon("noFill")}<span>No outline</span></button>`) +
        `<div class="pop-row">${range("width", 0.5, 12, 0.5, st.width, "Width", "pt")}</div>` +
        `<div class="pop-row"><div class="seg" role="radiogroup" aria-label="Line">${LINES.map(([l, ic, label]) => `<button data-sline="${l}" class="${l === st.line ? "on" : ""}" title="${label}">${icon(ic)}</button>`)
          .join("")}</div></div>`
      );
    }
    const cur = st.fill ? rgbToHex(st.fill) : null;
    return (
      `<div class="pop-row swatches"><button class="swatch none ${cur ? "" : "on"}" data-sfill="none" title="No fill"></button>${PALETTE.map((c) => sw("sfill", c, c === cur)).join("")}<label class="swatch custom" title="Custom colour" style="--c:${cur ?? "#ffd400"}"><input type="color" data-sfill-input value="${cur ?? "#ffd400"}"></label></div>` +
      `<div class="pop-row">${range("opacity", 10, 100, 5, Math.round(st.opacity * 100), "Opacity", "%")}</div>`
    );
  }

  /** A click or input in the toolbar or the panel. Returns whether it was a shape control. */
  handle(e: Event): boolean {
    const t = e.target as HTMLElement;
    const s = this.host.settings;
    const { kind, st, selected } = this.current();
    const fillable = !isLineKind(kind);
    const apply = (style: Partial<ShapeStyle>) => {
      this.host.save();
      if (selected) this.host.restyle(style);
      this.host.rerender();
    };
    // sliders and colour pickers: the selected shape follows while dragging; one undo step when let go
    const input = t as HTMLInputElement;
    const follow = (style: Partial<ShapeStyle>) => {
      if (!selected) return;
      if (e.type === "input") this.host.live(style);
      else if (e.type === "change") this.host.commit();
    };
    if (input.dataset?.srange) {
      const v = Number(input.value);
      const out = input.parentElement!.querySelector("output")!;
      if (input.dataset.srange === "width") {
        out.textContent = `${v}pt`;
        s.shapeWidth = v;
        follow({ width: v });
      } else {
        out.textContent = `${v}%`;
        s.shapeOpacity = v / 100;
        follow({ opacity: v / 100 });
      }
      this.host.save();
      return true;
    }
    if (input.dataset?.scolorInput !== undefined || input.dataset?.sfillInput !== undefined) {
      if (e.type !== "change" && e.type !== "input") return true;
      if (input.dataset.scolorInput !== undefined) {
        s.colors.shape = input.value;
        s.shapeOutline = true;
        follow({ color: hexToRgb(input.value) });
      } else {
        s.shapeFill = input.value;
        follow({ fill: hexToRgb(input.value) });
      }
      this.host.save();
      if (e.type === "change") this.host.rerender();
      return true;
    }
    if (e.type !== "click") return false;
    const b = t.closest<HTMLElement>("button");
    if (!b) return false;
    const d = b.dataset;
    if (d.shape) {
      s.shapeKind = d.shape as ShapeKind;
      this.host.save();
      this.host.rerender();
    } else if (d.pop) {
      this.pop = this.pop === d.pop ? null : (d.pop as "outline" | "fill");
      this.host.rerender();
    } else if (d.scolor) {
      s.colors.shape = d.scolor;
      s.shapeOutline = true;
      apply({ color: hexToRgb(d.scolor) });
    } else if (d.snooutline !== undefined && fillable) {
      if (st.color) {
        // fill only: with no fill yet, fill with the outline colour
        const fill = st.fill ?? st.color;
        s.shapeOutline = false;
        s.shapeFill = rgbToHex(fill);
        apply({ color: null, fill });
      } else {
        s.shapeOutline = true;
        apply({ color: hexToRgb(s.colors.shape) });
      }
    } else if (d.sfill) {
      const fill = d.sfill === "none" ? null : hexToRgb(d.sfill);
      s.shapeFill = d.sfill === "none" ? null : d.sfill;
      // neither fill nor outline would be invisible: bring the outline back
      if (!fill && !st.color) {
        s.shapeOutline = true;
        apply({ fill: null, color: hexToRgb(s.colors.shape) });
      } else apply({ fill });
    } else if (d.sline) {
      s.shapeLine = d.sline as LineStyle;
      apply({ line: d.sline as LineStyle });
    } else return false;
    return true;
  }
}
