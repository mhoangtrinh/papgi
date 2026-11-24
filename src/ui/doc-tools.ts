// Dialogs for whole-document tools: password, watermark, page numbers / header & footer,
// redacting a text everywhere.
import { t } from "../i18n";
import type { Corner, FieldProps, HeaderFooterOptions, WatermarkOptions, WidgetInfo } from "../engine/engine";
import { DATE_FORMATS } from "../engine/forms";
import { parseRange } from "../core/pages";
import { hexToRgb } from "../storage";
import { modal } from "./dialogs";

export const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Remembered choices (this device only). */
function remember<T extends object>(key: string, defaults: T): { get(): T; set(v: T): void } {
  const k = `papgi.${key}`;
  return {
    get() {
      try {
        const v = JSON.parse(localStorage.getItem(k) ?? "null");
        return v && typeof v === "object" ? { ...defaults, ...v } : { ...defaults };
      } catch {
        return { ...defaults };
      }
    },
    set(v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {
        /* private mode */
      }
    },
  };
}

/** "All pages" or a range like "1-3, 5": the field and how to read it. */
export function pagesField(count: number): { html: string; read(root: HTMLElement): number[] | null } {
  return {
    html: `<label class="dt-row"><span>Pages</span><input class="field" data-k="pages" placeholder="All pages (or e.g. 1-3, 5)" autocomplete="off"></label>`,
    read(root) {
      const v = root.querySelector<HTMLInputElement>('[data-k="pages"]')!.value.trim();
      return v ? parseRange(v, count) : [...Array(count).keys()];
    },
  };
}

/** On phones, don't pop up the keyboard for a dialog that's mostly sliders and choices. */
export function noKeyboard(): void {
  if (matchMedia("(pointer: coarse)").matches) requestAnimationFrame(() => (document.activeElement as HTMLElement | null)?.blur());
}

function bad(root: HTMLElement, msg: string): void {
  const el = root.querySelector<HTMLElement>(".dt-error")!;
  el.textContent = msg;
  el.hidden = !msg;
}

/** A wrong input: the message to show (the dialog stays open). */
export class Bad {
  constructor(readonly msg: string) {}
}
export const no = (msg: string) => new Bad(msg);

/** Keeps a modal open on its buttons while the input is wrong. */
export async function form<T>(title: string, html: string, okLabel: string, onOpen: (root: HTMLElement) => void, read: (root: HTMLElement, action: string) => T | Bad, extra: { label: string; value: string; danger?: boolean }[] = []): Promise<{ value: T; action: string } | null> {
  const body = document.createElement("div");
  body.className = "dt";
  body.innerHTML = html + `<p class="dt-error" role="alert" hidden></p>`;
  let result: { value: T; action: string } | null = null;
  const check = (action: string, e: Event): void => {
    const r = read(body, action);
    if (r instanceof Bad) {
      e.preventDefault();
      e.stopPropagation();
      bad(body, r.msg);
    } else result = { value: r, action };
  };
  // Enter is handled by the modal on document (capture), so look first from window.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement) && body.isConnected) check("ok", e);
  };
  window.addEventListener("keydown", onKey, true);
  const v = await modal({ title, body, actions: [{ label: "Cancel", value: "" }, ...extra, { label: okLabel, value: "ok", primary: true }], wide: true }, (root) => {
    onOpen(body);
    root.addEventListener(
      "click",
      (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-v]");
        if (b?.dataset.v) check(b.dataset.v, e);
      },
      true,
    );
  });
  window.removeEventListener("keydown", onKey, true);
  return v ? result : null;
}

// ---------- password ----------

