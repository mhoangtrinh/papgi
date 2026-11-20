import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as mupdf from "mupdf";
import { pdfToWord, wordFont } from "../src/engine/toword";
import { buildDocx, xmlText } from "../src/core/docx";

const read = (p: string) => new Uint8Array(fs.readFileSync(new URL(p, import.meta.url)));
const sample = (n: string) => read(`../public/samples/${n}`);

/** Files in a stored (uncompressed) zip, as papgi writes them. */
function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0;
  while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const size = dv.getUint32(p + 18, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extra = dv.getUint16(p + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extra;
    out.set(name, bytes.subarray(start, start + size));
    p = start + size;
  }
  return out;
}
const docXml = (bytes: Uint8Array) => new TextDecoder().decode(unzip(bytes).get("word/document.xml"));
const plain = (xml: string) => [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<\/w:p>/g)].map((m) => (m[0] === "<w:tab/>" ? "\t" : m[0] === "</w:p>" ? "\n" : m[1])).join("");
const all = (n: number) => [...Array(n).keys()];

describe("docx writer", () => {
  it("writes a package Word can open", () => {
    const bytes = buildDocx([{ width: 595, height: 842, margins: { top: 72, right: 72, bottom: 72, left: 72 }, blocks: [{ kind: "p", runs: [{ text: "Hi & <bye>\tx", bold: true }] }] }], { title: "T" });
    const files = unzip(bytes);
    expect([...files.keys()]).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"]));
    const xml = docXml(bytes);
    expect(xml).toContain("Hi &amp; &lt;bye&gt;</w:t><w:tab/>");
    expect(xml).toContain('<w:pgSz w:w="11900" w:h="16840"/>');
  });
  it("drops characters XML can't hold", () => {
    expect(xmlText("a\u0001b￿c")).toBe("abc");
  });
});

describe("PDF fonts -> Word fonts", () => {
  it("maps common and TeX fonts", () => {
    expect(wordFont("ABCDEF+LMRoman10-Bold")).toEqual({ family: "Times New Roman", bold: true, italic: false });
    expect(wordFont("TimesNewRomanPS-ItalicMT")).toMatchObject({ family: "Times New Roman", italic: true });
    expect(wordFont("ArialMT").family).toBe("Arial");
    expect(wordFont("BAAAAA+Carlito-Bold")).toMatchObject({ family: "Calibri", bold: true });
    expect(wordFont("Helvetica-Oblique")).toMatchObject({ family: "Arial", italic: true });
    expect(wordFont("XYZABC+MinionPro-Semibold")).toMatchObject({ family: "Minion Pro", bold: true });
    expect(wordFont("OpenSymbol").family).toBe("");
  });
});

describe("PDF to Word", () => {
  it("pictures: one page-sized picture per page, turns respected", () => {
    const r = pdfToWord(mupdf, { name: "pages.pdf", bytes: sample("pages.pdf") }, [0, 2], { mode: "pictures", dpi: 72 }, [0, 90]);
    const files = unzip(r.bytes);
    expect([...files.keys()].filter((n) => n.startsWith("word/media/")).length).toBe(2);
    const xml = docXml(r.bytes);
    expect(xml.match(/<w:pgSz [^>]*\/>/g)).toEqual(['<w:pgSz w:w="11906" w:h="16838"/>', '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>']);
    expect(xml).toContain("<wp:anchor");
  });

  it("editable: a two-column paper", () => {
    const r = pdfToWord(mupdf, { name: "paper.pdf", bytes: sample("paper.pdf") }, [0], { mode: "editable" });
    const xml = docXml(r.bytes);
    const text = plain(xml);
    expect(r.scanned).toEqual([]);
    // words split over lines come back together; compound words keep their hyphen
    expect(text).toContain("because the heat dissipated");
    expect(text).toContain("analog-to-digital converter");
    // columns, headings, the formula as a picture, the table as tab stops
    expect(xml).toMatch(/<w:cols w:num="2"/);
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>.*?Introduction/);
    expect(xml).toContain('<w:br w:type="column"/>');
    expect(text).toMatch(/Supply \(V\)\t1\.2\t1\.8\t1\.0/);
    expect(text).not.toContain("R2");
    expect([...unzip(r.bytes).keys()].some((n) => n.startsWith("word/media/"))).toBe(true);
    // subscript and font
    expect(xml).toMatch(/<w:vertAlign w:val="subscript"\/><\/w:rPr><w:t xml:space="preserve">T<\/w:t><\/w:r><w:r>.*?<w:t xml:space="preserve"> = <\/w:t>/);
    expect(text).toMatch(/Area \(mm2\)\t0\.031\t0\.08\t0\.045/);
    // reference entries: hanging indent, one paragraph each; author lines aren't headings
    expect(text).toContain("[2]\tB. Author, “Curvature compensation revisited,” TCAS-I, 2022.");
    const para = (t: string) => xml.split("</w:p>").find((p) => p.includes(t)) ?? "";
    expect(para("November 2026")).not.toContain("Heading");
    expect(para("Introduction")).toContain('<w:pStyle w:val="Heading');
    expect(xml).toContain('w:ascii="Times New Roman"');
  });

  it("editable: bullets, bold, colours, tables as tabs, lines behind the text", () => {
    const r = pdfToWord(mupdf, { name: "report.pdf", bytes: sample("report.pdf") }, [0], { mode: "editable" });
    const xml = docXml(r.bytes);
    const text = plain(xml);
    expect(text).toContain("•\tFirst bullet item with some text");
    expect(xml).toMatch(/<w:ind w:left="\d+" w:hanging="\d+"\/>/);
    expect(text).toMatch(/Cell 00\tCell 01\tCell 02/);
    expect(xml).toMatch(/<w:b\/><w:bCs\/>.*?measurement campaign/);
    expect(xml).toMatch(/<w:color w:val="[0-9A-F]{6}"\/>/);
    // the table's lines: a see-through picture placed on the page, behind the text
    expect(xml).toMatch(/behindDoc="1"/);
    expect(text).toContain("results are preliminary and will be checked");
  });

  it("editable: accents (Vietnamese) and German come out whole", () => {
    const r = pdfToWord(mupdf, { name: "bericht.pdf", bytes: read("./fixtures/bericht.pdf") }, [0], { mode: "editable" });
    const text = plain(docXml(r.bytes));
    expect(text).toContain("Tiếng Việt: Kết quả đo được kiểm tra lại trước buổi họp cuối cùng.");
    expect(text).toContain("Größe der");
    expect(text).toMatch(/Probe\tRauschen \(dB\)\tLeistung \(mW\)/);
    expect(text).toMatch(/2\.\tZweiter Punkt, der etwas länger ist und deshalb in die nächste Zeile umbricht, damit man den hängenden Einzug sieht\n3\.\tDritter Punkt/);
  });

  it("editable: a scan without text comes out as a picture and is reported", () => {
    const r = pdfToWord(mupdf, { name: "scan.pdf", bytes: sample("scan.pdf") }, [0], { mode: "editable" });
    expect(r.scanned).toEqual([0]);
    expect(docXml(r.bytes)).toContain("<wp:anchor");
  });

  it("all pages of a few files without errors", () => {
    for (const n of ["pages.pdf", "form.pdf"]) {
      const bytes = sample(n);
      const count = mupdf.Document.openDocument(bytes, "application/pdf").countPages();
      const r = pdfToWord(mupdf, { name: n, bytes }, all(count), { mode: "editable" });
      expect(docXml(r.bytes).match(/<w:sectPr>/g)!.length).toBeGreaterThanOrEqual(count);
    }
  });
});
