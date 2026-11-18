// Render paper.pdf page 1 to a grey PNG (input for make_scan.py which adds scan noise).
import * as mupdf from "mupdf";
import fs from "node:fs";
const doc = mupdf.Document.openDocument(fs.readFileSync("../../public/samples/paper.pdf"), "application/pdf");
const pix = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(150 / 72, 150 / 72), mupdf.ColorSpace.DeviceGray, false);
fs.writeFileSync("scan_raw.png", pix.asPNG());
