import { describe, it, expect } from "vitest";
import { findCommands, type Command } from "../src/ui/commands";

const c = (id: string, label: string, words = "", where = "Tools"): Command => ({ id, label, icon: "x", where, words, run: () => {} });
const list = [
  c("ocr", "Recognize text (OCR)…", "ocr scan texterkennung", "Document menu"),
  c("compress", "Compress PDF", "smaller reduce size verkleinern", "All tools"),
  c("sign", "Sign", "signature unterschrift"),
  c("signdigital", "Sign digitally…", "certificate zertifikat digitale unterschrift", "Document menu"),
  c("theme", "Theme", "dark light design", "View"),
  c("spread", "Two pages side by side", "book doppelseite", "View"),
];
const ids = (q: string) => findCommands(list, q).map((x) => x.id);

describe("Find a function", () => {
  it("finds by name, other words, in German, without accents; best first", () => {
    expect(ids("ocr")[0]).toBe("ocr");
    expect(ids("smaller")).toEqual(["compress"]);
    expect(ids("unterschrift")).toEqual(["sign", "signdigital"]);
    expect(ids("unterschrift digital")).toEqual(["signdigital"]);
    expect(ids("TWO pages")).toEqual(["spread"]);
    expect(ids("Doppelseite")).toEqual(["spread"]);
    // "sign" is not hiding in "design"
    expect(ids("sign")).toEqual(["sign", "signdigital"]);
    expect(ids("nothing like this")).toEqual([]);
    expect(ids("")).toHaveLength(list.length);
  });
});
