import { describe, it, expect } from "vitest";
import { layoutParagraph, tokenize, normalizeRuns, type Run } from "../src/core/textlayout";
import { substituteFor, cleanFontName } from "../src/core/fontmatch";

// monospace-ish measure: style 0 = 1 unit per char, style 1 (bold) = 1.5 units
const measure = (style: number, text: string) => [...text].length * (style === 1 ? 1.5 : 1);
const lineText = (l: { pieces: { text: string }[] }) => l.pieces.map((p) => p.text).join(" ");

describe("text layout", () => {
  it("wraps words greedily", () => {
    const lines = layoutParagraph([{ text: "aaa bbb ccc ddd", style: 0 }], { width: 7, align: "left", measure });
    expect(lines.map(lineText)).toEqual(["aaa bbb", "ccc ddd"]);
    expect(lines.map((l) => l.last)).toEqual([false, true]);
    expect(lines[0].pieces.map((p) => p.x)).toEqual([0, 4]);
  });

  it("justifies all but the last line", () => {
    const lines = layoutParagraph([{ text: "aa bb cc dd ee", style: 0 }], { width: 9, align: "justify", measure });
    expect(lines.map(lineText)).toEqual(["aa bb cc", "dd ee"]);
    // 3 words, natural width 8, 2 gaps -> 0.5 extra each; last word ends exactly at 9
    const l0 = lines[0].pieces;
    expect(l0[2].x + 2).toBeCloseTo(9);
    // last line is not stretched
    expect(lines[1].pieces.map((p) => p.x)).toEqual([0, 3]);
  });

  it("centres and right-aligns", () => {
    const c = layoutParagraph([{ text: "ab", style: 0 }], { width: 10, align: "center", measure });
    expect(c[0].pieces[0].x).toBe(4);
    const r = layoutParagraph([{ text: "ab", style: 0 }], { width: 10, align: "right", measure });
    expect(r[0].pieces[0].x).toBe(8);
  });

  it("keeps styles inside words and across runs", () => {
    const runs: Run[] = [
      { text: "plain bo", style: 0 },
      { text: "ld", style: 1 },
      { text: " end", style: 0 },
    ];
    const lines = layoutParagraph(runs, { width: 100, align: "left", measure });
    const p = lines[0].pieces;
    expect(p.map((x) => [x.text, x.style])).toEqual([["plain", 0], ["bo", 0], ["ld", 1], ["end", 0]]);
    expect(p[2].x).toBe(p[1].x + 2); // "ld" right after "bo"
    expect(p[3].x).toBe(p[2].x + 3 + 1); // bold "ld" is 3 wide, then a space
  });

  it("honours hard line breaks and blank lines", () => {
    const lines = layoutParagraph([{ text: "one\ntwo\n\nthree", style: 0 }], { width: 100, align: "justify", measure });
    expect(lines.map(lineText)).toEqual(["one", "two", "", "three"]);
    expect(lines.every((l) => l.last)).toBe(true);
  });

  it("breaks a word that is longer than the line", () => {
    const lines = layoutParagraph([{ text: "abcdefghij x", style: 0 }], { width: 4, align: "left", measure });
    expect(lines.map(lineText)).toEqual(["abcd", "efgh", "ij x"]);
  });

  it("collapses repeated spaces and handles empty text", () => {
    expect(layoutParagraph([{ text: "a    b", style: 0 }], { width: 100, align: "left", measure })[0].pieces.map((p) => p.x)).toEqual([0, 2]);
    expect(layoutParagraph([], { width: 10, align: "left", measure })).toHaveLength(1);
  });

  it("tokenizes and normalizes", () => {
    expect(tokenize([{ text: "a b", style: 0 }]).map((t) => t.kind)).toEqual(["word", "space", "word"]);
    expect(normalizeRuns([{ text: "a", style: 0 }, { text: "", style: 1 }, { text: "b", style: 0 }])).toEqual([{ text: "ab", style: 0 }]);
  });
});

describe("font matching", () => {
  const t = (name: string, extra: Partial<{ bold: boolean; italic: boolean; serif: boolean; mono: boolean }> = {}) =>
    substituteFor({ name, bold: false, italic: false, serif: true, mono: false, ...extra }).file;
  it("maps TeX fonts to Latin Modern", () => {
    expect(t("ZJRMJD+LMRoman10-Regular")).toBe("lmroman10-regular.otf");
    expect(t("MVTXZL+LMRoman12-Bold")).toBe("lmroman10-bold.otf");
    expect(t("GJRRCY+LMRoman10-Italic")).toBe("lmroman10-italic.otf");
    expect(t("CMBX10")).toBe("lmroman10-bold.otf");
    expect(t("CMTI10")).toBe("lmroman10-italic.otf");
    expect(t("CMSS10")).toBe("lmsans10-regular.otf");
    expect(t("CMTT10")).toBe("lmmono10-regular.otf");
    expect(t("KBABFZ+LMMathItalic10-Regular")).toBe("lmroman10-italic.otf");
  });
  it("maps Office and common fonts to metric-compatible ones", () => {
    expect(t("ABCDEF+Calibri-Bold")).toBe("Carlito-Bold.ttf");
    expect(t("Cambria-Italic")).toBe("Caladea-Italic.ttf");
    expect(t("ArialMT", { serif: false })).toBe("LiberationSans-Regular.ttf");
    expect(t("Arial-BoldMT", { serif: false })).toBe("LiberationSans-Bold.ttf");
    expect(t("Helvetica-Oblique", { serif: false })).toBe("LiberationSans-Italic.ttf");
    expect(t("TimesNewRomanPS-BoldItalicMT")).toBe("LiberationSerif-BoldItalic.ttf");
    expect(t("CourierNewPSMT", { mono: true })).toBe("LiberationMono-Regular.ttf");
    expect(t("SomeUnknownSans", { serif: false })).toBe("LiberationSans-Regular.ttf");
    expect(t("Georgia")).toBe("LiberationSerif-Regular.ttf");
  });
  it("cleans subset tags", () => {
    expect(cleanFontName("ABCDEF+Foo-Bar")).toBe("Foo-Bar");
    expect(cleanFontName("Foo")).toBe("Foo");
  });
});

describe("hyphen breaks", () => {
  it("can break after a hyphen inside a word, without adding a space", () => {
    const lines = layoutParagraph([{ text: "aa full-scale bb", style: 0 }], { width: 8, align: "left", measure });
    expect(lines.map((l) => l.pieces.map((p) => p.text).join("|"))).toEqual(["aa|full-", "scale|bb"]);
    // when it fits, the pieces sit right next to each other
    const one = layoutParagraph([{ text: "full-scale", style: 0 }], { width: 100, align: "justify", measure })[0].pieces;
    expect(one[1].x).toBe(5);
  });
  it("does not stretch hyphen joins when justifying", () => {
    const l = layoutParagraph([{ text: "a full-scale b c d e f g h", style: 0 }], { width: 16, align: "justify", measure })[0];
    const scale = l.pieces.find((p) => p.text === "scale")!;
    const full = l.pieces.find((p) => p.text === "full-")!;
    expect(scale.x).toBeCloseTo(full.x + 5);
  });
});
