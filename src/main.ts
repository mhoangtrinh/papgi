import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";

const app = new App(document.getElementById("app")!);
// Handy for debugging from the console (and used by the browser tests).
(window as unknown as { papgi: App }).papgi = app;

// When a new version has been downloaded: switch right away if nothing is open,
// otherwise offer a reload so unsaved work is never lost.
const updateSW = registerSW({
  onNeedRefresh() {
    app.updateReady(() => void updateSW(true));
  },
  onRegisteredSW(_url, reg) {
    if (reg) setInterval(() => void reg.update().catch(() => {}), 30 * 60 * 1000);
  },
});
