// All tools papgi offers, as shown on the start screen and in the tools menu.
// "Open PDF" is a page to drop or browse for a PDF, which then opens in the editor (editing
// text, annotating, filling, signing, recognizing scans all happen there). "flow" tools are
// stand-alone pages: pick files -> choose options -> get the result.

export type ToolId = "open" | "merge" | "split" | "compress" | "images-to-pdf" | "pdf-to-images";

export interface ToolDef {
  id: ToolId;
  name: string;
  desc: string;
  icon: string;
  kind: "open" | "flow";
  /** What it covers (shown on the Open PDF card). */
  features?: string[];
}

export const TOOL_LIST: ToolDef[] = [
  {
    id: "open",
    name: "Open PDF",
    desc: "Edit, annotate, fill & sign, recognize scans",
    icon: "file",
    kind: "open",
    features: ["Edit text", "Highlight & draw", "Text boxes", "Fill forms", "Sign", "Recognize text (OCR)", "Pages", "Print"],
  },
  { id: "merge", name: "Merge PDFs", desc: "Combine several PDFs into one", icon: "merge", kind: "flow" },
  { id: "split", name: "Split PDF", desc: "Into single pages or chosen ranges", icon: "split", kind: "flow" },
  { id: "compress", name: "Compress PDF", desc: "Make a PDF smaller to send or upload", icon: "compress", kind: "flow" },
  { id: "images-to-pdf", name: "Images to PDF", desc: "Photos and scans (JPG, PNG…) into a PDF", icon: "toPdf", kind: "flow" },
  { id: "pdf-to-images", name: "PDF to images", desc: "Save pages as PNG or JPG pictures", icon: "fromPdf", kind: "flow" },
];

export const tool = (id: string): ToolDef | undefined => TOOL_LIST.find((t) => t.id === id);
