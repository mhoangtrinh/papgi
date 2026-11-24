import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PdfEngine } from "../src/engine/engine";
import { makeSelfSigned } from "../src/sign/cms";
import { checkSignatures, finishSignature } from "../src/sign/signpdf";
import { parsePdfDate, pdfDate } from "../src/engine/sigfield";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const has = (cmd: string) => {
  try {
    execSync(`which ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const pdfsig = (bytes: Uint8Array) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pdfsig-")), "s.pdf");
  fs.writeFileSync(f, bytes);
  try {
    return execSync(`pdfsig "${f}" 2>&1`).toString();
  } catch (e) {
    return String((e as { stdout?: Buffer }).stdout ?? e);
  }
};

describe("signing a PDF", { timeout: 30000 }, () => {
  it("PDF dates go both ways", () => {
    const t = Date.UTC(2026, 10, 24, 13, 30, 5);
    expect(parsePdfDate(pdfDate(t))).toBe(t);
    expect(parsePdfDate("D:20261124143005+01'00'")).toBe(t);
  });

  it("signs in a signature box: other apps and papgi find the signature valid", async () => {
    const me = await makeSelfSigned("Hoang Trinh", "hoang@example.com");
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addField(0, "signature", [100, 600, 300, 680]);
    const w = e.listWidgets(0).find((x) => x.kind === "signature")!;
    const prepared = e.prepareSign({ field: { page: 0, widget: w.index }, name: "Hoang Trinh", reason: "I agree", location: "Aachen", time: Date.now(), lines: ["Digitally signed by", "Hoang Trinh", "Date: 2026-11-24", "Reason: I agree"] });
    // the open document itself is untouched
    expect(e.listWidgets(0).find((x) => x.kind === "signature")!.signed).toBeUndefined();
    const signed = await finishSignature(prepared, me);
    const f = new PdfEngine(mupdf);
    f.open(signed.slice());
    const sigs = f.signatures();
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ page: 0, name: "Hoang Trinh", reason: "I agree", location: "Aachen", subFilter: "adbe.pkcs7.detached" });
    expect(f.listWidgets(0).find((x) => x.kind === "signature")!.signed).toBe(true);
    const [r] = await checkSignatures(signed, sigs);
    expect(r).toMatchObject({ status: "valid", whole: true, signer: "Hoang Trinh", selfSigned: true });
    // the box shows the signature (something is drawn in it)
    const img = f.render(0, 1);
    let dark = 0;
    for (let y = 600; y < 680; y++) for (let x = 100; x < 300; x++) if (img.data[(y * img.width + x) * 4] < 128) dark++;
    expect(dark).toBeGreaterThan(50);
    if (has("pdfsig")) {
      const out = pdfsig(signed);
      expect(out).toMatch(/Signature is Valid/);
      expect(out).toMatch(/Signer Certificate Common Name: Hoang Trinh/);
      expect(out).toMatch(/Total document signed/);
    }
    // one changed byte in the signed part: no longer valid
    const bad = signed.slice();
    const at = bad.indexOf(0x50, 2000); // a "P" somewhere in the file
    bad[at] = 0x51;
    expect((await checkSignatures(bad, sigs))[0].status).toBe("invalid");
    // something added after signing: still valid, but not the whole file
    const more = new Uint8Array([...signed, ...new TextEncoder().encode("\n% added later\n")]);
    expect((await checkSignatures(more, sigs))[0]).toMatchObject({ status: "valid", whole: false });
  });

  it("signs without a box (not shown on the page)", async () => {
    const me = await makeSelfSigned("Aga", "");
    const e = new PdfEngine(mupdf);
    e.open(sample("form.pdf"));
    const signed = await finishSignature(e.prepareSign({ field: null, name: "Aga", reason: "", location: "", time: Date.now(), lines: [] }), me);
    const f = new PdfEngine(mupdf);
    f.open(signed.slice());
    const sigs = f.signatures();
    expect(sigs).toHaveLength(1);
    expect(sigs[0].page).toBe(-1);
    expect((await checkSignatures(signed, sigs))[0]).toMatchObject({ status: "valid", whole: true });
    if (has("pdfsig")) expect(pdfsig(signed)).toMatch(/Signature is Valid/);
  });

  it("signing a signed PDF again keeps the first signature valid (added to the file as it is)", async () => {
    const a = await makeSelfSigned("First Person", "");
    const b = await makeSelfSigned("Second Person", "");
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addField(0, "signature", [100, 600, 300, 680]);
    e.addField(1, "signature", [100, 600, 300, 680]);
    const once = await finishSignature(e.prepareSign({ field: { page: 0, widget: 0 }, name: "First Person", reason: "", location: "", time: Date.now(), lines: ["Signed by", "First Person"] }), a);
    const f = new PdfEngine(mupdf);
    f.open(once.slice());
    const twice = await finishSignature(f.prepareSign({ field: { page: 1, widget: 0 }, name: "Second Person", reason: "", location: "", time: Date.now(), lines: ["Signed by", "Second Person"] }, once.slice()), b);
    // the first file is still there, byte for byte
    expect(Buffer.from(twice.subarray(0, once.length)).equals(Buffer.from(once))).toBe(true);
    const g = new PdfEngine(mupdf);
    g.open(twice.slice());
    const r = await checkSignatures(twice, g.signatures());
    expect(r.map((x) => [x.signer, x.status, x.whole])).toEqual([
      ["First Person", "valid", false],
      ["Second Person", "valid", true],
    ]);
    if (has("pdfsig")) expect(pdfsig(twice).match(/Signature is Valid/g)).toHaveLength(2);
  });
});
