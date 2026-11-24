import { describe, it, expect } from "vitest";
import * as mupdf from "mupdf";
import fs from "node:fs";
import { PdfEngine } from "../src/engine/engine";

const sample = (name: string) => new Uint8Array(fs.readFileSync(new URL(`../public/samples/${name}`, import.meta.url)));
const reopen = (e: PdfEngine) => mupdf.Document.openDocument(e.save(), "application/pdf") as mupdf.PDFDocument;

describe("making form fields", () => {
  it("adds every kind as a real field other apps can fill (with appearances)", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    const t = e.addField(0, "text", [100, 300, 260, 320]);
    expect(t.name).toBe("Text 1");
    e.addField(0, "multiline", [100, 330, 320, 390]);
    e.addField(0, "checkbox", [100, 400, 114, 414]);
    const r1 = e.addField(0, "radio", [100, 430, 114, 444]);
    e.addField(0, "radio", [130, 430, 144, 444], { group: r1.name });
    e.addField(0, "combobox", [100, 460, 240, 480], { options: ["Red", "Green"] });
    e.addField(0, "date", [100, 490, 190, 510], { dateFormat: "dd.mm.yyyy" });
    e.addField(0, "signature", [100, 520, 280, 570]);
    const ws = e.listWidgets(0);
    expect(ws.map((w) => w.kind)).toEqual(["text", "text", "checkbox", "radio", "radio", "combobox", "text", "signature"]);
    expect(ws[1].multiline).toBe(true);
    expect(ws[3].name).toBe(ws[4].name);
    expect(ws[5].options).toEqual(["Red", "Green"]);
    expect(ws[6].dateFormat).toBe("dd.mm.yyyy");
    expect(e.state().undoName).toBe("Add field");
    // fill them in
    e.setFieldText(0, 0, "Hoang");
    e.toggleField(0, 2);
    e.toggleField(0, 4);
    e.setFieldChoice(0, 5, "Green");
    const d = reopen(e);
    const page = d.loadPage(0);
    const got = page.getWidgets().map((w) => [w.getFieldType(), w.getValue()]);
    expect(got[0]).toEqual(["text", "Hoang"]);
    expect(got[2][1]).not.toBe("Off");
    expect(got[3][1]).toBe(got[4][1]); // one group, one value
    expect(got[5]).toEqual(["combobox", "Green"]);
    // appearances are in the file (not only made up by MuPDF when it opens it)
    const annots = d.findPage(0).get("Annots");
    const noAp: string[] = [];
    annots.forEach((a) => {
      if (a.get("Subtype").asName() === "Widget" && !a.get("AP").isDictionary()) noAp.push(a.get("T").toString());
    });
    expect(noAp).toEqual([]);
    const fields = d.getTrailer().get("Root", "AcroForm", "Fields");
    expect(fields.length).toBe(7); // the two radio buttons are one field
  });

  it("moves, renames, changes and deletes; one undo step each", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addField(0, "combobox", [100, 460, 240, 480]);
    e.setFieldRect(0, 0, [200, 200, 400, 230]);
    expect(e.listWidgets(0)[0].rect[0]).toBeCloseTo(200, 0);
    e.setFieldProps(0, 0, { name: "Colour", options: ["Red", "Blue"], required: true });
    const w = e.listWidgets(0)[0];
    expect([w.name, w.options, w.required]).toEqual(["Colour", ["Red", "Blue"], true]);
    expect(() => e.setFieldProps(0, 0, { name: "a.b" })).toThrow(/dot/);
    e.addField(0, "text", [100, 100, 200, 120], { name: "Other" });
    expect(() => e.setFieldProps(0, 1, { name: "Colour" })).toThrow(/already/);
    e.deleteField(0, 0);
    expect(e.listWidgets(0).map((x) => x.name)).toEqual(["Other"]);
    e.undo();
    expect(e.listWidgets(0).length).toBe(2);
  });

  it("duplicates a field with the next name; a radio copy joins its group", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addField(0, "text", [100, 100, 200, 120]);
    const d = e.duplicateField(0, 0);
    expect(d.name).toBe("Text 2");
    expect(d.widgets[d.index].rect[1]).toBeGreaterThan(120);
    const r = e.addField(0, "radio", [100, 300, 114, 314]);
    const r2 = e.duplicateField(0, r.index);
    expect(r2.name).toBe(r.name);
    const doc = reopen(e);
    expect(doc.getTrailer().get("Root", "AcroForm", "Fields").length).toBe(3);
  });

  it("deleting the last radio button removes its group", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.addField(0, "radio", [100, 300, 114, 314]);
    e.deleteField(0, 0);
    const doc = reopen(e);
    expect(doc.getTrailer().get("Root", "AcroForm", "Fields").length).toBe(0);
  });

  it("fields on a turned page are upright as seen", () => {
    const e = new PdfEngine(mupdf);
    e.open(sample("pages.pdf"));
    e.rotatePages([0], 90);
    e.addField(0, "text", [100, 100, 300, 124]);
    e.addField(0, "checkbox", [100, 150, 120, 170]);
    e.setFieldText(0, 0, "Upright");
    e.toggleField(0, 1);
    const d = reopen(e);
    const page = d.loadPage(0);
    const annots = d.findPage(0).get("Annots");
    // turned with the page (/MK /R), the box as drawn on the page
    expect(annots.get(0).get("MK", "R").asNumber()).toBe(90);
    expect(annots.get(1).get("AP", "N", "Yes", "Matrix").isArray()).toBe(true);
    const w = e.listWidgets(0)[0];
    expect(w.rect[2] - w.rect[0]).toBeCloseTo(200, 0);
    expect(page.getWidgets()[0].getValue()).toBe("Upright");
  });
});
