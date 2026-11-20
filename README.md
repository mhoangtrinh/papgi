# papgi

PDF tools that run in your browser: edit text, annotate, fill and sign, merge, split, compress, and convert between PDFs and pictures. Files never leave your device, and it works offline once loaded.

**Live:** https://mhoangtrinh.github.io/papgi/

## Install

- **Windows (Edge or Chrome):** open the link, then click the install icon in the address bar (or menu → *Apps* → *Install papgi*). Once installed, you can right-click a PDF → *Open with* → *papgi*.
- **iPhone:** open the link in Safari → Share → *Add to Home Screen*.

In Edge/Chrome, **Save (Ctrl+S) writes back to the file you opened**. In other browsers, Save downloads a copy.

The start screen lists all tools and your recent files. In the editor, the top-left bar has the papgi button (switch tools), **File** (open, save, print) and **Document** (recognize text, signatures, insert, flatten, send this PDF to Merge/Split/Compress/PDF to images). Tools have their own addresses (e.g. `…/papgi/#merge`) to bookmark, and an installed papgi offers them on right-click of its icon (Windows).

Updates: when a new version is ready, papgi switches to it right away if no document is open; otherwise it shows a small "Reload" bar so unsaved work isn't lost.

## Tools

| Tool | |
|---|---|
| Open PDF | Drop or browse for a PDF; it opens in the editor (below): edit text, highlight and draw, text boxes, fill forms, sign, recognize scans (OCR), pages, print |
| Merge PDFs | All pages of the added files as thumbnails (each file its own colour): drag pages into any order (long-press on a phone), turn or remove single pages, *Reset order* to start again. The size slider makes the thumbnails bigger; *View* (or double-click a page) shows every page full size in the current order (↑/↓ to move, Esc to close). The same viewer is in Split, Images to PDF and PDF to images. Form fields, annotations and signatures come along. Password-protected files ask for the password |
| Split PDF | Single pages, every N pages, or custom ranges (“1-3, 4, 5-”). A preview shows each file it will make: click ✂ between two pages to cut there, *Join* to put a file back together with the one before, turn or leave out pages. Several files come as one ZIP |
| Compress PDF | Light (clean-up only), Recommended (pictures to 150 dpi) or Strong (96 dpi): pictures sharper than the page needs are scaled down and saved as JPEG; text and drawings stay sharp. Never returns a bigger file. The resulting size of each level shows before you press Compress (worked out in the background; pressing Compress then reuses it) |
| Images to PDF | JPG, PNG, GIF, BMP, TIFF (and HEIC/WebP where the browser can read them) on A4, Letter or picture-sized pages; phone photos keep the right way up. A preview shows one page per picture: drag to reorder, turn or remove |
| PDF to images | PNG or JPG at 72/150/300 dpi. A preview shows every page: remove the ones you don't need, turn or reorder the rest; ZIP, or Share (e.g. to Photos) on a phone |

From the editor, the tools menu sends the open PDF straight to Merge, Split, Compress or PDF to images. Results can be downloaded, shared, or opened in the editor.

**Recent files** are kept in this browser only. In Edge/Chrome on a computer papgi remembers the file itself and reopens it from disk; elsewhere it keeps a copy (files up to 40 MB). Samples aren't listed. Remove single files with × or all with *Clear*.

## The editor

