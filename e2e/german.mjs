// The interface in German: every screen, menu and dialog is walked through, and any text
// left without a translation is listed. Screenshots go to e2e/shots/de-*.png.
// Usage: npm run build && npm run e2e:de
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = 4181;
const URL_ = `http://localhost:${PORT}/`;
const shots = new URL("./shots/", import.meta.url).pathname;
fs.mkdirSync(shots, { recursive: true });
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
await new Promise((res, rej) => {
  server.stdout.on("data", (d) => String(d).includes(String(PORT)) && res());
  server.on("exit", (code) => rej(new Error(`preview server exited (${code})`)));
});
process.on("exit", () => server.kill());

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const local = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const browser = await chromium.launch(fs.existsSync(local) && !process.env.PW_DEFAULT ? { executablePath: local } : {});
const missing = new Map(); // text -> where
let where = "";
try {
  for (const [label, vp] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
    const phone = label === "phone";
    const ctx = await browser.newContext({ viewport: vp, locale: "de-DE", ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    // (a fresh start once; the language chosen later must survive the reload)
    await ctx.addInitScript(() => {
      if (window.top === window && !sessionStorage.getItem("fresh")) {
        localStorage.clear();
        sessionStorage.setItem("fresh", "1");
      }
    });
    await ctx.exposeFunction("__papgiMissingOut", (s) => !missing.has(s) && missing.set(s, `${label}: ${where}`));
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const tap = (sel) => (phone ? page.tap(sel) : page.click(sel));
    const shot = (name) => page.screenshot({ path: shots + `de-${label}-${name}.png` });
    const closeModal = async () => {
      if (await page.locator(".modal").count()) await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    };
    where = "start screen";
    await page.goto(URL_);
    await page.waitForSelector(".hub-home");
    check(`${label}: the page says it's German`, (await page.evaluate(() => document.documentElement.lang)) === "de");
    check(`${label}: start screen in German`, /Was möchten Sie tun\?|PDF öffnen/.test(await page.textContent("#hub")), (await page.textContent("#hub")).slice(0, 80));
    await shot("home");
    // every tool page
    for (const tool of ["open", "merge", "split", "compress", "images-to-pdf", "pdf-to-images", "pdf-to-word"]) {
      where = `tool ${tool}`;
      const ok = await page.evaluate((t) => {
        const el = document.querySelector(`.tool-card[data-tool="${t}"]`);
        el?.click();
        return !!el;
      }, tool);
      if (!ok) continue;
      await page.waitForTimeout(400);
      await shot(`tool-${tool}`);
      await page.goto(URL_);
      await page.waitForSelector(".hub-home");
    }
    // a sample in the editor
    where = "editor";
    await page.evaluate(async () => {
      location.hash = "#edit";
      const r = await fetch("./samples/form.pdf");
      await window.papgi.open({ name: "form.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    });
    await page.waitForSelector(".page.rendered", { timeout: 20000 });
    await page.waitForTimeout(500);
    await shot("editor");
    // every tool's options
    for (const t of ["select", "area", "edit", "highlight", "pen", "text", "shape", "note", "form", "eraser", "sign"]) {
      where = `tool ${t}`;
      await page.evaluate((id) => document.querySelector(`.tools [data-tool="${id}"]`)?.click(), t);
      await page.waitForTimeout(200);
      if (t === "sign") await closeModal();
      if (!phone && (t === "form" || t === "shape")) await shot(`tool-${t}`);
    }
    await page.evaluate(() => document.querySelector('.tools [data-tool="select"]')?.click());
    // menus
    for (const [btn, menu] of [["#btn-file", "#file-menu"], ["#btn-doc", "#doc-menu"], ["#btn-tools", "#tools-menu"]]) {
      where = `menu ${menu}`;
      await tap(btn);
      await page.waitForTimeout(200);
      await shot(`menu-${menu.slice(1)}`);
      await tap(btn);
    }
    // the Document menu's dialogs
    for (const item of ["crop", "watermark", "numbers", "redact", "password", "ocr", "flatten", "signature"]) {
      where = `dialog ${item}`;
      await tap("#btn-doc");
      await page.click(`#doc-menu [data-menu="${item}"]`);
      await page.waitForTimeout(500);
      if (item === "redact") {
        await page.fill('.modal [data-k="q"]', "Name");
        await page.waitForTimeout(600);
      }
      if (item === "watermark" || item === "numbers" || item === "crop" || item === "ocr") await shot(`dialog-${item}`);
      await closeModal();
    }
    for (const item of ["keys", "about", "lang"]) {
      where = `dialog ${item}`;
      await tap("#btn-file");
      await page.click(`#file-menu [data-menu="${item}"]`);
      await page.waitForTimeout(300);
      await shot(`dialog-${item}`);
      await closeModal();
    }
    // a field, its menu and settings
    where = "form fields";
    const ws = await page.evaluate(() => window.papgi.engine.listWidgets(0));
    await page.evaluate(() => document.querySelector('.tools [data-tool="form"]')?.click());
    const b = await page.locator(".page").first().boundingBox();
    const info = await page.evaluate(() => window.papgi.info.pages[0]);
    const at = (x, y) => [b.x + ((x - info.x) / info.w) * b.width, b.y + ((y - info.y) / info.h) * b.height];
    const f = ws[0].rect;
    await page.mouse.click(...at((f[0] + f[2]) / 2, (f[1] + f[3]) / 2));
    await page.waitForTimeout(300);
    await shot("field-menu");
    await page.click('.floating[data-kind="field"] button[data-act="props"]');
    await page.waitForTimeout(300);
    await shot("field-settings");
    await closeModal();
    // a new field gets a German name
    await page.click('#options [data-field="checkbox"]');
    await page.evaluate(() => (document.querySelector(".viewer").scrollTop = 0));
    await page.waitForTimeout(200);
    await page.mouse.click(...at(info.x + info.w - 60, info.y + 40));
    await page.waitForTimeout(500);
    const names = (await page.evaluate(() => window.papgi.engine.listWidgets(0))).map((w) => w.name);
    check(`${label}: new fields are named in German`, names.includes("Kontrollkästchen 1"), names.slice(-2).join(", "));
    await page.keyboard.press("Escape");
    // a toast
    where = "toasts";
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(400);
    const toastText = (await page.locator(".toast").last().textContent().catch(() => "")) ?? "";
    check(`${label}: toasts in German`, /Rückgängig/.test(toastText), toastText);
    // the document's own words are never translated: "Page 1" stays "Page 1" when edited
    where = "edit text";
    await page.evaluate(async () => {
      window.papgi["dirty"] = false;
      const r = await fetch("./samples/pages.pdf");
      await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    });
    await page.waitForSelector(".page.rendered");
    await page.evaluate(() => (document.querySelector(".viewer").scrollTop = 0));
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('.tools [data-tool="edit"]')?.click());
    const pb = await page.locator(".page").first().boundingBox();
    const pi = await page.evaluate(() => window.papgi.info.pages[0]);
    await page.mouse.click(pb.x + (100 / pi.w) * pb.width, pb.y + (70 / pi.h) * pb.height);
    await page.waitForSelector(".para-editor", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
    const para = (await page.locator(".para-editor").textContent().catch(() => "")) ?? "";
    check(`${label}: the document's own text isn't translated`, para.trim() === "Page 1", JSON.stringify(para));
    await page.keyboard.press("Escape");
    await page.evaluate(() => (window.papgi["dirty"] = true));
    // switching back to English
    where = "language";
    await tap("#btn-file");
    await page.click('#file-menu [data-menu="lang"]');
    await page.waitForSelector(".lang-opt");
    await page.click('.lang-opt[data-v="en"]');
    await page.waitForTimeout(300);
    // (unsaved changes: it asks first)
    const asked = await page.locator(".modal .btn.danger").count();
    await Promise.all([page.waitForNavigation({ timeout: 10000 }).catch(() => {}), asked ? page.click(".modal .btn.danger") : Promise.resolve()]);
    await page.waitForSelector(".hub-home, #app .topbar", { timeout: 10000 });
    check(`${label}: the language can be switched to English`, (await page.evaluate(() => document.documentElement.lang)) === "en" && /File|Open PDF/.test(await page.textContent("body")));
    check(`${label}: no page errors`, errors.length === 0, errors.join(" | "));
    await ctx.close();
  }
  const list = [...missing.entries()];
  check("every text has a German translation", list.length === 0, list.length ? "\n  " + list.map(([s, w]) => `${JSON.stringify(s)}  (${w})`).join("\n  ") : "");
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
