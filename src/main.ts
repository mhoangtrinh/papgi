import "./style.css";
import { App } from "./app";

const app = new App(document.getElementById("app")!);
// Handy for debugging from the console (and used by the browser tests).
(window as unknown as { pdfStudio: App }).pdfStudio = app;
