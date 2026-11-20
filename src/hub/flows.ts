// The stand-alone tools' settings and what they do. The page around them (file list, options,
// result) is in flow-view.ts; the PDF work happens in the engine worker (engine/tools.ts).
import type { Engine } from "../engine/client";
import type { OutFile } from "../engine/tools";
import { everyN, parseGroups } from "../core/pages";
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
  | { kind: "choice"; key: string; label: string; choices: [value: string, label: string, hint?: string][]; value: string }
  | { kind: "text"; key: string; label: string; placeholder: string; value: string; showIf?: [key: string, value: string]; hint?: string }
  | { kind: "range"; key: string; label: string; min: number; max: number; step: number; value: string; unit: string; showIf?: [key: string, value: string] };

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
  /** Shows every page; pages can be reordered, turned and removed (merge). */
  pageView?: boolean;
  options: Option[];
  action(items: Item[]): string;
  /** Problem with the current options, shown instead of running. */
  check?(items: Item[], opts: Record<string, string>, order?: PageSlot[]): string | null;
  run(ctx: RunContext): Promise<RunResult>;
}

const stem = (name: string) => name.replace(/\.[^.]+$/, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const src = (it: Item) => ({ name: it.name, bytes: it.bytes, password: it.password });

export const FLOWS: Record<string, FlowDef> = {
  merge: {
    id: "merge",
    title: "Merge PDFs",
    intro: "Combine PDFs into one file. All pages are shown below: drag them into any order (long-press on a phone), turn or remove single pages. Form fields, annotations and signatures come along.",
    takes: "pdf",
    multiple: true,
    min: 1,
    reorder: false,
    pageView: true,
    options: [],
    action: (items) =>
      items.length === 0 ? "Add PDFs to merge" : items.length === 1 ? "Save pages in this order" : `Merge ${items.length} files`,
    check: (_items, _o, order) => (order && order.length === 0 ? "All pages were removed. Add a file or start over." : null),
    async run({ engine, items, order }) {
      const index = new Map(items.map((it, i) => [it.id, i]));
      const bytes = await engine.toolMergePages(
        items.map(src),
        order.map((o) => ({ file: index.get(o.item)!, page: o.page, rotate: o.rotate })),
      );
      const used = new Set(order.map((o) => o.item)).size;
      return {
        files: [{ name: `${stem(items[0].name)} (merged).pdf`, bytes, type: "application/pdf" }],
        note: `${plural(order.length, "page")} from ${plural(used, "file")}`,
      };
    },
  },

  split: {
    id: "split",
    title: "Split PDF",
    intro: "Cut a PDF into several files. Several files come as one ZIP download.",
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
      { kind: "range", key: "n", label: "Pages per file", min: 1, max: 50, step: 1, value: "2", unit: "", showIf: ["mode", "every"] },
      { kind: "text", key: "ranges", label: "Ranges", placeholder: "e.g. 1-3, 4, 5-", value: "", showIf: ["mode", "ranges"], hint: "Commas separate the files: “1-3, 4, 5-” makes 3 files. “5-” means 5 to the end." },
    ],
    action: () => "Split",
    check(items, o) {
      if (o.mode === "ranges" && items[0] && !parseGroups(o.ranges, items[0].pages)) return `Enter page ranges between 1 and ${items[0].pages}, like “1-3, 4, 5-”.`;
      return null;
    },
    async run({ engine, items, opts }) {
      const it = items[0];
      const groups = opts.mode === "each" ? everyN(it.pages, 1) : opts.mode === "every" ? everyN(it.pages, Number(opts.n)) : parseGroups(opts.ranges, it.pages)!;
      const files = await engine.toolSplit(src(it), groups, stem(it.name));
      return { files, note: `${plural(files.length, "file")} from ${plural(it.pages, "page")}` };
    },
  },

  compress: {
    id: "compress",
    title: "Compress PDF",
    intro: "Make a PDF smaller. Pictures are scaled down to what the page needs; text and drawings stay sharp.",
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
          ["medium", "Recommended", "Pictures at 150 dpi: good for screen and printing"],
          ["strong", "Strong", "Pictures at 96 dpi: smallest, fine on screen"],
        ],
      },
    ],
    action: (items) => (items.length > 1 ? `Compress ${items.length} files` : "Compress"),
    async run({ engine, items, opts, progress, cancelled }) {
      const preset = opts.level === "light" ? { dpi: 0, quality: 80 } : opts.level === "strong" ? { dpi: 96, quality: 60 } : { dpi: 150, quality: 75 };
      const files: OutFile[] = [];
      let before = 0;
      let after = 0;
      for (let i = 0; i < items.length && !cancelled(); i++) {
        progress(i, items.length, `Compressing ${items[i].name}…`);
        const r = await engine.toolCompress(src(items[i]), preset);
        before += r.before;
        after += r.after;
        files.push({ name: `${stem(items[i].name)} (compressed).pdf`, bytes: r.bytes, type: "application/pdf" });
      }
      const saved = before ? Math.round((1 - after / before) * 100) : 0;
      const note =
        after < before ? `${formatSize(before)} → ${formatSize(after)} (${saved}% smaller)` : `${formatSize(before)}: this file is already about as small as it gets`;
      return { files, note };
    },
  },

  "images-to-pdf": {
    id: "images-to-pdf",
    title: "Images to PDF",
    intro: "Turn photos and scans into one PDF, one picture per page, in the order shown. Phone photos keep the right way up.",
    takes: "image",
    multiple: true,
    min: 1,
    reorder: true,
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
    action: (items) => (items.length ? `Make PDF from ${plural(items.length, "picture")}` : "Add pictures"),
    async run({ engine, items, opts }) {
      const page = opts.page as "a4" | "letter" | "fit";
      const bytes = await engine.toolImagesToPdf(
        items.map((it) => ({ name: it.name, bytes: it.bytes })),
        { page, margin: page === "fit" ? 0 : Number(opts.margin) },
      );
      const name = items.length === 1 ? `${stem(items[0].name)}.pdf` : "Images.pdf";
      return { files: [{ name, bytes, type: "application/pdf" }], note: plural(items.length, "page") };
    },
  },

  "pdf-to-images": {
    id: "pdf-to-images",
    title: "PDF to images",
    intro: "Save each page as a picture. Several pages come as one ZIP; on a phone you can share them to Photos.",
    takes: "pdf",
    multiple: false,
    min: 1,
    reorder: false,
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
      { kind: "text", key: "pages", label: "Pages", placeholder: "All pages, or e.g. 1-3, 5", value: "" },
    ],
    action: () => "Make images",
    check(items, o) {
      if (o.pages.trim() && items[0] && !parseGroups(o.pages, items[0].pages)) return `Pages must be between 1 and ${items[0].pages}, like “1-3, 5”.`;
      return null;
    },
    async run({ engine, items, opts, progress, cancelled }) {
      const it = items[0];
      const pages = opts.pages.trim() ? [...new Set(parseGroups(opts.pages, it.pages)!.flat())].sort((a, b) => a - b) : [...Array(it.pages).keys()];
      const fmt = opts.format as "png" | "jpeg";
      const ext = fmt === "png" ? "png" : "jpg";
      const width = String(it.pages).length;
      const files: OutFile[] = [];
      // a few pages per call: the file goes to the worker once per batch, with progress between
      for (let k = 0; k < pages.length && !cancelled(); k += 4) {
        const batch = pages.slice(k, k + 4);
        progress(k, pages.length, `Page ${batch[0] + 1} of ${it.pages}…`);
        const out = await engine.toolPagesToImages(src(it), batch, { format: fmt, dpi: Number(opts.dpi), quality: 85 });
        out.forEach((bytes, j) =>
          files.push({ name: `${stem(it.name)}-${String(batch[j] + 1).padStart(width, "0")}.${ext}`, bytes, type: fmt === "png" ? "image/png" : "image/jpeg" }),
        );
      }
      return { files, note: plural(files.length, "picture") };
    },
  },
};
