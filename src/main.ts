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
 * Load the page again from the service worker. (A plain reload of an app on the iPhone home
 * screen can show the old page from memory: a new address makes it ask again.)
 */
function freshReload(): void {
  const u = new URL(location.href);
  u.searchParams.set("v", Date.now().toString(36));
  location.replace(u.href);
}
// (and the address is tidied up again once the page has loaded)
if (new URL(location.href).searchParams.has("v")) {
  const u = new URL(location.href);
  u.searchParams.delete("v");
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

/** Wait until a newly found version is installed (or gone), at most `ms`. */
function installed(sw: ServiceWorker, ms: number): Promise<void> {
  return new Promise((res) => {
    const done = () => sw.state !== "installing" && res();
    sw.addEventListener("statechange", done);
    setTimeout(res, ms);
    done();
  });
}

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
    freshReload();
  };
  const sw = navigator.serviceWorker;
  sw?.addEventListener("controllerchange", reload, { once: true });
  const reg = registration ?? (await sw?.getRegistration().catch(() => undefined));
  // (a version still downloading: let it finish first)
  if (reg?.installing && !reg.waiting) await installed(reg.installing, 30000);
  const waiting = reg?.waiting;
  if (!waiting) return reload();
  waiting.addEventListener("statechange", () => {
    // a page the old version didn't control gets no controllerchange: reload once it's active
    if (waiting.state === "activated") setTimeout(reload, 50);
    // replaced by an even newer version meanwhile: switch to that one
    if (waiting.state === "redundant" && !done) void applyUpdate();
  });
  waiting.postMessage({ type: "SKIP_WAITING" });
  // (if the switch never happens, reload anyway rather than leave the button doing nothing)
  setTimeout(reload, 10000);
}

// Another window switched to the new version: this one still runs the old code.
const hadController = !!navigator.serviceWorker?.controller;
navigator.serviceWorker?.addEventListener("controllerchange", () => {
  if (!applying && hadController) app.updateReady(freshReload);
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
    if (!reg) return;
    // look for a new version every 30 minutes, and when the app comes back to the front
    // (an app on the iPhone home screen is mostly paused in the background, so timers rarely
    // run there), at most every 5 minutes
    let last = Date.now();
    const check = () => {
      if (applying || !navigator.onLine) return;
      last = Date.now();
      void reg.update().catch(() => {});
    };
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - last > 5 * 60 * 1000) check();
    });
  },
});
