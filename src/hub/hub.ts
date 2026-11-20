// The start screen (tools + recent files) and the stand-alone tool pages.
// It sits over the editor; the app shows it for the routes "" (home) and the flow tools' ids.
import type { Engine } from "../engine/client";
import type { OutFile } from "../engine/tools";
import type { OpenedFile } from "../files";
import { saveFile } from "../files";
import { icon } from "../ui/icons";
import { askPassword, confirmDialog, toast } from "../ui/dialogs";
import { zip } from "../core/zip";
import { ago, forgetAll, forgetFile, formatSize, listRecent, readRecent, type RecentFile } from "../recent";
import { TOOL_LIST, tool, type ToolDef, type ToolId } from "./registry";
import { FLOWS, type FlowDef, type Item, type Option } from "./flows";
import { isPdf, normalizeImage, looksLikeImage } from "./images";

export interface HubHost {
  engine: Engine;
  ready: Promise<void>;
  /** Open a file in the editor and switch to it; `then` prepares a tool or action. */
  openInEditor(f: OpenedFile): Promise<void>;
  /** Name of the document open in the editor, if any. */
  editorDoc(): string | null;
  showEditor(): void;
  pickPdf(): Promise<OpenedFile | null>;
  cycleTheme(): void;
  themeIcon(): string;
  openSample(name: string): void;
}

export const SAMPLES = [
  { file: "paper.pdf", label: "Paper" },
  { file: "form.pdf", label: "Form" },
  { file: "report.pdf", label: "Word report" },
  { file: "scan.pdf", label: "Scan" },
  { file: "pages.pdf", label: "5 pages" },
];

const OPTS_KEY = "papgi.tools.v1";
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function loadOpts(id: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}")[id] ?? {};
  } catch {
    return {};
  }
}

