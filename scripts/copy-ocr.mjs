// Copies the text-recognition engine (tesseract.js) and its language data into public/ocr
// so papgi can serve them itself: nothing is fetched from other sites, and after the first
// use OCR works offline. Runs before every build (npm "prebuild"). The languages are the
// @tesseract.js-data/* packages in package.json (see also src/core/ocrlangs.ts).
import fs from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = path.join(root, "public/ocr");
const nm = (...p) => path.join(root, "node_modules", ...p);
fs.mkdirSync(path.join(out, "lang"), { recursive: true });
const copy = (from, to) => fs.copyFileSync(from, path.join(out, to));
copy(nm("tesseract.js/dist/worker.min.js"), "worker.min.js");
for (const v of ["lstm", "simd-lstm", "relaxedsimd-lstm"]) copy(nm(`tesseract.js-core/tesseract-core-${v}.wasm.js`), `tesseract-core-${v}.wasm.js`);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const langs = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter((d) => d.startsWith("@tesseract.js-data/"))
  .map((d) => d.split("/")[1]);
for (const l of langs) copy(nm(`@tesseract.js-data/${l}/4.0.0_best_int/${l}.traineddata.gz`), `lang/${l}.traineddata.gz`);
console.log(`OCR files copied to public/ocr (${langs.join(", ")})`);