export async function passwordDialog(state: { locked: boolean }): Promise<{ user: string } | "none" | null> {
  const html =
    `<p>${state.locked ? "This file needs a password to open. Set a new one, or remove it." : "Anyone opening the saved file will need this password. It's encrypted with AES-256."}</p>` +
    `<label class="dt-row"><span>Password</span><input class="field" type="password" data-k="p1" autocomplete="new-password"></label>` +
    `<label class="dt-row"><span>Again</span><input class="field" type="password" data-k="p2" autocomplete="new-password"></label>` +
    `<p class="muted dt-note">Takes effect when you save. Keep the password safe: without it the file can't be opened, not even by papgi.</p>`;
  const r = await form<{ user: string } | "none">(
    "Password protection",
    html,
    state.locked ? "Change password" : "Protect",
    () => {},
    (root, action) => {
      if (action === "remove") return "none";
      const p1 = root.querySelector<HTMLInputElement>('[data-k="p1"]')!.value;
      const p2 = root.querySelector<HTMLInputElement>('[data-k="p2"]')!.value;
      if (!p1) return no("Type a password");
      if (p1.includes(",")) return no("Passwords can't contain a comma here");
      if (p1 !== p2) return no("The two passwords aren't the same");
      return { user: p1 };
    },
    state.locked ? [{ label: "Remove password", value: "remove", danger: true }] : [],
  );
  return r ? r.value : null;
}

// ---------- watermark ----------

const wmStore = remember("watermark", { text: t("CONFIDENTIAL"), size: 64, color: "#e5484d", opacity: 30, angle: 45, bold: true });

