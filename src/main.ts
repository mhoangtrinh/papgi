import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";
import { toast } from "./ui/dialogs";
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
  try {
    sessionStorage.setItem("papgi.updated", "1");
  } catch {
    /* private mode */
  }
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

// Say so after switching to a new version (it may have happened by itself)
try {
  if (sessionStorage.getItem("papgi.updated")) {
    sessionStorage.removeItem("papgi.updated");
    setTimeout(() => toast(`papgi was updated to the newest version (${__BUILD_DATE__}).`), 600);
  }
} catch {
  /* private mode */
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
    // Look for a new version every 2 minutes while the app is on screen, and right away when
    // it comes back to the front, gets the focus or goes online again (at most every 30 s).
    // (An app on the iPhone home screen is mostly paused in the background, so timers rarely
    // run there.) Each look only asks for the small sw.js.
    let last = Date.now();
    const check = (min: number) => {
      if (applying || !navigator.onLine || document.visibilityState !== "visible" || Date.now() - last < min) return;
      last = Date.now();
      void reg.update().catch(() => {});
    };
    setInterval(() => check(110 * 1000), 120 * 1000);
    const soon = () => check(30 * 1000);
    document.addEventListener("visibilitychange", soon);
    window.addEventListener("focus", soon);
    window.addEventListener("online", soon);
  },
});
