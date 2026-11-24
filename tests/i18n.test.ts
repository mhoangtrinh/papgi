import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { translate } from "../src/i18n";
import { DE } from "../src/i18n-de";

describe("German interface", () => {
  it("has a translation for every text the browser tests saw (fixtures/ui-strings.json)", () => {
    // (collected with COLLECT=1 npm run e2e; refresh the file when the interface changes)
    const all: string[] = JSON.parse(fs.readFileSync(new URL("./fixtures/ui-strings.json", import.meta.url), "utf8"));
    const plain = (s: string) => !/[A-Za-z]{2,}/.test(s) || /^#[0-9a-f]{3,8}$/i.test(s) || /→/.test(s);
    const missing = all.filter((s) => !plain(s) && translate(s) === null);
    expect(missing).toEqual([]);
  });

  it("fills in numbers and names", () => {
    expect(translate("3 pages")).toBe("3 Seiten");
    expect(translate("1 page")).toBe("1 Seite");
    expect(translate("Undo Add field (Ctrl+Z)")).toBe("Rückgängig: Feld hinzufügen (Strg+Z)");
    expect(translate("Copy (Ctrl+C)")).toBe("Kopieren (Strg+C)");
    expect(translate("Found in 1 place.")).toBe("An einer Stelle gefunden.");
    expect(translate("Couldn't open Antrag.pdf: it isn't a PDF, or it is too damaged to open.")).toBe("Antrag.pdf konnte nicht geöffnet werden: es ist kein PDF oder zu beschädigt zum Öffnen.");
    expect(translate("just now · 5 pages · 4 KB")).toBe("gerade eben · 5 Seiten · 4 KB");
    expect(translate("Copied drawing. Paste with Ctrl+V.")).toBe("Zeichnung kopiert. Einfügen mit Strg+V.");
    expect(translate("Make PDF from 2 pictures")).toBe("PDF aus 2 Bildern erstellen");
    expect(translate("Antrag Seite.pdf")).toBe("Antrag Seite.pdf");
  });

  it("translations keep the placeholders and keys of the English", () => {
    for (const [en, de] of Object.entries(DE)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(de), en).toBe(ph(en));
    }
  });
});
