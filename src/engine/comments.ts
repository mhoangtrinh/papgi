// Comment threads: replies to a note are notes of their own that point at it (/IRT), the way
// Acrobat, Preview and others store them. They draw nothing on the page (the note's card
// shows them), but other apps list them under the note.
import type * as MuPDF from "mupdf";

export interface Reply {
  /** Index into page.getAnnotations(). */
  index: number;
  num: number;
  author: string;
  /** When it was written (ms since 1970), 0 if unknown. */
  date: number;
  text: string;
}

/** The note this annotation answers (its object number), or 0 if it's not a reply. */
export function replyTo(a: MuPDF.PDFAnnotation): number {
  try {
    const irt = a.getObject().get("IRT");
    return irt.isIndirect() ? irt.asIndirect() : 0;
  } catch {
    return 0;
  }
}

export function isReply(a: MuPDF.PDFAnnotation): boolean {
  return replyTo(a) !== 0;
}

/** Who wrote an annotation ("" if not said). */
export function authorOf(a: MuPDF.PDFAnnotation): string {
  try {
    return a.hasAuthor() ? a.getAuthor() : "";
  } catch {
    return "";
  }
}

/** When an annotation was written (or else last changed; ms), 0 if unknown. */
export function dateOf(a: MuPDF.PDFAnnotation): number {
  const o = a.getObject();
  for (const key of ["CreationDate", "M"]) {
    if (!o.get(key).isString()) continue;
    try {
      const t = (key === "M" ? a.getModificationDate() : a.getCreationDate()).getTime();
      if (t > 0) return t;
    } catch {
      /* malformed date */
    }
  }
  return 0;
}

/** Write a reply to a note. */
export function addReply(page: MuPDF.PDFPage, parent: MuPDF.PDFAnnotation, text: string, author: string): void {
  const r = page.createAnnotation("Text");
  r.setRect(parent.getRect());
  r.setContents(text);
  if (author) r.setAuthor(author);
  const now = new Date();
  r.setCreationDate(now);
  r.setModificationDate(now);
  r.update();
  const o = r.getObject();
  o.put("IRT", parent.getObject());
  // (print, no zoom, no rotate: as Acrobat writes replies)
  r.setFlags(4 | 8 | 16);
  emptyAppearance(page, r);
}

/** Change the text of a reply. */
export function setReplyText(page: MuPDF.PDFPage, r: MuPDF.PDFAnnotation, text: string): void {
  r.setContents(text);
  r.setModificationDate(new Date());
  r.update();
  emptyAppearance(page, r);
}

/** A reply shows nothing on the page itself. */
export function emptyAppearance(page: MuPDF.PDFPage, a: MuPDF.PDFAnnotation): void {
  const doc = page._doc;
  const form = doc.addStream("", {});
  form.put("Type", doc.newName("XObject"));
  form.put("Subtype", doc.newName("Form"));
  form.put("BBox", [0, 0, 0, 0]);
  const ap = doc.newDictionary();
  ap.put("N", form);
  a.getObject().put("AP", ap);
}

/** Remove replies whose note is gone (they'd show up alone in other apps). True if any were. */
export function dropOrphanReplies(page: MuPDF.PDFPage): boolean {
  const annots = page.getAnnotations();
  const nums = new Set(annots.map((a) => a.getObject().asIndirect()));
  let dropped = false;
  // (several rounds: a reply to a reply goes with it)
  for (let round = 0; round < 4; round++) {
    const orphans = page.getAnnotations().filter((a) => {
      const p = replyTo(a);
      return p !== 0 && !nums.has(p);
    });
    if (!orphans.length) break;
    for (const a of orphans) {
      nums.delete(a.getObject().asIndirect());
      page.deleteAnnotation(a);
    }
    dropped = true;
  }
  return dropped;
}
