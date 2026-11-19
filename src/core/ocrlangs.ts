// Languages papgi can recognise. Their data ships with the app (public/ocr/lang) and is
// downloaded the first time a language is used, then kept for offline use.
// Only scripts the hidden text font (Carlito) covers: Latin, Greek and Cyrillic.

export interface OcrLang {
  code: string; // Tesseract language code
  name: string; // English name
  native: string;
}

export const OCR_LANGS: OcrLang[] = [
  { code: "eng", name: "English", native: "English" },
  { code: "deu", name: "German", native: "Deutsch" },
  { code: "vie", name: "Vietnamese", native: "Tiếng Việt" },
  { code: "fra", name: "French", native: "Français" },
  { code: "spa", name: "Spanish", native: "Español" },
  { code: "ita", name: "Italian", native: "Italiano" },
  { code: "por", name: "Portuguese", native: "Português" },
  { code: "nld", name: "Dutch", native: "Nederlands" },
  { code: "pol", name: "Polish", native: "Polski" },
  { code: "ces", name: "Czech", native: "Čeština" },
  { code: "hun", name: "Hungarian", native: "Magyar" },
  { code: "tur", name: "Turkish", native: "Türkçe" },
  { code: "rus", name: "Russian", native: "Русский" },
  { code: "ukr", name: "Ukrainian", native: "Українська" },
];

export const DEFAULT_OCR_LANGS = ["deu", "eng"];
/** More languages at once make recognition slower and less accurate. */
export const MAX_OCR_LANGS = 3;

/** Keep only known languages, at most MAX_OCR_LANGS, never none. */
export function cleanOcrLangs(v: unknown): string[] {
  const known = new Set(OCR_LANGS.map((l) => l.code));
  const list = Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && known.has(x)))] : [];
  return list.length ? list.slice(0, MAX_OCR_LANGS) : [...DEFAULT_OCR_LANGS];
}
