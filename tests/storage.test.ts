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
});
