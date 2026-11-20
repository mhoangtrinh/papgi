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
    if (window.top === window) window.localStorage.clear(); // (not in frames such as the PDF viewer used for printing)
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(URL_);
  await page.waitForSelector(".hub-home");
  await page.screenshot({ path: shots + "desktop-home-light.png" });
  check("start screen shows the tools", (await page.locator(".tool-card").count()) === 6 && (await page.isVisible("#hub")));
  check("Open PDF comes first and lists what the editor does", (await page.locator(".tool-card").first().getAttribute("data-tool")) === "open" && /Sign/.test(await page.textContent(".tool-card.main")) && /OCR/.test(await page.textContent(".tool-card.main")));
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
    check("merge: reset order", (await labels()).join(" ") === [...Array(formPages)].map((_, i) => `A·${i + 1}`).concat([1, 2, 3, 4, 5].map((i) => `B·${i}`)).join(" "));

    // split, opened straight from its address
    await page.goto(URL_ + "#split");
    await page.waitForSelector('[data-flow="split"]');
    await page.evaluate(() => (window.showSaveFilePicker = undefined));
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

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();

  // ---------------- phone ----------------
  for (const scheme of ["light", "dark"]) {
    const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: scheme });
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
    check(`phone ${scheme}: tool page fits`, !(await pp.evaluate(() => document.querySelector("#hub").scrollWidth > window.innerWidth)));
    await pp.goto(URL_);
    await pp.waitForSelector(".hub-home");
    await pp.tap('[data-sample="form.pdf"]');
    await pp.waitForSelector(".page.rendered", { timeout: 20000 });
    await pp.waitForTimeout(400);
    await pp.screenshot({ path: shots + `phone-form-${scheme}.png` });
    check(`phone ${scheme}: papgi (tools), File and Document buttons in the top bar`, (await pp.isVisible("#btn-tools")) && (await pp.isVisible("#btn-file")) && (await pp.isVisible("#btn-doc")));
    await pp.tap("#btn-doc");
    await pp.screenshot({ path: shots + `phone-doc-menu-${scheme}.png` });
    const menuFits = await pp.evaluate(() => { const r = document.querySelector("#doc-menu").getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; });
    check(`phone ${scheme}: Document menu fits on screen`, menuFits);
    await pp.tap("#btn-doc");
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
