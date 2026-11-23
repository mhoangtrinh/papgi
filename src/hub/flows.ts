// The stand-alone tools' settings and what they do. The page around them (file list, options,
// result) is in flow-view.ts; the PDF work happens in the engine worker (engine/tools.ts).
import type { Engine } from "../engine/client";
import type { CompressResult, OutFile } from "../engine/tools";
import { parseGroups } from "../core/pages";
import { formatSize } from "../recent";
import type { ToolId } from "./registry";

export interface Item {
  id: string;
  name: string;
  bytes: Uint8Array;
  kind: "pdf" | "image";
  pages: number;
  password?: string;
  thumb: string; // URL for the list
}

/** A page in the page view: which file, which page, extra turn. */
export interface PageSlot {
  item: string;
  page: number;
  rotate: number;
}

export interface RunContext {
  engine: Engine;
  items: Item[];
  /** Page order (tools with a page view). */
  order: PageSlot[];
  /** Split: the files to make, each with its pages. */
  parts: PageSlot[][];
  opts: Record<string, string>;
  progress(done: number, total: number, text?: string): void;
  cancelled(): boolean;
}

export interface RunResult {
  files: OutFile[];
  /** A line shown above the result, e.g. sizes before/after. */
  note?: string;
}

/** One option: a row of choices, or a text field shown only for some choice. */
export type Option =
  | {
      kind: "choice";
      key: string;
      label: string;
      choices: [value: string, label: string, hint?: string][];
      value: string;
    }
  | {
      kind: "text";
      key: string;
      label: string;
      placeholder: string;
      value: string;
      showIf?: [key: string, value: string];
      hint?: string;
    }
  | {
      kind: "range";
      key: string;
      label: string;
      min: number;
      max: number;
      step: number;
      value: string;
      unit: string;
      showIf?: [key: string, value: string];
    };

