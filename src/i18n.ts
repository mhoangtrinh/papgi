// Interface language. The UI is written in English; in German every text the page shows
// (text, tooltips, placeholders, labels) is swapped for its translation as it appears, from
// a dictionary plus patterns for texts with numbers and names in them. Anything inside
// translate="no" (file names, field names, PDF headings, typed text) is left alone.
import { DE, DE_PATTERNS } from "./i18n-de";

export type Lang = "en" | "de";
export type LangSetting = "auto" | Lang;

const KEY = "papgi.lang";

export function langSetting(): LangSetting {
  try {
    const v = localStorage.getItem(KEY);
    return v === "en" || v === "de" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function setLangSetting(v: LangSetting): void {
  try {
    if (v === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, v);
  } catch {
    /* private mode */
  }
}

function detect(): Lang {
  const s = langSetting();
  if (s !== "auto") return s;
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  for (const l of prefs) {
    if (/^de\b/i.test(l)) return "de";
    if (/^en\b/i.test(l)) return "en";
  }
  return "en";
}

export const lang: Lang = detect();

const ATTRS = ["title", "placeholder", "aria-label", "alt"] as const;
/** Texts already in German (so a translation isn't looked up again). */
const done = new Set<string>();
/** English texts with no translation (for the tests). */
export const missing = new Set<string>();
/** Every text seen (English, when collecting for the dictionary). */
export const seen = new Set<string>();
const collect = !!(globalThis as { __papgiCollect?: boolean }).__papgiCollect;

const SHORTCUT = /^(.*?)\s+\(((?:Ctrl|Shift|Alt|Del|Esc|Enter|Tab|⇧|[A-Z0-9])[^()]*)\)$/;

function keys(s: string): string {
  return s.replace(/\bCtrl\b/g, "Strg").replace(/\bDel\b/g, "Entf").replace(/\bShift\b/g, "Umschalt").replace(/\bEnter\b/g, "Eingabe");
}

/** The German for an English text (null: none known). */
export function translate(text: string): string | null {
  const d = DE[text];
  if (d !== undefined) return d;
  // "Copy (Ctrl+C)": the words, then the keys
  const sc = SHORTCUT.exec(text);
  if (sc) {
    const base = translate(sc[1]);
    if (base !== null) return `${base} (${keys(sc[2])})`;
  }
  for (const [re, fn] of DE_PATTERNS) {
    const m = re.exec(text);
    if (m) return typeof fn === "string" ? text.replace(re, fn) : fn(m, translate);
  }
  // "Ctrl O" and other key names alone
  if (/^(Ctrl|Shift|Del|Ctrl ⇧)\b[\w ⇧+]*$/.test(text)) return keys(text);
  return null;
}

/** For code: the text in the interface language. `{name}` parts are filled in afterwards. */
export function t(text: string, vars?: Record<string, string | number>): string {
  let out = text;
  if (lang === "de") {
    const de = translate(text);
    if (de === null) {
      missing.add(text);
      (globalThis as { __papgiMissingOut?: (s: string) => void }).__papgiMissingOut?.(text);
    } else out = de;
  }
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  // (already in the interface language: not looked up again when shown)
  if (lang === "de") done.add(out.trim());
  return out;
}

/** Whether a text needs no translation: numbers, sizes, symbols, single letters, keys. */
function plain(s: string): boolean {
  return !/[A-Za-z]{2,}/.test(s) || /^#[0-9a-f]{3,8}$/i.test(s) || /^[\d.,]+ (B|KB|MB|GB) → [\d.,]+ (B|KB|MB|GB)$/.test(s) || /^[\d\s.,:%×x\-–/()+#]*(pt|px|mm|cm|dpi|KB|MB|GB|%)?[\d\s.,:%×x\-–/()+]*$/.test(s) || /^papgi$/i.test(s);
}

function swap(s: string): string | null {
  const core = s.trim();
  if (!core || plain(core) || done.has(core)) return null;
  if (collect && !seen.has(core)) {
    seen.add(core);
    (globalThis as { __papgiSeenOut?: (s: string) => void }).__papgiSeenOut?.(core);
  }
  if (lang !== "de") return null;
  const de = translate(core);
  if (de === null) {
    if (!missing.has(core)) {
      missing.add(core);
      (globalThis as { __papgiMissingOut?: (s: string) => void }).__papgiMissingOut?.(core);
    }
    return null;
  }
  done.add(de);
  return de === core ? null : s.replace(core, de);
}

function skip(el: Element | null): boolean {
  return !!el?.closest('[translate="no"], .page-canvas, .text-editor, .para-editor, script, style, textarea');
}

function doText(n: Text): void {
  if (skip(n.parentElement) || n.parentElement?.closest("svg")) return;
  const v = swap(n.data);
  if (v !== null) n.data = v;
}

function doElement(el: Element): void {
  if (skip(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v) continue;
    const de = swap(v);
    if (de !== null) el.setAttribute(a, de);
  }
}

function walk(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const el = root as Element;
  if (skip(el) || el.tagName === "svg" || el.tagName === "CANVAS") return;
  doElement(el);
  const tw = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && ((n as Element).tagName === "svg" || (n as Element).tagName === "CANVAS" || (n as Element).getAttribute("translate") === "no") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) doText(n as Text);
    else doElement(n as Element);
  }
}

/** Translate the page now and whatever is shown later. */
export function startTranslating(): void {
  document.documentElement.lang = lang;
  if (lang !== "de" && !collect) return;
  walk(document.body);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "childList") m.addedNodes.forEach(walk);
      else if (m.type === "characterData") doText(m.target as Text);
      else if (m.type === "attributes") doElement(m.target as Element);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
}
