# Third-party software in papgi

papgi itself is licensed under the GNU Affero General Public License v3.0 or later (see `LICENSE`), because it is built on MuPDF. The source code is at https://github.com/mhoangtrinh/papgi.

| Part | Used for | License |
|---|---|---|
| [MuPDF](https://mupdf.com) / [mupdf.js](https://github.com/ArtifexSoftware/mupdf.js) (Artifex Software) | Opening, drawing, editing and writing PDFs; the PDF tools; PDF to Word | AGPL-3.0 |
| [Tesseract](https://github.com/tesseract-ocr/tesseract) via [tesseract.js](https://github.com/naptha/tesseract.js) and tesseract.js-core | Recognize text (OCR) | Apache-2.0 |
| Tesseract language data (`@tesseract.js-data`, "best_int" models) | OCR languages | Apache-2.0 (models), packaged under MIT |
| [Workbox](https://developer.chrome.com/docs/workbox) (via vite-plugin-pwa) | Working offline, updates | MIT |
| Fonts: Liberation Sans/Serif/Mono, Carlito, Caladea, Latin Modern | Text editing with fonts that match the PDF's metrics, the hidden OCR text layer | SIL OFL 1.1 / GUST Font License; full texts in `public/fonts/LICENSES.txt` |