export interface FlowDef {
  id: ToolId;
  title: string;
  intro: string;
  /** What files it takes. */
  takes: "pdf" | "image";
  multiple: boolean;
  min: number;
  /** Files can be put in order (images). */
  reorder: boolean;
  /** Shows every page (or picture); they can be reordered, turned and removed. */
  pageView?: boolean;
  /** Split: shows each resulting file with its pages. */
  splitView?: boolean;
  options: Option[];
  action(items: Item[], order: PageSlot[]): string;
  /** Problem with the current options, shown instead of running. */
  check?(
    items: Item[],
    opts: Record<string, string>,
    order?: PageSlot[],
  ): string | null;
  run(ctx: RunContext): Promise<RunResult>;
  /** Shows the result size of each choice of one option before running. */
  estimate?: {
    key: string;
    size(
      engine: Engine,
      items: Item[],
      value: string,
    ): Promise<{ before: number; after: number }>;
  };
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");
const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
const src = (it: Item) => ({
  name: it.name,
  bytes: it.bytes,
  password: it.password,
});

/** Compressed copies, made once per file and level (for the size preview and the result). */
const compressCache = new WeakMap<Item, Map<string, Promise<CompressResult>>>();
const compressPreset = (level: string) =>
  level === "light"
    ? { dpi: 0, quality: 80 }
    : level === "strong"
      ? { dpi: 96, quality: 60 }
      : { dpi: 150, quality: 75 };
function compressed(
  engine: Engine,
  it: Item,
  level: string,
): Promise<CompressResult> {
  let m = compressCache.get(it);
  if (!m) compressCache.set(it, (m = new Map()));
  let p = m.get(level);
  if (!p) {
    p = engine.toolCompress(src(it), compressPreset(level));
    m.set(level, p);
    p.catch(() => m.delete(level));
  }
  return p;
}

export const FLOWS: Record<string, FlowDef> = {
  merge: {
    id: "merge",
    title: "Merge PDFs",
    intro:
      "Combine PDFs into one file. All pages are shown below: drag them into any order (long-press on a phone), turn or remove single pages. Form fields, annotations and signatures come along.",
    takes: "pdf",
    multiple: true,
    min: 1,
    reorder: false,
    pageView: true,
    options: [],
    action: (items, order) =>
      items.length === 0
        ? "Add PDFs to merge"
        : items.length === 1
          ? `Save ${plural(order.length, "page")} in this order`
          : `Merge ${items.length} files (${plural(order.length, "page")})`,
    check: (_items, _o, order) =>
      order && order.length === 0
        ? "All pages were removed. Add a file or start over."
        : null,
    async run({ engine, items, order }) {
      const index = new Map(items.map((it, i) => [it.id, i]));
      const bytes = await engine.toolMergePages(
        items.map(src),
        order.map((o) => ({
          file: index.get(o.item)!,
          page: o.page,
          rotate: o.rotate,
        })),
      );
      const used = new Set(order.map((o) => o.item)).size;
      return {
        files: [
          {
            name: `${stem(items[0].name)} (merged).pdf`,
            bytes,
            type: "application/pdf",
          },
        ],
        note: `${plural(order.length, "page")} from ${plural(used, "file")}`,
      };
    },
  },

  split: {
    id: "split",
    title: "Split PDF",
    intro:
      "Cut a PDF into several files. Several files come as one ZIP download.",
    takes: "pdf",
    multiple: false,
    min: 1,
    reorder: false,
    options: [
      {
        kind: "choice",
        key: "mode",
        label: "Split into",
        value: "each",
        choices: [
          ["each", "Single pages", "One file per page"],
          ["every", "Every N pages", "Equal parts"],
          ["ranges", "Custom ranges", "Each range becomes a file"],
        ],
      },
      {
        kind: "range",
        key: "n",
        label: "Pages per file",
        min: 1,
        max: 50,
        step: 1,
        value: "2",
        unit: "",
        showIf: ["mode", "every"],
      },
      {
        kind: "text",
        key: "ranges",
        label: "Ranges",
        placeholder: "e.g. 1-3, 4, 5-",
        value: "",
        showIf: ["mode", "ranges"],
        hint: "Commas separate the files: “1-3, 4, 5-” makes 3 files. “5-” means 5 to the end.",
      },
    ],
    splitView: true,
    action: () => "Split",
    check(items, o) {
      if (
        o.mode === "ranges" &&
        items[0] &&
        !parseGroups(o.ranges, items[0].pages)
      )
        return `Enter page ranges between 1 and ${items[0].pages}, like “1-3, 4, 5-”.`;
      return null;
    },
    async run({ engine, items, parts }) {
      const it = items[0];
      const groups = parts
        .filter((p) => p.length)
        .map((p) => p.map((s) => ({ page: s.page, rotate: s.rotate })));
      if (!groups.length) throw new Error("All pages were removed");
      const files = await engine.toolSplit(src(it), groups, stem(it.name));
      return {
        files,
        note: `${plural(files.length, "file")} from ${plural(it.pages, "page")}`,
      };
    },
  },

  compress: {
    id: "compress",
    title: "Compress PDF",
    intro:
      "Make a PDF smaller. Pictures are scaled down to what the page needs; text and drawings stay sharp.",
    takes: "pdf",
    multiple: true,
    min: 1,
    reorder: false,
    options: [
      {
        kind: "choice",
        key: "level",
        label: "Compression",
        value: "medium",
        choices: [
          ["light", "Light", "Clean up only, pictures untouched"],
          [
            "medium",
            "Recommended",
            "Pictures at 150 dpi: good for screen and printing",
          ],
          ["strong", "Strong", "Pictures at 96 dpi: smallest, fine on screen"],
        ],
      },
    ],
    action: (items) =>
      items.length > 1 ? `Compress ${items.length} files` : "Compress",
    estimate: {
      key: "level",
      async size(engine, items, level) {
        let before = 0;
        let after = 0;
        for (const it of items) {
          const r = await compressed(engine, it, level);
          before += r.before;
          after += Math.min(r.after, r.before);
        }
        return { before, after };
      },
    },
    async run({ engine, items, opts, progress, cancelled }) {
      const files: OutFile[] = [];
      let before = 0;
      let after = 0;
      for (let i = 0; i < items.length && !cancelled(); i++) {
        progress(i, items.length, `Compressing ${items[i].name}…`);
        const r = await compressed(engine, items[i], opts.level);
        before += r.before;
        after += r.after;
        files.push({
          name: `${stem(items[i].name)} (compressed).pdf`,
          bytes: r.bytes,
          type: "application/pdf",
        });
      }
      const saved = before ? Math.round((1 - after / before) * 100) : 0;
      const note =
        after < before
          ? `${formatSize(before)} → ${formatSize(after)} (${saved}% smaller)`
          : `${formatSize(before)}: this file is already about as small as it gets`;
      return { files, note };
    },
  },

  "images-to-pdf": {
    id: "images-to-pdf",
    title: "Images to PDF",
    intro:
      "Turn photos and scans into one PDF, one picture per page. Drag them into order (long-press on a phone), turn or remove them before making the PDF. Phone photos keep the right way up.",
    takes: "image",
    multiple: true,
    min: 1,
    reorder: false,
    pageView: true,
    options: [
      {
        kind: "choice",
        key: "page",
        label: "Page size",
        value: "a4",
        choices: [
          ["a4", "A4", "Pictures fit on A4 pages"],
          ["letter", "Letter", "Pictures fit on US Letter"],
          ["fit", "Same as picture", "Each page the size of its picture"],
        ],
      },
      {
        kind: "choice",
        key: "margin",
        label: "Margin",
        value: "18",
        choices: [
          ["0", "None"],
          ["18", "Small"],
          ["42", "Large"],
        ],
      },
    ],
    action: (items, order) =>
      items.length
        ? `Make PDF from ${plural(order.length, "picture")}`
        : "Add pictures",
    check: (items, _o, order) =>
      items.length && order && !order.length
        ? "All pictures were removed. Add some or start over."
        : null,
    async run({ engine, items, opts, order }) {
      const page = opts.page as "a4" | "letter" | "fit";
      const byId = new Map(items.map((it) => [it.id, it]));
      const pics = order.map((s) => byId.get(s.item)!);
      const bytes = await engine.toolImagesToPdf(
        order.map((s, i) => ({
          name: pics[i].name,
          bytes: pics[i].bytes,
          rotate: s.rotate,
        })),
        { page, margin: page === "fit" ? 0 : Number(opts.margin) },
      );
      const name =
        pics.length === 1 ? `${stem(pics[0].name)}.pdf` : "Images.pdf";
      return {
        files: [{ name, bytes, type: "application/pdf" }],
        note: plural(pics.length, "page"),
      };
    },
  },

  "pdf-to-images": {
    id: "pdf-to-images",
    title: "PDF to images",
    intro:
      "Save pages as pictures. All pages are shown below: remove the ones you don't need, turn or reorder the rest. Several pictures come as one ZIP; on a phone you can share them to Photos.",
    takes: "pdf",
    multiple: false,
    min: 1,
    reorder: false,
    pageView: true,
    options: [
      {
        kind: "choice",
        key: "format",
        label: "Format",
        value: "png",
        choices: [
          ["png", "PNG", "Sharpest, bigger files"],
          ["jpeg", "JPG", "Smaller, best for photos and scans"],
        ],
      },
      {
        kind: "choice",
        key: "dpi",
        label: "Quality",
        value: "150",
        choices: [
          ["72", "Screen", "72 dpi"],
          ["150", "Standard", "150 dpi"],
          ["300", "Print", "300 dpi"],
        ],
      },
    ],
    action: (_items, order) =>
      order.length ? `Make ${plural(order.length, "picture")}` : "Make images",
    check: (items, _o, order) =>
      items.length && order && !order.length
        ? "All pages were removed. Use Reset order to start again."
        : null,
    async run({ engine, items, opts, order, progress, cancelled }) {
      const it = items[0];
      const pages = order.map((s) => s.page);
      const turns = order.map((s) => s.rotate);
      const fmt = opts.format as "png" | "jpeg";
      const ext = fmt === "png" ? "png" : "jpg";
      const width = String(it.pages).length;
      const files: OutFile[] = [];
      // a few pages per call: the file goes to the worker once per batch, with progress between
      for (let k = 0; k < pages.length && !cancelled(); k += 4) {
        const batch = pages.slice(k, k + 4);
        progress(k, pages.length, `Page ${batch[0] + 1} of ${it.pages}…`);
        const out = await engine.toolPagesToImages(
          src(it),
          batch,
          { format: fmt, dpi: Number(opts.dpi), quality: 85 },
          turns.slice(k, k + 4),
        );
        out.forEach((bytes, j) =>
          files.push({
            name: `${stem(it.name)}-${String(batch[j] + 1).padStart(width, "0")}.${ext}`,
            bytes,
            type: fmt === "png" ? "image/png" : "image/jpeg",
          }),
        );
      }
      return { files, note: plural(files.length, "picture") };
    },
  },

  "pdf-to-word": {
    id: "pdf-to-word",
    title: "PDF to Word",
    intro:
      "Turn a PDF into a Word document (.docx). All pages are shown below: remove the ones you don't need or reorder them. Works best with PDFs made from documents; scans need text recognition first.",
    takes: "pdf",
    multiple: false,
    min: 1,
    reorder: false,
    pageView: true,
    options: [
      {
        kind: "choice",
        key: "mode",
        label: "Make",
        value: "editable",
        choices: [
          [
            "editable",
            "Editable text",
            "Text, fonts, columns, lists and pictures rebuilt so you can edit them. Lines and boxes sit behind the text as a picture",
          ],
          [
            "pictures",
            "As pictures",
            "Every page as one picture: looks exactly like the PDF, but the text can't be edited",
          ],
        ],
      },
    ],
    action: (_items, order) =>
      order.length
        ? `Make Word file (${plural(order.length, "page")})`
        : "Make Word file",
    check: (items, _o, order) =>
      items.length && order && !order.length
        ? "All pages were removed. Use Reset to start again."
        : null,
    async run({ engine, items, opts, order, progress, cancelled }) {
      const it = items[0];
      const mode = opts.mode === "pictures" ? "pictures" : "editable";
      const pages = order.map((s) => s.page);
      const turns = order.map((s) => s.rotate);
      const verb = mode === "pictures" ? "Picturing" : "Reading";
      await engine.toolWordStart(src(it), { mode });
      const step = mode === "pictures" ? 20 : 8;
      for (let k = 0; k < pages.length; k += step) {
        if (cancelled()) {
          await engine.toolWordCancel();
          return { files: [], note: "" };
        }
        progress(k, pages.length + 1, `${verb} page ${k + 1} of ${pages.length}…`);
        await engine.toolWordAdd(pages.slice(k, k + step), turns.slice(k, k + step));
      }
      progress(pages.length, pages.length + 1, "Writing the Word file…");
      const r = await engine.toolWordFinish();
      progress(1, 1);
      const scans = r.scanned.map((p) => p + 1);
      const turned =
        opts.mode !== "pictures" && order.some((s) => s.rotate % 360);
      const notes = [plural(order.length, "page")];
      if (scans.length)
        notes.push(
          `${scans.length === 1 ? `page ${scans[0]} is a scan` : `pages ${scans.join(", ")} are scans`} and went in as ${scans.length === 1 ? "a picture" : "pictures"}: open the PDF, use Recognize text, then convert again to edit ${scans.length === 1 ? "it" : "them"}`,
        );
      if (turned) notes.push("turning pages only applies to “As pictures”");
      return {
        files: [
          {
            name: `${stem(it.name)}.docx`,
            bytes: r.bytes,
            type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          },
        ],
        note: notes.join(" · "),
      };
    },
  },
};
