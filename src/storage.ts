// Settings in localStorage. Defaults are merged in, so older saved data never breaks newer versions.
import type { Point } from "./core/geometry";

export type Theme = "auto" | "light" | "dark";
export type Tool = "select" | "edit" | "highlight" | "pen" | "text" | "shape" | "sign";
export type MarkKind = "Highlight" | "Underline" | "StrikeOut";
export type ShapeKind = "Square" | "Circle" | "Arrow";

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
  sidebar: boolean;
  signatures: SavedSignature[];
  activeSignature: string | null;
  signatureWidth: number;
}

const KEY = "papgi.settings.v1";
const OLD_KEYS = ["pdf-studio.settings.v1"]; // the app's earlier name

export const DEFAULTS: Settings = {
  theme: "auto",
  tool: "select",
  colors: {
    select: "#ffd400",
    edit: "#1c1c1c",
    highlight: "#ffd400",
    pen: "#2f6fed",
    text: "#1c1c1c",
    shape: "#e5484d",
    sign: "#1a3a8f",
  },
  penWidth: 2,
  shapeWidth: 2,
  textSize: 12,
  markKind: "Highlight",
  shapeKind: "Square",
  sidebar: true,
  signatures: [],
  activeSignature: null,
  signatureWidth: 150,
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

export function rgbToHex(c: number[]): string {
  if (c.length === 1) c = [c[0], c[0], c[0]];
  if (c.length === 4) c = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])];
  if (c.length !== 3) return "#000000";
  return "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}
