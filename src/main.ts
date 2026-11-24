import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";
import { lang, missing, seen, startTranslating } from "./i18n";

const app = new App(document.getElementById("app")!);
startTranslating();
// (for the browser tests: texts with no translation, and all texts seen)
(window as unknown as { papgiI18n: unknown }).papgiI18n = { lang, missing, seen };
// Handy for debugging from the console (and used by the browser tests).
(window as unknown as { papgi: App }).papgi = app;
// (tells builds apart in the update test)
if (import.meta.env.VITE_BUILD_TAG) (window as unknown as { papgiBuild: string }).papgiBuild = import.meta.env.VITE_BUILD_TAG;

// The page itself never scrolls (older Safari has no overflow: clip): undo any nudge
for (const el of [document.documentElement, document.body])
  el.addEventListener("scroll", () => {
    if (el.scrollLeft || el.scrollTop) el.scrollTo(0, 0);
  });

let registration: ServiceWorkerRegistration | undefined;
let applying = false;

/**
 * Switch to the version that's waiting and reload. (The plugin's own reload only happens
 * for a version downloaded while this page was open, so a version found earlier, e.g.
 * after "Later" or by another window, would never load.)
 */
async function applyUpdate(): Promise<void> {
  applying = true;
  let done = false;
  const reload = () => {
    if (done) return;
    done = true;
    location.reload();
  };
  const sw = navigator.serviceWorker;
  sw?.addEventListener("controllerchange", reload, { once: true });
  const reg = registration ?? (await sw?.getRegistration().catch(() => undefined));
  const waiting = reg?.waiting;
  if (!waiting) return reload();
  waiting.postMessage({ type: "SKIP_WAITING" });
  // a page the old version didn't control gets no controllerchange: reload once it's active
  waiting.addEventListener("statechange", () => waiting.state === "activated" && setTimeout(reload, 50));
  setTimeout(reload, 4000);
}

// Another window switched to the new version: this one still runs the old code.
const hadController = !!navigator.serviceWorker?.controller;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
  if (!applying && hadController) app.updateReady(() => location.reload());
});

// When a new version has been downloaded: switch right away if nothing is open,
// otherwise offer a reload so unsaved work is never lost.
registerSW({
  onNeedRefresh() {
    app.updateReady(() => void applyUpdate());
  },
  // (the plugin would reload by itself when another window switches versions, even with a
  // document open: the controllerchange listener above asks first instead)
  onNeedReload() {},
  onRegisteredSW(_url, reg) {
    registration = reg;
    if (reg) setInterval(() => void reg.update().catch(() => {}), 30 * 60 * 1000);
  },
});
