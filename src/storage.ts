// Settings in localStorage. Defaults are merged in, so older saved data never breaks newer versions.
import type { Point } from "./core/geometry";

export type Theme = "auto" | "light" | "dark";
export type Tool = "select" | "highlight" | "pen" | "text" | "shape" | "sign";
export type MarkKind = "Highlight" | "Underline" | "StrikeOut";
export type ShapeKind = "Square" | "Circle" | "Arrow";

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
  signature: Point[][] | null;
  signatureWidth: number;
}

const KEY = "papgi.settings.v1";
const OLD_KEYS = ["pdf-studio.settings.v1"]; // the app's earlier name

export const DEFAULTS: Settings = {
  theme: "auto",
  tool: "select",
  colors: {
    select: "#ffd400",
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
  signature: null,
  signatureWidth: 150,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY) ?? OLD_KEYS.map((k) => localStorage.getItem(k)).find((v) => v !== null) ?? null;
    if (!raw) return structuredClone(DEFAULTS);
    const saved = JSON.parse(raw) as Partial<Settings>;
    return { ...structuredClone(DEFAULTS), ...saved, colors: { ...DEFAULTS.colors, ...(saved.colors ?? {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
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
