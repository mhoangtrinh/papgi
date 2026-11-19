// Toasts and modal dialogs (password, signature pad, shortcuts, confirm).
import { icon } from "./icons";

let toastTimer = 0;
/** A short message at the bottom; with an action it gets a button and stays a bit longer. */
export function toast(msg: string, kind: "info" | "error" = "info", action?: { label: string; run: () => void }): void {
  let el = document.querySelector<HTMLDivElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  const text = document.createElement("span");
  text.textContent = msg;
  el.replaceChildren(text);
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-action";
    b.textContent = action.label;
    b.onclick = () => {
      el!.classList.remove("show");
      action.run();
    };
    el.append(b);
  }
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), action ? 9000 : kind === "error" ? 5000 : 2500);
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

export function showShortcuts(): void {
  const rows: [string, string][] = [
    ["V", "Select / move"],
    ["E", "Edit text in the PDF"],
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
