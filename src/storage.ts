// Settings in localStorage. Defaults are merged in, so older saved data never breaks newer versions.
import type { Point } from "./core/geometry";
import { cleanOcrLangs, DEFAULT_OCR_LANGS } from "./core/ocrlangs";
import { SHAPE_KINDS, isLineKind, type LineStyle, type ShapeKind, type ShapeStyle } from "./core/shapes";
export type { ShapeKind, LineStyle } from "./core/shapes";

export type Theme = "auto" | "light" | "dark";
export type Tool = "select" | "area" | "edit" | "highlight" | "pen" | "text" | "shape" | "sign" | "eraser" | "note" | "form";
export type MarkKind = "Highlight" | "Underline" | "StrikeOut";

/** A signature made from a picture: transparent PNG as a data URL, with its pixel size. */
export interface SignatureImage {
  src: string;
  w: number;
  h: number;
}

/** One saved signature: drawn strokes or a picture. */
export type SavedSignature =
  | { id: string; kind: "drawn"; strokes: Point[][] }
  | { id: string; kind: "image"; image: SignatureImage };

export const MAX_SIGNATURES = 5;

export interface Settings {
  theme: Theme;
  tool: Tool;
  colors: Record<Tool, string>;
  penWidth: number;
  shapeWidth: number;
  textSize: number;
  markKind: MarkKind;
  shapeKind: ShapeKind;
  /** Shape fill colour (hex), or null for none. */
  shapeFill: string | null;
  /** Draw the shape's outline (off: fill only). */
  shapeOutline: boolean;
  shapeLine: LineStyle;
  /** 0.1 .. 1 */
  shapeOpacity: number;
  sidebar: boolean;
  /** Pages panel width set by hand (px; 0 = default). */
  sidebarWidth: number;
  /** Page size in the pages panel (px; 0 = default). */
  sidebarZoom: number;
  signatures: SavedSignature[];
  activeSignature: string | null;
  signatureWidth: number;
  /** Languages for text recognition (Tesseract codes). */
  ocrLangs: string[];
  /** Write edited recognised text in a serif font. */
  ocrSerif: boolean;
  /** Eraser size (diameter, points). */
  eraserSize: number;
  /** The eraser also erases what's printed on the page (not just added items). */
  eraserAll: boolean;
  /** The sidebar shows the table of contents instead of the pages. */
  sideToc: boolean;
  /** The kind of field the Form tool adds. */
  fieldKind: FieldKind;
}

export const FIELD_KINDS = ["text", "multiline", "checkbox", "radio", "combobox", "date", "signature"] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

const KEY = "papgi.settings.v1";
const OLD_KEYS = ["pdf-studio.settings.v1"]; // the app's earlier name

export const DEFAULTS: Settings = {
  theme: "auto",
  tool: "select",
  colors: {
    select: "#ffd400",
    area: "#2f6fed",
    edit: "#1c1c1c",
    highlight: "#ffd400",
    pen: "#2f6fed",
    text: "#1c1c1c",
    shape: "#e5484d",
    sign: "#1a3a8f",
    eraser: "#1c1c1c",
    note: "#ffd400",
    form: "#2f6fed",
  },
  penWidth: 2,
  shapeWidth: 2,
  textSize: 12,
  markKind: "Highlight",
  shapeKind: "Square",
  shapeFill: null,
  shapeOutline: true,
  shapeLine: "solid",
  shapeOpacity: 1,
  sidebar: true,
  sidebarWidth: 0,
  sidebarZoom: 0,
  signatures: [],
  activeSignature: null,
  signatureWidth: 150,
  ocrLangs: [...DEFAULT_OCR_LANGS],
  ocrSerif: false,
  eraserSize: 16,
  eraserAll: false,
  sideToc: false,
  fieldKind: "text",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? OLD_KEYS.map((k) => localStorage.getItem(k)).find((v) => v !== null) ?? null;
    return mergeSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return structuredClone(DEFAULTS);
  }
}