export async function watermarkDialog(pageCount: number, page: { w: number; h: number }): Promise<WatermarkOptions | null> {
  const v = wmStore.get();
  const pages = pagesField(pageCount);
  const ratio = page.h / page.w;
  const html =
    `<div class="dt-split"><div class="dt-fields">` +
    `<label class="dt-row"><span>Text</span><input class="field" data-k="text" value="${esc(v.text)}" maxlength="80"></label>` +
    `<label class="dt-row"><span>Size</span><input type="range" data-k="size" min="12" max="160" value="${v.size}"><output>${v.size} pt</output></label>` +
    `<label class="dt-row"><span>Opacity</span><input type="range" data-k="opacity" min="5" max="100" step="5" value="${v.opacity}"><output>${v.opacity}%</output></label>` +
    `<div class="dt-row"><span>Direction</span><div class="seg text-seg" role="radiogroup"><button type="button" data-angle="45" class="${v.angle === 45 ? "on" : ""}">Diagonal</button><button type="button" data-angle="0" class="${v.angle === 0 ? "on" : ""}">Across</button></div></div>` +
    `<div class="dt-row"><span>Colour</span><div class="dt-colors">${["#e5484d", "#1c1c1c", "#8a8a8a", "#2f6fed", "#5fd068"].map((c) => `<button type="button" class="swatch ${c === v.color ? "on" : ""}" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join("")}<label class="dt-check"><input type="checkbox" data-k="bold" ${v.bold ? "checked" : ""}> Bold</label></div></div>` +
    pages.html +
    `</div><div class="dt-preview" style="--ratio:${ratio}"><div class="dt-page"><span class="dt-wm" translate="no"></span></div></div></div>`;
  let angle = v.angle;
  let color = v.color;
  const paint = (root: HTMLElement) => {
    const wm = root.querySelector<HTMLElement>(".dt-wm")!;
    const get = (k: string) => root.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
    wm.textContent = get("text").value || " ";
    const pw = root.querySelector<HTMLElement>(".dt-page")!.clientWidth || 160;
    wm.style.fontSize = `${(Number(get("size").value) * pw) / page.w}px`;
    wm.style.opacity = String(Number(get("opacity").value) / 100);
    wm.style.color = color;
    wm.style.fontWeight = get("bold").checked ? "700" : "400";
    wm.style.transform = `translate(-50%, -50%) rotate(${-angle}deg)`;
    get("size").nextElementSibling!.textContent = `${get("size").value} pt`;
    get("opacity").nextElementSibling!.textContent = `${get("opacity").value}%`;
    root.querySelectorAll<HTMLElement>("[data-angle]").forEach((b) => b.classList.toggle("on", Number(b.dataset.angle) === angle));
    root.querySelectorAll<HTMLElement>("[data-color]").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
  };
  const r = await form(
    "Watermark",
    html,
    "Add watermark",
    (root) => {
      root.addEventListener("input", () => paint(root));
      root.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-angle], [data-color]");
        if (!b) return;
        if (b.dataset.angle) angle = Number(b.dataset.angle);
        if (b.dataset.color) color = b.dataset.color;
        paint(root);
      });
      requestAnimationFrame(() => paint(root));
      noKeyboard();
    },
    (root) => {
      const get = (k: string) => root.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
      const text = get("text").value.trim();
      if (!text) return no("Type the watermark's text");
      const pg = pages.read(root);
      if (!pg?.length) return no(`Pages: use numbers from 1 to ${pageCount}, like 1-3, 5`);
      return { text, size: Number(get("size").value), opacity: Number(get("opacity").value), bold: get("bold").checked, pages: pg };
    },
  );
  if (!r) return null;
  const o = r.value;
  wmStore.set({ text: o.text, size: o.size, color, opacity: o.opacity, angle, bold: o.bold });
  return { text: o.text, size: o.size, color: hexToRgb(color), opacity: o.opacity / 100, angle, bold: o.bold, pages: o.pages };
}

// ---------- page numbers, header and footer ----------

const FORMATS: [string, string][] = [
  ["{page}", "1"],
  ["Page {page}", "Page 1"],
  ["Page {page} of {pages}", "Page 1 of 9"],
  ["{page} / {pages}", "1 / 9"],
  ["– {page} –", "– 1 –"],
];
const CORNERS: [Corner, string][] = [
  ["tl", "Top left"],
  ["tc", "Top centre"],
  ["tr", "Top right"],
  ["bl", "Bottom left"],
  ["bc", "Bottom centre"],
  ["br", "Bottom right"],
];
const hfStore = remember("headerFooter", { format: "{page}", where: "bc" as Corner, header: "", footer: "", size: 10, startAt: 1, skipFirst: false });

export async function headerFooterDialog(pageCount: number, page: { w: number; h: number }, file: string): Promise<HeaderFooterOptions | null> {
  const v = hfStore.get();
  const pages = pagesField(pageCount);
  const html =
    `<div class="dt-split"><div class="dt-fields">` +
    `<label class="dt-row"><span>Numbers</span><select class="field" data-k="format"><option value="">No page numbers</option>${FORMATS.map(([en, label]) => {
      // (the words in the stamped text follow the interface language: "Seite 1 von 9")
      const f = t(en);
      return `<option value="${esc(f)}" ${f === v.format || en === v.format ? "selected" : ""}>${esc(label)}</option>`;
    }).join("")}</select></label>` +
    `<label class="dt-row"><span>Where</span><select class="field" data-k="where">${CORNERS.map(([c, label]) => `<option value="${c}" ${c === v.where ? "selected" : ""}>${label}</option>`).join("")}</select></label>` +
    `<label class="dt-row"><span>Header</span><input class="field" data-k="header" value="${esc(v.header)}" placeholder="Text at the top (centre), optional"></label>` +
    `<label class="dt-row"><span>Footer</span><input class="field" data-k="footer" value="${esc(v.footer)}" placeholder="Text at the bottom (left), optional"></label>` +
    `<p class="muted dt-note">In the texts, {page}, {pages}, {date} and {file} are filled in.</p>` +
    `<label class="dt-row"><span>Size</span><input type="range" data-k="size" min="6" max="20" value="${v.size}"><output>${v.size} pt</output></label>` +
    `<label class="dt-row"><span>Start at</span><input class="field dt-num" type="number" min="0" max="9999" data-k="startAt" value="${v.startAt}"></label>` +
    `<label class="dt-row dt-checkrow"><input type="checkbox" data-k="skipFirst" ${v.skipFirst ? "checked" : ""}> Nothing on the first page (a title page)</label>` +
    pages.html +
    `</div><div class="dt-preview" style="--ratio:${page.h / page.w}"><div class="dt-page">${CORNERS.map(([c]) => `<span class="dt-hf dt-${c}" translate="no"></span>`).join("")}</div></div></div>`;
  const date = new Date().toLocaleDateString();
  const collect = (root: HTMLElement) => {
    const get = (k: string) => root.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!;
    const items: Partial<Record<Corner, string>> = {};
    const add = (c: Corner, t: string) => {
      if (t.trim()) items[c] = items[c] ? `${items[c]}   ${t}` : t;
    };
    add(get("where").value as Corner, get("format").value);
    add("tc", get("header").value);
    add("bl", get("footer").value);
    return { items, size: Number(get("size").value), startAt: Math.max(0, Math.round(Number(get("startAt").value) || 0)), skipFirst: get("skipFirst").checked };
  };
  const paint = (root: HTMLElement) => {
    const c = collect(root);
    // (the pages that get a number: the chosen ones, less a skipped title page)
    const chosen = pages.read(root) ?? [...Array(pageCount).keys()];
    const shown = Math.max(1, chosen.filter((i) => !(c.skipFirst && i === 0)).length);
    const pw = root.querySelector<HTMLElement>(".dt-page")!.clientWidth || 160;
    for (const [corner] of CORNERS) {
      const el = root.querySelector<HTMLElement>(`.dt-${corner}`)!;
      const t = c.items[corner] ?? "";
      el.textContent = t.replace(/\{page\}/g, String(c.startAt)).replace(/\{pages\}/g, String(shown + c.startAt - 1)).replace(/\{date\}/g, date).replace(/\{file\}/g, file);
      el.style.fontSize = `${Math.max(5, (c.size * pw) / page.w)}px`;
    }
    const size = root.querySelector<HTMLInputElement>('[data-k="size"]')!;
    size.nextElementSibling!.textContent = `${size.value} pt`;
  };
  const r = await form(
    "Page numbers, header & footer",
    html,
    "Add",
    (root) => {
      root.addEventListener("input", () => paint(root));
      root.addEventListener("change", () => paint(root));
      requestAnimationFrame(() => paint(root));
      noKeyboard();
    },
    (root) => {
      const c = collect(root);
      if (!Object.keys(c.items).length) return no("Choose page numbers, or type a header or footer");
      const pg = pages.read(root);
      if (!pg?.length) return no(`Pages: use numbers from 1 to ${pageCount}, like 1-3, 5`);
      const get = (k: string) => root.querySelector<HTMLInputElement>(`[data-k="${k}"]`)!.value;
      return { ...c, pages: pg, format: get("format"), where: get("where") as Corner, header: get("header"), footer: get("footer") };
    },
  );
  if (!r) return null;
  const o = r.value;
  hfStore.set({ format: o.format, where: o.where, header: o.header, footer: o.footer, size: o.size, startAt: o.startAt, skipFirst: o.skipFirst });
  return { items: o.items, size: o.size, color: [0, 0, 0], margin: 28, startAt: o.startAt, skipFirst: o.skipFirst, pages: o.pages, file, date };
}

// ---------- redact a text everywhere ----------

export async function redactTextDialog(count: (q: string) => Promise<number>): Promise<string | null> {
  const html =
    `<p>Every place this text appears is blacked out, and the text under the black boxes is really removed from the file (not just covered).</p>` +
    `<label class="dt-row"><span>Text</span><input class="field" data-k="q" autocomplete="off" placeholder="A name, a number, an e-mail address…"></label>` +
    `<p class="muted dt-count" aria-live="polite"></p>`;
  let timer = 0;
  let last = 0;
  const r = await form(
    "Redact a text everywhere",
    html,
    "Redact",
    (root) => {
      const input = root.querySelector<HTMLInputElement>('[data-k="q"]')!;
      const out = root.querySelector<HTMLElement>(".dt-count")!;
      input.addEventListener("input", () => {
        clearTimeout(timer);
        timer = window.setTimeout(async () => {
          const q = input.value;
          if (!q.trim()) return void (out.textContent = "");
          last = await count(q).catch(() => 0);
          if (input.value === q) out.textContent = last ? `Found in ${last} place${last === 1 ? "" : "s"}.` : "Not found in this file.";
        }, 250);
      });
    },
    (root) => {
      const q = root.querySelector<HTMLInputElement>('[data-k="q"]')!.value;
      return q.trim() ? q : no("Type the text to redact");
    },
  );
  return r ? r.value : null;
}

// ---------- sticky note ----------

/** Write or change a note's text. "delete": remove the note. */
export async function noteDialog(text: string, isNew: boolean, title = "Note"): Promise<string | "delete" | null> {
  const body = document.createElement("div");
  body.className = "dt";
  body.innerHTML = `<textarea class="field note-text" rows="6" maxlength="5000" placeholder="Write your note…" aria-label="Note"></textarea><p class="muted dt-note">Ctrl+Enter to save. The note shows as an icon on the page; click it to read it.</p>`;
  const ta = body.querySelector("textarea")!;
  ta.value = text;
  let value = text;
  const v = await modal(
    {
      title: isNew ? "New note" : title,
      body,
      actions: [...(isNew ? [] : [{ label: "Delete", value: "delete", danger: true }]), { label: "Cancel", value: "" }, { label: "Save", value: "ok", primary: true }],
    },
    (root) => {
      ta.addEventListener("input", () => (value = ta.value));
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          root.querySelector<HTMLButtonElement>('button[data-v="ok"]')!.click();
        }
      });
      requestAnimationFrame(() => ta.focus());
    },
  );
  if (v === "delete") return "delete";
  return v === "ok" ? value : null;
}

// ---------- form field settings ----------

export async function fieldDialog(w: WidgetInfo): Promise<FieldProps | "delete" | null> {
  const isText = w.kind === "text";
  const isDate = isText && !!w.dateFormat;
  const sized = w.kind === "text" || w.kind === "combobox";
  const html =
    `<label class="dt-row"><span>${w.kind === "radio" ? "Group name" : "Name"}</span><input class="field" data-k="name" value="${esc(w.name)}" autocomplete="off"></label>` +
    (w.kind === "radio" ? `<p class="muted dt-note">All radio buttons with this name are one choice: picking one clears the others.</p>` : "") +
    (w.kind === "combobox" || w.kind === "listbox"
      ? `<label class="dt-row dt-top"><span>Choices</span><textarea class="field note-text" data-k="options" rows="5" placeholder="One per line">${esc(w.options.join("\n"))}</textarea></label>`
      : "") +
    (isDate ? `<label class="dt-row"><span>Format</span><select class="field" data-k="date">${DATE_FORMATS.map((f) => `<option ${f === w.dateFormat ? "selected" : ""}>${f}</option>`).join("")}</select></label>` : "") +
    (sized
      ? `<label class="dt-row"><span>Text size</span><select class="field" data-k="size">${[0, 8, 9, 10, 11, 12, 14, 16].map((n) => `<option value="${n}" ${n === Math.round(w.fontSize) ? "selected" : ""}>${n ? `${n} pt` : "Fit the box"}</option>`).join("")}</select></label>`
      : "") +
    (isText && !isDate ? `<label class="dt-row dt-checkrow"><input type="checkbox" data-k="multiline" ${w.multiline ? "checked" : ""}> Several lines</label>` : "") +
    `<label class="dt-row dt-checkrow"><input type="checkbox" data-k="required" ${w.required ? "checked" : ""}> Must be filled in</label>`;
  const r = await form<FieldProps>(
    "Field settings",
    html,
    "Save",
    () => {},
    (root, action) => {
      const get = <T extends HTMLElement = HTMLInputElement>(k: string) => root.querySelector<T>(`[data-k="${k}"]`);
      const name = get("name")!.value.trim();
      if (action === "delete") return {};
      if (!name) return no("A field needs a name");
      if (name.includes(".")) return no("A field name can't contain a dot");
      const p: FieldProps = { name, required: get("required")!.checked };
      const opts = get<HTMLTextAreaElement>("options");
      if (opts) {
        p.options = opts.value.split("\n").map((o) => o.trim()).filter(Boolean);
        if (!p.options.length) return no("Add at least one choice");
      }
      const date = get<HTMLSelectElement>("date");
      if (date) p.dateFormat = date.value;
      const size = get<HTMLSelectElement>("size");
      if (size) p.fontSize = Number(size.value);
      const ml = get("multiline");
      if (ml) p.multiline = ml.checked;
      return p;
    },
    [{ label: "Delete field", value: "delete", danger: true }],
  );
  if (!r) return null;
  return r.action === "delete" ? "delete" : r.value;
}
