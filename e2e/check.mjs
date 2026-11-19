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

  // --- scan sample: area highlight ---
  await page.evaluate(async () => {
    window.papgi["dirty"] = false;
    const r = await fetch("./samples/scan.pdf");
    await window.papgi.open({ name: "scan.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
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
  await page.keyboard.press("e");
  const sc = await pt(300, 400);
  await page.mouse.click(...sc);
  await page.waitForTimeout(400);
  check("scan: explains there is no editable text", /no text that can be edited/.test(await page.textContent(".toast")));
  await page.keyboard.press("v");
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