| | |
|---|---|
| **Edit text** | Click any paragraph and change the words right on the page. The old text is really removed; the new text is set in the closest bundled font (Latin Modern for LaTeX papers, Carlito/Caladea for Calibri/Cambria, Liberation for Arial/Helvetica/Times/Courier — same letter widths as the originals), re-wrapped and justified like before. Highlights follow their words. |
| View | Fast, sharp rendering (MuPDF in WebAssembly), thumbnails, zoom, search |
| Text | Select and copy text; highlight, underline, strike out |
| Draw | Pen, rectangles, ellipses, arrows, text boxes |
| Sign | Keep up to 5 signatures, drawn or from a photo/scan (paper removed automatically, crop, recolour, or drop/paste the image); saved on this device, pick one and click to place |
| Forms | Fill text fields, tick boxes, radios and drop-downs; flatten |
| Print | Ctrl+P or File → Print: prints the document as it is now (edits, annotations, signatures, filled forms). Chrome/Edge use their PDF print dialog (sharp vector output); iPhone, Safari and Firefox print the rendered pages (about 200 dpi). |
| Pages | **Pages** button: all pages as a grid to drag into order, turn, remove, insert other PDFs, add blank pages (double-click a page to go to it). Also in the sidebar: reorder, rotate, delete, insert, save pages as a new PDF |
| Edit | Move, recolour, delete annotations; full undo/redo for everything |
| **Scans (OCR)** | Recognize text on scanned pages (Document → Recognize text, or the button shown when a scan opens). The words become hidden, selectable text: select, copy, search, highlight. Edit text then works on scans too: the old words are painted over in the paper colour and the new text is written in the ink colour (Sans or Serif). Runs on the device; languages: English, German, Vietnamese, French, Spanish, Italian, Portuguese, Dutch, Polish, Czech, Hungarian, Turkish, Russian, Ukrainian (up to 3 at once). Each language downloads once (1–3 MB) and then works offline. |

Planned next: PDF to Word (as pictures, or fully editable), bold/italic changes while editing text.

Text editing limits: formulas and sub/superscripts inside an edited paragraph are flattened onto one line; rotated text can't be edited yet. On scans, edit only after recognizing the text; Chinese, Japanese, Korean, Arabic and other scripts aren't supported for recognition.

## Controls

| Key | Action |
|---|---|
| V / E / H / P / T / R / S | Select, Edit text, Highlight, Pen, Text box, Shapes, Sign |
| Ctrl+P | Print |
| Edit text: Ctrl+Enter / Esc | Finish / cancel editing a paragraph (clicking outside also finishes) |
| Ctrl+O, Ctrl+S, Ctrl+Shift+S | Open, Save, Save a copy |
| Ctrl+Z, Ctrl+Y | Undo, redo |
| Ctrl+F | Search (Enter / Shift+Enter to step) |
| Ctrl+C | Copy selected text |
| Ctrl + wheel, Ctrl +/−, Ctrl+0 | Zoom, fit width |
| Delete | Delete the selected annotation (or selected pages in the sidebar) |
| Double-click a text box | Edit it (Ctrl+Enter to finish, Esc to cancel) |
| Drag an annotation | Move it, also onto another page |

In the sidebar: click a page to jump, Ctrl/Shift-click to select several, drag to reorder. Drag its right edge to resize it: wider gives bigger pages, and from about 300 px the pages sit side by side, left to right (arrow keys then move by page and by row). The width is remembered; double-click the edge to go back to normal.

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
  engine/ocr.ts      writes recognised words as a hidden text layer on a scanned page
  core/ocrwords.ts   recognition output -> words in page space (columns, sizes, skew; pure, tested)
  core/ocrlangs.ts   the recognition languages on offer
  ui/ocr.ts          recognition dialog, progress, and the tesseract.js runner
  ui/print.ts        printing (browser PDF viewer, or rendered pages)
  engine/tools.ts    merge, split, images <-> PDF, compress (work on copies; unit-tested in Node)
  hub/registry.ts    the list of tools
  hub/flows.ts       each stand-alone tool's options and what it runs
  hub/hub.ts         start screen (tools, recent files) and the tool pages
  hub/viewer.ts      full-size page viewer for the tool previews
  hub/images.ts      recognising dropped files; HEIC/WebP -> JPEG via the browser
  core/zip.ts        small ZIP writer (pure, tested)
  core/exif.ts       camera orientation of JPEG photos (pure, tested)
  recent.ts          recent files in IndexedDB
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
public/ocr/          tesseract.js engine + language data, copied from node_modules on build (scripts/copy-ocr.mjs)
tests/               Vitest unit tests
e2e/check.mjs        Playwright browser check
```

## License

AGPL-3.0-or-later, because it is built on [MuPDF](https://mupdf.com) (AGPL).
