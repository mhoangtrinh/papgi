// Crop pages: drag the box (or type the margins), or trim to what's printed.
import type { Rect } from "../core/geometry";
import type { Engine } from "../engine/client";
import { parseRange } from "../core/pages";
import { form, no, noKeyboard } from "./doc-tools";

export type CropSpec = { margins: [number, number, number, number] } | { trim: number } | { reset: true };

const MM = 72 / 25.4;
const MIN = 36; // points (about 1.3 cm)
const SIDES = ["left", "top", "right", "bottom"] as const;
const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

export async function cropDialog(engine: Engine, index: number, pageCount: number): Promise<{ pages: number[]; spec: CropSpec } | null> {
  const boxes = await engine.pageBoxes(index);
  const W = boxes.crop[2] - boxes.crop[0];
  const H = boxes.crop[3] - boxes.crop[1];
  // the preview fits in about 240 x 320 css px
  const scale = Math.min(240 / W, 320 / H);
  const m: [number, number, number, number] = [0, 0, 0, 0]; // left, top, right, bottom (points)
  let auto = false; // the box came from "Trim white margins"
  const field = (side: string, label: string) => `<label class="dt-row crop-mm"><span>${label}</span><input class="field dt-num" type="number" inputmode="decimal" min="0" step="1" data-side="${side}" value="0"><output>mm</output></label>`;
  const html =
    `<div class="dt-split crop-split"><div class="dt-fields">` +
    `<p class="muted dt-note">Drag the box's edges or corners, or type how much to cut off.</p>` +
    `<div class="crop-grid">${field("top", "Top")}${field("bottom", "Bottom")}${field("left", "Left")}${field("right", "Right")}</div>` +
    `<div class="dt-row"><span></span><button type="button" class="btn small" data-act="trim">Trim white margins</button></div>` +
    `<label class="dt-row"><span>Apply to</span><select class="field" data-k="target"><option value="this">This page (${index + 1})</option><option value="all">All pages</option><option value="range">Pages…</option></select></label>` +
    `<label class="dt-row" data-range hidden><span>Pages</span><input class="field" data-k="pages" placeholder="e.g. 1-3, 5" autocomplete="off"></label>` +
    `<p class="muted dt-note" data-auto hidden>Each page is trimmed to what's printed on it.</p>` +
    `</div><div class="crop-stage" style="width:${Math.round(W * scale)}px;height:${Math.round(H * scale)}px"><canvas></canvas><div class="crop-clip"><div class="crop-shade"></div></div><div class="crop-box">${HANDLES.map((h) => `<span class="crop-h" data-h="${h}"></span>`).join("")}</div></div></div>`;

  let root!: HTMLElement;
  const box = () => root.querySelector<HTMLElement>(".crop-box")!;
  const input = (side: string) => root.querySelector<HTMLInputElement>(`[data-side="${side}"]`)!;
  const target = () => root.querySelector<HTMLSelectElement>('[data-k="target"]')!.value;
  /** `typing`: the field being typed in keeps what's typed. */
  const draw = (typing?: HTMLInputElement) => {
    for (const b of [box(), root.querySelector<HTMLElement>(".crop-shade")!]) {
      b.style.left = `${m[0] * scale}px`;
      b.style.top = `${m[1] * scale}px`;
      b.style.width = `${(W - m[0] - m[2]) * scale}px`;
      b.style.height = `${(H - m[1] - m[3]) * scale}px`;
    }
    SIDES.forEach((side, k) => {
      const el = input(side);
      if (el !== typing) el.value = String(Math.round(m[k] / MM));
    });
    root.querySelector<HTMLElement>("[data-auto]")!.hidden = !(auto && target() !== "this");
    root.querySelector<HTMLElement>("[data-range]")!.hidden = target() !== "range";
  };
  /** Keep the box inside the page and at least MIN big; `k` is the side just changed. */
  const fix = (k: number) => {
    for (let i = 0; i < 4; i++) m[i] = Math.max(0, Number.isFinite(m[i]) ? m[i] : 0);
    const span = (a: number) => (a % 2 === 0 ? W : H);
    const other = (k + 2) % 4;
    if (span(k) - m[k] - m[other] < MIN) m[k] = Math.max(0, span(k) - m[other] - MIN);
  };

  const r = await form<{ pages: number[]; spec: CropSpec }>(
    "Crop pages",
    html,
    "Crop",
    (body) => {
      root = body;
      noKeyboard();
      // the page picture
      void engine.renderBitmap(index, scale * (window.devicePixelRatio || 1)).then((bmp) => {
        const c = root.querySelector("canvas")!;
        c.width = bmp.width;
        c.height = bmp.height;
        const ctx = c.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      });
      draw();
      root.addEventListener("input", (e) => {
        const el = e.target as HTMLInputElement;
        const k = SIDES.indexOf(el.dataset.side as (typeof SIDES)[number]);
        if (k >= 0) {
          m[k] = Number(el.value) * MM;
          auto = false;
          fix(k);
        }
        draw(el);
      });
      root.addEventListener("change", (e) => {
        if ((e.target as HTMLElement).dataset.side) (e.target as HTMLInputElement).value = String(Math.round(m[SIDES.indexOf((e.target as HTMLInputElement).dataset.side as never)] / MM));
        draw();
      });
      root.querySelector('[data-act="trim"]')!.addEventListener("click", async () => {
        const c: Rect | null = await engine.contentBox(index);
        if (!c) return;
        const pad = 6;
        m[0] = Math.max(0, c[0] - boxes.crop[0] - pad);
        m[1] = Math.max(0, c[1] - boxes.crop[1] - pad);
        m[2] = Math.max(0, boxes.crop[2] - c[2] - pad);
        m[3] = Math.max(0, boxes.crop[3] - c[3] - pad);
        fix(0);
        fix(1);
        auto = true;
        draw();
      });
      // dragging the box or its handles
      const stage = root.querySelector<HTMLElement>(".crop-stage")!;
      let drag: { h: string; x: number; y: number; m0: number[] } | null = null;
      stage.addEventListener("pointerdown", (e) => {
        const h = (e.target as HTMLElement).dataset.h ?? ((e.target as HTMLElement).closest(".crop-box") ? "move" : null);
        if (!h) return;
        e.preventDefault();
        stage.setPointerCapture(e.pointerId);
        drag = { h, x: e.clientX, y: e.clientY, m0: [...m] };
      });
      stage.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dx = (e.clientX - drag.x) / scale;
        const dy = (e.clientY - drag.y) / scale;
        const [l, t, r, b] = drag.m0;
        if (drag.h === "move") {
          const mx = Math.max(-l, Math.min(r, dx));
          const my = Math.max(-t, Math.min(b, dy));
          m[0] = l + mx;
          m[2] = r - mx;
          m[1] = t + my;
          m[3] = b - my;
        } else {
          if (drag.h.includes("w")) (m[0] = l + dx), fix(0);
          if (drag.h.includes("e")) (m[2] = r - dx), fix(2);
          if (drag.h.includes("n")) (m[1] = t + dy), fix(1);
          if (drag.h.includes("s")) (m[3] = b - dy), fix(3);
        }
        auto = false;
        draw();
      });
      const end = () => (drag = null);
      stage.addEventListener("pointerup", end);
      stage.addEventListener("pointercancel", end);
    },
    (body, action) => {
      const t = target();
      let pages: number[];
      if (t === "this") pages = [index];
      else if (t === "all") pages = [...Array(pageCount).keys()];
      else {
        const pg = parseRange(body.querySelector<HTMLInputElement>('[data-k="pages"]')!.value, pageCount);
        if (!pg?.length) return no(`Pages: use numbers from 1 to ${pageCount}, like 1-3, 5`);
        pages = pg;
      }
      if (action === "reset") return { pages, spec: { reset: true } };
      if (auto) return { pages, spec: { trim: 6 } };
      if (m.every((v) => v < 0.5)) return no("Drag the box's edges inwards first (or use Trim white margins)");
      return { pages, spec: { margins: m.map((v) => Math.round(v * 100) / 100) as [number, number, number, number] } };
    },
    boxes.cropped ? [{ label: "Remove crop", value: "reset" }] : [],
  );
  return r ? r.value : null;
}