/** Defaults + saved values, upgrading older formats (single drawn/picture signature). */
export function mergeSettings(saved: Record<string, unknown> | null): Settings {
  const out: Settings = structuredClone(DEFAULTS);
  if (!saved || typeof saved !== "object") return out;
  const { signature, signatureImage, signatureKind, ...rest } = saved as Record<string, unknown>;
  Object.assign(out, rest);
  out.colors = { ...DEFAULTS.colors, ...((saved.colors as Settings["colors"]) ?? {}) };
  if (!Array.isArray(out.signatures)) out.signatures = [];
  out.signatures = out.signatures.filter(isSignature).slice(0, MAX_SIGNATURES);
  // version 1 kept one drawn and one picture signature
  if (Array.isArray(signature) && signature.length && out.signatures.length < MAX_SIGNATURES)
    out.signatures.push({ id: "drawn-1", kind: "drawn", strokes: signature as Point[][] });
  if (isImage(signatureImage) && out.signatures.length < MAX_SIGNATURES)
    out.signatures.push({ id: "image-1", kind: "image", image: signatureImage });
  if (signature !== undefined || signatureImage !== undefined)
    out.activeSignature = out.signatures.find((x) => x.kind === signatureKind)?.id ?? out.signatures[0]?.id ?? null;
  if (!out.signatures.some((x) => x.id === out.activeSignature)) out.activeSignature = out.signatures[0]?.id ?? null;
  out.ocrLangs = cleanOcrLangs(out.ocrLangs);
  out.ocrSerif = out.ocrSerif === true;
  out.eraserAll = out.eraserAll === true;
  if (!SHAPE_KINDS.includes(out.shapeKind)) out.shapeKind = DEFAULTS.shapeKind;
  if (!(typeof out.shapeFill === "string" && /^#[0-9a-f]{6}$/i.test(out.shapeFill))) out.shapeFill = null;
  out.shapeOutline = out.shapeOutline !== false;
  // (clouds used to be a line style; now they're a shape of their own)
  if ((out.shapeLine as string) === "cloudy") {
    out.shapeLine = "solid";
    if (out.shapeKind === "Square") out.shapeKind = "Cloud";
  }
  if (!["solid", "dashed", "dotted"].includes(out.shapeLine)) out.shapeLine = "solid";
  out.shapeOpacity = typeof out.shapeOpacity === "number" && out.shapeOpacity >= 0.1 && out.shapeOpacity <= 1 ? out.shapeOpacity : 1;
  out.sideToc = out.sideToc === true;
  if (!FIELD_KINDS.includes(out.fieldKind)) out.fieldKind = "text";
  out.eraserSize = typeof out.eraserSize === "number" && out.eraserSize >= 2 && out.eraserSize <= 80 ? out.eraserSize : DEFAULTS.eraserSize;
  out.sidebarZoom = typeof out.sidebarZoom === "number" && out.sidebarZoom > 0 && out.sidebarZoom < 4000 ? Math.round(out.sidebarZoom) : 0;
  out.sidebarWidth = typeof out.sidebarWidth === "number" && out.sidebarWidth > 0 && out.sidebarWidth < 4000 ? Math.round(out.sidebarWidth) : 0;
  return out;
}

function isImage(v: unknown): v is SignatureImage {
  const i = v as SignatureImage;
  return !!i && typeof i.src === "string" && i.w > 0 && i.h > 0;
}

function isSignature(v: unknown): v is SavedSignature {
  const s = v as SavedSignature;
  if (!s || typeof s.id !== "string") return false;
  return (s.kind === "drawn" && Array.isArray(s.strokes) && s.strokes.length > 0) || (s.kind === "image" && isImage(s.image));
}

export function newSignatureId(): string {
  return `sig-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: settings just won't persist */
  }
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** The style new shapes get. */
export function shapeStyle(s: Settings): ShapeStyle {
  const line = isLineKind(s.shapeKind);
  return {
    color: s.shapeOutline || line ? hexToRgb(s.colors.shape) : null,
    fill: s.shapeFill && !line ? hexToRgb(s.shapeFill) : null,
    width: s.shapeWidth,
    line: s.shapeLine,
    opacity: s.shapeOpacity,
  };
}

export function rgbToHex(c: number[]): string {
  if (c.length === 1) c = [c[0], c[0], c[0]];
  if (c.length === 4) c = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  if (c.length !== 3) return "#000000";
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}
