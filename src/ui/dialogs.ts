// Toasts and modal dialogs (password, signature pad, shortcuts, confirm).
import type { Point } from "../core/geometry";
import { simplifyStroke } from "../core/geometry";
import { icon } from "./icons";

let toastTimer = 0;
export function toast(msg: string, kind: "info" | "error" = "info"): void {
  let el = document.querySelector<HTMLDivElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), kind === "error" ? 5000 : 2500);
}

interface ModalOpts {
  title: string;
  body: HTMLElement | string;
  actions: { label: string; value: string; primary?: boolean; danger?: boolean }[];
  wide?: boolean;
}

/** Shows a modal; resolves with the clicked action value, or "" when dismissed. */
export function modal(opts: ModalOpts, onOpen?: (root: HTMLElement) => void): Promise<string> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal ${opts.wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${opts.title}">
      <div class="modal-head"><h2>${opts.title}</h2><button class="icon-btn" data-v="" aria-label="Close">${icon("close")}</button></div>
      <div class="modal-body"></div>
      <div class="modal-actions">${opts.actions
        .map((a) => `<button class="btn ${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""}" data-v="${a.value}">${a.label}</button>`)
        .join("")}</div></div>`;
    const body = back.querySelector(".modal-body")!;
    if (typeof opts.body === "string") body.innerHTML = opts.body;
    else body.append(opts.body);
    const done = (v: string) => {
      document.removeEventListener("keydown", onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done("");
      } else if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = opts.actions.find((a) => a.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          done(primary.value);
        }
      }
    };
    back.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
      if (b) done(b.dataset.v!);
      else if (e.target === back) done("");
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    onOpen?.(back);
    back.querySelector<HTMLElement>("input, .btn.primary")?.focus();
  });
}

export async function askPassword(name: string, wrong: boolean): Promise<string | null> {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<p>${wrong ? "That password didn't work. " : ""}<b></b> is protected. Enter its password to open it.</p>
    <input type="password" class="field" autocomplete="current-password" aria-label="Password">`;
  wrap.querySelector("b")!.textContent = name;
  const input = wrap.querySelector("input")!;
  const v = await modal({ title: "Password needed", body: wrap, actions: [{ label: "Cancel", value: "" }, { label: "Open", value: "ok", primary: true }] });
  return v === "ok" ? input.value : null;
}

export async function confirmDialog(title: string, text: string, ok: string, danger = false): Promise<boolean> {
  const v = await modal({ title, body: `<p>${text}</p>`, actions: [{ label: "Cancel", value: "" }, { label: ok, value: "ok", primary: true, danger }] });
  return v === "ok";
}

/** Signature pad. Resolves to strokes in pad coordinates, or null if cancelled. */
export async function drawSignature(color: string, existing: Point[][] | null): Promise<Point[][] | null> {
  const wrap = document.createElement("div");
  wrap.className = "sigpad";
  wrap.innerHTML = `<p class="muted">Sign inside the box with your mouse, pen or finger.</p>
    <canvas width="600" height="220" aria-label="Signature pad"></canvas>
    <div class="sig-line"></div>
    <button class="btn small" data-act="clear">Clear</button>`;
  const canvas = wrap.querySelector("canvas")!;
  const ctx = canvas.getContext("2d")!;
  let strokes: Point[][] = existing ? existing.map((s) => s.slice()) : [];
  let current: Point[] | null = null;

  const redraw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = ctx.lineJoin = "round";
    for (const s of [...strokes, ...(current ? [current] : [])]) {
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1] + 0.1);
      ctx.stroke();
    }
  };
  const pos = (e: PointerEvent): Point => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    current = [pos(e)];
    redraw();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!current) return;
    for (const ce of e.getCoalescedEvents?.() ?? [e]) current.push(pos(ce));
    redraw();
  });
  const end = () => {
    if (current) strokes.push(simplifyStroke(current, 0.6));
    current = null;
    redraw();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  wrap.querySelector('[data-act="clear"]')!.addEventListener("click", () => {
    strokes = [];
    redraw();
  });
  redraw();
  const v = await modal({
    title: "Your signature",
    body: wrap,
    wide: true,
    actions: [
      { label: "Cancel", value: "" },
      { label: "Save signature", value: "ok", primary: true },
    ],
  });
  if (v !== "ok") return null;
  return strokes.filter((s) => s.length > 0);
}

export function showShortcuts(): void {
  const rows: [string, string][] = [
    ["V", "Select / move"],
    ["H", "Highlight text"],
    ["P", "Pen"],
    ["T", "Text box"],
    ["R", "Shapes"],
    ["S", "Signature"],
    ["Ctrl + O", "Open"],
    ["Ctrl + S", "Save"],
    ["Ctrl + Shift + S", "Save a copy"],
    ["Ctrl + Z / Ctrl + Y", "Undo / redo"],
    ["Ctrl + F", "Search"],
    ["Ctrl + C", "Copy selected text"],
    ["Ctrl + + / − / 0", "Zoom in / out / fit width"],
    ["Ctrl + wheel", "Zoom"],
    ["Delete", "Delete selected annotation or pages"],
    ["Double-click text box", "Edit it"],
    ["Esc", "Cancel / deselect"],
  ];
  modal({
    title: "Keyboard shortcuts",
    body: `<table class="keys">${rows.map(([k, d]) => `<tr><td><kbd>${k}</kbd></td><td>${d}</td></tr>`).join("")}</table>`,
    actions: [{ label: "Close", value: "", primary: true }],
  });
}
