// Making form fields: text, multi-line text, check boxes, radio buttons, drop-downs,
// dates and signature boxes, as real AcroForm fields other PDF apps can fill in.
import type * as MuPDF from "mupdf";
import type { Rect } from "../core/geometry";

type M = typeof MuPDF;

export type NewFieldKind = "text" | "multiline" | "checkbox" | "radio" | "combobox" | "date" | "signature";

export const DATE_FORMATS = ["dd.mm.yyyy", "dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd"] as const;

export interface FieldProps {
  name?: string;
  /** Drop-downs: the choices. */
  options?: string[];
  required?: boolean;
  multiline?: boolean;
  /** Dates: how they're written. */
  dateFormat?: string;
  /** Text size (0: fit the box). */
  fontSize?: number;
}

const BORDER = [0.55, 0.55, 0.6];
const FF_REQUIRED = 2;
const FF_MULTILINE = 4096;
const FF_NO_TOGGLE_OFF = 16384;
const FF_RADIO = 32768;
const FF_COMBO = 131072;

/** Default size (points) for a field placed with a click. */
export function defaultFieldSize(kind: NewFieldKind): [number, number] {
  switch (kind) {
    case "text":
      return [160, 20];
    case "multiline":
      return [220, 60];
    case "checkbox":
    case "radio":
      return [14, 14];
    case "combobox":
      return [140, 20];
    case "date":
      return [90, 20];
    case "signature":
      return [180, 50];
  }
}

const BASE_NAMES: Record<NewFieldKind, string> = {
  text: "Text",
  multiline: "Text",
  checkbox: "Check box",
  radio: "Choice",
  combobox: "Drop-down",
  date: "Date",
  signature: "Signature",
};

/** All field names in the document (full names). */
export function allFieldNames(doc: MuPDF.PDFDocument): Set<string> {
  const out = new Set<string>();
  const walk = (list: MuPDF.PDFObject, prefix: string, depth: number) => {
    if (!list.isArray() || depth > 20) return;
    list.forEach((f) => {
      const t = f.get("T");
      const name = t.isString() ? (prefix ? `${prefix}.${t.asString()}` : t.asString()) : prefix;
      if (name) out.add(name);
      walk(f.get("Kids"), name, depth + 1);
    });
  };
  walk(doc.getTrailer().get("Root", "AcroForm", "Fields"), "", 0);
  return out;
}

