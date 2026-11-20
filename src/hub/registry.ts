// All tools papgi offers, as shown on the start screen and in the tools menu.
// "editor" tools open a PDF in the editor (with a tool or action ready); "flow" tools are
// stand-alone pages: pick files -> choose options -> get the result.

export type ToolId = "edit" | "sign" | "ocr" | "merge" | "split" | "compress" | "images-to-pdf" | "pdf-to-images";

export interface ToolDef {
  id: ToolId;
  name: string;
  desc: string;
  icon: string;
  kind: "editor" | "flow";
}

export const TOOL_LIST: ToolDef[] = [
  { id: "edit", name: "Edit PDF", desc: "Change text, highlight, draw, add text boxes", icon: "textEdit", kind: "editor" },
  { id: "sign", name: "Fill & sign", desc: "Fill in forms and add your signature", icon: "sign", kind: "editor" },
  { id: "merge", name: "Merge PDFs", desc: "Combine several PDFs into one", icon: "merge", kind: "flow" },
  { id: "split", name: "Split PDF", desc: "Into single pages or chosen ranges", icon: "split", kind: "flow" },
  { id: "compress", name: "Compress PDF", desc: "Make a PDF smaller to send or upload", icon: "compress", kind: "flow" },
  { id: "images-to-pdf", name: "Images to PDF", desc: "Photos and scans (JPG, PNG…) into a PDF", icon: "toPdf", kind: "flow" },
  { id: "pdf-to-images", name: "PDF to images", desc: "Save pages as PNG or JPG pictures", icon: "fromPdf", kind: "flow" },
  { id: "ocr", name: "Recognize text", desc: "Make scans searchable and editable (OCR)", icon: "scan", kind: "editor" },
];

export const tool = (id: string): ToolDef | undefined => TOOL_LIST.find((t) => t.id === id);
