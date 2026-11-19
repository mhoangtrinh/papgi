import { describe, it, expect, beforeAll } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { createWorker } from "tesseract.js";
import { PdfEngine } from "../src/engine/engine";
import { wordsToPage, keepWord, ocrScale, type TessBlock } from "../src/core/ocrwords";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const fontFile = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/fonts/${name}`, import.meta.url)));
const langDir = (l: string) => new URL(`../node_modules/@tesseract.js-data/${l}/4.0.0_best_int`, import.meta.url).pathname;

describe("ocr word mapping", () => {
  it("drops specks and keeps words", () => {
    expect(keepWord({ text: "~~", confidence: 20, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } })).toBe(false);
    expect(keepWord({ text: "Bandgap", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } })).toBe(true);
    expect(keepWord({ text: "—", confidence: 80, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } })).toBe(true);
  });
  it("maps pixels to page points along the baseline", () => {
    const blocks: TessBlock[] = [
      { paragraphs: [{ lines: [{ bbox: { x0: 100, y0: 100, x1: 500, y1: 140 }, baseline: { x0: 100, y0: 130, x1: 500, y1: 134 }, words: [
        { text: "Hello", confidence: 95, bbox: { x0: 100, y0: 100, x1: 250, y1: 132 } },
        { text: "world", confidence: 95, bbox: { x0: 270, y0: 102, x1: 500, y1: 134 } },
      ] }] }] },
    ];
    const w = wordsToPage(blocks, 2, 0, 0);
    expect(w.map((x) => x.text)).toEqual(["Hello", "world"]);
    expect(w[0].bbox).toEqual([50, 50, 125, 66]);
    expect(w[0].slope).toBeCloseTo(0.01);
    // both sit on one line at the page's slope, through the bottoms of the words
    expect(w[1].baseline - w[0].baseline).toBeCloseTo(((270 - 100) * 0.01) / 2, 2); // (at each word's left edge)
    expect(w[1].baseline).toBeCloseTo(66.475, 2);
    expect(w[1].join).toBe(true);
    // "Hello" spans cap height to baseline: about 0.7 em; both words share the line's size
    expect(w[0].size).toBeCloseTo(32 / 0.7 / 2, 1);
    expect(w[1].size).toBe(w[0].size);
  });
  it("cuts a line that runs across two columns", () => {
    const word = (text: string, x0: number, x1: number) => ({ text, confidence: 95, bbox: { x0, y0: 100, x1, y1: 128 } });
    const blocks: TessBlock[] = [
      { paragraphs: [{ lines: [{ bbox: { x0: 0, y0: 100, x1: 900, y1: 130 }, baseline: { x0: 0, y0: 128, x1: 900, y1: 128 }, words: [
        word("Left", 0, 80), word("the", 95, 140), word("Right", 200, 290), word("side", 305, 380),
      ] }] }] },
    ];
    const w = wordsToPage(blocks, 1, 0, 0);
    expect(w).toHaveLength(4);
    // nothing nearby to compare with: a gap of more than 0.8 em ends the piece
    expect(w.map((x) => !!x.join)).toEqual([false, true, false, true]);
  });
  it("renders at ~300 dpi but caps big pages", () => {
    expect(ocrScale(612, 792)).toBeCloseTo(300 / 72);
    expect(ocrScale(2000, 3000)).toBeCloseTo(3500 / 3000);
  });
});

describe("recognised text in other scripts", () => {
  it("reads a Vietnamese scan with the Vietnamese language data", async () => {
    // a page of Vietnamese text, rendered to an image like a scanner would
    const doc = new mupdf.PDFDocument();
    const font = new mupdf.Font("LiberationSerif", fontFile("LiberationSerif-Regular.ttf"));
    const res = doc.newDictionary();
    const fd = doc.newDictionary();
    fd.put("F", doc.addFont(font));
    res.put("Font", fd);
    const line = (t: string, y: number) =>
      `BT /F 14 Tf 1 0 0 1 60 ${y} Tm <${[...t].map((c) => font.encodeCharacter(c.codePointAt(0)!).toString(16).padStart(4, "0")).join("")}> Tj ET`;
    doc.insertPage(-1, doc.addPage([0, 0, 420, 200], 0, res, [line("Tiếng Việt có dấu thanh rất đẹp.", 140), line("Người đọc văn bản này bằng máy.", 110)].join("\n")));
    const png = Buffer.from(doc.loadPage(0).toPixmap(mupdf.Matrix.scale(300 / 72, 300 / 72), mupdf.ColorSpace.DeviceRGB, false).asPNG());
    fs.mkdirSync("/tmp/tlang", { recursive: true });
    fs.copyFileSync(`${langDir("vie")}/vie.traineddata.gz`, "/tmp/tlang/vie.traineddata.gz");
    const worker = await createWorker(["vie"], 1, { langPath: "/tmp/tlang", cachePath: "/tmp/tcache", gzip: true });
    const r = await worker.recognize(png, {}, { blocks: true });
    await worker.terminate();
    const words = wordsToPage((r.data.blocks ?? []) as unknown as TessBlock[], 300 / 72, 0, 0);
    const text = words.map((w) => w.text).join(" ");
    expect(text).toContain("Tiếng Việt");
    expect(text).toContain("Người đọc");
  }, 120000);

  it("keeps Vietnamese, Polish and Cyrillic letters searchable", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("scan.pdf"));
    e.registerFont(e.ocrFontFile, fontFile(e.ocrFontFile));
    const texts = ["Tiếng", "Việt", "đường", "Łódź", "Привет"];
    const words = texts.map((text, i) => ({ text, bbox: [60 + i * 70, 760, 120 + i * 70, 772] as [number, number, number, number], baseline: 770, size: 11, slope: 0, join: i > 0 }));
    e.addOcrText(0, words);
    const t = e.pageText(0);
    for (const w of texts) expect(t).toContain(w);
    expect(e.search("đường").length).toBe(1);
  });
});

describe("recognise a scan, then select and edit it", () => {
  let e: PdfEngine;
  beforeAll(async () => {
    e = new PdfEngine(mupdf);
    e.open(sample("scan.pdf"));
    expect(e.pageHasText(0)).toBe(false);
    const info = e.pageInfo(0);
    const scale = ocrScale(info.w, info.h);
    const img = e.render(0, scale);
    // tesseract in Node takes an encoded image
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, img.width, img.height], true);
    pix.getPixels().set(img.data);
    const png = Buffer.from(pix.asPNG());
    fs.mkdirSync("/tmp/tlang", { recursive: true });
    fs.copyFileSync(`${langDir("deu")}/deu.traineddata.gz`, "/tmp/tlang/deu.traineddata.gz");
    fs.copyFileSync(`${langDir("eng")}/eng.traineddata.gz`, "/tmp/tlang/eng.traineddata.gz");
    const worker = await createWorker(["deu", "eng"], 1, { langPath: "/tmp/tlang", cachePath: "/tmp/tcache", gzip: true });
    const r = await worker.recognize(png, {}, { blocks: true });
    await worker.terminate();
    const words = wordsToPage((r.data.blocks ?? []) as unknown as TessBlock[], scale, info.x, info.y);
    e.registerFont(e.ocrFontFile, fontFile(e.ocrFontFile));
    expect(e.addOcrText(0, words)).toBeGreaterThan(100);
  }, 120000);

  it("makes the scan searchable and selectable", () => {
    expect(e.isRecognized(0)).toBe(true);
    const t = e.pageText(0).replace(/\s+/g, " ");
    expect(t).toContain("Bandgap Reference");
    expect(t).toContain("Voltage references are a fundamental");
    const hit = e.search("Voltage references")[0];
    expect(hit).toBeTruthy();
    // the invisible words sit on top of the printed ones: the hit is inside the left column
    expect(hit.quads[0][0]).toBeGreaterThan(40);
    expect(hit.quads[0][2]).toBeLessThan(320);
  });

  it("edits a recognised paragraph: old words painted over in paper colour, new text in the ink colour", () => {
    const b = e.textBlocks(0).find((x) => x.runs.map((r) => r.text).join("").startsWith("Voltage references"))!;
    expect(b.ocr).toBe(true);
    expect(b.editable).toBe(true);
    expect(b.runs.map((r) => r.text).join("")).toContain("block of every mixed-signal"); // hyphenation undone
    const runs = [{ text: "This paragraph was recognised from a scan and then edited in papgi.", style: b.runs[0].style }];
    for (const f of e.fontsForEdit(0, b.id, runs)) e.registerFont(f, fontFile(f));
    const { result } = e.replaceText(0, b.id, runs);
    expect(result.lines).toBeGreaterThan(1);
    const t = e.pageText(0).replace(/\s+/g, " ");
    expect(t).toContain("recognised from a scan and then edited in papgi.");
    expect(t).not.toContain("fundamental building block");
    // the old printed words are gone from view: the area of the old 5th line is now plain paper
    const img = e.render(0, 1);
    const y = Math.round(b.lines[Math.min(3, b.lines.length - 1)].baseline - 3);
    expect(b.lines.length).toBeGreaterThan(8); // the whole recognised paragraph is one block
    expect(b.align).toBe("justify");
    expect(b.warn).toBeUndefined(); // the skewed baseline isn't mistaken for superscripts
    let dark = 0;
    for (let x = Math.round(b.left + 5); x < Math.round(b.left + b.width - 5); x++) {
      const i = (y * img.width + x) * 4;
      if (img.data[i] < 120) dark++;
    }
    expect(dark).toBeLessThan(4);
  });

  it("undo takes the recognised text away again", () => {
    e.undo();
    e.undo();
    expect(e.pageHasText(0)).toBe(false);
  });
});
