// "Find a function": type what you want to do (e.g. "ocr", "unterschrift", "smaller") and
// get the matching tools and menu items, wherever they live in the app.
import { t } from "../i18n";
import { icon } from "./icons";
import { toast } from "./dialogs";

export interface Command {
  id: string;
  /** English label (shown translated). */
  label: string;
  icon: string;
  /** Where it is in the app (shown small), e.g. "Document menu". */
  where: string;
  /** Other words people may search for (any language). */
  words?: string;
  /** Keyboard shortcut, shown on the right. */
  key?: string;
  /** Needs an open PDF. */
  needsDoc?: boolean;
  run: () => void;
}

/** Lower case, no accents (so "ubersetzen" finds "übersetzen"). */
export const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** How well a command matches the query (0: not at all). Every word typed must be found. */
export function score(c: Command, query: string): number {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const label = fold(`${c.label} ${t(c.label)}`);
  const rest = fold(`${c.words ?? ""} ${c.where} ${t(c.where)}`);
  let total = 0;
  for (const w of words) {
    const inLabel = label.indexOf(w);
    if (inLabel === 0) total += 10;
    else if (inLabel > 0 && /[\s(/-]/.test(label[inLabel - 1])) total += 7;
    else if (inLabel > 0) total += 4;
    else if (new RegExp(`(^|[\\s,(/-])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(rest)) total += 3;
    else if (rest.includes(w)) total += 1;
    else return 0;
  }
  return total;
}

/** Best matches first (ties keep their order). */
export function findCommands(list: Command[], query: string): Command[] {
  return list
    .map((c, i) => ({ c, i, s: score(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.c);
}

let open: HTMLElement | null = null;

/** Show the search box with the commands; `hasDoc`: a PDF is open. */
export function showCommands(list: Command[], hasDoc: boolean): void {
  if (open) return void open.querySelector<HTMLInputElement>("input")?.focus();
  const back = document.createElement("div");
  back.className = "cmd-back";
  back.innerHTML = `<div class="cmd" role="dialog" aria-modal="true" aria-label="${t("Find a function")}">
      <div class="cmd-search">${icon("search")}<input type="search" placeholder="${t("What do you want to do? e.g. OCR, sign, smaller…")}" aria-label="${t("Find a function")}" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="cmd-list" role="listbox"></div>
    </div>`;
  open = back;
  const input = back.querySelector("input")!;
  const listEl = back.querySelector<HTMLElement>(".cmd-list")!;
  let shown: Command[] = [];
  let active = 0;
  const close = () => {
    back.remove();
    open = null;
    document.removeEventListener("keydown", onKey, true);
  };
  const run = (c: Command | undefined) => {
    if (!c) return;
    if (c.needsDoc && !hasDoc) return void toast("Open a PDF first", "info");
    close();
    c.run();
  };
  const draw = () => {
    shown = findCommands(list, input.value).slice(0, 40);
    active = Math.min(active, Math.max(0, shown.length - 1));
    listEl.innerHTML = shown.length
      ? shown
          .map(
            (c, i) =>
              `<button type="button" class="cmd-item${i === active ? " on" : ""}${c.needsDoc && !hasDoc ? " off" : ""}" role="option" aria-selected="${i === active}" data-i="${i}">${icon(c.icon)}<span class="cmd-label">${t(c.label)}</span><span class="cmd-where">${c.needsDoc && !hasDoc ? t("open a PDF first") : t(c.where)}</span>${c.key ? `<kbd>${c.key}</kbd>` : ""}</button>`,
          )
          .join("")
      : `<p class="cmd-none">${t("Nothing found. Try another word.")}</p>`;
    listEl.querySelector(".cmd-item.on")?.scrollIntoView({ block: "nearest" });
  };
  const move = (d: number) => {
    if (!shown.length) return;
    active = (active + d + shown.length) % shown.length;
    listEl.querySelectorAll(".cmd-item").forEach((b, i) => {
      b.classList.toggle("on", i === active);
      b.setAttribute("aria-selected", String(i === active));
    });
    listEl.querySelector(".cmd-item.on")?.scrollIntoView({ block: "nearest" });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      run(shown[active]);
    }
  };
  input.addEventListener("input", () => {
    active = 0;
    draw();
  });
  listEl.addEventListener("click", (e) => run(shown[Number((e.target as HTMLElement).closest<HTMLElement>(".cmd-item")?.dataset.i ?? -1)]));
  listEl.addEventListener("pointermove", (e) => {
    const i = Number((e.target as HTMLElement).closest<HTMLElement>(".cmd-item")?.dataset.i ?? -1);
    if (i >= 0 && i !== active) {
      active = i;
      move(0);
    }
  });
  back.addEventListener("pointerdown", (e) => {
    if (e.target === back) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(back);
  draw();
  input.focus();
}

export const commandsOpen = () => open !== null;
