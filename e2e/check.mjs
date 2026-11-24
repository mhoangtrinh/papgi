// Browser check with Playwright + Chromium: desktop and phone sizes, light and dark.
// Usage: npm run build && npm run e2e
import { chromium } from "@playwright/test";
import { spawn, execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import * as mupdf from "mupdf";
import sharp from "sharp";

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
// COLLECT=1: write every interface text shown (for the translations) to shots/strings.json
const collected = new Set();
const collecting = !!process.env.COLLECT;
const collectIn = async (c) => {
  if (!collecting) return;
  await c.addInitScript(() => (window.__papgiCollect = true));
  await c.exposeFunction("__papgiSeenOut", (s) => collected.add(s));
  await c.exposeFunction("__papgiMissingOut", (s) => collected.add(s));
};
process.on("exit", () => collecting && fs.writeFileSync(shots + "strings.json", JSON.stringify([...collected].sort(), null, 1)));
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// Use a locally installed Chromium if Playwright's own download isn't there.
const local = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const browser = await chromium.launch(fs.existsSync(local) && !process.env.PW_DEFAULT ? { executablePath: local } : {});
try {
  // ---------------- desktop ----------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, colorScheme: "light", deviceScaleFactor: 1, locale: process.env.LOCALE || "en-US" });
  await collectIn(ctx);
  await ctx.addInitScript(() => {
    // Force the download fallback so saves can be captured.
    delete window.showSaveFilePicker;
    delete window.showOpenFilePicker;
    if (window.top === window) window.localStorage.clear(); // (not in frames such as the PDF viewer used for printing)
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_);
  await page.waitForSelector(".hub-home");
  await page.screenshot({ path: shots + "desktop-home-light.png" });
  check("start screen shows the tools", (await page.locator(".tool-card").count()) === 7 && (await page.isVisible("#hub")));
  check("Open PDF comes first and lists what the editor does", (await page.locator(".tool-card").first().getAttribute("data-tool")) === "open" && /Sign/.test(await page.textContent(".tool-card.main")) && /OCR/.test(await page.textContent(".tool-card.main")));
  // About & feedback from the start screen: version, privacy, where to report problems, source
  await page.click('.hub-foot [data-act="about"]');
  await page.waitForSelector(".modal");
  const about = await page.textContent(".modal");
  check("About: version, no uploads, feedback and source links", /Version \d+\.\d+\.\d+/.test(about) && /never uploaded/.test(about) && (await page.locator('.modal a[href*="/issues"]').count()) === 1 && (await page.locator('.modal a[href="https://github.com/mhoangtrinh/papgi"]').count()) === 1, about.slice(0, 120));
  await page.keyboard.press("Escape");
  // a file that isn't a PDF: said in plain words
  await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(["hello, I am not a PDF"], "notes.pdf", { type: "application/pdf" }));
    for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const notPdf = await page.waitForSelector(".toast", { timeout: 10000 }).then((t) => t.textContent());
  check("a file that isn't a PDF: plain-words message", /isn't a PDF, or it is too damaged/.test(notPdf), notPdf);
  await page.goto(URL_);
  await page.waitForSelector(".hub-home");
  // Open PDF: its own page to drop or browse
  await page.click('[data-tool="open"]');
  await page.waitForSelector(".open-page .drop-area");
  check("Open PDF shows a drop / browse page", (await page.evaluate(() => location.hash)) === "#open" && /Browse for a PDF/.test(await page.textContent(".open-page")));
  await page.screenshot({ path: shots + "desktop-open-light.png" });
  {
    const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click(".open-page .drop-area")]);
    await fc.setFiles([new URL("../public/samples/pages.pdf", import.meta.url).pathname]);
    await page.waitForSelector(".page.rendered", { timeout: 20000 });
    check("Open PDF: a browsed file opens in the editor", (await page.evaluate(() => location.hash)) === "#edit" && (await page.locator(".page").count()) === 5);
    // dropping on the Open PDF page opens it too
    await page.goto(URL_ + "#open");
    await page.waitForSelector(".open-page");
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      dt.items.add(new File([await (await fetch("./samples/form.pdf")).arrayBuffer()], "Antrag.pdf", { type: "application/pdf" }));
      for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    const opened = await page.waitForFunction(() => document.querySelector("#docname .name")?.textContent === "Antrag.pdf" && location.hash === "#edit" && !document.querySelector("#hub:not([hidden])"), null, { timeout: 15000 }).then(() => true, () => false);
    check("Open PDF: a dropped file opens in the editor", opened);
    await page.goto(URL_);
    await page.waitForSelector(".hub-home");
  }

  const engine = (fn, ...args) => page.evaluate(([f, a]) => window.papgi.engine[f](...a), [fn, args]);
  const waitRendered = async () => {
    await page.waitForSelector(".page.rendered", { timeout: 20000 });
    await page.waitForTimeout(300);
  };
  const pageBox = async (i = 0) => page.locator(".page").nth(i).boundingBox();
  // page point -> screen point
  // (scrolls the viewer first if the point is off screen)
  const pt = async (x, y, i = 0) => {
    const info = await page.evaluate((k) => window.papgi.info.pages[k], i);
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
  check("a sample opens in the editor", (await page.evaluate(() => location.hash)) === "#edit" && !(await page.isVisible("#hub")));
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
  // watch every frame from release until the page image has the stroke: it must never vanish
  await page.evaluate(() => {
    window.__strokeGone = 0;
    const el = document.querySelector(".page");
    const pv = window.papgi.viewer.pages[0];
    const v0 = pv.version;
    const t0 = performance.now();
    const watch = () => {
      const shown = el.querySelector(".g-preview polyline, .g-pending polyline");
      const drawn = pv.version > v0 && pv.renderedVersion >= pv.version;
      if (drawn) return; // the page image has it now
      if (!shown) window.__strokeGone++;
      if (performance.now() - t0 < 3000) requestAnimationFrame(watch);
    };
    window.addEventListener("pointerup", () => requestAnimationFrame(watch), { once: true });
  });
  await page.mouse.up();
  await page.waitForTimeout(300);
  annots = await engine("listAnnots", 0);
  await page.waitForTimeout(1300);
  check("pen: the stroke never vanishes between release and the redrawn page", (await page.evaluate(() => window.__strokeGone)) === 0 && (await page.locator(".g-pending").count()) === 0);
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
  await page.click('.modal-actions .btn.primary');
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

  // signature from a picture: photo with shading and a desk edge -> transparent ink
  await page.click('[data-act="sig-add"]');
  await page.waitForSelector(".sigdlg");
  await page.click('[data-tab="image"]');
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click('.pic-empty [data-act="pick"]')]);
  await chooser.setFiles(new URL("./fixtures/signature-photo.jpg", import.meta.url).pathname);
  await page.waitForSelector(".pic-work:not([hidden]) .out-canvas:not([hidden])");
  await page.waitForTimeout(300);
  const fullOut = await page.evaluate(() => { const c = document.querySelector(".out-canvas"); return [c.width, c.height]; });
  // crop away the desk: drag over the top 85% of the photo
  const sb = await page.locator(".src-canvas").boundingBox();
  await page.mouse.move(sb.x + 2, sb.y + 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width - 2, sb.y + sb.height * 0.85, { steps: 5 });
  await page.mouse.up();
  await page.click('[data-ink="blue"]');
  await page.waitForTimeout(300);
  const cropOut = await page.evaluate(() => { const c = document.querySelector(".out-canvas"); return [c.width, c.height]; });
  check("picture signature: crop removes the desk edge", cropOut[1] < fullOut[1] && cropOut[1] < 260, `${fullOut} -> ${cropOut}`);
  await page.screenshot({ path: shots + "desktop-signature-picture-light.png" });
  await page.click(".modal-actions .btn.primary");
  await page.waitForTimeout(300);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("papgi.settings.v1")));
  const activeSig = stored.signatures.find((x) => x.id === stored.activeSignature);
  check("second signature (picture) saved as a transparent PNG and selected", stored.signatures.length === 2 && activeSig?.kind === "image" && activeSig.image.src.startsWith("data:image/png"));
  const sp = await pt(150, 760);
  await page.mouse.move(...sp);
  await page.waitForTimeout(100);
  await page.mouse.click(...sp);
  await page.waitForTimeout(500);
  annots = await engine("listAnnots", 0);
  check("picture signature placed as a stamp", annots.some((x) => x.kind === "Stamp"));
  await page.screenshot({ path: shots + "desktop-signature-chips-light.png", clip: { x: 0, y: 48, width: 1440, height: 46 } });
  // switch back to the drawn one
  await page.locator(".sig-chip[data-sigid]").nth(0).click();
  const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem("papgi.settings.v1")));
  check("pick another saved signature", st2.signatures.find((x) => x.id === st2.activeSignature)?.kind === "drawn");
  // up to 5: the add button disappears at the limit
  await page.evaluate(() => {
    const s = window.papgi.settings;
    while (s.signatures.length < 5) s.signatures.push({ ...s.signatures[0], id: "copy" + s.signatures.length });
    window.papgi.renderOptions();
  });
  check("at most 5 signatures", (await page.locator(".sig-chip[data-sigid]").count()) === 5 && (await page.locator('[data-act="sig-add"]').count()) === 0);
  // delete the selected one
  await page.locator(".sig-chip[data-sigid]").nth(4).click();
  await page.click('[data-act="sig-delete"]');
  await page.click(".modal-actions .btn.primary");
  await page.waitForTimeout(200);
  check("delete a signature", (await page.locator(".sig-chip[data-sigid]").count()) === 4 && (await page.locator('[data-act="sig-add"]').count()) === 1);
  await page.locator(".sig-chip[data-sigid]").nth(0).click();

  // drop and paste a picture into the signature dialog
  const photoB64 = fs.readFileSync(new URL("./fixtures/signature-photo.jpg", import.meta.url)).toString("base64");
  const fileEvent = async (how) =>
    page.evaluate(([b64, how]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], "my-signature.jpg", { type: "image/jpeg" }));
      if (how === "paste") {
        document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
        return;
      }
      const el = document.querySelector(".sigdlg");
      for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [photoB64, how]);
  for (const how of ["drop", "paste"]) {
    await page.click('[data-act="sig-add"]');
    await page.waitForSelector(".sigdlg");
    const docBefore = await page.evaluate(() => window.papgi.info.pageCount);
    await fileEvent(how);
    const ok = await page.waitForSelector(".pic-work:not([hidden]) .out-canvas:not([hidden])", { timeout: 5000 }).then(() => true, () => false);
    const tabOn = await page.evaluate(() => document.querySelector('[data-tab="image"]').classList.contains("on"));
    const docAfter = await page.evaluate(() => window.papgi.info.pageCount);
    check(`picture signature by ${how}`, ok && tabOn && docBefore === docAfter);
    if (how === "drop") await page.screenshot({ path: shots + "desktop-signature-drop-light.png" });
    await page.click('.modal-actions [data-v=""]');
    await page.waitForTimeout(200);
  }

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

  // ---- live text editing ----
  await page.keyboard.press("e");
  const introHit = (await engine("search", "Power is the dominant"))[0].quads[0];
  const ip = await pt((introHit[0] + introHit[2]) / 2, (introHit[1] + introHit[5]) / 2);
  await page.mouse.move(ip[0], ip[1]);
  await page.waitForTimeout(400);
  await page.mouse.move(ip[0] + 2, ip[1]);
  check("edit tool highlights the paragraph under the mouse", await page.locator(".hover-block").count() === 1);
  await page.mouse.click(ip[0], ip[1]);
  await page.waitForSelector(".para-editor");
  const edText = await page.locator(".para-editor").innerText();
  check("paragraph opens in the in-page editor", edText.includes("Power is the dominant constraint") && edText.includes("achievable"));
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Edited live in papgi.");
  await page.screenshot({ path: shots + "desktop-textedit-open-light.png" });
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".para-editor", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(500);
  let ptxt = (await engine("pageText", 0)).replace(/\s+/g, " ");
  check("edited text is written into the PDF", ptxt.includes("Edited live in papgi.") && ptxt.includes("Power is the dominant constraint"));
  await page.screenshot({ path: shots + "desktop-textedit-done-light.png" });
  // edit the same paragraph again (re-reading our own text), replacing a word
  const again = (await engine("search", "Edited live in papgi"))[0].quads[0];
  const ap = await pt(again[0] + 3, (again[1] + again[5]) / 2);
  await page.mouse.click(ap[0], ap[1]);
  await page.waitForSelector(".para-editor");
  await page.evaluate(() => {
    const el = document.querySelector(".para-editor");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) if (n.textContent.includes("live")) n.textContent = n.textContent.replace("live", "twice");
  });
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".para-editor", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(400);
  ptxt = (await engine("pageText", 0)).replace(/\s+/g, " ");
  check("a paragraph can be edited again", ptxt.includes("Edited twice in papgi."));
  // Esc cancels
  await page.mouse.click(ap[0], ap[1]);
  await page.waitForSelector(".para-editor");
  await page.keyboard.type("SHOULD NOT APPEAR");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check("Esc cancels an edit", !(await engine("pageText", 0)).includes("SHOULD NOT APPEAR") && (await page.locator(".para-editor").count()) === 0);
  // undo / redo the text edit
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  check("undo a text edit", (await engine("pageText", 0)).replace(/\s+/g, " ").includes("Edited live in papgi."));
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(500);
  // the reported bug: undo, then edit again -> letters came out shifted ("$OOH" for "Alle")
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  const au = (await engine("search", "Edited live in papgi"))[0].quads[0];
  const aup = await pt(au[0] + 3, (au[1] + au[5]) / 2);
  await page.mouse.click(aup[0], aup[1]);
  await page.waitForSelector(".para-editor");
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" After undo.");
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".para-editor", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(500);
  ptxt = (await engine("pageText", 0)).replace(/\s+/g, " ");
  check("edit after undo is not garbled", ptxt.includes("Edited live in papgi. After undo.") && !/\$OOH|\u0000/.test(ptxt));
  await page.screenshot({ path: shots + "desktop-textedit-after-undo-light.png" });
  await page.keyboard.press("v");

  // save -> download and verify the file in Node
  const [dl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
  const savedPath = shots + "saved-paper.pdf";
  await dl.saveAs(savedPath);
  const doc = mupdf.Document.openDocument(fs.readFileSync(savedPath), "application/pdf").asPDF();
  const kinds = doc.loadPage(0).getAnnotations().map((x) => x.getType());
  const savedText = doc.loadPage(0).toStructuredText("").asText().replace(/\s+/g, " ");
  check("saved PDF contains the edited text", savedText.includes("Edited live in papgi. After undo."));
  check("saved PDF contains the annotations", kinds.includes("Highlight") && kinds.includes("FreeText") && kinds.includes("Ink") && kinds.includes("Stamp"), kinds.join(","));
  await page.waitForTimeout(200);
  check("clean after save", !(await page.locator("#docname.dirty").isVisible()));

  // dark theme screenshot
  await page.click("#btn-theme"); // auto -> light
  await page.click("#btn-theme"); // light -> dark
  await page.waitForTimeout(200);
  await page.screenshot({ path: shots + "desktop-annotated-dark.png" });
  await page.click("#btn-theme"); // -> auto

  // --- form sample ---
  await page.evaluate(() => window.papgi.open({ name: "form.pdf", bytes: new Uint8Array(), handle: null }).catch(() => {}));
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    const r = await fetch("./samples/form.pdf");
    await window.papgi.open({ name: "form.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
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
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press("e");
  const th = (await engine("search", "Lab Access Registration"))[0].quads[0];
  const tp = await pt(th[0] + 20, (th[1] + th[5]) / 2);
  await page.mouse.click(...tp);
  await page.waitForSelector(".para-editor");
  await page.evaluate(() => {
    const el = document.querySelector(".para-editor");
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) n.textContent = n.textContent.replace("Registration", "Request — Đăng ký");
  });
  await page.keyboard.press("Control+Enter");
  await page.waitForSelector(".para-editor", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(400);
  check("edit a bold heading in a form (with Vietnamese letters)", (await engine("pageText", 0)).includes("Lab Access Request — Đăng ký"));
  check("form fields still work after editing text", (await engine("listWidgets", 0)).length > 5);
  {
    // the eraser on Everything takes form fields too (and Ctrl+Z brings them back)
    const ws = await engine("listWidgets", 0);
    const f = ws.find((w) => w.kind === "text");
    const b = await pageBox(0);
    const pi = await page.evaluate(() => window.papgi.info.pages[0]);
    const at = (x, y) => [b.x + ((x - pi.x) / pi.w) * b.width, b.y + ((y - pi.y) / pi.h) * b.height];
    const fieldsShown = () => page.locator(".page").nth(0).locator(".page-forms > *").count();
    const shownBefore = await fieldsShown();
    await page.keyboard.press("x");
    if (!(await page.locator('#options [data-erase="1"].on').count())) await page.click('#options [data-erase="1"]');
    const cy = (f.rect[1] + f.rect[3]) / 2;
    await page.mouse.move(...at(f.rect[0] + 10, cy));
    await page.mouse.down();
    await page.mouse.move(...at(f.rect[0] + 40, cy), { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const left = await engine("listWidgets", 0);
    check("the eraser (Everything) removes a form field it touches", left.length === ws.length - 1 && !left.some((w) => w.name === f.name) && (await fieldsShown()) === shownBefore - 1, `${ws.length} -> ${left.length}`);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(600);
    check("undo brings the field back", (await engine("listWidgets", 0)).length === ws.length);
    await page.click('#options [data-erase="0"]');
    // select area: a field moves with its label
    await page.keyboard.press("a");
    await page.mouse.move(...at(40, f.rect[1] - 4));
    await page.mouse.down();
    await page.mouse.move(...at(f.rect[2] + 4, f.rect[3] + 4), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await page.mouse.move(...at(f.rect[0] + 20, cy));
    await page.mouse.down();
    await page.mouse.move(...at(f.rect[0] + 20, cy + 300), { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const movedField = (await engine("listWidgets", 0)).find((w) => w.name === f.name);
    check("select area moves form fields too", !!movedField && Math.abs(movedField.rect[1] - f.rect[1] - 300) < 4 && (await engine("listWidgets", 0)).length === ws.length, JSON.stringify(movedField?.rect));
    // and again: the box stays selected where it landed, so it all moves together again
    await page.mouse.move(...at(f.rect[0] + 20, cy + 300));
    await page.mouse.down();
    await page.mouse.move(...at(f.rect[0] + 20, cy + 400), { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const again = (await engine("listWidgets", 0)).find((w) => w.name === f.name);
    const label = (await engine("listAnnots", 0)).find((a) => a.area);
    check("dragging the box a second time moves the field and its label again", !!again && Math.abs(again.rect[1] - f.rect[1] - 400) < 4 && !!label && Math.abs(label.rect[1] - (f.rect[1] - 4 + 400)) < 8, `${JSON.stringify(again?.rect)} ${JSON.stringify(label?.rect)}`);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(600);
    await page.keyboard.press("v");
  }
  await page.screenshot({ path: shots + "desktop-form-edited-light.png" });
  await page.keyboard.press("v");

  // --- pages sample: rotate, delete, reorder by drag ---
  await page.evaluate(async () => {
    window.papgi["dirty"] = false;
    const r = await fetch("./samples/pages.pdf");
    await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await waitRendered();
  await page.waitForSelector(".thumb");
  const first = async () => (await engine("pageText", 0)).trim().split("\n")[0];
  await page.locator(".thumb").nth(0).click();
  await page.click('[data-act="rotR"]');
  await page.waitForTimeout(400);
  let info = await page.evaluate(() => window.papgi.info);
  check("rotate page", info.pages[0].rotation === 90);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  await page.locator(".thumb").nth(1).click();
  await page.locator(".thumb").nth(2).click({ modifiers: ["Shift"] });
  await page.click('[data-act="delete"]');
  await page.waitForSelector(".modal");
  await page.click(".modal-actions .btn.primary");
  await page.waitForTimeout(500);
  info = await page.evaluate(() => window.papgi.info);
  check("delete pages 2-3", info.pageCount === 3);
  await page.locator(".thumb").nth(2).dragTo(page.locator(".thumb").nth(0), { targetPosition: { x: 20, y: 5 } });
  await page.waitForTimeout(500);
  check("drag to reorder", (await first()) === "Page 5", await first());

  // drag an annotation from page 1 onto page 2
  await page.evaluate(() => { window.papgi.viewer.setZoom(0.5); document.querySelector(".viewer").scrollTop = 0; });
  await page.waitForTimeout(500);
  const raw = async (i, x, y) => {
    const b = await pageBox(i);
    const info = await page.evaluate((k) => window.papgi.info.pages[k], i);
    return [b.x + ((x - info.x) / info.w) * b.width, b.y + ((y - info.y) / info.h) * b.height];
  };
  await page.keyboard.press("p");
  const d0 = await raw(0, 120, 600);
  await page.mouse.move(...d0);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(d0[0] + i * 5, d0[1] + Math.sin(i) * 8);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const inkBefore = (await engine("listAnnots", 0)).find((x) => x.kind === "Ink");
  await page.keyboard.press("v");
  const grab = await raw(0, inkBefore.rect[0] + 2, (inkBefore.rect[1] + inkBefore.rect[3]) / 2);
  const dropAt = await raw(1, 200, 250);
  await page.mouse.move(...grab);
  await page.mouse.down();
  await page.mouse.move(...dropAt, { steps: 15 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: shots + "desktop-drag-across-pages.png" });
  const ghostVisible = await page.locator(".drag-ghost").isVisible();
  await page.mouse.up();
  await page.waitForTimeout(500);
  const pg0 = await engine("listAnnots", 0);
  const pg1 = await engine("listAnnots", 1);
  const movedInk = pg1.find((x) => x.kind === "Ink");
  check("drag ghost follows the pointer across pages", ghostVisible);
  check("annotation dragged to the next page", !pg0.some((x) => x.kind === "Ink") && !!movedInk && Math.abs(movedInk.rect[0] - 198) < 15 && Math.abs((movedInk.rect[1] + movedInk.rect[3]) / 2 - 250) < 15, JSON.stringify(movedInk?.rect));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  check("undo brings it back to page 1", (await engine("listAnnots", 0)).some((x) => x.kind === "Ink") && !(await engine("listAnnots", 1)).some((x) => x.kind === "Ink"));
  await page.screenshot({ path: shots + "desktop-pages-light.png" });

  // --- table of contents in the sidebar ---
  for (const [name, want, kind] of [["report.pdf", 2, "bookmarks"], ["paper.pdf", 8, "headings"]]) {
    await page.evaluate(async (n) => {
      window.papgi["dirty"] = false;
      const r = await fetch("./samples/" + n);
      await window.papgi.open({ name: "contents-" + n, bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    }, name);
    await waitRendered();
    if (!(await page.locator('.side-tabs [data-tab="toc"].on').count())) await page.click('.side-tabs [data-tab="toc"]');
    await page.waitForSelector(".toc-item", { timeout: 10000 }).catch(() => {});
    const items = await page.locator(".toc-item").allTextContents();
    check(`contents panel: ${kind} of ${name}`, items.length === want, items.join(" | ").slice(0, 160));
  }
  await page.evaluate(() => window.papgi.viewer.setZoom(1.5));
  await page.waitForTimeout(300);
  const top0 = await page.evaluate(() => document.querySelector(".viewer").scrollTop);
  await page.locator(".toc-item", { hasText: "References" }).click();
  await page.waitForTimeout(900);
  const top1 = await page.evaluate(() => document.querySelector(".viewer").scrollTop);
  check("clicking a heading scrolls to it", top1 > top0 + 200, `${top0} -> ${top1}`);
  check("the section in view is marked", (await page.locator(".toc-item.current").count()) === 1);
  await page.screenshot({ path: shots + "desktop-contents-light.png" });
  await page.click('.side-tabs [data-tab="pages"]');
  await page.waitForTimeout(200);

  // --- copy, cut, paste, duplicate · select area · eraser ---
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: URL_ });
  await page.evaluate(async () => {
    window.papgi["dirty"] = false;
    const r = await fetch("./samples/pages.pdf");
    await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await waitRendered();
  await page.evaluate(() => { window.papgi.viewer.setZoom(0.75); document.querySelector(".viewer").scrollTop = 0; });
  await page.waitForTimeout(500);
  const inks = async () => (await engine("listAnnots", 0)).filter((x) => x.kind === "Ink");
  await page.keyboard.press("p");
  const q0 = await raw(0, 100, 400);
  await page.mouse.move(...q0);
  await page.mouse.down();
  for (let i = 1; i <= 15; i++) await page.mouse.move(q0[0] + i * 10 * 0.75, q0[1] + Math.sin(i / 3) * 6);
  await page.mouse.up();
  await page.waitForTimeout(400);
  await page.keyboard.press("v");
  const ink0 = (await inks())[0];
  await page.mouse.click(...(await raw(0, ink0.rect[0] + 3, (ink0.rect[1] + ink0.rect[3]) / 2)));
  await page.waitForTimeout(200);
  check("an item's menu has Copy and Duplicate", (await page.locator('.floating [data-act="copy"]').count()) === 1 && (await page.locator('.floating [data-act="duplicate"]').count()) === 1);
  await page.keyboard.press("Control+c");
  await page.waitForTimeout(400);
  await page.mouse.move(...(await raw(0, 300, 600)));
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(700);
  let list = await inks();
  const pasted = list.find((x) => x.rect[1] > 500);
  check("Ctrl+C, Ctrl+V pastes the drawing where the mouse is", list.length === 2 && !!pasted && Math.abs((pasted.rect[0] + pasted.rect[2]) / 2 - 300) < 8 && Math.abs((pasted.rect[1] + pasted.rect[3]) / 2 - 600) < 8, JSON.stringify(pasted?.rect));
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(500);
  check("Ctrl+D duplicates the selected item", (await inks()).length === 3);
  check("the Paste button shows once something is copied", (await page.locator('#options [data-act="paste"]').count()) === 1);
  // select area: drag around the heading of page 1, then drag it down the page
  await page.keyboard.press("a");
  await page.mouse.move(...(await raw(0, 35, 30)));
  await page.mouse.down();
  await page.mouse.move(...(await raw(0, 200, 110)), { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("select area: a box with Copy, Cut and Erase", (await page.locator('.floating[data-kind="area"] [data-act="cut"]').count()) === 1 && (await page.locator('.floating[data-kind="area"] [data-act="erase"]').count()) === 1);
  await page.screenshot({ path: shots + "desktop-area-selected.png" });
  await page.mouse.move(...(await raw(0, 100, 70)));
  await page.mouse.down();
  await page.mouse.move(...(await raw(0, 360, 470)), { steps: 12 });
  await page.waitForTimeout(250);
  const areaGhost = await page.locator(".area-ghost").isVisible();
  await page.screenshot({ path: shots + "desktop-area-moving.png" });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const moved = (await engine("listAnnots", 0)).find((x) => x.area);
  check("dragging the area moves that part of the page (a picture follows the mouse)", areaGhost && !!moved && Math.abs(moved.rect[0] - 295) < 12 && !(await engine("pageText", 0)).includes("Page 1"), JSON.stringify(moved?.rect));
  await page.screenshot({ path: shots + "desktop-area-moved.png" });
  const cursor0 = () => page.evaluate(() => getComputedStyle(document.querySelectorAll(".page")[0]).cursor);
  const afterDrop = await cursor0();
  await page.mouse.move(...(await raw(0, moved.rect[0] + 20, moved.rect[1] + 20)));
  const overMoved = await cursor0();
  await page.mouse.move(...(await raw(0, 450, 760)));
  const elsewhere = await cursor0();
  check("after a move the pointer says it can be dragged again", afterDrop === "move" && overMoved === "move" && elsewhere === "crosshair", `${afterDrop} / ${overMoved} / ${elsewhere}`);
  const leftovers = () => page.evaluate(() => document.querySelectorAll(".page .g-annsel > *, .page .g-area > *").length + (document.querySelector('.floating:not([hidden])[data-kind="annot"]') ? 1 : 0));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);
  check("undoing a move leaves no selection box behind", (await leftovers()) === 0 && (await engine("pageText", 0)).includes("Page 1"));
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(600);
  // the eraser: rub through the first drawing, then (Everything) through the sentence
  await page.keyboard.press("x");
  check("eraser options: added items or everything, and a size", (await page.locator('#options [data-erase="1"]').count()) === 1 && (await page.locator('#options [data-range="eraserSize"]').count()) === 1);
  const inkCount = (await inks()).length;
  await page.mouse.move(...(await raw(0, 160, 380)));
  await page.mouse.down();
  await page.mouse.move(...(await raw(0, 160, 430)), { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const est = await engine("state");
  check("the eraser rubs out part of a drawing (one undo step)", est.undoName === "Erase" && (await inks()).length === inkCount);
  await page.click('#options [data-erase="1"]');
  await page.mouse.move(...(await raw(0, 40, 165)));
  await page.mouse.down();
  await page.mouse.move(...(await raw(0, 420, 165)), { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(800);
  check("with Everything, the eraser removes the PDF's own text", !(await engine("pageText", 0)).includes("reordering"));
  await page.screenshot({ path: shots + "desktop-eraser.png" });
  // pictures and text from other apps
  await page.keyboard.press("v");
  await page.mouse.move(...(await raw(0, 450, 700)));
  const stamps = async () => (await engine("listAnnots", 0)).filter((x) => x.kind === "Stamp" && !x.area).length;
  await page.evaluate(async () => {
    const f = new File([await (await fetch("./pwa-192.png")).blob()], "shot.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(f);
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(800);
  check("pasting a picture from another app puts it on the page", (await stamps()) === 1);
  {
    // resize it by its corner: it keeps its proportions
    const pic = (await engine("listAnnots", 0)).find((x) => x.kind === "Stamp" && !x.area);
    check("a pasted picture is selected with resize handles", (await page.locator(".page .handle").count()) === 4);
    const zoom = await page.evaluate(() => window.papgi.viewer.zoom);
    const se = await raw(0, pic.rect[2] + 3 / zoom, pic.rect[3] + 3 / zoom);
    await page.mouse.move(...se);
    await page.mouse.down();
    await page.mouse.move(se[0] + 60, se[1] + 10, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const pic2 = (await engine("listAnnots", 0)).find((x) => x.kind === "Stamp" && !x.area);
    const ratio = (r) => (r[2] - r[0]) / (r[3] - r[1]);
    check("dragging a corner stretches the picture freely", pic2.rect[2] - pic.rect[2] > 40 && Math.abs(ratio(pic2.rect) - ratio(pic.rect)) > 0.15 && Math.abs(pic2.rect[0] - pic.rect[0]) < 0.5, `${JSON.stringify(pic.rect)} -> ${JSON.stringify(pic2.rect)}`);
    // with Shift it keeps its proportions
    const se2 = await raw(0, pic2.rect[2] + 3 / zoom, pic2.rect[3] + 3 / zoom);
    await page.mouse.move(...se2);
    await page.keyboard.down("Shift");
    await page.mouse.down();
    await page.mouse.move(se2[0] + 50, se2[1] - 20, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await page.waitForTimeout(600);
    const pic3 = (await engine("listAnnots", 0)).find((x) => x.kind === "Stamp" && !x.area);
    check("Shift + corner keeps the proportions", Math.abs(ratio(pic3.rect) - ratio(pic2.rect)) < 0.03 && pic3.rect[2] > pic2.rect[2] + 30, `${JSON.stringify(pic2.rect)} -> ${JSON.stringify(pic3.rect)}`);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(700);
    check("undoing the paste leaves no selection box behind", (await stamps()) === 0 && (await leftovers()) === 0);
    await page.keyboard.press("Control+y");
    await page.keyboard.press("Control+y");
    await page.keyboard.press("Control+y");
    await page.waitForTimeout(600);
  }
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "Pasted from somewhere");
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(600);
  check("pasting text from another app makes a text box", (await engine("listAnnots", 0)).some((x) => x.kind === "FreeText" && x.contents === "Pasted from somewhere"));
  // shapes: a filled triangle, then restyle it from the toolbar
  await page.keyboard.press("r");
  await page.click('#options [data-shape="Triangle"]');
  await page.click('#options [data-pop="fill"]');
  check("shape fill panel opens", await page.isVisible(".opt-pop"));
  await page.click('.opt-pop [data-sfill="#5fd068"]');
  await page.screenshot({ path: shots + "desktop-shape-fill-panel.png" });
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("r");
  const tA = await raw(0, 100, 620);
  await page.mouse.move(...tA);
  await page.mouse.down();
  await page.mouse.move(...(await raw(0, 220, 740)), { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const tri = (await engine("listAnnots", 0)).find((x) => x.shape?.kind === "Triangle");
  check("draws a filled triangle", !!tri && JSON.stringify(tri.shape.fill.map((v) => Math.round(v * 255))) === JSON.stringify([95, 208, 104]), JSON.stringify(tri?.shape));
  await page.keyboard.press("v");
  await page.mouse.click(...(await raw(0, 160, 720)));
  await page.waitForTimeout(300);
  check("selecting a shape shows its style in the toolbar", (await page.locator('#options [data-pop="outline"]').count()) === 1 && (await page.locator('#options [data-pop="fill"]').count()) === 1);
  await page.click('#options [data-pop="outline"]');
  await page.click('.opt-pop [data-sline="dashed"]');
  await page.waitForTimeout(500);
  const tri2 = (await engine("listAnnots", 0)).find((x) => x.shape?.kind === "Triangle");
  check("changing the line style restyles the selected shape", tri2?.shape.line === "dashed" && !!tri2.shape.fill, JSON.stringify(tri2?.shape));
  await page.click('.opt-pop [data-snooutline]');
  await page.waitForTimeout(500);
  const tri3 = (await engine("listAnnots", 0)).find((x) => x.shape?.kind === "Triangle");
  check("No outline keeps just the fill", tri3?.shape.color === null && !!tri3.shape.fill, JSON.stringify(tri3?.shape));
  await page.screenshot({ path: shots + "desktop-shape-selected.png" });
  await page.mouse.click(...(await raw(0, 500, 820)));

  // saved: the moved part is page content again
  const savedArea = await page.evaluate(async () => Array.from(await window.papgi.engine.save(false)));
  {
    const d = new mupdf.PDFDocument(new Uint8Array(savedArea));
    const p0 = d.loadPage(0);
    const txt = p0.toStructuredText("").asText();
    const hasArea = p0.getAnnotations().some((a) => a.getObject().get("PapgiArea").isBoolean());
    check("saving turns the moved part back into page text", txt.includes("Page 1") && !hasArea && !txt.includes("reordering"));
    d.destroy();
  }

  // --- organize pages (editor): the Pages button ---
  {
    const pc = await page.evaluate(() => window.papgi.info.pageCount);
    const label = async (i) => ((await engine("pageText", i)).match(/page \d+ of \d+/) ?? ["?"])[0];
    const labelsNow = async () => { const out = []; for (let i = 0; i < (await page.evaluate(() => window.papgi.info.pageCount)); i++) out.push(await label(i)); return out; };
    const start = await labelsNow();
    await page.click("#btn-organize");
    await page.waitForFunction((n) => document.querySelectorAll(".organize .ptile img").length === n, pc, { timeout: 20000 });
    check("Pages button: all pages as a grid", (await page.locator(".organize .ptile").count()) === pc && (await page.locator("#btn-organize.on").count()) === 1);
    await page.screenshot({ path: shots + "desktop-organize-light.png" });
    // drag the last page in front of the first
    const ts = page.locator(".organize .ptile");
    const lastB = await ts.nth(pc - 1).boundingBox();
    const firstB = await ts.nth(0).boundingBox();
    await page.mouse.move(lastB.x + lastB.width / 2, lastB.y + lastB.height / 2);
    await page.mouse.down();
    await page.mouse.move(lastB.x + lastB.width / 2 - 20, lastB.y + lastB.height / 2, { steps: 4 });
    await page.mouse.move(firstB.x + 12, firstB.y + firstB.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const moved = await labelsNow();
    check("Pages: dragging reorders the document", moved[0] === start[pc - 1] && moved[1] === start[0], moved.join(" | "));
    // turn page 2, remove page 3 (keyboard)
    await page.hover(".organize .ptile >> nth=1");
    await page.click(".organize .ptile >> nth=1 >> [data-turn]");
    await page.waitForTimeout(500);
    await page.focus(".organize .ptile >> nth=2");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(700);
    const info2 = await page.evaluate(() => window.papgi.info);
    check("Pages: turn and remove pages", info2.pages[1].rotation === 90 && info2.pageCount === pc - 1 && (await page.locator(".organize .ptile").count()) === pc - 1, `rot ${info2.pages[1].rotation}, ${info2.pageCount} pages`);
    // undo everything with Ctrl+Z: the grid follows
    for (let k = 0; k < 3; k++) {
      await page.keyboard.press("Control+z");
      await page.waitForTimeout(500);
    }
    await page.waitForFunction((n) => document.querySelectorAll(".organize .ptile img").length === n, pc, { timeout: 20000 });
    check("Pages: Ctrl+Z undoes, the grid follows", (await labelsNow()).join() === start.join() && (await page.evaluate(() => window.papgi.info.pages.every((p) => p.rotation === 0))));
    // double-click a page: back to the editor at that page
    await page.dblclick(".organize .ptile >> nth=2");
    await page.waitForTimeout(600);
    const inView = await page.evaluate(() => {
      const r = document.querySelectorAll(".viewer .page")[2].getBoundingClientRect();
      const v = document.querySelector(".viewer").getBoundingClientRect();
      return r.top < v.bottom - 50 && r.bottom > v.top + 50;
    });
    check("Pages: double-click opens that page in the editor", !(await page.isVisible(".organize")) && inView);
  }

  // --- printing ---
  const pcount = await page.evaluate(() => window.papgi.info.pageCount);
  // (headless Chromium can't open a print dialog and crashes if asked to: catch the final call)
  await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
      configurable: true,
      get() {
        const w = desc.get.call(this);
        if (w && this.classList.contains("print-frame")) w.print = () => (window.__framePrinted = true);
        return w;
      },
    });
  });
  await page.keyboard.press("Control+p");
  await page.waitForFunction(() => window.__framePrinted === true, null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const framePdf = await page.evaluate(async () => {
    const f = document.querySelector("iframe.print-frame");
    const b = new Uint8Array(await (await fetch(f.src)).arrayBuffer());
    return { head: String.fromCharCode(...b.slice(0, 5)), size: b.length, printed: window.__framePrinted === true, toast: document.querySelector(".toast.show")?.textContent ?? "" };
  });
  check("print (Chrome/Edge): the current PDF goes to the browser's PDF viewer", framePdf.head === "%PDF-" && framePdf.size > 1000 && framePdf.printed && !/Couldn't print/.test(framePdf.toast), JSON.stringify(framePdf));
  check("print doesn't count as saving", await page.locator("#docname.dirty").isVisible());
  check("keyboard stays on papgi after printing", await page.evaluate(() => document.activeElement?.tagName !== "IFRAME"), await page.evaluate(() => document.activeElement?.tagName));
  // other browsers (iPhone, Safari, Firefox): page images in a print-only layer
  await page.evaluate(() => {
    Object.defineProperty(Navigator.prototype, "pdfViewerEnabled", { get: () => false, configurable: true });
    window.__printed = -1;
    window.print = () => (window.__printed = document.querySelectorAll("#print-root img").length);
  });
  await page.keyboard.press("Control+p");
  await page.waitForFunction(() => window.__printed >= 0, null, { timeout: 30000 });
  check("print (iPhone/Safari/Firefox): every page rendered for printing", (await page.evaluate(() => window.__printed)) === pcount, `${await page.evaluate(() => window.__printed)} of ${pcount}`);
  await page.emulateMedia({ media: "print" });
  check("print layout: only the pages are visible", (await page.locator("#print-root img").evaluateAll((ims) => ims.filter((im) => im.getBoundingClientRect().width > 100).length)) === pcount && !(await page.locator(".topbar, .viewer").first().isVisible()));
  await page.screenshot({ path: shots + "desktop-print-preview.png" });
  await page.emulateMedia({ media: null }); // (page.pdf uses screen styles while screen is forced)
  const printedPdf = await page.pdf({ preferCSSPageSize: true });
  const printedPages = (await import("mupdf")).Document.openDocument(printedPdf, "application/pdf").countPages();
  check("print layout: one sheet per page", printedPages === pcount, `${printedPages} sheets for ${pcount} pages`);
  await page.evaluate(() => delete Navigator.prototype.pdfViewerEnabled);

  // --- text box: the text must not jump when you finish typing ---
  {
    const ink = async (buf) => {
      const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
      let sx = 0, sy = 0, n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      for (let y = 0; y < info.height; y++)
        for (let x = 0; x < info.width; x++) {
          const v = 255 - data[y * info.width + x];
          if (v < 40) continue;
          sx += v * x; sy += v * y; n += v;
          if (v > 100) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        }
      return { cx: sx / n, cy: sy / n, x0, x1, y0, y1 };
    };
    for (let i = 0; i < 3; i++) await page.keyboard.press("Control+=");
    await page.waitForTimeout(500);
    await page.keyboard.press("t");
    await page.mouse.click(...(await pt(120, 520)));
    await page.waitForSelector(".text-editor");
    await page.keyboard.type("Hamburg Quality 123");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Second line gjpq");
    await page.waitForTimeout(400);
    const r = await page.locator(".text-editor").boundingBox();
    const clip = { x: Math.round(r.x - 12), y: Math.round(r.y - 12), width: Math.round(r.width + 40), height: Math.round(r.height + 24) };
    await page.evaluate(() => Object.assign(document.querySelector(".text-editor").style, { borderColor: "transparent", background: "transparent", caretColor: "transparent" }));
    const typing = await ink(await page.screenshot({ clip }));
    await page.keyboard.press("Control+Enter");
    await page.mouse.move(5, 5); // (no hover outline in the picture)
    await page.waitForTimeout(1500);
    const done = await ink(await page.screenshot({ clip }));
    const dx = done.cx - typing.cx, dy = done.cy - typing.cy;
    const edges = (a, b) => [a.x0 - b.x0, a.y0 - b.y0, a.x1 - b.x1, a.y1 - b.y1];
    check("text box: text stays put when you finish typing", Math.abs(dx) < 1.2 && Math.abs(dy) < 1.2 && edges(done, typing).every((v) => Math.abs(v) <= 1), `moved ${dx.toFixed(2)}, ${dy.toFixed(2)} px, edges ${edges(done, typing)}`);
    // and again when the box is opened for editing
    await page.keyboard.press("v");
    await page.mouse.dblclick(...(await pt(140, 528)));
    await page.waitForSelector(".text-editor");
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    await page.evaluate(() => Object.assign(document.querySelector(".text-editor").style, { borderColor: "transparent", background: "transparent", caretColor: "transparent" }));
    const reopened = await ink(await page.screenshot({ clip }));
    check("text box: reopening it shows the text in the same place", Math.abs(reopened.cx - done.cx) < 1.2 && Math.abs(reopened.cy - done.cy) < 1.2 && edges(reopened, done).every((v) => Math.abs(v) <= 1), `moved ${(reopened.cx - done.cx).toFixed(2)}, ${(reopened.cy - done.cy).toFixed(2)} px, edges ${edges(reopened, done)}`);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    for (let i = 0; i < 3; i++) await page.keyboard.press("Control+-");
    await page.waitForTimeout(400);
  }


  // --- scan sample: area highlight ---
  await page.evaluate(async () => {
    window.papgi["dirty"] = false;
    const r = await fetch("./samples/scan.pdf");
    await window.papgi.open({ name: "scan.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await waitRendered();
  check("scan: offers text recognition when opened", /looks like a scan/.test(await page.textContent(".toast")) && (await page.locator(".toast .toast-action").isVisible()));
  await page.keyboard.press("h");
  const h0 = await pt(60, 120);
  const h1 = await pt(300, 140);
  await page.mouse.move(...h0);
  await page.mouse.down();
  await page.mouse.move(...h1, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  check("area highlight on a scan", (await engine("listAnnots", 0)).some((x) => x.kind === "Highlight"));
  await page.keyboard.press("e");
  const sc = await pt(150, 330);
  await page.mouse.click(...sc);
  await page.waitForTimeout(400);
  check("scan: edit tool offers to recognize the text", /no text yet/.test(await page.textContent(".toast")));

  // --- text recognition (OCR) ---
  await page.click(".toast .toast-action");
  await page.waitForSelector(".ocr-dialog");
  const chipOn = () => page.$$eval(".lang-chip.on", (bs) => bs.map((b) => b.dataset.lang));
  check("OCR dialog: German + English chosen by default", JSON.stringify(await chipOn()) === JSON.stringify(["eng", "deu"]) || JSON.stringify((await chipOn()).sort()) === JSON.stringify(["deu", "eng"]), JSON.stringify(await chipOn()));
  await page.click('.lang-chip[data-lang="vie"]');
  const disabled = await page.locator(".lang-chip:disabled").count();
  check("OCR dialog: Vietnamese can be added, at most 3 languages", (await chipOn()).includes("vie") && disabled > 5, `${await chipOn()} disabled=${disabled}`);
  await page.click('.lang-chip[data-lang="vie"]');
  await page.screenshot({ path: shots + "desktop-ocr-dialog-light.png" });
  const ocrT0 = Date.now();
  await page.click(".modal-actions .btn.primary");
  await page.waitForSelector(".ocr-progress");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shots + "desktop-ocr-progress-light.png" });
  await page.waitForFunction(() => /Recognized \d+ words/.test(document.querySelector(".toast")?.textContent ?? "") || /failed/.test(document.querySelector(".toast")?.textContent ?? ""), null, { timeout: 180000 });
  const ocrToast = await page.textContent(".toast");
  check("OCR: recognizes the scan in the browser", /Recognized \d+ words/.test(ocrToast), `${ocrToast} (${((Date.now() - ocrT0) / 1000).toFixed(1)} s)`);
  console.log(`   OCR took ${((Date.now() - ocrT0) / 1000).toFixed(1)} s`);
  const ocrText = (await engine("pageText", 0)).replace(/\s+/g, " ");
  check("OCR: text is selectable/searchable", ocrText.includes("Voltage references are a fundamental") && (await engine("search", "Bandgap Reference")).length > 0);
  check("OCR: settings remember the languages", (await page.evaluate(() => JSON.parse(localStorage.getItem("papgi.settings.v1")).ocrLangs)).sort().join() === "deu,eng");
  // UI search finds recognised words
  await page.keyboard.press("Control+f");
  await page.fill("#search-input", "neural recording");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  check("OCR: search bar finds recognised words", /^1 \/ \d+$/.test(await page.textContent("#search-count")), await page.textContent("#search-count"));
  await page.keyboard.press("Escape");
  // edit a recognised paragraph
  await page.keyboard.press("e");
  await page.mouse.click(...(await pt(150, 340)));
  await page.waitForSelector(".para-editor");
  const ocrEd = await page.textContent(".para-editor");
  check("OCR: a recognised paragraph opens in the editor", ocrEd.includes("Voltage references") && ocrEd.includes("every mixed-signal") && ocrEd.includes("(CTAT)."), ocrEd.slice(0, 80));
  check("OCR: Sans/Serif choice offered, no formula warning", (await page.locator('.floating [data-act="serif"]').count()) === 1 && (await page.locator(".floating .float-warn").count()) === 0);
  await page.click('.floating [data-act="serif"]');
  await page.click(".para-editor");
  await page.keyboard.press("Control+a");
  await page.keyboard.type("This scanned paragraph was recognised and rewritten in papgi.");
  await page.screenshot({ path: shots + "desktop-ocr-editing-light.png" });
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(1500);
  const ocrAfter = (await engine("pageText", 0)).replace(/\s+/g, " ");
  check("OCR: edited text replaces the scanned paragraph", ocrAfter.includes("recognised and rewritten in papgi.") && !ocrAfter.includes("fundamental building block"));
  check("OCR: serif font used", (await page.evaluate(() => JSON.parse(localStorage.getItem("papgi.settings.v1")).ocrSerif)) === true);
  await page.keyboard.press("v");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shots + "desktop-scan-light.png" });
  // the menu entry
  await page.click("#btn-doc");
  check("OCR: in the Document menu (left of the top bar)", await page.locator('#doc-menu [data-menu="ocr"]').isVisible());
  await page.screenshot({ path: shots + "desktop-doc-menu-light.png" });
  await page.click("#btn-file");
  check("File menu: open, save, print; one menu at a time", (await page.locator('#file-menu [data-menu="print"]').isVisible()) && !(await page.locator("#doc-menu").isVisible()));
  const leftOfZoom = await page.evaluate(() => document.querySelector("#btn-file").getBoundingClientRect().right < document.querySelector("#zoom-label").getBoundingClientRect().left);
  check("File/Document menus sit on the left", leftOfZoom);
  await page.keyboard.press("Escape");

  // ---------------- tools ----------------
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "papgi-e2e-"));
    const samplesDir = new URL("../public/samples/", import.meta.url).pathname;
    // downloads instead of "Save as" dialogs (headless browsers can't show those)
    await page.evaluate(() => {
      window.showSaveFilePicker = undefined;
    });
    const download = async (click) => {
      const [d] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), click()]);
      const p = path.join(tmp, d.suggestedFilename());
      await d.saveAs(p);
      return { name: d.suggestedFilename(), bytes: new Uint8Array(fs.readFileSync(p)) };
    };
    const pdfPages = (bytes) => mupdf.Document.openDocument(bytes, "application/pdf").countPages();
    const zipNames = (bytes) => {
      const f = path.join(tmp, "x.zip");
      fs.writeFileSync(f, bytes);
      return execSync(`python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print('\\n'.join(z.namelist()))" ${f}`).toString().trim().split("\n");
    };
    const choose = async (files) => {
      const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click(".drop-area")]);
      await fc.setFiles(files);
    };
    const waitDone = () => page.waitForSelector(".flow-result:not([hidden])", { timeout: 60000 });

    // from the editor: compress the open document
    await page.click("#btn-tools");
    check("tools menu in the editor", await page.locator("#tools-menu").isVisible());
    await page.click('#tools-menu [data-goto="compress"]');
    await page.waitForSelector('[data-flow="compress"] .file-row');
    check("tools menu: Compress opens with this PDF", (await page.textContent(".file-row")).includes("scan.pdf") && (await page.evaluate(() => location.hash)) === "#compress");
    // the size of each level shows before compressing
    await page.waitForFunction(() => [...document.querySelectorAll("[data-est]")].every((e) => /\d/.test(e.textContent)), null, { timeout: 30000 });
    const ests = await page.$$eval("[data-est]", (e) => e.map((x) => x.textContent));
    check("compress: sizes shown before running", ests.length === 3 && /KB|MB/.test(ests[0]) && /KB|MB|already/.test(await page.textContent(".est-line")), ests.join() + " / " + (await page.textContent(".est-line")));
    await page.click('[data-choose="level"][data-value="strong"]');
    check("compress: the line follows the chosen level", (await page.textContent(".est-line")).includes(ests[2]), await page.textContent(".est-line"));
    await page.screenshot({ path: shots + "desktop-tool-compress-estimate-light.png" });
    await page.click("[data-act=run]");
    await waitDone();
    const comp = await download(() => page.click("[data-act=save-all]"));
    check("compress: makes a working PDF", comp.name === "scan (compressed).pdf" && pdfPages(comp.bytes) === 1, `${comp.name} ${comp.bytes.length} B: ${await page.textContent(".result-head")}`);
    await page.screenshot({ path: shots + "desktop-tool-compress-light.png" });
    // back to the editor: the document is still open there
    await page.click(".to-editor");
    check("back to the editor keeps the document", (await page.evaluate(() => location.hash)) === "#edit" && (await page.locator(".page").count()) === 1);

    // merge: home -> card -> two files -> reorder -> merge
    await page.click("#btn-tools");
    await page.click('#tools-menu [data-goto="home"]');
    await page.waitForSelector(".hub-home");
    await page.click('[data-tool="merge"]');
    await page.waitForSelector('[data-flow="merge"]');
    check("merge: button waits for files", await page.locator("[data-act=run]").isDisabled());
    await choose([path.join(samplesDir, "form.pdf"), path.join(samplesDir, "pages.pdf")]);
    await page.waitForFunction(() => document.querySelectorAll(".file-row").length === 2);
    const formPages = pdfPages(fs.readFileSync(path.join(samplesDir, "form.pdf")));
    await page.waitForFunction((n) => document.querySelectorAll(".flow .ptile").length === n && document.querySelectorAll(".flow .ptile img").length === n, formPages + 5, { timeout: 20000 });
    check("merge: shows every page of both files", (await page.locator(".flow .ptile").count()) === formPages + 5);
    const labels = () => page.$$eval(".flow .ptile .psrc", (els) => els.map((e) => e.textContent));
    // drag the last page (B·5) in front of the first one, with the mouse
    const tiles = page.locator(".flow .ptile");
    const last = await tiles.nth(formPages + 4).boundingBox();
    const first = await tiles.nth(0).boundingBox();
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2 - 20, last.y + last.height / 2, { steps: 4 });
    await page.mouse.move(first.x + 12, first.y + first.height / 2, { steps: 12 });
    await page.screenshot({ path: shots + "desktop-tool-merge-drag-light.png" });
    await page.mouse.up();
    const afterDrag = await labels();
    check("merge: drag a page to the front", afterDrag[0] === "B·5" && afterDrag[1] === "A·1", afterDrag.join(" "));
    // turn the new first page, remove page A·1 (now 2nd) via keyboard
    await page.hover(".flow .ptile >> nth=0");
    await page.click('.flow .ptile >> nth=0 >> [data-turn]');
    await page.focus('.flow .ptile >> nth=1');
    await page.keyboard.press("Delete");
    // move the (new) 2nd page one step left with Ctrl+Left
    await page.focus('.flow .ptile >> nth=1');
    await page.keyboard.press("Control+ArrowLeft");
    const final = await labels();
    check("merge: turn, remove and keyboard-move pages", final.length === formPages + 4 && final[0] === (formPages > 1 ? "A·2" : "B·1") && final[1] === "B·5", final.join(" "));
    await page.screenshot({ path: shots + "desktop-tool-merge-light.png" });
    await page.click("[data-act=run]");
    await waitDone();
    const merged = await download(() => page.click("[data-act=save-all]"));
    const mdoc = mupdf.Document.openDocument(merged.bytes, "application/pdf");
    const text = (i) => mdoc.loadPage(i).toStructuredText().asText();
    const b0 = mdoc.loadPage(1).getBounds();
    check("merge: the PDF follows the page view", mdoc.countPages() === formPages + 4 && text(1).includes("page 5 of 5") && b0[2] - b0[0] > b0[3] - b0[1], `${mdoc.countPages()} pages; p2: ${text(1).slice(0, 30)}`);
    // the order resets to file order
    await page.click("[data-act=reset-order]");
    // full-size viewer: opens at the double-clicked page, arrows move, Esc closes
    await page.dblclick(".flow .ptile >> nth=2");
    await page.waitForFunction(() => document.querySelectorAll(".pv-sheet.ready").length >= 1, null, { timeout: 15000 });
    check("merge: viewer opens at the chosen page", (await page.locator(".pv-page").count()) === formPages + 5 && (await page.textContent(".pv-where")).startsWith("Page 3 of"), await page.textContent(".pv-where"));
    await page.screenshot({ path: shots + "desktop-tool-merge-view-light.png" });
    await page.keyboard.press("ArrowDown");
    await page.waitForFunction(() => document.querySelector(".pv-where").textContent.startsWith("Page 4"), null, { timeout: 5000 }).catch(() => {});
    check("merge viewer: next page", (await page.textContent(".pv-where")).startsWith("Page 4"), await page.textContent(".pv-where"));
    await page.keyboard.press("Escape");
    check("merge viewer: Esc closes, the tool stays", (await page.locator(".pviewer").count()) === 0 && (await page.evaluate(() => location.hash)) === "#merge");
    // bigger tiles
    const w0 = (await page.locator(".flow .ptile >> nth=0").boundingBox()).width;
    await page.fill("[data-size]", "240");
    const w1 = (await page.locator(".flow .ptile >> nth=0").boundingBox()).width;
    check("merge: page size slider", w1 > w0 * 1.5, `${w0} -> ${w1}`);
    await page.fill("[data-size]", "124");
    check("merge: reset order", (await labels()).join(" ") === [...Array(formPages)].map((_, i) => `A·${i + 1}`).concat([1, 2, 3, 4, 5].map((i) => `B·${i}`)).join(" "));

    // split, opened straight from its address
    await page.goto(URL_ + "#split");
    await page.waitForSelector('[data-flow="split"]');
    // results are normal downloads, never a "Save as" dialog (a picker that is there must stay unused)
    await page.evaluate(() => {
      window.__picked = 0;
      window.showSaveFilePicker = async () => {
        window.__picked++;
        throw new Error("no dialog wanted");
      };
    });
    check("tools open from their address", (await page.textContent(".flow-head h1")) === "Split PDF");
    await choose([path.join(samplesDir, "pages.pdf")]);
    await page.waitForSelector(".file-row");
    await page.click('[data-choose="mode"][data-value="ranges"]');
    await page.fill('[data-input="ranges"]', "1-2, 9");
    check("split: bad ranges are explained", (await page.locator("[data-act=run]").isDisabled()) && /between 1 and 5/.test(await page.textContent(".flow-error")));
    await page.fill('[data-input="ranges"]', "1-2, 3-");
    await page.waitForFunction(() => document.querySelectorAll(".split-view .stile img").length === 5, null, { timeout: 20000 });
    const heads = () => page.$$eval(".split-head b", (bs) => bs.map((b) => b.textContent).join(" "));
    check("split: preview shows the files it will make", (await heads()) === "pages-p1-2.pdf pages-p3-5.pdf", await heads());
    // edit the preview: cut after page 3, turn page 1, leave out page 5, join page 4 back to page 3
    await page.click('[data-scut="1,0"]');
    check("split preview: cut makes a new file", (await heads()) === "pages-p1-2.pdf pages-p3.pdf pages-p4-5.pdf", await heads());
    await page.hover(".split-row >> nth=0 >> .stile >> nth=0");
    await page.click('[data-sturn="0,0"]');
    await page.hover(".split-row >> nth=2 >> .stile >> nth=1");
    await page.click('[data-sdel="2,1"]');
    await page.click('[data-sjoin="2"]');
    check("split preview: turn, remove and join", (await heads()) === "pages-p1-2.pdf pages-p3-4.pdf" && (await page.textContent(".split-count")) === "(2 files)", await heads());
    await page.screenshot({ path: shots + "desktop-tool-split-light.png" });
    await page.click("[data-act=run]");
    await waitDone();
    const parts = await download(() => page.click("[data-act=save-all]"));
    check("split: a ZIP that matches the preview", JSON.stringify(zipNames(parts.bytes)) === JSON.stringify(["pages-p1-2.pdf", "pages-p3-4.pdf"]), zipNames(parts.bytes).join());
    const unzip = (bytes, name) => {
      const f = path.join(tmp, "y.zip");
      fs.writeFileSync(f, bytes);
      return new Uint8Array(execSync(`python3 -c "import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))" ${f} "${name}"`));
    };
    const p1 = mupdf.Document.openDocument(unzip(parts.bytes, "pages-p1-2.pdf"), "application/pdf");
    const p2 = mupdf.Document.openDocument(unzip(parts.bytes, "pages-p3-4.pdf"), "application/pdf");
    const wide = (d, i) => { const b = d.loadPage(i).getBounds(); return b[2] - b[0] > b[3] - b[1]; };
    check("split: turned page and left-out page", p1.countPages() === 2 && wide(p1, 0) && !wide(p1, 1) && p2.countPages() === 2 && p2.loadPage(1).toStructuredText().asText().includes("Page 4"), p2.loadPage(1).toStructuredText().asText().slice(0, 20));
    await page.click("[data-act=reset-parts]");
    check("split preview: reset", (await heads()) === "pages-p1-2.pdf pages-p3-5.pdf", await heads());

    // PDF to images
    await page.goto(URL_ + "#pdf-to-images");
    await page.waitForSelector('[data-flow="pdf-to-images"]');
    await page.evaluate(() => (window.showSaveFilePicker = undefined));
    await choose([path.join(samplesDir, "pages.pdf")]);
    await page.waitForSelector(".file-row");
    await page.waitForFunction(() => document.querySelectorAll(".flow .ptile img").length === 5, null, { timeout: 20000 });
    await page.click('[data-choose="format"][data-value="jpeg"]');
    // leave out pages 1, 4 and 5, turn page 3
    for (const i of [0, 2, 2]) {
      await page.focus(`.flow .ptile >> nth=${i}`);
      await page.keyboard.press("Delete");
    }
    await page.hover(".flow .ptile >> nth=1");
    await page.click(".flow .ptile >> nth=1 >> [data-turn]");
    check("PDF to images: preview with the chosen pages", (await page.locator(".flow .ptile").count()) === 2 && /2 pictures/.test(await page.textContent("[data-act=run]")), await page.textContent("[data-act=run]"));
    await page.screenshot({ path: shots + "desktop-tool-pdf-to-images-light.png" });
    await page.click("[data-act=run]");
    await waitDone();
    const pics = await download(() => page.click("[data-act=save-all]"));
    check("PDF to images: chosen pages as JPGs", JSON.stringify(zipNames(pics.bytes)) === JSON.stringify(["pages-2.jpg", "pages-3.jpg"]), zipNames(pics.bytes).join());
    const third = await sharp(Buffer.from(unzip(pics.bytes, "pages-3.jpg"))).metadata();
    check("PDF to images: turned page comes out turned", third.width > third.height, `${third.width}x${third.height}`);
    const one = await download(() => page.click('[data-out="0"]'));
    check("PDF to images: single picture download", one.bytes[0] === 0xff && one.bytes[1] === 0xd8);

    // PDF to Word: editable, then as pictures
    await page.goto(URL_ + "#pdf-to-word");
    await page.waitForSelector('[data-flow="pdf-to-word"]');
    await page.evaluate(() => (window.showSaveFilePicker = undefined));
    await choose([path.join(samplesDir, "paper.pdf")]);
    await page.waitForFunction(() => document.querySelectorAll(".flow .ptile img").length === 1, null, { timeout: 20000 });
    check("PDF to Word: button names the pages", /Make Word file \(1 page\)/.test(await page.textContent("[data-act=run]")), await page.textContent("[data-act=run]"));
    await page.screenshot({ path: shots + "desktop-tool-word-light.png" });
    await page.click("[data-act=run]");
    await waitDone();
    const word = await download(() => page.click("[data-act=save-all]"));
    const wordXml = (bytes) => {
      const f = path.join(tmp, "w.docx");
      fs.writeFileSync(f, bytes);
      return execSync(`python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read('word/document.xml').decode()); print('MEDIA', len([n for n in z.namelist() if n.startswith('word/media/')]))" ${f}`).toString();
    };
    const wx = wordXml(word.bytes);
    check("tool results (split, merge, word…): normal downloads, never a save dialog", (await page.evaluate(() => window.__picked)) === 0);
    check("PDF to Word: an editable .docx", word.name === "paper.docx" && wx.includes("Curvature Correction") && wx.includes('w:num="2"') && wx.includes("Heading"), `${word.name} ${word.bytes.length} B`);
    await page.click('[data-choose="mode"][data-value="pictures"]');
    await page.click("[data-act=run]");
    await waitDone();
    const wordPics = await download(() => page.click("[data-act=save-all]"));
    const wp = wordXml(wordPics.bytes);
    check("PDF to Word: as pictures", !wp.includes("Curvature Correction") && /MEDIA 1/.test(wp) && wp.includes("<wp:anchor"), wp.slice(-40));

    // images to PDF, then open the result in the editor
    const img1 = path.join(tmp, "Foto 1.png");
    const img2 = path.join(tmp, "IMG_2.jpg");
    await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toFile(img1);
    await sharp({ create: { width: 600, height: 900, channels: 3, background: { r: 200, g: 60, b: 40 } } }).jpeg().withMetadata({ orientation: 6 }).toFile(img2);
    await page.goto(URL_ + "#images-to-pdf");
    await page.waitForSelector('[data-flow="images-to-pdf"]');
    await choose([img1, img2]);
    await page.waitForFunction(() => document.querySelectorAll(".flow .ptile img").length === 2, null, { timeout: 15000 });
    // second picture first, then turn the first picture (now second)
    await page.focus(".flow .ptile >> nth=1");
    await page.keyboard.press("Control+ArrowLeft");
    await page.hover(".flow .ptile >> nth=1");
    await page.click(".flow .ptile >> nth=1 >> [data-turn]");
    await page.screenshot({ path: shots + "desktop-tool-images-light.png" });
    await page.click("[data-act=run]");
    await waitDone();
    await page.click("[data-act=open-result]");
    // the edited scan is still open in the editor: papgi asks before replacing it
    await page.waitForSelector(".modal-back");
    check("opening a result over unsaved work asks first", /unsaved changes/.test(await page.textContent(".modal-back")));
    await page.click(".modal-actions .btn.primary");
    await page.waitForFunction(() => document.querySelector("#docname .name")?.textContent === "Images.pdf", null, { timeout: 15000 });
    await waitRendered();
    const imgInfo = await page.evaluate(() => window.papgi.info.pages.map((p) => [Math.round(p.w), Math.round(p.h)]));
    check("images to PDF: follows the preview (order, turn)", JSON.stringify(imgInfo) === JSON.stringify([[842, 595], [595, 842]]), JSON.stringify(imgInfo));
    check("images to PDF: opens in the editor", (await page.evaluate(() => location.hash)) === "#edit" && (await page.textContent("#docname .name")) === "Images.pdf");

    // recent files
    await page.goto(URL_);
    await page.waitForSelector(".recent-item", { timeout: 10000 });
    const recent = await page.$$eval(".recent-item .recent-text b", (bs) => bs.map((b) => b.textContent));
    check("recent files list opened files (not samples)", recent[0] === "Images.pdf" && !recent.includes("paper.pdf"), recent.join());
    await page.screenshot({ path: shots + "desktop-home-recent-light.png" });
    await page.click(".recent-item");
    await waitRendered();
    check("recent file reopens in the editor", (await page.textContent("#docname .name")) === "Images.pdf" && (await page.locator(".page").count()) === 2);
    await page.goto(URL_);
    await page.waitForSelector(".recent-item");
    await page.click(".recent-x");
    await page.waitForTimeout(300);
    check("recent file can be removed", (await page.locator(".recent-item").count()) === recent.length - 1);

    // dropping two PDFs on the start screen goes to Merge
    await page.evaluate(async () => {
      const dt = new DataTransfer();
      for (const n of ["pages.pdf", "form.pdf"]) dt.items.add(new File([await (await fetch("./samples/" + n)).arrayBuffer()], n, { type: "application/pdf" }));
      for (const type of ["dragenter", "dragover", "drop"]) window.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-flow="merge"] .file-row').length === 2, null, { timeout: 15000 });
    check("dropping PDFs on the start screen opens Merge with them", (await page.evaluate(() => location.hash)) === "#merge");

    // dark start screen
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(URL_);
    await page.waitForSelector(".hub-home");
    await page.screenshot({ path: shots + "desktop-home-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
  }

  // ---- pages panel: drag wider -> pages side by side; reorder there; double-click resets ----
  {
    await page.goto(URL_);
    await page.waitForSelector(".hub-home");
    await page.evaluate(async () => {
      location.hash = "#edit";
      const r = await fetch("./samples/pages.pdf");
      await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    });
    await waitRendered();
    await page.waitForSelector(".thumb");
    const w0 = await page.evaluate(() => document.querySelector(".sidebar").offsetWidth);
    const hd = await page.locator(".side-resize").boundingBox();
    await page.mouse.move(hd.x + hd.width / 2, hd.y + 300);
    await page.mouse.down();
    await page.mouse.move(hd.x + 120, hd.y + 300, { steps: 6 });
    const listW = await page.evaluate(() => [document.querySelector(".sidebar").classList.contains("grid"), document.querySelector(".thumb").offsetWidth]);
    await page.mouse.move(hd.x + 360, hd.y + 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => {
      const t = [...document.querySelectorAll(".thumb")];
      return { w: document.querySelector(".sidebar").offsetWidth, grid: document.querySelector(".sidebar").classList.contains("grid"), cols: t.filter((x) => x.offsetTop === t[0].offsetTop).length, saved: JSON.parse(localStorage.getItem("papgi.settings.v1")).sidebarWidth };
    });
    check("pages panel: a bit wider keeps the list with bigger pages", !listW[0] && listW[1] >= 190, JSON.stringify(listW));
    check("pages panel: wide shows pages left to right, width remembered", st.grid && st.cols >= 2 && st.w > w0 + 300 && st.saved === st.w, JSON.stringify(st));
    await page.screenshot({ path: shots + "desktop-pages-panel-wide-light.png" });
    // pages never got smaller on the way
    // zoom: smaller pages -> more columns; Ctrl + wheel bigger again; remembered
    const cols = () => page.evaluate(() => getComputedStyle(document.querySelector(".thumbs")).gridTemplateColumns.split(" ").length);
    const c0 = await cols();
    await page.click('.side-zoom [data-zoom="-1"]');
    await page.click('.side-zoom [data-zoom="-1"]');
    const c1 = await cols();
    const tw1 = (await page.locator(".thumb >> nth=0").boundingBox()).width;
    const tb = await page.locator(".thumbs").boundingBox();
    await page.mouse.move(tb.x + tb.width / 2, tb.y + 200);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -120);
    await page.keyboard.up("Control");
    await page.waitForTimeout(500);
    const tw2 = (await page.locator(".thumb >> nth=0").boundingBox()).width;
    const zsaved = await page.evaluate(() => JSON.parse(localStorage.getItem("papgi.settings.v1")).sidebarZoom);
    check("pages panel: zoom out gives more columns, Ctrl+wheel zooms in, remembered", c1 > c0 && tw2 > tw1 && Math.abs(zsaved - tw2) < 2, `${c0}->${c1} cols, ${tw1}->${tw2}px, saved ${zsaved}`);
    await page.screenshot({ path: shots + "desktop-pages-panel-zoom-light.png" });
    // drag page 4 in front of page 1 in the grid
    const t1 = await page.locator(".thumb").nth(0).boundingBox();
    await page.locator(".thumb").nth(3).dragTo(page.locator(".thumb").nth(0), { targetPosition: { x: 8, y: t1.height / 2 } });
    await page.waitForTimeout(600);
    check("pages panel (wide): drag reorders left to right", (await engine("pageText", 0)).includes("page 4 of 5"));
    // arrows move by rows
    await page.locator(".thumb").nth(0).click();
    await page.waitForTimeout(500);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(500);
    const cur = () => page.evaluate(() => [...document.querySelectorAll(".thumb")].findIndex((x) => x.classList.contains("current")));
    check("pages panel (wide): arrow right goes to the next page", (await cur()) === 1, String(await cur()));
    await page.click('.side-zoom [data-zoom="1"]');
    await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("papgi.settings.v1"));
      s.sidebarZoom = 0;
      localStorage.setItem("papgi.settings.v1", JSON.stringify(s));
    });
    await page.locator(".side-resize").dblclick();
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => [document.querySelector(".sidebar").offsetWidth, document.querySelector(".sidebar").classList.contains("grid"), JSON.parse(localStorage.getItem("papgi.settings.v1")).sidebarWidth]);
    check("pages panel: double-click the edge resets it", back[0] === w0 && !back[1] && back[2] === 0, JSON.stringify(back));
  }

  // ---- document tools: watermark, page numbers, redaction, password, notes, picture from a file ----
  {
    await page.evaluate(async () => {
      window.papgi["dirty"] = false;
      location.hash = "#edit";
      const r = await fetch("./samples/pages.pdf");
      await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    });
    await waitRendered();
    await page.evaluate(() => { window.papgi.viewer.setZoom(0.75); document.querySelector(".viewer").scrollTop = 0; });
    await page.waitForTimeout(500);
    const docMenu = async (item) => {
      await page.click("#btn-doc");
      await page.click(`#doc-menu [data-menu="${item}"]`);
      await page.waitForSelector(".modal");
    };
    const allText = async () => (await Promise.all([0, 1, 2, 3, 4].map((i) => engine("pageText", i)))).map((t) => t.replace(/\s+/g, " "));
    // watermark: a wrong page range keeps the dialog open and says why
    await docMenu("watermark");
    await page.waitForTimeout(150);
    check("watermark dialog: text, size, opacity, direction, colour, pages, preview", (await page.locator('.modal [data-k="text"]').count()) === 1 && (await page.locator(".modal .dt-wm").textContent()) === "CONFIDENTIAL" && (await page.locator(".modal [data-angle]").count()) === 2);
    await page.fill('.modal [data-k="text"]', "DRAFT");
    await page.fill('.modal [data-k="pages"]', "9-12");
    await page.click('.modal [data-v="ok"]');
    check("watermark: a wrong page range is explained, the dialog stays", (await page.locator(".modal").count()) === 1 && /from 1 to 5/.test(await page.textContent(".modal .dt-error")));
    await page.fill('.modal [data-k="pages"]', "");
    await page.screenshot({ path: shots + "desktop-watermark-dialog.png" });
    await page.click('.modal [data-v="ok"]');
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForTimeout(800);
    let txt = await allText();
    check("watermark on every page (one undo step)", txt.every((t) => t.includes("DRAFT")) && (await engine("state")).undoName === "Watermark", txt[4].slice(0, 60));
    await page.screenshot({ path: shots + "desktop-watermark.png" });
    // page numbers "1 / 5", nothing on the title page
    await docMenu("numbers");
    await page.selectOption('.modal [data-k="format"]', "{page} / {pages}");
    await page.check('.modal [data-k="skipFirst"]');
    await page.waitForTimeout(100);
    const prev = await page.textContent(".modal .dt-bc");
    await page.click('.modal [data-v="ok"]');
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForTimeout(800);
    txt = await allText();
    check("page numbers: preview, then 1 / 4 … 4 / 4 after a bare title page", prev === "1 / 4" && txt[1].includes("1 / 4") && txt[4].includes("4 / 4") && !/\d \/ \d/.test(txt[0]), `${prev} · ${txt[1].slice(-12)} · ${txt[4].slice(-12)}`);
    // redact a word everywhere: live count, then gone from every page
    await docMenu("redact");
    await page.fill('.modal [data-k="q"]', "rotating");
    await page.waitForFunction(() => /Found in 5 places/.test(document.querySelector(".modal .dt-count")?.textContent ?? ""), null, { timeout: 5000 });
    await page.click('.modal [data-v="ok"]');
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForTimeout(800);
    txt = await allText();
    check("redact a text everywhere: count shown, then removed from all pages", txt.every((t) => !t.includes("rotating") && t.includes("deleting")), txt[0]);
    // redact an area: the heading of page 1
    await page.keyboard.press("a");
    await page.mouse.move(...(await raw(0, 35, 30)));
    await page.mouse.down();
    await page.mouse.move(...(await raw(0, 200, 110)), { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    await page.click('.floating[data-kind="area"] [data-act="redact"]');
    await page.waitForTimeout(800);
    txt = await allText();
    check("select area → Redact removes what's under the box", !txt[0].includes("Page 1") && txt[1].includes("Page 2") && (await engine("state")).undoName === "Redact", txt[0].slice(0, 40));
    await page.screenshot({ path: shots + "desktop-redacted.png" });
    // sticky note: N, click, type, Ctrl+Enter; the select tool shows its text
    await page.keyboard.press("n");
    await page.mouse.click(...(await raw(0, 480, 300)));
    await page.waitForSelector(".modal textarea");
    await page.keyboard.type("Check this figure");
    await page.keyboard.press("Control+Enter");
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForTimeout(600);
    const note = (await engine("listAnnots", 0)).find((x) => x.kind === "Text");
    check("note tool: click, write, a note on the page", note?.contents === "Check this figure", JSON.stringify(note));
    await page.keyboard.press("v");
    await page.mouse.click(...(await raw(0, (note.rect[0] + note.rect[2]) / 2, (note.rect[1] + note.rect[3]) / 2)));
    await page.waitForTimeout(300);
    check("clicking a note shows its text", (await page.textContent(".floating .note-peek").catch(() => "")) === "Check this figure");
    await page.screenshot({ path: shots + "desktop-note.png" });
    await page.click(".floating .note-peek");
    await page.waitForSelector(".modal textarea");
    await page.fill(".modal textarea", "Changed");
    await page.click('.modal [data-v="ok"]');
    await page.waitForTimeout(600);
    check("a note's text can be changed", (await engine("listAnnots", 0)).find((x) => x.kind === "Text")?.contents === "Changed");
    // a picture from a file
    const pics = async () => (await engine("listAnnots", 0)).filter((x) => x.kind === "Stamp" && !x.area).length;
    const p0 = await pics();
    await page.click("#btn-doc");
    const [fc] = await Promise.all([page.waitForEvent("filechooser"), page.click('#doc-menu [data-menu="picture"]')]);
    await fc.setFiles([new URL("../public/pwa-192.png", import.meta.url).pathname]);
    await page.waitForTimeout(900);
    check("Add a picture… puts the file's picture on the page, ready to resize", (await pics()) === p0 + 1 && (await page.locator(".page .handle").count()) === 4);
    // password: set it, save, the file needs it to open
    await docMenu("password");
    await page.fill('.modal [data-k="p1"]', "s3cret");
    await page.fill('.modal [data-k="p2"]', "other");
    await page.click('.modal [data-v="ok"]');
    check("password: different passwords are refused", (await page.locator(".modal").count()) === 1 && /aren't the same/.test(await page.textContent(".modal .dt-error")));
    await page.fill('.modal [data-k="p2"]', "s3cret");
    await page.click('.modal [data-v="ok"]');
    await page.waitForSelector(".modal", { state: "detached" });
    const [pdl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    await pdl.saveAs(shots + "saved-protected.pdf");
    const pdoc = mupdf.Document.openDocument(fs.readFileSync(shots + "saved-protected.pdf"), "application/pdf");
    const needs = pdoc.needsPassword();
    const wrong = pdoc.authenticatePassword("nope");
    const right = pdoc.authenticatePassword("s3cret");
    const ptext = right ? pdoc.loadPage(1).toStructuredText("").asText() : "";
    const pann = right ? pdoc.loadPage(0).getAnnotations().map((a) => a.getType()) : [];
    check("saved with a password: locked, opens with it, keeps every change", needs && !wrong && !!right && ptext.includes("DRAFT") && ptext.includes("1 / 4") && !ptext.includes("rotating") && pann.includes("Text"), `${needs} ${wrong} ${right} ${pann}`);
    // remove it again
    await docMenu("password");
    check("password dialog offers Remove when the file is protected", (await page.locator('.modal [data-v="remove"]').count()) === 1);
    await page.click('.modal [data-v="remove"]');
    await page.waitForSelector(".modal", { state: "detached" });
    const [udl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    await udl.saveAs(shots + "saved-unprotected.pdf");
    check("password removed: the saved file opens without one", !mupdf.Document.openDocument(fs.readFileSync(shots + "saved-unprotected.pdf"), "application/pdf").needsPassword());
    await page.keyboard.press("v");
  }

  // ---- crop pages, and making form fields ----
  {
    await page.evaluate(async () => {
      window.papgi["dirty"] = false;
      const r = await fetch("./samples/pages.pdf");
      await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    });
    await waitRendered();
    await page.evaluate(() => { window.papgi.viewer.setZoom(0.75); document.querySelector(".viewer").scrollTop = 0; });
    await page.waitForTimeout(500);
    const docMenu = async (item) => {
      await page.click("#btn-doc");
      await page.click(`#doc-menu [data-menu="${item}"]`);
      await page.waitForSelector(".modal");
    };
    const h0 = (await engine("info")).pages.map((p) => p.h);
    // crop: drag the top edge down, all pages
    await docMenu("crop");
    await page.waitForSelector(".crop-stage canvas");
    await page.waitForTimeout(300);
    const hn = await page.locator('.crop-h[data-h="n"]').boundingBox();
    await page.mouse.move(hn.x + hn.width / 2, hn.y + hn.height / 2);
    await page.mouse.down();
    await page.mouse.move(hn.x + hn.width / 2, hn.y + 40, { steps: 5 });
    await page.mouse.up();
    const topMm = Number(await page.inputValue('.modal [data-side="top"]'));
    check("crop: dragging the box's top edge sets the top margin", topMm > 20, String(topMm));
    await page.selectOption('.modal [data-k="target"]', "all");
    await page.screenshot({ path: shots + "desktop-crop-dialog.png" });
    await page.click('.modal [data-v="ok"]');
    await page.waitForSelector(".modal", { state: "detached" });
    await page.waitForTimeout(700);
    let hs = (await engine("info")).pages.map((p) => p.h);
    check("crop: the view stays on the page you were on", (await page.inputValue("#page-input")) === "1");
    check("crop: every page loses the same strip; one undo step", hs.every((h, i) => Math.abs(h0[i] - h - topMm * 2.835) < 4) && (await engine("state")).undoName === "Crop", hs.map(Math.round).join(","));
    // trim page 1 to what's printed, then remove the crop again
    await docMenu("crop");
    await page.click('.modal [data-act="trim"]');
    await page.waitForTimeout(300);
    await page.click('.modal [data-v="ok"]');
    await page.waitForTimeout(700);
    hs = (await engine("info")).pages.map((p) => p.h);
    check("crop: Trim white margins cuts a page down to its content", hs[0] < h0[0] * 0.4, hs.map(Math.round).join(","));
    await docMenu("crop");
    check("crop: a cropped page offers Remove crop", (await page.locator('.modal [data-v="reset"]').count()) === 1);
    await page.selectOption('.modal [data-k="target"]', "all");
    await page.click('.modal [data-v="reset"]');
    await page.waitForTimeout(700);
    hs = (await engine("info")).pages.map((p) => p.h);
    check("crop: Remove crop shows whole pages again", hs.every((h, i) => Math.abs(h - h0[i]) < 1), hs.map(Math.round).join(","));
    await page.screenshot({ path: shots + "desktop-uncropped.png" });

    // form fields: the Form tool (F)
    await page.evaluate(() => (document.querySelector(".viewer").scrollTop = 0));
    await page.waitForTimeout(200);
    await page.keyboard.press("f");
    check("Form tool: a field kind picker", (await page.locator("#options [data-field]").count()) === 7);
    const place = async (kind, x, y, to) => {
      await page.click(`#options [data-field="${kind}"]`);
      const a = await raw(0, x, y);
      if (to) {
        await page.mouse.move(...a);
        await page.mouse.down();
        await page.mouse.move(...(await raw(0, ...to)), { steps: 5 });
        await page.mouse.up();
      } else await page.mouse.click(...a);
      await page.waitForTimeout(450);
    };
    await place("text", 80, 300);
    await place("multiline", 80, 340, [300, 400]);
    await place("checkbox", 90, 430);
    await place("radio", 90, 460);
    await place("radio", 140, 460);
    await place("combobox", 80, 500);
    await place("date", 80, 540);
    await place("signature", 80, 580);
    let ws = await engine("listWidgets", 0);
    await page.screenshot({ path: shots + "desktop-form-tool.png" });
    check("Form tool: text, several lines, check box, radio pair, drop-down, date, signature", ws.map((w) => w.kind).join() === "text,text,checkbox,radio,radio,combobox,text,signature" && ws[3].name === ws[4].name && ws[1].multiline && !!ws[6].dateFormat, ws.map((w) => `${w.kind}:${w.name}`).join(" "));
    check("Form tool: new fields are numbered by kind", ws[0].name === "Text 1" && ws[1].name === "Text 2" && ws[2].name === "Check box 1");
    check("Form tool: fields show their names", (await page.locator(".page .fieldname").count()) >= 8);
    await page.screenshot({ path: shots + "desktop-form-tool.png" });
    // drag a field somewhere else, resize it by its corner
    const t0 = ws[0].rect;
    const c0 = await raw(0, (t0[0] + t0[2]) / 2, (t0[1] + t0[3]) / 2);
    await page.mouse.move(...c0);
    await page.mouse.down();
    await page.mouse.move(c0[0] + 120, c0[1] - 90, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const t1 = (await engine("listWidgets", 0))[0].rect;
    const zoom = await page.evaluate(() => window.papgi.viewer.zoom);
    check("Form tool: drag moves a field", Math.abs(t1[0] - t0[0] - 120 / zoom) < 3 && Math.abs(t1[1] - t0[1] + 90 / zoom) < 3, JSON.stringify(t1));
    const se = await raw(0, t1[2] + 3 / zoom, t1[3] + 3 / zoom);
    await page.mouse.move(...se);
    await page.mouse.down();
    await page.mouse.move(se[0] + 60, se[1] + 20, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const t2 = (await engine("listWidgets", 0))[0].rect;
    check("Form tool: a corner resizes a field", t2[2] - t1[2] > 50 / zoom * 0.9 && t2[3] - t1[3] > 10, JSON.stringify(t2));
    // settings: rename the drop-down and give it choices
    const dd = ws[5].rect;
    await page.mouse.click(...(await raw(0, (dd[0] + dd[2]) / 2, (dd[1] + dd[3]) / 2)));
    await page.waitForTimeout(250);
    await page.click('.floating[data-kind="field"] button[data-act="props"]');
    await page.waitForSelector('.modal [data-k="options"]');
    await page.fill('.modal [data-k="name"]', "Colour");
    await page.fill('.modal [data-k="options"]', "Red\nGreen\nBlue");
    await page.check('.modal [data-k="required"]');
    await page.screenshot({ path: shots + "desktop-field-settings.png" });
    await page.click('.modal [data-v="ok"]');
    await page.waitForTimeout(500);
    const w5 = (await engine("listWidgets", 0))[5];
    check("field settings: name, choices, required", w5.name === "Colour" && w5.options.join() === "Red,Green,Blue" && w5.required, JSON.stringify([w5.name, w5.options, w5.required]));
    // Ctrl+D copies the selected field, Delete removes it
    await page.keyboard.press("Control+d");
    await page.waitForTimeout(500);
    const n1 = (await engine("listWidgets", 0)).length;
    await page.keyboard.press("Delete");
    await page.waitForTimeout(500);
    check("Form tool: Ctrl+D copies a field, Delete removes it", n1 === 9 && (await engine("listWidgets", 0)).length === 8);
    // fill the new form with the Select tool
    await page.keyboard.press("v");
    await page.waitForTimeout(300);
    check("Select tool: new fields can be filled, signature box says Sign here", (await page.locator(".page-forms .field-input").count()) >= 4 && (await page.locator(".page-forms .field-sign").count()) === 1);
    await page.locator(".page-forms input.field-input:not(.field-date)").first().fill("Hoang");
    await page.keyboard.press("Enter");
    await page.locator(".page-forms .field-check.radio").nth(1).click();
    await page.locator(".page-forms select.field-input").selectOption("Green");
    await page.waitForTimeout(400);
    await page.locator(".page-forms input.field-date").fill("2026-11-24");
    await page.waitForTimeout(600);
    const vals = (await engine("listWidgets", 0)).map((w) => w.value);
    const fmt = (await engine("listWidgets", 0))[6].dateFormat;
    check("filling: text, radio, drop-down, date (written in the field's format)", vals[0] === "Hoang" && vals[4] !== "Off" && vals[5] === "Green" && vals[6] === fmt.replace("yyyy", "2026").replace("mm", "11").replace("dd", "24"), JSON.stringify(vals));
    await page.locator(".page-forms .field-sign").click();
    await page.waitForSelector(".modal", { timeout: 5000 });
    check("Sign here asks for a signature when there's none yet", (await page.locator(".modal").count()) === 1);
    await page.keyboard.press("Escape");
    await page.screenshot({ path: shots + "desktop-form-filled.png" });
    // saved: real form fields with the values
    const [fdl] = await Promise.all([page.waitForEvent("download"), page.keyboard.press("Control+s")]);
    await fdl.saveAs(shots + "saved-form.pdf");
    const fdoc = mupdf.Document.openDocument(fs.readFileSync(shots + "saved-form.pdf"), "application/pdf");
    const fw = fdoc.loadPage(0).getWidgets().map((w) => [w.getFieldType(), w.getName(), w.getValue()]);
    check("saved: the new fields are real form fields with their values", fw.length === 8 && fw[0][2] === "Hoang" && fw[5][1] === "Colour" && fw[5][2] === "Green" && fdoc.getTrailer().get("Root", "AcroForm", "Fields").length === 7, JSON.stringify(fw));
    await page.keyboard.press("v");
  }

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // ---------------- phone ----------------
  for (const scheme of ["light", "dark"]) {
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
    await collectIn(pctx);
    const pp = await pctx.newPage();
    const perr = [];
    pp.on("pageerror", (e) => perr.push(e.message));
    await pp.goto(URL_);
    await pp.waitForSelector(".hub-home");
    await pp.screenshot({ path: shots + `phone-home-${scheme}.png` });
    check(`phone ${scheme}: start screen fits`, !(await pp.evaluate(() => document.querySelector("#hub").scrollWidth > window.innerWidth)));
    await pp.goto(URL_ + "#split");
    await pp.waitForSelector('[data-flow="split"]');
    const [pfc] = await Promise.all([pp.waitForEvent("filechooser"), pp.tap(".drop-area")]);
    await pfc.setFiles([new URL("../public/samples/pages.pdf", import.meta.url).pathname]);
    await pp.waitForSelector(".file-row");
    await pp.screenshot({ path: shots + `phone-tool-split-${scheme}.png` });
    await pp.tap(".split-view [data-act=view]");
    await pp.waitForFunction(() => document.querySelectorAll(".pv-sheet.ready").length >= 1, null, { timeout: 15000 });
    await pp.waitForTimeout(200);
    await pp.screenshot({ path: shots + `phone-tool-view-${scheme}.png` });
    const sheetW = (await pp.locator(".pv-sheet >> nth=0").boundingBox()).width;
    check(`phone ${scheme}: viewer pages fit the screen`, sheetW > 300 && sheetW <= 390, String(sheetW));
    await pp.tap('[data-pv="close"]');
    check(`phone ${scheme}: viewer closes`, (await pp.locator(".pviewer").count()) === 0 && (await pp.evaluate(() => location.hash)) === "#split");
    check(`phone ${scheme}: tool page fits`, !(await pp.evaluate(() => document.querySelector("#hub").scrollWidth > window.innerWidth)));
    await pp.goto(URL_);
    await pp.waitForSelector(".hub-home");
    await pp.tap('[data-sample="form.pdf"]');
    await pp.waitForSelector(".page.rendered", { timeout: 20000 });
    await pp.waitForTimeout(400);
    await pp.screenshot({ path: shots + `phone-form-${scheme}.png` });
    const fit = await pp.evaluate(() => {
      const bar = document.querySelector(".topbar");
      const theme = document.querySelector("#btn-theme").getBoundingClientRect();
      const pg = document.querySelector(".page").getBoundingClientRect();
      return { bar: bar.scrollWidth <= innerWidth, theme: theme.right <= innerWidth, page: pg.left >= 0 && pg.right <= innerWidth };
    });
    check(`phone ${scheme}: top bar and the page fit the screen width`, fit.bar && fit.theme && fit.page, JSON.stringify(fit));
    check(`phone ${scheme}: papgi (tools), File and Document buttons in the top bar`, (await pp.isVisible("#btn-tools")) && (await pp.isVisible("#btn-file")) && (await pp.isVisible("#btn-doc")));
    await pp.tap("#btn-doc");
    await pp.screenshot({ path: shots + `phone-doc-menu-${scheme}.png` });
    const menuFits = await pp.evaluate(() => { const r = document.querySelector("#doc-menu").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
    check(`phone ${scheme}: Document menu fits on screen`, menuFits);
    await pp.tap('#doc-menu [data-menu="numbers"]');
    await pp.waitForSelector(".modal .dt-page");
    await pp.waitForTimeout(150);
    await pp.screenshot({ path: shots + `phone-numbers-${scheme}.png` });
    const dlg = await pp.evaluate(() => {
      const m = document.querySelector(".modal").getBoundingClientRect();
      const wide = [...document.querySelectorAll(".modal .field, .modal input")].some((e) => e.getBoundingClientRect().right > m.right + 1);
      return m.left >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight && !wide;
    });
    check(`phone ${scheme}: page-numbers dialog fits (fields inside, scrolls if long)`, dlg);
    await pp.tap('.modal [data-v=""]');
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
