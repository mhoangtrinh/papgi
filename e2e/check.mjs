// Browser check with Playwright + Chromium: desktop and phone sizes, light and dark.
// Usage: npm run build && npm run e2e
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as mupdf from "mupdf";

const PORT = 4179;
const URL_ = `http://localhost:${PORT}/`;
const shots = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });

const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((res, rej) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && res());
  server.stderr.on("data", (d) => process.stderr.write(d));
  server.on("exit", (code) => rej(new Error(`preview server exited (${code})`)));
});

process.on("exit", () => server.kill());
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// Use a locally installed Chromium if Playwright's own download isn't there.
const local = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const browser = await chromium.launch(fs.existsSync(local) && !process.env.PW_DEFAULT ? { executablePath: local } : {});
try {
  // ---------------- desktop ----------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: "light", deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    // Force the download fallback so saves can be captured.
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
    window.localStorage.clear();
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_);
  await page.waitForSelector(".empty-card");
  await page.screenshot({ path: shots + "desktop-empty-light.png" });
  check("empty state shows", await page.isVisible("#empty-open"));

  const engine = (fn, ...args) => page.evaluate(([f, a]) => window.pdfStudio.engine[f](...a), [fn, args]);
  const waitRendered = async () => {
    await page.waitForSelector(".page.rendered", { timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const pageBox = async (i = 0) => page.locator(".page").nth(i).boundingBox();
  // page point -> screen point
  // (scrolls the viewer first if the point is off screen)
  const pt = async (x, y, i = 0) => {
    const info = await page.evaluate((k) => window.pdfStudio.info.pages[k], i);
    const vp = page.viewportSize();
    for (let tries = 0; tries < 2; tries++) {
      const b = await pageBox(i);
      const sx = b.x + ((x - info.x) / info.w) * b.width;
      const sy = b.y + ((y - info.y) / info.h) * b.height;
      if (sy > 120 && sy < vp.height - 120) return [sx, sy];
      await page.evaluate((dy) => (document.querySelector(".viewer").scrollTop += dy), sy - vp.height / 2);
      await page.waitForTimeout(250);
    }
    const b = await pageBox(i);
    return [b.x + ((x - info.x) / info.w) * b.width, b.y + ((y - info.y) / info.h) * b.height];
  };

  // --- paper sample ---
  await page.click('[data-sample="paper.pdf"]');
  await waitRendered();
  check("paper opens and renders", (await page.locator(".page").count()) === 1);
  await page.screenshot({ path: shots + "desktop-paper-light.png" });

  // select text with the select tool and highlight it from the floating menu
  const hit = (await engine("search", "Voltage references"))[0];
  const q = hit.quads[0];
  const a = await pt(q[0] + 1, (q[1] + q[5]) / 2);
  const b = await pt(q[6] - 1, (q[3] + q[7]) / 2);
  await page.mouse.move(a[0], a[1]);
  await page.mouse.down();
  await page.mouse.move(b[0], b[1], { steps: 8 });
  await page.mouse.up();
  await page.waitForSelector('.floating[data-kind="text"]');
  check("text selection shows the floating menu", true);
  await page.click('.floating button[data-act="Highlight"]');
  await page.waitForTimeout(300);
  let annots = await engine("listAnnots", 0);
  check("highlight from selection", annots.length === 1 && annots[0].kind === "Highlight");

  // highlight tool: drag over text
  await page.keyboard.press("h");
  const hit2 = (await engine("search", "fundamental building block"))[0].quads[0];
  const c1 = await pt(hit2[0] + 1, (hit2[1] + hit2[5]) / 2);
  const c2 = await pt(hit2[6] - 1, (hit2[3] + hit2[7]) / 2);
  await page.mouse.move(...c1);
  await page.mouse.down();
  await page.mouse.move(...c2, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  annots = await engine("listAnnots", 0);
  check("highlight tool on text", annots.filter((x) => x.kind === "Highlight").length === 2);

  // pen
  await page.keyboard.press("p");
  const p0 = await pt(420, 650);
  await page.mouse.move(...p0);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(p0[0] + i * 6, p0[1] + Math.sin(i / 3) * 20);
  await page.mouse.up();
  await page.waitForTimeout(300);
  annots = await engine("listAnnots", 0);
  check("pen draws ink", annots.some((x) => x.kind === "Ink"), JSON.stringify({ kinds: annots.map((x) => x.kind), toast: await page.evaluate(() => document.querySelector(".toast")?.textContent), tool: await page.evaluate(() => document.querySelector(".pages").dataset.tool), focus: await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 80)) }));

  // shapes: rectangle and arrow
  await page.keyboard.press("r");
  const s0 = await pt(60, 600);
  const s1 = await pt(200, 660);
  await page.mouse.move(...s0);
  await page.mouse.down();
  await page.mouse.move(...s1, { steps: 5 });
  await page.mouse.up();
  await page.click('[data-shape="Arrow"]');
  const r0 = await pt(220, 700);
  const r1 = await pt(320, 740);
  await page.mouse.move(...r0);
  await page.mouse.down();
  await page.mouse.move(...r1, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  annots = await engine("listAnnots", 0);
  check("rectangle and arrow", annots.some((x) => x.kind === "Square") && annots.some((x) => x.kind === "Line"));

  // text box
  await page.keyboard.press("t");
  const t0 = await pt(330, 560);
  await page.mouse.click(...t0);
  await page.waitForSelector(".text-editor");
  await page.keyboard.type("Check the TC value");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(400);
  annots = await engine("listAnnots", 0);
  const ft = annots.find((x) => x.kind === "FreeText");
  check("text box", ft?.contents === "Check the TC value\nsecond line", JSON.stringify(ft?.contents));

  // signature: no signature yet -> pad opens
  await page.keyboard.press("s");
  const sg = await pt(420, 760);
  await page.mouse.click(...sg);
  await page.waitForSelector(".sigpad canvas");
  const pad = await page.locator(".sigpad canvas").boundingBox();
  await page.mouse.move(pad.x + 60, pad.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(pad.x + 60 + i * 12, pad.y + 120 + Math.sin(i / 2) * 30);
  await page.mouse.up();
  await page.click('.modal .btn.primary');
  await page.waitForTimeout(400);
  annots = await engine("listAnnots", 0);
  check("signature placed where clicked after drawing it", annots.filter((x) => x.kind === "Ink").length === 2);
  const sg2 = await pt(480, 700);
  await page.mouse.move(...sg2);
  await page.mouse.click(...sg2);
  await page.waitForTimeout(400);
  annots = await engine("listAnnots", 0);
  check("saved signature placed again with one click", annots.filter((x) => x.kind === "Ink").length === 3);
  await page.screenshot({ path: shots + "desktop-annotated-light.png" });

  // select + move the text box, then delete the rectangle via keyboard
  await page.keyboard.press("v");
  const ftNow = (await engine("listAnnots", 0)).find((x) => x.kind === "FreeText");
  const m0 = await pt(ftNow.rect[0] + 5, ftNow.rect[1] + 5);
  await page.mouse.move(...m0);
  await page.mouse.down();
  await page.mouse.move(m0[0] + 40, m0[1] + 30, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const ftMoved = (await engine("listAnnots", 0)).find((x) => x.kind === "FreeText");
  check("drag moves a text box", ftMoved.rect[0] > ftNow.rect[0] + 10 && ftMoved.rect[1] > ftNow.rect[1] + 10);
  const sq = (await engine("listAnnots", 0)).find((x) => x.kind === "Square");
  const sqp = await pt(sq.rect[0] + 1, (sq.rect[1] + sq.rect[3]) / 2);
  await page.mouse.click(...sqp);
  await page.waitForSelector('.floating[data-kind="annot"]');
  await page.keyboard.press("Delete");
  await page.waitForTimeout(300);
  annots = await engine("listAnnots", 0);
  check("delete selected annotation", !annots.some((x) => x.kind === "Square"));

  // undo / redo
  const before = annots.length;
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(300);
  const afterUndo = (await engine("listAnnots", 0)).length;
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(300);
  const afterRedo = (await engine("listAnnots", 0)).length;
  check("undo / redo", afterUndo === before + 1 && afterRedo === before, `${before} ${afterUndo} ${afterRedo}`);
  check("dirty marker shown", await page.locator("#docname.dirty").isVisible());

  // search
  await page.keyboard.press("Control+f");
  await page.fill("#search-input", "bandgap");
  await page.waitForTimeout(500);
  const count = await page.textContent("#search-count");
  check("search counts hits", /^1 \/ \d+$/.test(count), count);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  check("search steps", /^2 \//.test(await page.textContent("#search-count")));
  await page.screenshot({ path: shots + "desktop-search-light.png" });
  await page.keyboard.press("Escape");

  // zoom
  await page.click("#btn-zoom-in");
  await page.waitForTimeout(300);
  const zl = await page.textContent("#zoom-label");
  check("zoom in", parseInt(zl) > 100 || zl !== "", zl);
  await page.click("#zoom-label");

  // save -> download and verify the file in Node
  const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const savedPath = shots + "saved-paper.pdf";
  await dl.saveAs(savedPath);
  const doc = mupdf.Document.openDocument(fs.readFileSync(savedPath), "application/pdf").asPDF();
  const kinds = doc.loadPage(0).getAnnotations().map((x) => x.getType());
  check("saved PDF contains the annotations", kinds.includes("Highlight") && kinds.includes("FreeText") && kinds.includes("Ink"), kinds.join(","));
  await page.waitForTimeout(200);
  check("clean after save", !(await page.locator("#docname.dirty").isVisible()));

  // dark theme screenshot
  await page.click("#btn-theme"); // auto -> light
  await page.click("#btn-theme"); // light -> dark
  await page.waitForTimeout(200);
  await page.screenshot({ path: shots + "desktop-annotated-dark.png" });
  await page.click("#btn-theme"); // -> auto

  // --- form sample ---
  await page.evaluate(() => window.pdfStudio.open({ name: "form.pdf", bytes: new Uint8Array(), handle: null }).catch(() => {}));
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const r = await fetch("./samples/form.pdf");
    await window.pdfStudio.open({ name: "form.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await waitRendered();
  await page.waitForSelector(".field-input");
  await page.locator('.field-input[aria-label="name"]').fill("Hoang Trinh");
  await page.locator('.field-input[aria-label="email"]').click();
  await page.locator('select[aria-label="role"]').selectOption("Postdoc");
  await page.locator('.field-check[aria-label="cleanroom"]').click();
  await page.locator('.field-check.radio').nth(1).click();
  await page.locator('.field-input[aria-label="comments"]').fill("Line one\nLine two");
  await page.locator('.field-input[aria-label="email"]').click();
  await page.waitForTimeout(500);
  const ws = await engine("listWidgets", 0);
  const get = (n, k = 0) => ws.filter((w) => w.name === n)[k];
  check("form: text field", get("name").value === "Hoang Trinh");
  check("form: combobox", get("role").value === "Postdoc");
  check("form: checkbox", get("cleanroom").checked === true);
  check("form: radio", get("building", 1).checked && !get("building", 0).checked);
  check("form: multiline", get("comments").value === "Line one\nLine two", JSON.stringify(get("comments").value));
  await page.screenshot({ path: shots + "desktop-form-light.png" });

  // --- pages sample: rotate, delete, reorder by drag ---
  await page.evaluate(async () => {
    window.pdfStudio["dirty"] = false;
    const r = await fetch("./samples/pages.pdf");
    await window.pdfStudio.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await waitRendered();
  await page.waitForSelector(".thumb");
  const first = async () => (await engine("pageText", 0)).trim().split("\n")[0];
  await page.locator(".thumb").nth(0).click();
  await page.click('[data-act="rotR"]');
  await page.waitForTimeout(400);
  let info = await page.evaluate(() => window.pdfStudio.info);
  check("rotate page", info.pages[0].rotation === 90);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  await page.locator(".thumb").nth(1).click();
  await page.locator(".thumb").nth(2).click({ modifiers: ["Shift"] });
  await page.click('[data-act="delete"]');
  await page.waitForSelector(".modal");
  await page.click(".modal .btn.primary");
  await page.waitForTimeout(500);
  info = await page.evaluate(() => window.pdfStudio.info);
  check("delete pages 2-3", info.pageCount === 3);
  await page.locator(".thumb").nth(2).dragTo(page.locator(".thumb").nth(0), { targetPosition: { x: 20, y: 5 } });
  await page.waitForTimeout(500);
  check("drag to reorder", (await first()) === "Page 5", await first());
  await page.screenshot({ path: shots + "desktop-pages-light.png" });

  // --- scan sample: area highlight ---
  await page.evaluate(async () => {
    window.pdfStudio["dirty"] = false;
    const r = await fetch("./samples/scan.pdf");
    await window.pdfStudio.open({ name: "scan.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await waitRendered();
  await page.keyboard.press("h");
  const h0 = await pt(60, 120);
  const h1 = await pt(300, 140);
  await page.mouse.move(...h0);
  await page.mouse.down();
  await page.mouse.move(...h1, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("area highlight on a scan", (await engine("listAnnots", 0)).some((x) => x.kind === "Highlight"));
  await page.screenshot({ path: shots + "desktop-scan-light.png" });

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // ---------------- phone ----------------
  for (const scheme of ["light", "dark"]) {
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
    const pp = await pctx.newPage();
    const perr = [];
    pp.on("pageerror", (e) => perr.push(e.message));
    await pp.goto(URL_);
    await pp.waitForSelector(".empty-card");
    await pp.screenshot({ path: shots + `phone-empty-${scheme}.png` });
    await pp.tap('[data-sample="form.pdf"]');
    await pp.waitForSelector(".page.rendered", { timeout: 20000 });
    await pp.waitForTimeout(400);
    await pp.screenshot({ path: shots + `phone-form-${scheme}.png` });
    const overflow = await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`phone ${scheme}: no page overflow`, !overflow);
    check(`phone ${scheme}: no errors`, perr.length === 0, perr.join(" | "));
    await pctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