export function uniqueName(doc: MuPDF.PDFDocument, base: string): string {
  const names = allFieldNames(doc);
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** The document's form, made if needed, with Helvetica and ZapfDingbats for its fields. */
export function ensureForm(doc: MuPDF.PDFDocument): MuPDF.PDFObject {
  const root = doc.getTrailer().get("Root");
  let form = root.get("AcroForm");
  if (!form.isDictionary()) {
    root.put("AcroForm", doc.addObject(doc.newDictionary()));
    form = root.get("AcroForm");
  }
  if (!form.get("Fields").isArray()) form.put("Fields", doc.newArray());
  if (!form.get("DR").isDictionary()) form.put("DR", doc.newDictionary());
  const dr = form.get("DR");
  if (!dr.get("Font").isDictionary()) dr.put("Font", doc.newDictionary());
  const fonts = dr.get("Font");
  if (fonts.get("Helv").isNull()) fonts.put("Helv", doc.addObject({ Type: doc.newName("Font"), Subtype: doc.newName("Type1"), BaseFont: doc.newName("Helvetica"), Encoding: doc.newName("WinAnsiEncoding") }));
  if (fonts.get("ZaDb").isNull()) fonts.put("ZaDb", doc.addObject({ Type: doc.newName("Font"), Subtype: doc.newName("Type1"), BaseFont: doc.newName("ZapfDingbats") }));
  if (!form.get("DA").isString()) form.put("DA", doc.newString("/Helv 0 Tf 0 g"));
  return form;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** A form XObject for a widget appearance of size w×h. */
function apStream(doc: MuPDF.PDFDocument, w: number, h: number, ops: string, res?: MuPDF.PDFObject): MuPDF.PDFObject {
  const dict = doc.newDictionary();
  dict.put("Type", doc.newName("XObject"));
  dict.put("Subtype", doc.newName("Form"));
  dict.put("BBox", [0, 0, w, h]);
  if (res) dict.put("Resources", res);
  return doc.addStream(new TextEncoder().encode(ops), dict);
}

// (Bézier circle: control points at 0.5523 of the radius)
function circle(cx: number, cy: number, r: number): string {
  const k = 0.5523 * r;
  return `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c `;
}

/**
 * Appearances for check boxes, radio buttons and signature boxes (MuPDF doesn't write
 * these into the file, and other apps need them). Size as the box is in PDF space;
 * a turned page has its widgets turned with /MK /R, so w and h are swapped there.
 */
export function writeButtonAppearance(doc: MuPDF.PDFDocument, obj: MuPDF.PDFObject, kind: "checkbox" | "radio" | "signature" | "box", onState = "Yes"): void {
  const r = obj.get("Rect");
  const w = Math.abs(r.get(2).asNumber() - r.get(0).asNumber());
  const h = Math.abs(r.get(3).asNumber() - r.get(1).asNumber());
  const rot = obj.get("MK", "R").isNumber() ? obj.get("MK", "R").asNumber() : 0;
  // the appearance is drawn upright, then turned with the page
  const [aw, ah] = rot % 180 ? [h, w] : [w, h];
  const matrix = rot === 90 ? [0, 1, -1, 0, w, 0] : rot === 180 ? [-1, 0, 0, -1, w, h] : rot === 270 ? [0, -1, 1, 0, 0, h] : null;
  const stroke = `${BORDER.map(n).join(" ")} RG 0.75 w`;
  const make = (ops: string, res?: MuPDF.PDFObject) => {
    const s = apStream(doc, aw, ah, ops, res);
    if (matrix) s.put("Matrix", matrix);
    return s;
  };
  const ap = doc.newDictionary();
  const normal = doc.newDictionary();
  if (kind === "box") {
    // an empty text field or drop-down: just its border (MuPDF draws it once it has a value)
    ap.put("N", make(`q ${stroke} 0.375 0.375 ${n(aw - 0.75)} ${n(ah - 0.75)} re S Q`));
    obj.put("AP", ap);
    return;
  }
  if (kind === "signature") {
    // a box with a line to sign on (no words: a signature put in later sits on top of it)
    const line = Math.max(4, ah * 0.25);
    ap.put("N", make(`q ${stroke} 0.375 0.375 ${n(aw - 0.75)} ${n(ah - 0.75)} re S 0.5 w 6 ${n(line)} m ${n(aw - 6)} ${n(line)} l S Q`));
    obj.put("AP", ap);
    return;
  }
  const s = Math.min(aw, ah);
  const ox = (aw - s) / 2;
  const oy = (ah - s) / 2;
  const box = kind === "radio" ? `${circle(aw / 2, ah / 2, s / 2 - 0.5)}S` : `${n(ox + 0.375)} ${n(oy + 0.375)} ${n(s - 0.75)} ${n(s - 0.75)} re S`;
  const off = `q 1 1 1 rg ${kind === "radio" ? `${circle(aw / 2, ah / 2, s / 2 - 0.5)}f` : `${n(ox)} ${n(oy)} ${n(s)} ${n(s)} re f`} ${stroke} ${box} Q`;
  const mark =
    kind === "radio"
      ? `q 0.1 0.1 0.12 rg ${circle(aw / 2, ah / 2, s * 0.24)}f Q`
      : `q 0.1 0.1 0.12 RG ${n(Math.max(1, s * 0.12))} w 1 J 1 j ${n(ox + s * 0.22)} ${n(oy + s * 0.52)} m ${n(ox + s * 0.42)} ${n(oy + s * 0.3)} l ${n(ox + s * 0.8)} ${n(oy + s * 0.74)} l S Q`;
  normal.put("Off", make(off));
  normal.put(onState, make(`${off} ${mark}`));
  ap.put("N", normal);
  obj.put("AP", ap);
}

/** The radio group named `name` (a field with kids), or null. */
function findGroup(doc: MuPDF.PDFDocument, name: string): MuPDF.PDFObject | null {
  let found: MuPDF.PDFObject | null = null;
  doc
    .getTrailer()
    .get("Root", "AcroForm", "Fields")
    .forEach((f) => {
      if (found) return;
      const t = f.get("T");
      const ff = f.get("Ff");
      if (t.isString() && t.asString() === name && f.get("FT").isName() && f.get("FT").asName() === "Btn" && ff.isNumber() && ff.asNumber() & FF_RADIO) found = f;
    });
  return found;
}

/**
 * Add a field to a page. `rect` is in page space (as seen). Radio buttons join the group
 * `group` when it exists (otherwise a new group is made). Returns the widget's object number
 * and the name of its field (the group's name for radio buttons).
 */
export function addField(m: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, kind: NewFieldKind, rect: Rect, opts: FieldProps & { group?: string | null; baseName?: string } = {}): { num: number; name: string } {
  const form = ensureForm(doc);
  const pobj = page.getObject();
  const pdf = m.Rect.transform(rect, m.Matrix.invert(page.getTransform())) as Rect;
  const rot = page.getObject().getInheritable("Rotate");
  const r = rot.isNumber() ? ((rot.asNumber() % 360) + 360) % 360 : 0;
  const N = (s: string) => doc.newName(s);
  const S = (s: string) => doc.newString(s);
  const w = doc.newDictionary();
  w.put("Type", N("Annot"));
  w.put("Subtype", N("Widget"));
  w.put("Rect", pdf.map((v) => Math.round(v * 100) / 100));
  w.put("F", 4);
  w.put("P", pobj);
  const mk = doc.newDictionary();
  mk.put("BC", BORDER);
  if (r) mk.put("R", r);
  w.put("MK", mk);
  const size = opts.fontSize ?? 0;
  let name = opts.name?.trim() || "";
  let parent: MuPDF.PDFObject | null = null;
  let ff = opts.required ? FF_REQUIRED : 0;
  switch (kind) {
    case "text":
    case "multiline":
    case "date":
      w.put("FT", N("Tx"));
      w.put("DA", S(`/Helv ${size} Tf 0 g`));
      if (kind === "multiline" || opts.multiline) ff |= FF_MULTILINE;
      if (kind === "date") setDateFormat(doc, w, opts.dateFormat ?? DATE_FORMATS[0]);
      break;
    case "checkbox":
      w.put("FT", N("Btn"));
      w.put("V", N("Off"));
      w.put("AS", N("Off"));
      w.put("DA", S("/ZaDb 0 Tf 0 g"));
      mk.put("CA", S("4"));
      break;
    case "radio": {
      // the group is the field; each button is a kid with its own "on" name
      parent = opts.group ? findGroup(doc, opts.group) : null;
      if (!parent) {
        const pd = doc.newDictionary();
        pd.put("FT", N("Btn"));
        pd.put("Ff", FF_RADIO | FF_NO_TOGGLE_OFF | (opts.required ? FF_REQUIRED : 0));
        pd.put("T", S(name || uniqueName(doc, opts.baseName || BASE_NAMES.radio)));
        pd.put("V", N("Off"));
        pd.put("Kids", doc.newArray());
        parent = doc.addObject(pd);
        form.get("Fields").push(parent);
      }
      name = parent.get("T").asString();
      w.put("AS", N("Off"));
      w.put("DA", S("/ZaDb 0 Tf 0 g"));
      mk.put("CA", S("l"));
      w.put("Parent", parent);
      break;
    }
    case "combobox":
      w.put("FT", N("Ch"));
      ff |= FF_COMBO;
      w.put("Opt", (opts.options?.length ? opts.options : ["Option 1", "Option 2", "Option 3"]).map((o) => S(o)));
      w.put("DA", S(`/Helv ${size} Tf 0 g`));
      break;
    case "signature":
      w.put("FT", N("Sig"));
      break;
  }
  if (kind !== "radio") {
    name = name || uniqueName(doc, opts.baseName || BASE_NAMES[kind]);
    if (allFieldNames(doc).has(name)) name = uniqueName(doc, name);
    w.put("T", S(name));
    if (ff) w.put("Ff", ff);
  }
  const ref = doc.addObject(w);
  if (kind === "radio") {
    const kids = parent!.get("Kids");
    const on = `Option ${kids.length + 1}`;
    kids.push(ref);
    writeButtonAppearance(doc, ref, "radio", on);
  } else {
    form.get("Fields").push(ref);
    writeButtonAppearance(doc, ref, kind === "checkbox" ? "checkbox" : kind === "signature" ? "signature" : "box");
  }
  let annots = pobj.get("Annots");
  if (!annots.isArray()) {
    pobj.put("Annots", doc.newArray());
    annots = pobj.get("Annots");
  }
  annots.push(ref);
  return { num: ref.asIndirect(), name };
}

/** Date format actions (Acrobat's), so other apps check and format the date too. */
function setDateFormat(doc: MuPDF.PDFDocument, w: MuPDF.PDFObject, fmt: string): void {
  const js = (code: string) => {
    const a = doc.newDictionary();
    a.put("S", doc.newName("JavaScript"));
    a.put("JS", doc.newString(code));
    return a;
  };
  const aa = doc.newDictionary();
  aa.put("K", js(`AFDate_KeystrokeEx("${fmt}");`));
  aa.put("F", js(`AFDate_FormatEx("${fmt}");`));
  w.put("AA", aa);
}

/** The date format of a field (from its format action), or "". */
export function dateFormatOf(w: MuPDF.PDFObject): string {
  const js = w.get("AA", "F", "JS");
  if (!js.isString()) return "";
  return /AFDate_FormatEx\("([^"]+)"\)/.exec(js.asString())?.[1] ?? "";
}

/** The field dictionary that has the name (a radio button's group, else the widget). */
function fieldOf(w: MuPDF.PDFObject): MuPDF.PDFObject {
  return w.get("T").isNull() && w.get("Parent").isDictionary() ? w.get("Parent") : w;
}

/** Change a field's settings. Returns false when nothing changed. */
export function setFieldProps(doc: MuPDF.PDFDocument, widget: MuPDF.PDFWidget, p: FieldProps): boolean {
  const w = widget.getObject();
  const f = fieldOf(w);
  let changed = false;
  if (p.name !== undefined) {
    const name = p.name.trim();
    if (!name) throw new Error("A field needs a name");
    if (/\./.test(name)) throw new Error("A field name can't contain a dot");
    const cur = f.get("T").isString() ? f.get("T").asString() : "";
    if (name !== cur) {
      if (allFieldNames(doc).has(name)) throw new Error(`There's already a field called "${name}"`);
      f.put("T", doc.newString(name));
      changed = true;
    }
  }
  const flags = (set: number, on: boolean | undefined) => {
    if (on === undefined) return;
    const cur = f.get("Ff").isNumber() ? f.get("Ff").asNumber() : 0;
    const next = on ? cur | set : cur & ~set;
    if (next !== cur) {
      f.put("Ff", next);
      changed = true;
    }
  };
  flags(FF_REQUIRED, p.required);
  if (widget.getFieldType() === "text") flags(FF_MULTILINE, p.multiline);
  if (p.options && widget.getFieldType() === "combobox") {
    const opts = p.options.map((o) => o.trim()).filter(Boolean);
    if (!opts.length) throw new Error("A drop-down needs at least one choice");
    const cur = widget.getOptions();
    if (cur.join("\n") !== opts.join("\n")) {
      f.put("Opt", opts.map((o) => doc.newString(o)));
      if (!opts.includes(widget.getValue())) f.delete("V");
      changed = true;
    }
  }
  if (p.dateFormat !== undefined && widget.getFieldType() === "text") {
    if (p.dateFormat !== dateFormatOf(w)) {
      if (p.dateFormat) setDateFormat(doc, w, p.dateFormat);
      else w.delete("AA");
      changed = true;
    }
  }
  if (p.fontSize !== undefined && (widget.getFieldType() === "text" || widget.getFieldType() === "combobox")) {
    const da = `/Helv ${p.fontSize} Tf 0 g`;
    const cur = w.get("DA");
    if (!cur.isString() || cur.asString() !== da) {
      w.put("DA", doc.newString(da));
      changed = true;
    }
  }
  return changed;
}

/** Whether a field must be filled in. */
export function isRequired(w: MuPDF.PDFObject): boolean {
  const f = fieldOf(w);
  return f.get("Ff").isNumber() && (f.get("Ff").asNumber() & FF_REQUIRED) !== 0;
}

/** Put a widget in a new box (page space), redrawing its appearance. */
export function placeWidget(m: M, doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, widget: MuPDF.PDFWidget, rect: Rect): void {
  const w = widget.getObject();
  w.put("Rect", (m.Rect.transform(rect, m.Matrix.invert(page.getTransform())) as Rect).map((v) => Math.round(v * 100) / 100));
  redrawWidget(doc, widget);
}

/** A fresh appearance for a widget (ours for buttons and signature boxes, MuPDF's for the rest). */
export function redrawWidget(doc: MuPDF.PDFDocument, widget: MuPDF.PDFWidget): void {
  const w = widget.getObject();
  const t = widget.getFieldType();
  if (t === "checkbox" || t === "radiobutton") {
    const n = w.get("AP", "N");
    let on = "Yes";
    if (n.isDictionary()) n.forEach((_, k) => String(k) !== "Off" && (on = String(k)));
    writeButtonAppearance(doc, w, t === "checkbox" ? "checkbox" : "radio", on);
  } else if (t === "signature") {
    if (w.get("V").isNull()) writeButtonAppearance(doc, w, "signature");
  } else if (t === "text" || t === "combobox" || t === "listbox") {
    // (MuPDF only draws a field again when its value is set)
    const v = widget.getValue();
    w.delete("AP");
    if (v) {
      if (t === "text") widget.setTextValue(v);
      else widget.setChoiceValue(v);
      widget.update();
    }
    if (!w.get("AP").isDictionary()) writeButtonAppearance(doc, w, "box");
  } else widget.update();
}

/** Remove a widget; a radio group with no buttons left goes too. */
export function deleteWidget(doc: MuPDF.PDFDocument, page: MuPDF.PDFPage, widget: MuPDF.PDFWidget): void {
  const w = widget.getObject();
  const parent = w.get("Parent");
  const num = w.asIndirect();
  page.deleteAnnotation(widget);
  if (parent.isDictionary()) {
    const kids = parent.get("Kids");
    if (kids.isArray())
      for (let i = kids.length - 1; i >= 0; i--) if (kids.get(i).asIndirect() === num) kids.delete(i);
    if (!kids.isArray() || kids.length === 0) {
      const fields = doc.getTrailer().get("Root", "AcroForm", "Fields");
      const pn = parent.asIndirect();
      if (fields.isArray()) for (let i = fields.length - 1; i >= 0; i--) if (fields.get(i).asIndirect() === pn) fields.delete(i);
    }
  }
  // (MuPDF takes a field off the form's list; make sure)
  const fields = doc.getTrailer().get("Root", "AcroForm", "Fields");
  if (fields.isArray()) for (let i = fields.length - 1; i >= 0; i--) if (fields.get(i).asIndirect() === num) fields.delete(i);
}
