import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { mergeSettings, DEFAULTS, MAX_SIGNATURES } from "../src/storage";

describe("settings", () => {
  it("falls back to defaults", () => {
    expect(mergeSettings(null)).toEqual(DEFAULTS);
    expect(mergeSettings({ penWidth: 4 }).penWidth).toBe(4);
    expect(mergeSettings({ colors: { pen: "#000000" } }).colors.text).toBe(DEFAULTS.colors.text);
  });

  it("upgrades the old single drawn + picture signature into the list", () => {
    const img = { src: "data:image/png;base64,AAAA", w: 10, h: 5 };
    const s = mergeSettings({ signature: [[[0, 0], [1, 1]]], signatureImage: img, signatureKind: "image" });
    expect(s.signatures.map((x) => x.kind)).toEqual(["drawn", "image"]);
    expect(s.signatures.find((x) => x.id === s.activeSignature)!.kind).toBe("image");
    expect("signature" in s).toBe(false);
    expect("signatureImage" in s).toBe(false);
  });

  it("drops broken entries, caps the list and fixes a dangling active id", () => {
    const good = (i: number) => ({ id: `s${i}`, kind: "drawn", strokes: [[[0, 0], [1, i]]] });
    const s = mergeSettings({
      signatures: [{ id: "bad", kind: "image", image: { src: 3 } }, ...Array.from({ length: 7 }, (_, i) => good(i))],
      activeSignature: "gone",
    });
    expect(s.signatures).toHaveLength(MAX_SIGNATURES);
    expect(s.activeSignature).toBe("s0");
  });

  it("keeps recognition languages valid", () => {
    expect(mergeSettings(null).ocrLangs).toEqual(["deu", "eng"]);
    expect(mergeSettings({ ocrLangs: ["vie", "xx", "vie", 3] }).ocrLangs).toEqual(["vie"]);
    expect(mergeSettings({ ocrLangs: [] }).ocrLangs).toEqual(["deu", "eng"]);
    expect(mergeSettings({ ocrLangs: ["eng", "deu", "vie", "fra"] }).ocrLangs).toHaveLength(3);
    expect(mergeSettings({ ocrSerif: "yes" }).ocrSerif).toBe(false);
  });

  it("ships data for every language it offers", async () => {
    const { OCR_LANGS } = await import("../src/core/ocrlangs");
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const l of OCR_LANGS) expect(pkg.devDependencies[`@tesseract.js-data/${l.code}`], l.code).toBeTruthy();
  });
});
