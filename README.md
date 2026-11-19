# papgi

A PDF editor that runs in your browser. Annotate, highlight, fill forms, sign and rearrange pages. Files never leave your device, and it works offline once loaded.

**Live:** https://mhoangtrinh.github.io/papgi/

## Install

- **Windows (Edge or Chrome):** open the link, then click the install icon in the address bar (or menu → *Apps* → *Install papgi*). Once installed, you can right-click a PDF → *Open with* → *papgi*.
- **iPhone:** open the link in Safari → Share → *Add to Home Screen*.

In Edge/Chrome, **Save (Ctrl+S) writes back to the file you opened**. In other browsers, Save downloads a copy.

## What it does (stage 1)

| | |
|---|---|
| **Edit text** | Click any paragraph and change the words right on the page. The old text is really removed; the new text is set in the original font when possible (otherwise the closest match: Latin Modern for LaTeX papers, Carlito/Caladea for Calibri/Cambria, Liberation for Arial/Times/Courier), re-wrapped and justified like before. Highlights follow their words. |
| View | Fast, sharp rendering (MuPDF in WebAssembly), thumbnails, zoom, search |
| Text | Select and copy text; highlight, underline, strike out |
| Draw | Pen, rectangles, ellipses, arrows, text boxes |
| Sign | Keep up to 5 signatures, drawn or from a photo/scan (paper removed automatically, crop, recolour, or drop/paste the image); saved on this device, pick one and click to place |
| Forms | Fill text fields, tick boxes, radios and drop-downs; flatten |
| Pages | Reorder by drag and drop, rotate, delete, insert other PDFs, add blank pages, save pages as a new PDF |
| Edit | Move, recolour, delete annotations; full undo/redo for everything |
| Scans | Highlight any area (OCR comes later) |

Planned next: OCR for scans, bold/italic changes while editing text, export to Word.

Text editing limits: formulas and sub/superscripts inside an edited paragraph are flattened onto one line; rotated text and scans can't be edited yet.

## Controls

| Key | Action |
|---|---|
| V / E / H / P / T / R / S | Select, Edit text, Highlight, Pen, Text box, Shapes, Sign |
| Edit text: Ctrl+Enter / Esc | Finish / cancel editing a paragraph (clicking outside also finishes) |
| Ctrl+O, Ctrl+S, Ctrl+Shift+S | Open, Save, Save a copy |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+F | Search (Enter / Shift+Enter to step) |
| Ctrl+C | Copy selected text |
| Ctrl + wheel, Ctrl +/−, Ctrl+0 | Zoom, fit width |
| Delete | Delete the selected annotation (or selected pages in the sidebar) |
| Double-click a text box | Edit it (Ctrl+Enter to finish, Esc to cancel) |
| Drag an annotation | Move it, also onto another page |

In the sidebar: click a page to jump, Ctrl/Shift-click to select several, drag to reorder.

## Development

```bash
npm install
npm run dev        # dev server
npm test           # unit tests (engine runs MuPDF in Node against the samples)
npm run build      # production build into dist/
npm run e2e        # browser check with Playwright (run after build); screenshots in e2e/shots/
npm run icons      # regenerate PNG icons from public/favicon.svg
npm run samples    # regenerate the sample PDFs (needs pdflatex + python3 with reportlab, Pillow)
```

## Structure

```
src/
  engine/engine.ts   all PDF work on top of MuPDF (no DOM, unit-tested in Node)
  engine/worker.ts   runs the engine in a Web Worker
  engine/client.ts   promise-based proxy to the worker
  core/geometry.ts   coordinates, stroke simplification, zoom steps (pure, tested)
  core/pages.ts      page selection, reorder and range logic (pure, tested)
  core/signature.ts  turns a signature photo into transparent, cropped ink (pure, tested)
  core/textlayout.ts line breaking / justification for edited paragraphs (pure, tested)
  core/fontmatch.ts  picks the closest bundled font for a PDF font (pure, tested)
  engine/textedit.ts finds paragraphs, removes old text, writes the new text into the page
  ui/viewer.ts       pages, rendering, tools, form fields, search highlights
  ui/sidebar.ts      thumbnails and page actions
  ui/dialogs.ts      toasts and modals
  ui/signature-dialog.ts  draw or picture signature
  ui/text-editor.ts  the in-page paragraph editor
  ui/icons.ts        icons
  app.ts             toolbar, files, shortcuts, wiring
  files.ts           open/save (File System Access API with download fallback)
  storage.ts         settings in localStorage
public/samples/      sample PDFs (paper, form, scan, pages); generators in samples/src/
public/fonts/        fonts for text editing, loaded only when needed (licences in LICENSES.txt)
tests/               Vitest unit tests
e2e/check.mjs        Playwright browser check
```

## License

AGPL-3.0-or-later, because it is built on [MuPDF](https://mupdf.com) (AGPL).
