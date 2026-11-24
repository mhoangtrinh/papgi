// Browser check of app updates: an open app gets a new version, shows the bar, and Reload
// switches to it. Two real builds (A, B) served by a tiny static server, swapped while open.
// Usage: node e2e/update.mjs   (takes about 2 minutes: workbox treats updates found more
// than a minute after the page registered as "external", which is the case that broke)
import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = "/tmp/papgi-update";
const site = path.join(root, "site");
fs.rmSync(root, { recursive: true, force: true });
for (const tag of ["A", "B"]) execSync(`npx vite build --outDir ${root}/${tag} --emptyOutDir`, { env: { ...process.env, VITE_BUILD_TAG: tag }, stdio: "ignore" });
const use = (tag) => {
  fs.rmSync(site, { recursive: true, force: true });
  fs.cpSync(path.join(root, tag), site, { recursive: true });
};
use("A");

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".pdf": "application/pdf" };
const server = http.createServer((req, res) => {
  const p = path.join(site, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
  fs.readFile(p, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  });
});
await new Promise((r) => server.listen(4188, r));
const URL_ = "http://localhost:4188/";

const results = [];
const check = (name, ok, extra = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const local = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const browser = await chromium.launch(fs.existsSync(local) ? { executablePath: local } : {});
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const build = () => page.evaluate(() => window.papgiBuild);
  await page.goto(URL_);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null || window.__reloaded, null, { timeout: 30000 }).catch(() => {});
  // first visit: the service worker takes over after a reload
  if (!(await page.evaluate(() => navigator.serviceWorker.controller))) await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 30000 });
  check("version A is running and works offline", (await build()) === "A");
  const openDoc = () =>
    page.evaluate(async () => {
      const r = await fetch("./samples/pages.pdf");
      await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
    });
  await openDoc();
  await page.waitForSelector(".page.rendered", { timeout: 20000 });

  // a new version is published while the app is open (found more than a minute later)
  await page.waitForTimeout(62000);
  use("B");
  // (found by the app itself: it looks again when the window gets the focus)
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const bar = await page.waitForSelector(".update-bar", { timeout: 30000 }).then(() => true, () => false);
  check("an open document gets the 'new version' bar", bar);
  if (bar) {
    await Promise.all([page.waitForEvent("load", { timeout: 15000 }).catch(() => {}), page.click('.update-bar [data-act="reload"]')]);
    await page.waitForFunction(() => window.papgiBuild, null, { timeout: 15000 }).catch(() => {});
    check("Reload switches to the new version", (await build()) === "B", String(await build()));
    check("and leaves a clean address", !new URL(page.url()).search, page.url());
    const told = await page.waitForSelector(".toast", { timeout: 5000 }).then((t) => t.textContent(), () => "");
    check("and says it was updated", /updated to the newest version/.test(told), told);
  }

  // "Later", then the next time the app opens with a document: Reload still works
  await openDoc();
  await page.waitForSelector(".page.rendered", { timeout: 20000 });
  use("A");
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page.waitForSelector(".update-bar", { timeout: 30000 });
  await page.click('.update-bar [data-act="later"]');
  check("Later hides the bar", !(await page.isVisible(".update-bar")));
  const page2 = await ctx.newPage();
  await page.close();
  // (headless Chromium sometimes stalls a page opened at the very moment the old one closes)
  await page2.waitForTimeout(1000);
  await page2.goto(URL_);
  await page2.waitForFunction(() => window.papgiBuild, null, { timeout: 15000 });
  // nothing open yet: the waiting version is put in right away
  await page2.waitForTimeout(3000);
  check("opening the app again with nothing open switches right away", (await page2.evaluate(() => window.papgiBuild)) === "A", await page2.evaluate(() => window.papgiBuild));

  // two windows: one with a document, one without. The empty one switches by itself,
  // and the bar in the other must still reload (there's no waiting version left by then)
  const withDoc = await ctx.newPage();
  await withDoc.goto(URL_);
  await withDoc.waitForFunction(() => window.papgiBuild, null, { timeout: 15000 });
  await withDoc.evaluate(async () => {
    const r = await fetch("./samples/pages.pdf");
    await window.papgi.open({ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null });
  });
  await withDoc.waitForSelector(".page.rendered", { timeout: 20000 });
  await withDoc.evaluate(() => {
    window.__log = [`controller ${!!navigator.serviceWorker.controller}`];
    navigator.serviceWorker.addEventListener("controllerchange", () => window.__log.push("controllerchange"));
  });
  use("B");
  await page2.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await page2.waitForFunction(() => window.papgiBuild === "B", null, { timeout: 30000 }).catch(() => {});
  check("the window without a document switched to the new version", (await page2.evaluate(() => window.papgiBuild)) === "B");
  const bar2 = await withDoc.waitForSelector(".update-bar", { timeout: 15000 }).then(() => true, () => false);
  check("the window with a document shows the bar", bar2, JSON.stringify(await withDoc.evaluate(() => window.__log)));
  if (bar2) {
    await withDoc.click('.update-bar [data-act="reload"]');
    await withDoc.waitForFunction(() => window.papgiBuild === "B", null, { timeout: 15000 }).catch(() => {});
    check("and Reload there switches too", (await withDoc.evaluate(() => window.papgiBuild).catch(() => "?")) === "B", await withDoc.evaluate(() => window.papgiBuild).catch(() => "?"));
  }

  // files picked in a tool (no document open): ask first instead of reloading them away
  const tool = await ctx.newPage();
  await tool.goto(URL_ + "#merge");
  await tool.waitForFunction(() => window.papgiBuild === "B", null, { timeout: 15000 });
  await tool.evaluate(async () => {
    const r = await fetch("./samples/pages.pdf");
    await window.papgi.hub.drop([{ name: "pages.pdf", bytes: new Uint8Array(await r.arrayBuffer()), handle: null }]);
  });
  await tool.waitForTimeout(1000);
  for (const p of [withDoc, page2]) await p.close().catch(() => {});
  use("A");
  await tool.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  const bar3 = await tool.waitForSelector(".update-bar", { timeout: 30000 }).then(() => true, () => false);
  check("files picked in a tool: the bar shows instead of a reload", bar3 && (await tool.evaluate(() => window.papgiBuild)) === "B");
  if (bar3) {
    await tool.click('.update-bar [data-act="reload"]');
    await tool.waitForFunction(() => window.papgiBuild === "A", null, { timeout: 15000 }).catch(() => {});
    check("and Reload there switches", (await tool.evaluate(() => window.papgiBuild).catch(() => "?")) === "A");
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
