// The stand-alone tools: merge, split, images -> PDF, PDF -> images, compress, plus zip/exif/ranges.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import sharp from "sharp";
import * as mupdf from "mupdf";
import { PdfEngine } from "../src/engine/engine";
import { orientationMatrix, PasswordError } from "../src/engine/tools";
import { jpegOrientation } from "../src/core/exif";
import { crc32, uniqueNames, zip } from "../src/core/zip";
import { everyN, parseGroups } from "../src/core/pages";

const sample = (n: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${n}`, import.meta.url)));
const pdf = (name: string) => ({ name, bytes: sample(name) });
const open = (bytes: Uint8Array) => {
  const e = new PdfEngine(mupdf);
  e.open(bytes);
  return e;
};
const engine = new PdfEngine(mupdf);

describe("merge", () => {
  it("joins files in order, keeping annotations and fillable fields", () => {
    // a copy of pages.pdf with a text box on page 2
    const a = open(sample("pages.pdf"));
    a.addFreeText(1, [100, 100], "Note on page 2", 12, [0, 0, 0]);
    const withNote = a.save(false);
    const out = engine.toolMerge([{ name: "a.pdf", bytes: withNote }, pdf("form.pdf"), { ...pdf("paper.pdf"), pages: [0] }]);
    const m = open(out);
    const n = engine.toolPageCount({ name: "a", bytes: withNote }) + engine.toolPageCount(pdf("form.pdf")) + 1;
    expect(m.info().pageCount).toBe(n);
    expect(m.listAnnots(1).some((x) => x.kind === "FreeText")).toBe(true);
    const formPage = engine.toolPageCount({ name: "a", bytes: withNote });
    const fields = m.listWidgets(formPage);
    expect(fields.length).toBeGreaterThan(2);
    // still fillable
    const text = fields.find((f) => f.kind === "text" && !f.readOnly)!;
    m.setFieldText(formPage, text.index, "Hoang");
    expect(m.listWidgets(formPage).find((f) => f.index === text.index)!.value).toBe("Hoang");
    expect(m.pageText(n - 1)).toContain(open(sample("paper.pdf")).pageText(0).slice(0, 30));
  });

  it("says which file is not a PDF or needs a password", () => {
    expect(() => engine.toolMerge([pdf("pages.pdf"), { name: "notes.txt", bytes: new TextEncoder().encode("hello") }])).toThrow(/notes\.txt/);
    const locked = new mupdf.PDFDocument(sample("pages.pdf")).saveToBuffer("encrypt=aes-256,user-password=secret,owner-password=secret").asUint8Array().slice();
    expect(() => engine.toolMerge([{ name: "locked.pdf", bytes: locked }])).toThrow(PasswordError);
    expect(engine.toolMerge([{ name: "locked.pdf", bytes: locked, password: "secret" }]).length).toBeGreaterThan(1000);
  });
});

describe("merge pages in any order", () => {
  it("interleaves, turns and drops pages, keeping fonts shared", () => {
    const a = pdf("pages.pdf");
    const b = pdf("form.pdf");
    const order = [
      { file: 0, page: 4 },
      { file: 1, page: 0, rotate: 90 },
      { file: 0, page: 0 },
      { file: 0, page: 2, rotate: 270 },
    ];
    const out = open(engine.toolMergePages([a, b], order));
    expect(out.info().pageCount).toBe(4);
    const src = open(a.bytes);
    expect(out.pageText(0)).toBe(src.pageText(4));
    expect(out.pageText(2)).toBe(src.pageText(0));
    expect(out.pageText(3)).toBe(src.pageText(2));
    // turned pages: width and height swap
    const [p0, p1, , p3] = out.info().pages;
    expect(p1.w).toBeGreaterThan(p1.h);
    expect(p3.w).toBeGreaterThan(p3.h);
    expect(p0.h).toBeGreaterThan(p0.w);
    // the form page stays fillable
    expect(out.listWidgets(1).length).toBeGreaterThan(2);
    // fonts aren't copied once per page
    const once = engine.toolMergePages([a], [0, 1, 2, 3, 4].map((page) => ({ file: 0, page }))).length;
    const twice = engine.toolMergePages([a], [0, 1, 2, 3, 4, 0, 1, 2, 3, 4].map((page) => ({ file: 0, page }))).length;
    expect(twice).toBeLessThan(once * 1.6);
    expect(() => engine.toolMergePages([a], [{ file: 0, page: 9 }])).toThrow(/no page 10/);
  });
});

describe("split", () => {
  it("makes one file per group, named by its pages", () => {
    const n = engine.toolPageCount(pdf("pages.pdf"));
    expect(n).toBe(5);
    const each = engine.toolSplit(pdf("pages.pdf"), everyN(n, 1), "pages");
    expect(each.map((f) => f.name)).toEqual(["pages-p1.pdf", "pages-p2.pdf", "pages-p3.pdf", "pages-p4.pdf", "pages-p5.pdf"]);
    expect(open(each[3].bytes).pageText(0)).toBe(open(sample("pages.pdf")).pageText(3));
    const groups = parseGroups("1-2, 4, 3-", n)!;
    const parts = engine.toolSplit(pdf("pages.pdf"), groups, "pages");
    expect(parts.map((f) => f.name)).toEqual(["pages-p1-2.pdf", "pages-p4.pdf", "pages-p3-5.pdf"]);
    expect(parts.map((f) => open(f.bytes).info().pageCount)).toEqual([2, 1, 3]);
    expect(() => engine.toolSplit(pdf("pages.pdf"), [[7]], "pages")).toThrow(/doesn't exist/);
  });

  it("keeps form fields fillable in the parts", () => {
    const parts = engine.toolSplit(pdf("form.pdf"), [[0]], "form");
    expect(open(parts[0].bytes).listWidgets(0).length).toBeGreaterThan(2);
  });
});

describe("page ranges", () => {
  it("parses split groups and every-N", () => {
    expect(parseGroups("1-3, 5", 6)).toEqual([[0, 1, 2], [4]]);
    expect(parseGroups("1-3, 9", 6)).toBeNull();
    expect(parseGroups("", 6)).toBeNull();
    expect(everyN(7, 3)).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(everyN(2, 0)).toEqual([[0], [1]]);
  });
});

/** A test picture: white with a red square in its top-left corner. */
async function marked(w: number, h: number, format: "png" | "jpeg", orientation?: number): Promise<Uint8Array> {
  const red = await sharp({ create: { width: Math.round(w / 4), height: Math.round(h / 4), channels: 3, background: { r: 220, g: 0, b: 0 } } }).png().toBuffer();
  let img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } }).composite([{ input: red, left: 0, top: 0 }]);
  img = format === "png" ? img.png() : img.jpeg({ quality: 90 });
  if (orientation) img = img.withMetadata({ orientation });
  return new Uint8Array(await img.toBuffer());
}

/** Where the red corner ended up on page 1: "tl", "tr", "bl" or "br". */
function redCorner(bytes: Uint8Array): string {
  const e = open(bytes);
  const r = e.render(0, 0.5);
  const at = (fx: number, fy: number) => {
    const x = Math.floor(r.width * fx);
    const y = Math.floor(r.height * fy);
    const i = (y * r.width + x) * 4;
    return r.data[i] > 180 && r.data[i + 1] < 80;
  };
  return at(0.08, 0.08) ? "tl" : at(0.92, 0.08) ? "tr" : at(0.08, 0.92) ? "bl" : at(0.92, 0.92) ? "br" : "none";
}

describe("images to PDF", () => {
  it("one page per picture, sized to the picture or on paper", async () => {
    const wide = await marked(800, 400, "png");
    const tall = await marked(300, 600, "jpeg");
    const fit = open(engine.toolImagesToPdf([{ name: "w.png", bytes: wide }, { name: "t.jpg", bytes: tall }], { page: "fit", margin: 0 }));
    expect(fit.info().pageCount).toBe(2);
    const [p1, p2] = fit.info().pages;
    expect(p1.w / p1.h).toBeCloseTo(2, 2);
    expect(p2.w / p2.h).toBeCloseTo(0.5, 2);
    const a4 = open(engine.toolImagesToPdf([{ name: "w.png", bytes: wide }, { name: "t.jpg", bytes: tall }], { page: "a4", margin: 36 }));
    // the wide picture goes on a landscape A4 page, the tall one on portrait
    expect([Math.round(a4.info().pages[0].w), Math.round(a4.info().pages[0].h)]).toEqual([842, 595]);
    expect([Math.round(a4.info().pages[1].w), Math.round(a4.info().pages[1].h)]).toEqual([595, 842]);
  });

  it("turns phone photos the way the camera recorded", async () => {
    expect(redCorner(engine.toolImagesToPdf([{ name: "a.jpg", bytes: await marked(400, 300, "jpeg") }], { page: "fit", margin: 0 }))).toBe("tl");
    // orientation 6: shown turned 90° clockwise, so the top-left corner ends up top-right
    const six = await marked(400, 300, "jpeg", 6);
    expect(jpegOrientation(six)).toBe(6);
    const doc = engine.toolImagesToPdf([{ name: "six.jpg", bytes: six }], { page: "fit", margin: 0 });
    const pg = open(doc).info().pages[0];
    expect(pg.h).toBeGreaterThan(pg.w); // portrait now
    expect(redCorner(doc)).toBe("tr");
    expect(redCorner(engine.toolImagesToPdf([{ name: "3.jpg", bytes: await marked(400, 300, "jpeg", 3) }], { page: "fit", margin: 0 }))).toBe("br");
    expect(redCorner(engine.toolImagesToPdf([{ name: "8.jpg", bytes: await marked(400, 300, "jpeg", 8) }], { page: "fit", margin: 0 }))).toBe("bl");
    expect(redCorner(engine.toolImagesToPdf([{ name: "2.jpg", bytes: await marked(400, 300, "jpeg", 2) }], { page: "fit", margin: 0 }))).toBe("tr");
  });

  it("orientation matrices map the picture into its box", () => {
    for (let o = 1; o <= 8; o++) {
      const [a, b, c, d, e, f] = orientationMatrix(o, 100, 50, 10, 20);
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => [a * u + c * v + e, b * u + d * v + f]);
      const xs = corners.map((p) => p[0]);
      const ys = corners.map((p) => p[1]);
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(Math.round)).toEqual([10, 110, 20, 70]);
    }
  });

  it("names a file that isn't a picture", () => {
    expect(() => engine.toolImagesToPdf([{ name: "x.txt", bytes: new TextEncoder().encode("nope") }], { page: "fit", margin: 0 })).toThrow(/x\.txt/);
  });
});

describe("PDF to images", () => {
  it("renders pages as PNG or JPEG at the chosen resolution", () => {
    const png = engine.toolPageToImage(pdf("pages.pdf"), 0, { format: "png", dpi: 144, quality: 85 });
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    const w = open(sample("pages.pdf")).info().pages[0].w;
    const pix = new mupdf.Image(png);
    expect(Math.abs(pix.getWidth() - Math.ceil(w * 2))).toBeLessThanOrEqual(1);
    const jpg = engine.toolPageToImage(pdf("pages.pdf"), 1, { format: "jpeg", dpi: 72, quality: 80 });
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    expect(jpg.length).toBeLessThan(png.length);
  });
});

describe("compress", () => {
  it("scales down pictures sharper than needed, keeps the pages", async () => {
    // a photo-like 2400 px picture shown 3 inches wide (800 dpi)
    const noise = Buffer.alloc(2400 * 1800 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;
    const photo = new Uint8Array(await sharp(noise, { raw: { width: 2400, height: 1800, channels: 3 } }).blur(2).jpeg({ quality: 95 }).toBuffer());
    const doc = new mupdf.PDFDocument();
    const res = doc.newDictionary();
    const xo = doc.newDictionary();
    xo.put("Im0", doc.addImage(new mupdf.Image(photo)));
    res.put("XObject", xo);
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, res, "q 216 0 0 162 72 600 cm /Im0 Do Q BT /F1 12 Tf ET"));
    const input = doc.saveToBuffer("compress").asUint8Array().slice();
    const r = engine.toolCompress({ name: "photo.pdf", bytes: input }, { dpi: 150, quality: 70 });
    expect(r.images).toBe(1);
    expect(r.after).toBeLessThan(r.before * 0.2);
    const out = open(r.bytes);
    expect(out.info().pageCount).toBe(1);
    // the picture is still there, now about 3 in x 150 dpi = 450 px wide
    const img = new mupdf.PDFDocument(r.bytes).loadPage(0).getObject().get("Resources").get("XObject").get("Im0");
    expect(Math.abs(img.get("Width").asNumber() - 450)).toBeLessThan(10);
    // light: no picture changes, never bigger
    const light = engine.toolCompress({ name: "photo.pdf", bytes: input }, { dpi: 0, quality: 70 });
    expect(light.images).toBe(0);
    expect(light.after).toBeLessThanOrEqual(light.before);
  });

  it("doesn't touch text-only files beyond cleaning up, and never makes them bigger", () => {
    const f = pdf("paper.pdf");
    const r = engine.toolCompress(f, { dpi: 150, quality: 70 });
    expect(r.after).toBeLessThanOrEqual(f.bytes.length);
    expect(open(r.bytes).pageText(0)).toBe(open(f.bytes).pageText(0));
  });
});

describe("zip", () => {
  it("writes a valid archive with unique UTF-8 names", () => {
    const files = [
      { name: "a.pdf", bytes: new Uint8Array([1, 2, 3]) },
      { name: "a.pdf", bytes: new Uint8Array([4]) },
      { name: "Tiếng Việt.png", bytes: new TextEncoder().encode("hello") },
    ];
    const z = zip(files);
    const dv = new DataView(z.buffer);
    // end of central directory
    const end = z.length - 22;
    expect(dv.getUint32(end, true)).toBe(0x06054b50);
    expect(dv.getUint16(end + 10, true)).toBe(3);
    let p = dv.getUint32(end + 16, true);
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect(dv.getUint32(p, true)).toBe(0x02014b50);
      const nameLen = dv.getUint16(p + 28, true);
      const off = dv.getUint32(p + 42, true);
      const size = dv.getUint32(p + 20, true);
      const name = new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen));
      names.push(name);
      const data = z.subarray(off + 30 + nameLen, off + 30 + nameLen + size);
      expect(crc32(data)).toBe(dv.getUint32(p + 16, true));
      expect([...data]).toEqual([...files[i].bytes]);
      p += 46 + nameLen;
    }
    expect(names).toEqual(["a.pdf", "a (2).pdf", "Tiếng Việt.png"]);
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(uniqueNames(["x", "X", "x"])).toEqual(["x", "X (2)", "x (3)"]);
  });
});