function saveOpts(id: string, o: Record<string, string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(OPTS_KEY) ?? "{}");
    all[id] = o;
    localStorage.setItem(OPTS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

let seq = 0;

export class Hub {
  readonly el: HTMLElement;
  private route: "home" | ToolId = "home";
  private items: Item[] = [];
  private flow: FlowDef | null = null;
  private opts: Record<string, string> = {};
  private results: OutFile[] = [];
  private running = false;
  private cancel = false;
  private dragFrom = -1;

  constructor(
    private host: HubHost,
    parent: HTMLElement,
  ) {
    this.el = document.createElement("div");
    this.el.className = "hub";
    this.el.id = "hub";
    this.el.hidden = true;
    parent.append(this.el);
    this.el.addEventListener("click", (e) => void this.onClick(e));
    this.el.addEventListener("input", (e) => this.onInput(e));
    // (drop areas and recent files act as buttons from the keyboard too)
    this.el.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement;
      if ((e.key === "Enter" || e.key === " ") && t.getAttribute("role") === "button") {
        e.preventDefault();
        t.click();
      }
    });
    this.el.addEventListener("change", (e) => this.onInput(e));
  }

  visible(): boolean {
    return !this.el.hidden;
  }

  /** Show the start screen or a tool page. */
  show(route: "home" | ToolId): void {
    const changed = route !== this.route || this.el.hidden;
    this.el.hidden = false;
    document.body.classList.add("hub-open");
    if (!changed) return;
    if (route !== this.route) this.reset();
    this.route = route;
    this.flow = route === "home" || route === "open" ? null : (FLOWS[route] ?? null);
    if (this.flow) this.opts = { ...Object.fromEntries(this.flow.options.map((o) => [o.key, o.value])), ...loadOpts(route) };
    this.render();
    this.el.scrollTop = 0;
    document.title = this.flow ? `${this.flow.title} · papgi` : route === "open" ? "Open PDF · papgi" : "papgi";
  }

  /** Switch now (the address changes too, for back/forward and bookmarks). */
  go(route: "home" | ToolId): void {
    const hash = route === "home" ? "" : `#${route}`;
    if (location.hash !== hash) history.pushState(null, "", hash || location.pathname + location.search);
    this.show(route);
  }

  hide(): void {
    this.el.hidden = true;
    document.body.classList.remove("hub-open");
  }

  /** Files dropped on the window while the hub is showing. */
  async drop(files: OpenedFile[]): Promise<void> {
    if (!files.length) return;
    if (this.flow) return this.addFiles(files);
    if (this.route === "open") {
      const pdf = files.find((f) => isPdf(f.bytes));
      if (pdf) return void this.host.openInEditor(pdf);
      return toast(looksLikeImage(files[0].name, files[0].bytes) ? "That's a picture: use Images to PDF to make a PDF from it" : "That isn't a PDF", "error");
    }
    // start screen: pick the tool that fits
    const pdfs = files.filter((f) => isPdf(f.bytes));
    const images = files.filter((f) => !isPdf(f.bytes) && looksLikeImage(f.name, f.bytes));
    if (pdfs.length === 1 && files.length === 1) return void this.host.openInEditor(pdfs[0]);
    if (pdfs.length > 1 && !images.length) {
      this.go("merge");
      return this.addFiles(pdfs);
    }
    if (images.length && !pdfs.length) {
      this.go("images-to-pdf");
      return this.addFiles(images);
    }
    toast("Drop PDFs (to edit or merge) or pictures (to make a PDF)", "error");
  }

  private reset(): void {
    for (const it of this.items) URL.revokeObjectURL(it.thumb);
    this.items = [];
    this.results = [];
    this.cancel = true;
  }

  // ---------- rendering ----------

  private header(): string {
    const doc = this.host.editorDoc();
    const t = this.flow ? tool(this.flow.id) : this.route === "open" ? tool("open") : undefined;
    const title = t ? `<div class="hub-title">${icon(t.icon)}<span>${t.name}</span></div>` : "";
    return `
      <header class="hub-top">
        <button class="hub-brand" data-go="home" title="All tools"><span class="logo">${icon("file")}</span><span>papgi</span></button>
        ${t ? `<button class="btn flat hub-back" data-go="home">${icon("back")}<span>All tools</span></button>` : ""}
        ${title}
        <div class="hub-actions">
          ${doc ? `<button class="btn flat to-editor" data-go="edit" title="Back to ${esc(doc)}">${icon("textEdit")}<span class="lbl">Editor: </span><span class="docn">${esc(doc)}</span></button>` : ""}
          <button class="icon-btn" data-act="theme" title="Theme">${icon(this.host.themeIcon())}</button>
        </div>
      </header>`;
  }

  private render(): void {
    this.el.innerHTML = this.header() + (this.flow ? this.flowHtml(this.flow) : this.route === "open" ? this.openHtml() : this.homeHtml());
    if (this.flow) this.renderFiles();
    else void this.renderRecent();
  }

  private homeHtml(): string {
    const card = (t: ToolDef) => `
      <button class="tool-card${t.kind === "open" ? " main" : ""}" data-tool="${t.id}">
        <span class="tool-icon">${icon(t.icon)}</span>
        <span class="tool-text"><b>${t.name}</b><span class="muted">${t.desc}</span>
          ${t.features ? `<span class="feature-list">${t.features.map((f) => `<span>${f}</span>`).join("")}</span>` : ""}</span>
      </button>`;
    return `
      <main class="hub-main hub-home">
        <section class="hub-hero">
          <h1>What would you like to do?</h1>
          <p class="muted">Everything happens on this device. Your files are never uploaded.</p>
        </section>
        <section class="tool-grid" aria-label="Tools">${TOOL_LIST.map(card).join("")}</section>
        <section class="recent" hidden>
          <div class="sec-head"><h2>${icon("clock")}Recent files</h2><button class="btn flat small" data-act="clear-recent">Clear</button></div>
          <div class="recent-list"></div>
        </section>
        <p class="samples"><span class="muted small">Try a sample:</span>
          ${SAMPLES.map((s) => `<button class="chip" data-sample="${s.file}">${s.label}</button>`).join("")}
        </p>
      </main>`;
  }

  /** "Open PDF": drop or browse, then the editor (with recent files to reopen). */
  private openHtml(): string {
    const t = tool("open")!;
    return `
      <main class="hub-main open-page">
        <div class="drop-area big" data-act="open-pdf" role="button" tabindex="0">
          ${icon("file")}
          <span class="drop-title"><b>Drop a PDF here</b></span>
          <span class="muted">or</span>
          <span class="btn primary big">${icon("open")}Browse for a PDF</span>
          <span class="muted small">It opens in the editor: ${t.features!.join(" · ")}</span>
        </div>
        <section class="recent" hidden>
          <div class="sec-head"><h2>${icon("clock")}Recent files</h2><button class="btn flat small" data-act="clear-recent">Clear</button></div>
          <div class="recent-list"></div>
        </section>
      </main>`;
  }

  private recent: RecentFile[] = [];

  private async renderRecent(): Promise<void> {
    this.recent = await listRecent();
    const sec = this.el.querySelector<HTMLElement>(".recent");
    if (!sec) return;
    sec.hidden = !this.recent.length;
    sec.querySelector(".recent-list")!.innerHTML = this.recent
      .map(
        (r) => `
        <div class="recent-item" data-recent="${r.id}" role="button" tabindex="0" title="Open ${esc(r.name)}">
          <div class="recent-thumb">${r.thumb ? `<img src="${r.thumb}" alt="">` : icon("file")}</div>
          <div class="recent-text"><b>${esc(r.name)}</b><span class="muted small">${ago(r.opened)} · ${r.pages} ${r.pages === 1 ? "page" : "pages"} · ${formatSize(r.size)}</span></div>
          <button class="icon-btn sm recent-x" data-forget="${r.id}" title="Remove from recent files">${icon("close")}</button>
        </div>`,
      )
      .join("");
  }

  private flowHtml(f: FlowDef): string {
    const what = f.takes === "pdf" ? (f.multiple ? "PDFs" : "a PDF") : "pictures";
    return `
      <main class="hub-main flow" data-flow="${f.id}">
        <div class="flow-head">
          <span class="tool-icon big">${icon(tool(f.id)!.icon)}</span>
          <div><h1>${f.title}</h1><p class="muted">${f.intro}</p></div>
        </div>
        <section class="flow-files">
          <div class="drop-area" data-act="add" role="button" tabindex="0">
            ${icon(f.takes === "pdf" ? "file" : "images")}
            <span><b>Choose ${what}</b><span class="muted"> or drop ${f.multiple ? "them" : "it"} here</span></span>
          </div>
          <ul class="file-list"></ul>
        </section>
        <section class="flow-options">${f.options.map((o) => this.optionHtml(o)).join("")}</section>
        <div class="flow-actions">
          <p class="flow-error" role="alert"></p>
          <button class="btn primary big" data-act="run"></button>
          <div class="flow-progress" hidden><div class="meter"><div></div></div><span class="muted small"></span><button class="btn flat small" data-act="stop">Stop</button></div>
        </div>
        <section class="flow-result" hidden aria-live="polite"></section>
      </main>`;
  }

  private optionHtml(o: Option): string {
    const v = this.opts[o.key] ?? o.value;
    const show = !("showIf" in o) || !o.showIf || this.opts[o.showIf[0]] === o.showIf[1];
    const wrap = (inner: string, hint = "") =>
      `<div class="opt" data-opt="${o.key}" ${show ? "" : "hidden"}><span class="opt-label">${o.label}</span><div class="opt-body">${inner}${hint ? `<p class="muted small opt-hint">${hint}</p>` : ""}</div></div>`;
    if (o.kind === "choice") {
      const cur = o.choices.find((c) => c[0] === v) ?? o.choices[0];
      return wrap(
        `<div class="choice" role="radiogroup" aria-label="${o.label}">${o.choices.map(([val, label]) => `<button role="radio" aria-checked="${val === cur[0]}" class="${val === cur[0] ? "on" : ""}" data-choose="${o.key}" data-value="${val}">${label}</button>`).join("")}</div>`,
        cur[2] ?? "",
      );
    }
    if (o.kind === "range")
      return wrap(`<label class="range"><input type="range" data-input="${o.key}" min="${o.min}" max="${o.max}" step="${o.step}" value="${esc(v)}"><output>${esc(v)}${o.unit}</output></label>`);
    return wrap(`<input class="field" type="text" data-input="${o.key}" placeholder="${esc(o.placeholder)}" value="${esc(v)}" autocomplete="off">`, o.hint ?? "");
  }

  /** File list, run button and errors (without re-rendering options, so typing isn't disturbed). */
  private renderFiles(): void {
    const f = this.flow;
    if (!f) return;
    const list = this.el.querySelector(".file-list")!;
    list.innerHTML = this.items
      .map(
        (it, i) => `
        <li class="file-row" data-item="${i}" draggable="${f.reorder}">
          ${f.reorder ? `<span class="grip" title="Drag to reorder">${icon("grip")}</span>` : ""}
          <span class="file-thumb">${it.thumb ? `<img src="${it.thumb}" alt="">` : icon(it.kind === "pdf" ? "file" : "image")}</span>
          <span class="file-text"><b>${esc(it.name)}</b><span class="muted small">${it.kind === "pdf" ? `${it.pages} ${it.pages === 1 ? "page" : "pages"} · ` : ""}${formatSize(it.bytes.length)}${it.password ? " · unlocked" : ""}</span></span>
          ${f.reorder ? `<button class="icon-btn sm" data-move="${i}" data-dir="-1" title="Move up" ${i === 0 ? "disabled" : ""}>${icon("up")}</button><button class="icon-btn sm" data-move="${i}" data-dir="1" title="Move down" ${i === this.items.length - 1 ? "disabled" : ""}>${icon("down")}</button>` : ""}
          <button class="icon-btn sm" data-remove="${i}" title="Remove">${icon("close")}</button>
        </li>`,
      )
      .join("");
    const drop = this.el.querySelector<HTMLElement>(".drop-area")!;
    drop.classList.toggle("compact", this.items.length > 0);
    drop.hidden = !f.multiple && this.items.length > 0;
    const add = drop.querySelector("b")!;
    add.textContent = this.items.length ? (f.takes === "pdf" ? "Add more PDFs" : "Add more pictures") : `Choose ${f.takes === "pdf" ? (f.multiple ? "PDFs" : "a PDF") : "pictures"}`;
    this.renderAction();
  }

  private renderAction(): void {
    const f = this.flow;
    if (!f) return;
    const run = this.el.querySelector<HTMLButtonElement>("[data-act=run]")!;
    const err = this.el.querySelector<HTMLElement>(".flow-error")!;
    const problem = this.items.length >= f.min ? (f.check?.(this.items, this.opts) ?? null) : null;
    run.innerHTML = `${icon(tool(f.id)!.icon)}${f.action(this.items)}`;
    run.disabled = this.running || this.items.length < f.min || !!problem;
    err.textContent = problem ?? "";
    run.hidden = this.running;
  }

  private syncOptions(): void {
    const f = this.flow;
    if (!f) return;
    for (const o of f.options) {
      const row = this.el.querySelector<HTMLElement>(`[data-opt="${o.key}"]`);
      if (!row) continue;
      if ("showIf" in o && o.showIf) row.hidden = this.opts[o.showIf[0]] !== o.showIf[1];
      if (o.kind === "choice") {
        const cur = o.choices.find((c) => c[0] === this.opts[o.key]) ?? o.choices[0];
        row.querySelectorAll<HTMLButtonElement>("[data-choose]").forEach((b) => {
          const on = b.dataset.value === cur[0];
          b.classList.toggle("on", on);
          b.setAttribute("aria-checked", String(on));
        });
        const hint = row.querySelector(".opt-hint");
        if (hint) hint.textContent = cur[2] ?? "";
      }
    }
    this.renderAction();
  }

  // ---------- events ----------

  private async onClick(e: Event): Promise<void> {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>("button, [data-recent], .drop-area");
    if (!b) return;
    const d = b.dataset;
    if (d.go === "home") return void (location.hash = "");
    if (d.go === "edit") return this.host.showEditor();
    if (d.act === "theme") {
      this.host.cycleTheme();
      b.innerHTML = icon(this.host.themeIcon());
      return;
    }
    if (d.tool) return this.startTool(d.tool as ToolId);
    if (d.sample) return this.host.openSample(d.sample);
    if (d.forget) {
      e.stopPropagation();
      await forgetFile(d.forget);
      return this.renderRecent();
    }
    if (d.act === "clear-recent") {
      if (await confirmDialog("Clear recent files?", "papgi forgets the list (and any copies it kept). Your files themselves aren't touched.", "Clear", true)) {
        await forgetAll();
        await this.renderRecent();
      }
      return;
    }
    if (d.recent) return this.openRecent(d.recent);
    if (d.act === "add") return this.pickFiles();
    if (d.act === "open-pdf") {
      const f = await this.host.pickPdf();
      if (f) await this.host.openInEditor(f);
      return;
    }
    if (d.remove !== undefined) {
      const [it] = this.items.splice(Number(d.remove), 1);
      URL.revokeObjectURL(it.thumb);
      this.results = [];
      this.renderResult();
      return this.renderFiles();
    }
    if (d.move !== undefined) return this.moveItem(Number(d.move), Number(d.move) + Number(d.dir));
    if (d.choose) {
      this.opts[d.choose] = d.value!;
      saveOpts(this.flow!.id, this.opts);
      return this.syncOptions();
    }
    if (d.act === "run") return this.run();
    if (d.act === "stop") {
      this.cancel = true;
      return;
    }
    if (d.out !== undefined) return this.saveOne(Number(d.out));
    if (d.act === "save-all") return this.saveAll();
    if (d.act === "share") return this.share();
    // (a copy: the engine takes over the bytes it is given, and the result stays downloadable)
    if (d.act === "open-result") return void this.host.openInEditor({ name: this.results[0].name, bytes: this.results[0].bytes.slice(), handle: null });
    if (d.act === "again") {
      this.reset();
      this.cancel = false;
      return this.render();
    }
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    const key = t.dataset.input;
    if (!key || !this.flow) return;
    this.opts[key] = t.value;
    const out = t.parentElement?.querySelector("output");
    const o = this.flow.options.find((x) => x.key === key);
    if (out && o?.kind === "range") out.textContent = `${t.value}${o.unit}`;
    saveOpts(this.flow.id, this.opts);
    this.renderAction();
  }

  private startTool(id: ToolId): void {
    location.hash = `#${id}`;
  }

  private async openRecent(id: string): Promise<void> {
    const r = this.recent.find((x) => x.id === id);
    if (!r) return;
    try {
      const { bytes, handle } = await readRecent(r);
      await this.host.openInEditor({ name: r.name, bytes, handle });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  private pickFiles(): void {
    const f = this.flow!;
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = f.multiple;
    input.accept = f.takes === "pdf" ? "application/pdf,.pdf" : "image/*,.heic,.heif";
    input.onchange = async () => {
      const files = await Promise.all([...(input.files ?? [])].map(async (file) => ({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), handle: null })));
      await this.addFiles(files);
    };
    input.click();
  }

  /** Add files to the current tool: check them, ask for passwords, make thumbnails. */
  private async addFiles(files: OpenedFile[]): Promise<void> {
    const f = this.flow;
    if (!f) return;
    await this.host.ready;
    if (!f.multiple) {
      files = files.slice(0, 1);
      for (const it of this.items) URL.revokeObjectURL(it.thumb);
      this.items = [];
    }
    this.results = [];
    this.renderResult();
    const skipped: string[] = [];
    for (const file of files) {
      try {
        const item = f.takes === "pdf" ? await this.pdfItem(file) : await this.imageItem(file);
        if (item) this.items.push(item);
      } catch (err) {
        skipped.push(`${file.name}: ${(err as Error).message}`);
      }
      this.renderFiles();
    }
    if (skipped.length) toast(skipped.length === 1 ? skipped[0] : `${skipped.length} files couldn't be added. ${skipped[0]}`, "error");
  }

  private async pdfItem(file: OpenedFile): Promise<Item | null> {
    if (!isPdf(file.bytes)) {
      throw new Error(looksLikeImage(file.name, file.bytes) ? "that's a picture; use Images to PDF" : "not a PDF");
    }
    let password: string | undefined;
    let pages = 0;
    for (let wrong = false; ; wrong = true) {
      try {
        pages = await this.host.engine.toolPageCount({ name: file.name, bytes: file.bytes, password });
        break;
      } catch (err) {
        if (!/password/i.test((err as Error).message)) throw err;
        const pw = await askPassword(file.name, wrong);
        if (pw === null) return null;
        password = pw;
      }
    }
    let thumb = "";
    try {
      const [jpg] = await this.host.engine.toolPagesToImages({ name: file.name, bytes: file.bytes, password }, [0], { format: "jpeg", dpi: 24, quality: 70 });
      thumb = URL.createObjectURL(new Blob([jpg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }));
    } catch {
      /* no thumbnail */
    }
    return { id: `i${++seq}`, name: file.name, bytes: file.bytes, kind: "pdf", pages, password, thumb };
  }

  private async imageItem(file: OpenedFile): Promise<Item> {
    if (isPdf(file.bytes)) throw new Error("that's a PDF; use Merge PDFs to combine PDFs");
    const img = await normalizeImage(file.name, file.bytes);
    const thumb = URL.createObjectURL(new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.type }));
    return { id: `i${++seq}`, name: img.name, bytes: img.bytes, kind: "image", pages: 1, thumb };
  }

  private moveItem(from: number, to: number): void {
    if (to < 0 || to >= this.items.length || from === to) return;
    const [it] = this.items.splice(from, 1);
    this.items.splice(to, 0, it);
    this.results = [];
    this.renderResult();
    this.renderFiles();
  }

  /** Drag rows to reorder (mouse); the arrow buttons do the same on touch screens. */
  bindDrag(): void {
    this.el.addEventListener("dragstart", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (!row) return;
      this.dragFrom = Number(row.dataset.item);
      e.dataTransfer?.setData("text/x-papgi-row", String(this.dragFrom));
      row.classList.add("dragging");
    });
    this.el.addEventListener("dragover", (e) => {
      if (this.dragFrom < 0) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (!row) return;
      e.preventDefault();
      this.el.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
      const r = row.getBoundingClientRect();
      row.classList.add(e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after");
    });
    this.el.addEventListener("drop", (e) => {
      if (this.dragFrom < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const row = (e.target as HTMLElement).closest<HTMLElement>(".file-row");
      if (row) {
        let to = Number(row.dataset.item);
        if (row.classList.contains("drop-after")) to++;
        if (to > this.dragFrom) to--;
        this.moveItem(this.dragFrom, to);
      }
      this.dragFrom = -1;
    });
    this.el.addEventListener("dragend", () => {
      this.dragFrom = -1;
      this.el.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((x) => x.classList.remove("dragging", "drop-before", "drop-after"));
    });
  }

  /** A reorder drag in progress (the app must not treat it as a file drop). */
  draggingRow(): boolean {
    return this.dragFrom >= 0;
  }

  // ---------- running ----------

  private async run(): Promise<void> {
    const f = this.flow;
    if (!f || this.running || this.items.length < f.min) return;
    this.running = true;
    this.cancel = false;
    this.results = [];
    this.renderResult();
    const prog = this.el.querySelector<HTMLElement>(".flow-progress")!;
    const bar = prog.querySelector<HTMLElement>(".meter > div")!;
    const label = prog.querySelector<HTMLElement>("span")!;
    prog.hidden = false;
    bar.style.width = "0";
    label.textContent = "Working…";
    this.renderAction();
    const t0 = performance.now();
    try {
      const res = await f.run({
        engine: this.host.engine,
        items: this.items,
        opts: this.opts,
        progress: (done, total, text) => {
          bar.style.width = `${Math.round((done / Math.max(1, total)) * 100)}%`;
          if (text) label.textContent = text;
        },
        cancelled: () => this.cancel,
      });
      if (this.cancel && !res.files.length) return;
      this.results = res.files;
      this.renderResult(res.note, this.cancel, performance.now() - t0);
    } catch (err) {
      toast(`${f.title} didn't work: ${(err as Error).message}`, "error");
    } finally {
      this.running = false;
      prog.hidden = true;
      this.renderAction();
    }
  }

  private renderResult(note = "", stopped = false, ms = 0): void {
    const sec = this.el.querySelector<HTMLElement>(".flow-result");
    if (!sec) return;
    sec.hidden = !this.results.length;
    if (!this.results.length) return void (sec.innerHTML = "");
    const many = this.results.length > 1;
    const total = this.results.reduce((n, r) => n + r.bytes.length, 0);
    const canShare = this.canShare();
    const onePdf = !many && this.results[0].type === "application/pdf";
    sec.innerHTML = `
      <div class="result-head">
        <span class="result-ok">${icon("check")}</span>
        <div><b>${stopped ? "Stopped. Here's what was done" : "Done"}</b><span class="muted small">${esc(note)}${ms > 1500 ? ` · ${(ms / 1000).toFixed(1)} s` : ""}</span></div>
      </div>
      <div class="result-actions">
        <button class="btn primary" data-act="save-all">${icon("download")}${many ? `Download all (ZIP, ${formatSize(total)})` : `Download (${formatSize(total)})`}</button>
        ${canShare ? `<button class="btn" data-act="share">${icon("share")}Share</button>` : ""}
        ${onePdf ? `<button class="btn" data-act="open-result">${icon("textEdit")}Open in editor</button>` : ""}
        <button class="btn flat" data-act="again">Start over</button>
      </div>
      ${many ? `<ul class="out-list">${this.results.map((r, i) => `<li><span class="file-text"><b>${esc(r.name)}</b><span class="muted small">${formatSize(r.bytes.length)}</span></span><button class="icon-btn sm" data-out="${i}" title="Download ${esc(r.name)}">${icon("download")}</button></li>`).join("")}</ul>` : ""}`;
    sec.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private canShare(): boolean {
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (!nav.canShare || !navigator.share || !this.results.length) return false;
    try {
      return nav.canShare({ files: [new File([], "x.pdf", { type: "application/pdf" })] });
    } catch {
      return false;
    }
  }

  private async saveOne(i: number): Promise<void> {
    const r = this.results[i];
    if (r) await saveFile(r.bytes, r.name, r.type).catch((e) => toast(`Couldn't save: ${(e as Error).message}`, "error"));
  }

  private async saveAll(): Promise<void> {
    if (this.results.length === 1) return this.saveOne(0);
    const name = `${this.items[0]?.name.replace(/\.[^.]+$/, "") ?? "papgi"} (${this.flow?.id === "split" ? "split" : "pages"}).zip`;
    await saveFile(zip(this.results), name, "application/zip").catch((e) => toast(`Couldn't save: ${(e as Error).message}`, "error"));
  }

  private async share(): Promise<void> {
    const files = this.results.map((r) => new File([r.bytes as Uint8Array<ArrayBuffer>], r.name, { type: r.type }));
    try {
      await navigator.share({ files });
    } catch (e) {
      if ((e as Error).name !== "AbortError") toast(`Couldn't share: ${(e as Error).message}`, "error");
    }
  }
}
