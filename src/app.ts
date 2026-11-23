// App shell: toolbar, files, keyboard shortcuts, and wiring between engine, viewer and sidebar.
import { createEngine, type Engine } from "./engine/client";
import type { DocInfo, SearchHit } from "./engine/engine";
import { Viewer, PALETTE } from "./ui/viewer";
import { Sidebar } from "./ui/sidebar";
import { icon } from "./ui/icons";
import { toast, askPassword, confirmDialog, showShortcuts, modal } from "./ui/dialogs";
import { signatureDialog } from "./ui/signature-dialog";
import { ocrDialog, runOcr } from "./ui/ocr";
import { Organize } from "./ui/organize";
import { canPrintPdfNatively, printPdfBytes, printAsImages } from "./ui/print";
import { loadSettings, saveSettings, newSignatureId, MAX_SIGNATURES, type Settings, type Tool, type Theme, type SavedSignature } from "./storage";
import { pickPdfs, writeToHandle, saveAs, download, onLaunchFiles, fileToOpened, baseName, friendlyError, type OpenedFile } from "./files";
import { nextZoom, strokesBounds, ZOOM_STEPS } from "./core/geometry";
import { afterDelete, formatRange, movedSelection } from "./core/pages";
import { Hub } from "./hub/hub";
import { FLOWS } from "./hub/flows";
import { TOOL_LIST, type ToolId } from "./hub/registry";
import { rememberFile } from "./recent";

const TOOLS: { id: Tool; label: string; key: string; icon: string }[] = [
  { id: "select", label: "Select", key: "V", icon: "select" },
  { id: "edit", label: "Edit text", key: "E", icon: "textEdit" },
  { id: "highlight", label: "Highlight", key: "H", icon: "highlight" },
  { id: "pen", label: "Pen", key: "P", icon: "pen" },
  { id: "text", label: "Text box", key: "T", icon: "text" },
  { id: "shape", label: "Shapes", key: "R", icon: "shape" },
  { id: "sign", label: "Sign", key: "S", icon: "sign" },
];


export class App {
  engine: Engine;
  settings: Settings = loadSettings();
  private viewer!: Viewer;
  private sidebar!: Sidebar;
  private hub!: Hub;
  private organize!: Organize;
  /** The open file is one of the samples (not added to recent files). */
  private sampleOpen = false;
  private openingSample = false;
  private info: DocInfo | null = null;
  private file: { name: string; handle: FileSystemFileHandle | null } | null = null;
  private dirty = false;
  private busyCount = 0;
  private hits: SearchHit[] = [];
  private hitIndex = -1;
  private searchTimer = 0;
  private ready: Promise<void>;
  private $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

  constructor(root: HTMLElement) {
    const { engine, ready } = createEngine();
    this.engine = engine;
    this.ready = ready;
    this.applyTheme();
    root.innerHTML = this.template();
    const main = this.$(".main");
    this.sidebar = new Sidebar(
      {
        engine,
        goTo: (i) => this.viewer.scrollToPage(i),
        viewerBusy: () => this.viewer?.busyWithVisible() ?? false,
        rotate: (p, d) => this.pageOp(this.engine.rotatePages(p, d), p),
        remove: (p) => this.removePages(p),
        extract: (p) => this.extractPages(p),
        insertPdf: (at) => this.insertPdf(at),
        insertBlank: (at) => this.pageOp(this.engine.insertBlankPage(at), [at], at),
        reorder: (order, moved) => this.pageOp(this.engine.reorderPages(order), movedSelection(order, moved)),
        resized: (w) => {
          this.settings.sidebarWidth = w;
          saveSettings(this.settings);
        },
        zoomed: (z) => {
          this.settings.sidebarZoom = z;
          saveSettings(this.settings);
        },
      },
      main,
    );
    this.viewer = new Viewer(
      {
        engine,
        settings: this.settings,
        edited: (info, pages) => this.edited(info, pages),
        currentPageChanged: (i) => this.currentChanged(i),
        zoomChanged: (z) => (this.$<HTMLButtonElement>("#zoom-label").textContent = `${Math.round(z * 100)}%`),
        needSignature: () => this.addSignature(),
        activeSignature: () => this.activeSignature(),
        busy: (p) => this.busy(p),
        recognize: () => void this.recognize(),
        saveSettings: () => saveSettings(this.settings),
      },
      main,
    );
    this.viewer.el.append(this.$("#empty"));
    // On phones the pages panel covers the page, so start with it closed there.
    if (window.matchMedia("(max-width: 760px)").matches) this.settings.sidebar = false;
    this.sidebar.show(this.settings.sidebar);
    addEventListener("papgi-about", () => this.menuAction("about"));
    this.sidebar.setTile(this.settings.sidebarZoom);
    this.sidebar.setWidth(this.settings.sidebarWidth);
    this.bind();
    this.setTool(this.settings.tool);
    this.renderOptions();
    this.updateUi();
    this.organize = new Organize(
      {
        engine,
        info: () => this.info,
        reorder: (order) => this.pageOp(this.engine.reorderPages(order)),
        rotate: (p, d) => this.pageOp(this.engine.rotatePages(p, d)),
        remove: (p) => this.removePages(p),
        insertPdf: (at) => this.insertPdf(at),
        insertBlank: (at) => this.pageOp(this.engine.insertBlankPage(at)),
        split: () => void this.gotoTool("split"),
        closed: (page) => {
          this.$("#btn-organize").classList.remove("on");
          if (page !== undefined) this.viewer.scrollToPage(page);
        },
      },
      main,
    );
    this.hub = new Hub(
      {
        engine,
        ready,
        openInEditor: (f) => this.openInEditor(f),
        editorDoc: () => (this.info && this.file ? this.file.name : null),
        showEditor: () => (location.hash = "#edit"),
        pickPdf: async () => (await pickPdfs(false))[0] ?? null,
        cycleTheme: () => this.cycleTheme(),
        themeIcon: () => this.themeIcon(),
        openSample: (name) => void this.openSample(name),
      },
      document.body,
    );
    this.hub.bindDrag();
    window.addEventListener("hashchange", () => this.route());
    this.route();
    onLaunchFiles((f) => void this.openInEditor(f));
    ready.catch((e) => toast(`The PDF engine failed to load: ${e.message}`, "error"));
  }

  private template(): string {
    return `
    <header class="topbar">
      <div class="tb-group">
        <div class="menu-wrap">
          <button class="brand brand-btn" id="btn-tools" title="All tools" aria-haspopup="menu"><span class="logo">${icon("file")}</span><span class="brand-name">papgi</span>${icon("down", "caret")}</button>
          <div class="menu tools-menu" id="tools-menu" role="menu" hidden>
            <button data-goto="home">${icon("home")}All tools</button>
            <hr>
            ${TOOL_LIST.map((t) => `<button data-goto="${t.id}">${icon(t.icon)}${t.id === "open" ? "Open another PDF" : t.name}${FLOWS[t.id]?.takes === "pdf" ? `<span class="muted small">this PDF</span>` : ""}</button>`).join("")}
          </div>
        </div>
        <button class="icon-btn" id="btn-sidebar" title="Pages panel">${icon("sidebar")}</button>
        <div class="menu-wrap">
          <button class="menu-label" id="btn-file" aria-haspopup="menu" title="Open, save, print">${icon("open", "ml-icon")}<span>File</span></button>
          <div class="menu left" id="file-menu" role="menu" hidden>
            <button data-menu="open">${icon("open")}Open…<kbd>Ctrl O</kbd></button>
            <button data-menu="save" data-needs-doc>${icon("save")}Save<kbd>Ctrl S</kbd></button>
            <button data-menu="saveas" data-needs-doc>${icon("extract")}Download a copy<kbd>Ctrl ⇧ S</kbd></button>
            <button data-menu="print" data-needs-doc>${icon("print")}Print…<kbd>Ctrl P</kbd></button>
            <hr>
            <button data-menu="keys">${icon("keyboard")}Keyboard shortcuts</button>
            <button data-menu="about">${icon("file")}About papgi</button>
          </div>
        </div>
        <div class="menu-wrap">
          <button class="menu-label" id="btn-doc" aria-haspopup="menu" title="Recognize text, sign, pages, compress…">${icon("tools", "ml-icon")}<span>Document</span></button>
          <div class="menu left" id="doc-menu" role="menu" hidden>
            <button data-menu="organize" data-needs-doc>${icon("pages")}Organize pages</button>
            <button data-menu="ocr" data-needs-doc>${icon("scan")}Recognize text (OCR)…</button>
            <button data-menu="signature">${icon("sign")}Add a signature…</button>
            <button data-menu="insert" data-needs-doc>${icon("insert")}Insert PDF at end…</button>
            <button data-menu="flatten" data-needs-doc>${icon("flatten")}Flatten forms &amp; annotations</button>
            <hr>
            ${TOOL_LIST.filter((t) => FLOWS[t.id]?.takes === "pdf").map((t) => `<button data-goto="${t.id}" data-needs-doc>${icon(t.icon)}${t.id === "merge" ? "Merge with other PDFs…" : `${t.name}…`}</button>`).join("")}
          </div>
        </div>
        <button class="menu-label" id="btn-organize" title="See all pages: drag to reorder, turn, remove, insert">${icon("pages", "ml-icon")}<span>Pages</span></button>
      </div>
      <div class="docname" id="docname"><span class="dirty-dot" title="Unsaved changes"></span><span class="name"></span></div>
      <div class="tb-group">
        <button class="icon-btn" id="btn-undo" title="Undo (Ctrl+Z)">${icon("undo")}</button>
        <button class="icon-btn" id="btn-redo" title="Redo (Ctrl+Y)">${icon("redo")}</button>
      </div>
      <div class="tb-group pagenav">
        <input id="page-input" class="page-input" inputmode="numeric" aria-label="Current page" value="0">
        <span class="muted" id="page-count">/ 0</span>
      </div>
      <div class="tb-group">
        <button class="icon-btn" id="btn-zoom-out" title="Zoom out (Ctrl −)">${icon("zoomOut")}</button>
        <button class="zoom-label" id="zoom-label" title="Fit width (Ctrl 0)">100%</button>
        <button class="icon-btn" id="btn-zoom-in" title="Zoom in (Ctrl +)">${icon("zoomIn")}</button>
      </div>
      <div class="tb-group">
        <button class="icon-btn" id="btn-search" title="Search (Ctrl+F)">${icon("search")}</button>
        <button class="icon-btn" id="btn-theme" title="Theme">${icon("auto")}</button>
      </div>
      <div class="searchbar" id="searchbar" hidden>
        <input id="search-input" type="search" placeholder="Search in document" aria-label="Search">
        <span class="muted" id="search-count"></span>
        <button class="icon-btn" id="search-prev" title="Previous (Shift+Enter)">${icon("up")}</button>
        <button class="icon-btn" id="search-next" title="Next (Enter)">${icon("down")}</button>
        <button class="icon-btn" id="search-close" title="Close (Esc)">${icon("close")}</button>
      </div>
      <div class="progress" id="progress"></div>
    </header>
    <nav class="toolstrip" aria-label="Tools">
      <div class="tools" role="radiogroup">
        ${TOOLS.map((t) => `<button class="tool" data-tool="${t.id}" role="radio" title="${t.label} (${t.key})">${icon(t.icon)}<span>${t.label}</span></button>`).join("")}
      </div>
      <div class="options" id="options"></div>
    </nav>
    <div class="main"></div>
    <div class="empty" id="empty">
      <div class="empty-card">
        <div class="empty-icon">${icon("file")}</div>
        <h1>Open a PDF to start</h1>
        <p class="muted">Annotate, highlight, fill forms, sign and rearrange pages. Everything stays on this device.</p>
        <button class="btn primary big" id="empty-open">${icon("open")}Open PDF</button>
        <p class="muted small">or drop a file anywhere</p>
        <button class="btn flat" id="empty-tools">${icon("tools")}All tools</button>
      </div>
    </div>
    <div class="dropzone" id="dropzone"><div>Drop files here</div></div>`;
  }

  // ---------- wiring ----------

  private bind(): void {
    const on = (id: string, fn: () => void) => this.$(id).addEventListener("click", fn);
    on("#empty-open", () => this.openPicker());
    on("#empty-tools", () => (location.hash = ""));
    on("#btn-tools", () => this.toggleMenu(undefined, "#tools-menu"));
    this.$("#tools-menu").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-goto]");
      if (!b) return;
      this.toggleMenu(false, "#tools-menu");
      void this.gotoTool(b.dataset.goto as ToolId | "home");
    });
    on("#btn-undo", () => this.undo());
    on("#btn-redo", () => this.redo());
    on("#btn-zoom-in", () => this.viewer.setZoom(nextZoom(this.viewer.zoom, 1)));
    on("#btn-zoom-out", () => this.viewer.setZoom(nextZoom(this.viewer.zoom, -1)));
    on("#zoom-label", () => this.viewer.setFitWidth());
    on("#btn-search", () => this.openSearch());
    on("#btn-theme", () => this.cycleTheme());
    on("#btn-sidebar", () => {
      this.settings.sidebar = !this.settings.sidebar;
      saveSettings(this.settings);
      this.sidebar.show(this.settings.sidebar);
      this.updateUi();
    });
    on("#btn-file", () => this.toggleMenu(undefined, "#file-menu"));
    on("#btn-organize", () => this.toggleOrganize());
    on("#btn-doc", () => this.toggleMenu(undefined, "#doc-menu"));
    for (const id of ["#file-menu", "#doc-menu"])
      this.$(id).addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-menu], button[data-goto]");
        if (!b) return;
        this.toggleMenu(false, id);
        if (b.dataset.goto) void this.gotoTool(b.dataset.goto as ToolId);
        else this.menuAction(b.dataset.menu!);
      });
    document.addEventListener("pointerdown", (e) => {
      if (!(e.target as HTMLElement).closest(".menu-wrap")) this.closeMenus();
    });
    this.$(".tools").addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tool]");
      if (b) this.setTool(b.dataset.tool as Tool);
    });
    this.$("#options").addEventListener("click", (e) => this.onOption(e));
    this.$("#options").addEventListener("input", (e) => this.onOption(e));

    const pageInput = this.$<HTMLInputElement>("#page-input");
    pageInput.addEventListener("change", () => {
      const n = parseInt(pageInput.value, 10);
      if (this.info && n >= 1 && n <= this.info.pageCount) this.viewer.scrollToPage(n - 1);
      else pageInput.value = String(this.viewer.currentPage() + 1);
    });
    pageInput.addEventListener("keydown", (e) => e.key === "Enter" && pageInput.blur());

    const si = this.$<HTMLInputElement>("#search-input");
    si.addEventListener("input", () => {
      clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => this.runSearch(si.value), 220);
    });
    si.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.stepSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") this.closeSearch();
    });
    on("#search-next", () => this.stepSearch(1));
    on("#search-prev", () => this.stepSearch(-1));
    on("#search-close", () => this.closeSearch());

    // drag & drop
    const dz = this.$("#dropzone");
    let depth = 0;
    const dialogOpen = () => !!document.querySelector(".modal-back");
    window.addEventListener("dragenter", (e) => {
      if (!e.dataTransfer?.types.includes("Files") || dialogOpen() || this.hub.draggingRow()) return;
      depth++;
      dz.classList.add("show");
    });
    window.addEventListener("dragleave", () => {
      if (--depth <= 0) {
        depth = 0;
        dz.classList.remove("show");
      }
    });
    window.addEventListener("dragover", (e) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    window.addEventListener("drop", async (e) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      depth = 0;
      dz.classList.remove("show");
      if (dialogOpen()) return;
      const items = [...e.dataTransfer.items].filter((it) => it.kind === "file");
      // (read everything now: the drop data is gone after the first await)
      const pending = items.map((item) => {
        const withHandle = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
        return { file: item.getAsFile(), handle: withHandle.getAsFileSystemHandle?.().catch(() => null) };
      });
      const files: OpenedFile[] = [];
      for (const p of pending) {
        if (!p.file) continue;
        const h = await p.handle;
        files.push(await fileToOpened(p.file, h && h.kind === "file" ? (h as FileSystemFileHandle) : null));
      }
      if (!files.length) return;
      if (this.hub.visible()) return void this.hub.drop(files);
      const pdf = files.find((f) => /\.pdf$/i.test(f.name)) ?? files[0];
      await this.openInEditor(pdf);
    });

    document.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("copy", (e) => {
      if (this.viewer.hasTextSelection() && !this.isTyping(e.target)) {
        e.preventDefault();
        void this.viewer.copySelection();
      }
    });
    window.addEventListener("beforeunload", (e) => {
      if (this.dirty) e.preventDefault();
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.applyTheme());
  }

  private isTyping(t: EventTarget | null): boolean {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  }

  private onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (document.querySelector(".modal-back")) return;
    if (this.hub?.visible()) return;
    if (mod && k === "s") {
      e.preventDefault();
      return void (e.shiftKey ? this.saveCopy() : this.save());
    }
    if (mod && k === "p") {
      e.preventDefault();
      return void this.print();
    }
    if (mod && k === "o") {
      e.preventDefault();
      return void this.openPicker();
    }
    if (mod && k === "f") {
      e.preventDefault();
      return this.openSearch();
    }
    if (this.isTyping(e.target)) return;
    if (mod && (k === "=" || k === "+")) {
      e.preventDefault();
      return this.viewer.setZoom(nextZoom(this.viewer.zoom, 1));
    }
    if (mod && k === "-") {
      e.preventDefault();
      return this.viewer.setZoom(nextZoom(this.viewer.zoom, -1));
    }
    if (mod && k === "0") {
      e.preventDefault();
      return this.viewer.setFitWidth();
    }
    if (mod && k === "z") {
      e.preventDefault();
      return void (e.shiftKey ? this.redo() : this.undo());
    }
    if (mod && k === "y") {
      e.preventDefault();
      return void this.redo();
    }
    if (mod && k === "c") {
      if (this.viewer.hasTextSelection()) {
        e.preventDefault();
        void this.viewer.copySelection();
      }
      return;
    }
    if (mod || e.altKey) return;
    // (the page grid has its own keys: arrows, R, Delete)
    if (this.organize.isOpen()) {
      if (e.key === "Escape") this.organize.close();
      return;
    }
    if (e.key === "Escape") {
      this.closeMenus();
      this.viewer.clearSelection();
      this.viewer.selectAnnot(null);
      if (this.settings.tool !== "select") this.setTool("select");
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (this.viewer.selectedAnnot()) {
        e.preventDefault();
        void this.viewer.deleteSelectedAnnot().catch((err) => toast(err.message, "error"));
      } else if (this.sidebar.focused() && this.sidebar.hasSelection()) {
        e.preventDefault();
        this.removePages(this.sidebar.targetPages());
      }
      return;
    }
    const tool = TOOLS.find((t) => t.key.toLowerCase() === k);
    if (tool && this.info) {
      e.preventDefault();
      this.setTool(tool.id);
    }
  }

  // ---------- tools & options ----------

  private setTool(tool: Tool): void {
    this.settings.tool = tool;
    saveSettings(this.settings);
    this.viewer.setTool(tool);
    document.querySelectorAll<HTMLButtonElement>("[data-tool]").forEach((b) => {
      b.classList.toggle("on", b.dataset.tool === tool);
      b.setAttribute("aria-checked", String(b.dataset.tool === tool));
    });
    this.renderOptions();
  }

  private renderOptions(): void {
    const s = this.settings;
    const t = s.tool;
    const el = this.$("#options");
    const swatches = () =>
      `<div class="swatches">${PALETTE.map((c) => `<button class="swatch ${s.colors[t] === c ? "on" : ""}" data-color="${c}" style="--c:${c}" title="${c}"></button>`).join("")}
       <label class="swatch custom" title="Custom colour" style="--c:${s.colors[t]}"><input type="color" data-color-input value="${s.colors[t]}"></label></div>`;
    const seg = (name: string, items: [string, string, string][], value: string) =>
      `<div class="seg">${items.map(([v, ic, label]) => `<button data-${name}="${v}" class="${v === value ? "on" : ""}" title="${label}">${icon(ic)}</button>`).join("")}</div>`;
    const range = (name: string, min: number, max: number, step: number, value: number, label: string, unit = "pt") =>
      `<label class="range"><span class="muted">${label}</span><input type="range" data-range="${name}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}${unit}</output></label>`;
    let html = "";
    switch (t) {
      case "select":
        html = `<span class="muted hint">Drag over text to select it · click an annotation to move, recolour or delete it · drag empty space to scroll</span>`;
        break;
      case "edit":
        html = `<span class="muted hint">Click a paragraph to change its text · Ctrl+Enter or click outside to finish · Esc to cancel</span>`;
        break;
      case "highlight":
        html = seg("mark", [["Highlight", "highlight", "Highlight"], ["Underline", "underline", "Underline"], ["StrikeOut", "strike", "Strike out"]], s.markKind) + swatches() +
          `<span class="muted hint">Drag over text — or over any area on scans</span>`;
        break;
      case "pen":
        html = swatches() + range("penWidth", 0.5, 12, 0.5, s.penWidth, "Width");
        break;
      case "text":
        html = swatches() + range("textSize", 6, 48, 1, s.textSize, "Size") + `<span class="muted hint">Click to add a text box · Ctrl+Enter to finish</span>`;
        break;
      case "shape":
        html = seg("shape", [["Square", "square", "Rectangle"], ["Circle", "circle", "Ellipse"], ["Arrow", "arrow", "Arrow"]], s.shapeKind) + swatches() + range("shapeWidth", 0.5, 12, 0.5, s.shapeWidth, "Width");
        break;
      case "sign": {
        const active = this.activeSignature();
        const chips = s.signatures
          .map((sig, i) => `<button class="sig-chip ${sig.id === active?.id ? "on" : ""}" data-sigid="${sig.id}" title="Signature ${i + 1}">${this.signatureThumb(sig)}</button>`)
          .join("");
        const add =
          s.signatures.length < MAX_SIGNATURES
            ? `<button class="sig-chip add" data-act="sig-add" title="Add a signature (up to ${MAX_SIGNATURES})">${icon("plus")}${s.signatures.length ? "" : "<span>Add signature</span>"}</button>`
            : "";
        html =
          `<div class="sig-chips" role="radiogroup" aria-label="Saved signatures">${chips}${add}</div>` +
          (active
            ? `<button class="icon-btn sm" data-act="sig-edit" title="Edit this signature">${icon("edit")}</button><button class="icon-btn sm" data-act="sig-delete" title="Delete this signature">${icon("trash")}</button>`
            : "") +
          (active?.kind === "drawn" ? swatches() : "") +
          range("signatureWidth", 60, 300, 5, s.signatureWidth, "Size", "") +
          `<span class="muted hint">${active ? "Click on the page to place it" : `Save up to ${MAX_SIGNATURES} signatures`}</span>`;
        break;
      }
    }
    el.innerHTML = html;
  }

  private onOption(e: Event): void {
    const target = e.target as HTMLElement;
    const s = this.settings;
    const t = s.tool;
    if (e.type === "input") {
      const input = target as HTMLInputElement;
      if (input.dataset.range) {
        (s as unknown as Record<string, number>)[input.dataset.range] = Number(input.value);
        const out = input.parentElement!.querySelector("output")!;
        out.textContent = `${input.value}${input.dataset.range === "signatureWidth" ? "" : "pt"}`;
        saveSettings(s);
      } else if (input.dataset.colorInput !== undefined) {
        s.colors[t] = input.value;
        saveSettings(s);
        this.renderOptions();
      }
      return;
    }
    const b = target.closest<HTMLButtonElement>("button");
    if (!b) return;
    if (b.dataset.color) s.colors[t] = b.dataset.color;
    else if (b.dataset.mark) s.markKind = b.dataset.mark as Settings["markKind"];
    else if (b.dataset.shape) s.shapeKind = b.dataset.shape as Settings["shapeKind"];
    else if (b.dataset.sigid) s.activeSignature = b.dataset.sigid;
    else if (b.dataset.act === "sig-add") return void this.addSignature();
    else if (b.dataset.act === "sig-edit") return void this.editSignature();
    else if (b.dataset.act === "sig-delete") return void this.deleteSignature();
    else return;
    saveSettings(s);
    this.renderOptions();
  }

  /** The signature the Sign tool places. */
  private activeSignature(): SavedSignature | null {
    const list = this.settings.signatures;
    return list.find((x) => x.id === this.settings.activeSignature) ?? list[0] ?? null;
  }

  /** Small preview for the signature picker. */
  private signatureThumb(sig: SavedSignature): string {
    if (sig.kind === "image") return `<img src="${sig.image.src}" alt="">`;
    const b = strokesBounds(sig.strokes);
    if (!b) return "";
    const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.06 + 2;
    const vb = `${b[0] - pad} ${b[1] - pad} ${b[2] - b[0] + 2 * pad} ${b[3] - b[1] + 2 * pad}`;
    const w = Math.max(b[2] - b[0], 1) / 60;
    return `<svg viewBox="${vb}" preserveAspectRatio="xMidYMid meet">${sig.strokes
      .map((st) => `<polyline points="${st.map((q) => q.join(",")).join(" ")}" fill="none" stroke="${this.settings.colors.sign}" stroke-width="${w * 3}" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("")}</svg>`;
  }

  private async addSignature(): Promise<boolean> {
    const s = this.settings;
    if (s.signatures.length >= MAX_SIGNATURES) {
      toast(`You can keep up to ${MAX_SIGNATURES} signatures. Delete one first.`, "error");
      return false;
    }
    const res = await signatureDialog({ title: "New signature", color: s.colors.sign, strokes: null, image: null, start: "drawn" });
    if (!res) return false;
    const sig: SavedSignature = res.kind === "drawn" ? { id: newSignatureId(), kind: "drawn", strokes: res.strokes } : { id: newSignatureId(), kind: "image", image: res.image };
    s.signatures.push(sig);
    s.activeSignature = sig.id;
    saveSettings(s);
    if (s.tool !== "sign") this.setTool("sign");
    else this.renderOptions();
    toast("Signature saved on this device");
    return true;
  }

  private async editSignature(): Promise<void> {
    const s = this.settings;
    const cur = this.activeSignature();
    if (!cur) return void this.addSignature();
    const res = await signatureDialog({
      title: "Edit signature",
      color: s.colors.sign,
      strokes: cur.kind === "drawn" ? cur.strokes : null,
      image: cur.kind === "image" ? cur.image : null,
      start: cur.kind,
    });
    if (!res) return;
    const next: SavedSignature = res.kind === "drawn" ? { id: cur.id, kind: "drawn", strokes: res.strokes } : { id: cur.id, kind: "image", image: res.image };
    s.signatures = s.signatures.map((x) => (x.id === cur.id ? next : x));
    saveSettings(s);
    this.renderOptions();
    toast("Signature updated");
  }

  private async deleteSignature(): Promise<void> {
    const s = this.settings;
    const cur = this.activeSignature();
    if (!cur) return;
    if (!(await confirmDialog("Delete signature?", "This removes the selected signature from this device. Signatures already placed in documents stay.", "Delete", true))) return;
    s.signatures = s.signatures.filter((x) => x.id !== cur.id);
    s.activeSignature = s.signatures[0]?.id ?? null;
    saveSettings(s);
    this.renderOptions();
  }

  // ---------- theme & menu ----------

  private applyTheme(): void {
    const t = this.settings.theme;
    const dark = t === "dark" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#16181d" : "#f6f7f9");
    const btn = document.querySelector("#btn-theme");
    if (btn) {
      btn.innerHTML = icon(this.themeIcon());
      btn.setAttribute("title", `Theme: ${t}`);
    }
  }

  private cycleTheme(): void {
    const order: Theme[] = ["auto", "light", "dark"];
    this.settings.theme = order[(order.indexOf(this.settings.theme) + 1) % 3];
    saveSettings(this.settings);
    this.applyTheme();
    toast(`Theme: ${this.settings.theme}`);
  }

  private toggleMenu(force: boolean | undefined, sel: string): void {
    const m = this.$(sel);
    const show = force === undefined ? m.hidden === true : force;
    // (one menu at a time)
    if (show) this.closeMenus();
    m.hidden = !show;
    m.previousElementSibling?.classList.toggle("open", show);
  }

  /** The page grid over the editor (Pages button). */
  private toggleOrganize(force?: boolean): void {
    if (!this.info) return;
    const open = force ?? !this.organize.isOpen();
    if (open) {
      this.viewer.closeEditor(true);
      void this.viewer.closeParagraph(true);
      this.organize.open();
      this.$("#btn-organize").classList.add("on");
    } else this.organize.close();
  }

  private closeMenus(): void {
    for (const id of ["#tools-menu", "#file-menu", "#doc-menu"]) {
      this.$(id).hidden = true;
      this.$(id).previousElementSibling?.classList.remove("open");
    }
  }

  private themeIcon(): string {
    const t = this.settings.theme;
    return t === "auto" ? "auto" : t === "dark" ? "moon" : "sun";
  }

  // ---------- views: start screen, tool pages, editor ----------

  /** Show what the address says: "" = start screen, #edit = editor, #merge etc. = tool pages. */
  private route(): void {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h === "edit") {
      this.hub.hide();
      document.title = this.file && this.info ? `${this.file.name} · papgi` : "papgi";
      return;
    }
    this.viewer.closeEditor(true);
    void this.viewer.closeParagraph(true);
    this.hub.show(FLOWS[h] || h === "open" ? (h as ToolId) : "home");
  }

  /** Open a file in the editor and show it. */
  async openInEditor(f: OpenedFile): Promise<void> {
    await this.open(f);
    if (!this.info || this.file?.name !== f.name) return;
    if (location.hash !== "#edit") location.hash = "#edit";
    else this.route();
  }

  /** From the editor's tools menu: the start screen, an action here, or a tool with this PDF. */
  private async gotoTool(id: ToolId | "home"): Promise<void> {
    if (id === "home") return void (location.hash = "");
    if (id === "open") return void (location.hash = "#open");
    if (!FLOWS[id]) return;
    let file: OpenedFile | null = null;
    if (this.info && this.file && FLOWS[id].takes === "pdf") {
      this.viewer.closeEditor(true);
      await this.viewer.closeParagraph(true);
      file = { name: this.file.name, bytes: await this.busy(this.engine.save(false)), handle: null };
    }
    this.hub.go(id);
    if (file) await this.hub.drop([file]);
  }

  /** Remember the open file in "Recent files", with a small picture of page 1. */
  private async remember(bytes: Uint8Array): Promise<void> {
    if (!this.info || !this.file || this.sampleOpen) return;
    const file = this.file;
    let thumb = "";
    try {
      const p = this.info.pages[0];
      const bmp = await this.engine.renderBitmap(0, 120 / Math.max(p.w, p.h));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d")!.drawImage(bmp, 0, 0);
      bmp.close();
      thumb = c.toDataURL("image/jpeg", 0.72);
    } catch {
      /* no picture */
    }
    await rememberFile({ name: file.name, bytes, handle: file.handle, pages: this.info.pageCount, thumb });
  }

  private menuAction(a: string): void {
    switch (a) {
      case "open": return void this.openPicker();
      case "save": return void this.save();
      case "saveas": return void this.saveCopy();
      case "insert": return void (this.info && this.insertPdf(this.info.pageCount));
      case "flatten": return void this.flatten();
      case "organize": return this.toggleOrganize(true);
      case "ocr": return void this.recognize();
      case "print": return void this.print();
      case "signature": return void this.addSignature();
      case "keys": return showShortcuts();
      case "about":
        return void modal({
          title: "About papgi",
          body: `<p>papgi is a PDF editor and toolbox that runs entirely in your browser. Your files are never uploaded: opening, editing, converting and text recognition all happen on this device, and it works offline once loaded.</p>
                 <p>Found a problem or have an idea? <a href="https://github.com/mhoangtrinh/papgi/issues" target="_blank" rel="noopener">Tell us on GitHub</a>.</p>
                 <p class="muted small">Version ${__APP_VERSION__} · ${__BUILD_DATE__}<br>Free software under the AGPL-3.0. Built on <a href="https://mupdf.com" target="_blank" rel="noopener">MuPDF</a> (AGPL) and <a href="https://github.com/naptha/tesseract.js" target="_blank" rel="noopener">Tesseract</a> (Apache-2.0). Source and licenses: <a href="https://github.com/mhoangtrinh/papgi" target="_blank" rel="noopener">github.com/mhoangtrinh/papgi</a></p>`,
          actions: [{ label: "Close", value: "", primary: true }],
        });
    }
  }

  // ---------- files ----------

  private async openPicker(): Promise<void> {
    const [f] = await pickPdfs(false);
    if (f) await this.open(f);
  }

  private async openSample(name: string): Promise<void> {
    try {
      const res = await fetch(`./samples/${name}`);
      if (!res.ok) throw new Error(`Couldn't load the sample (${res.status})`);
      this.openingSample = true;
      await this.openInEditor({ name, bytes: new Uint8Array(await res.arrayBuffer()), handle: null });
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async open(f: OpenedFile): Promise<void> {
    const sample = this.openingSample;
    this.openingSample = false;
    if (this.dirty && !(await confirmDialog("Discard changes?", "The current document has unsaved changes.", "Discard", true))) return;
    await this.ready;
    // (the engine takes over the bytes; keep a copy for "Recent files")
    const keep = f.bytes.slice();
    try {
      let info = await this.busy(this.engine.open(f.bytes, f.name));
      let wrong = false;
      while (!info) {
        const pw = await askPassword(f.name, wrong);
        if (pw === null) {
          await this.engine.close();
          this.setDoc(null);
          return;
        }
        info = await this.engine.authenticate(pw);
        wrong = true;
      }
      this.file = { name: f.name, handle: f.handle };
      this.sampleOpen = sample;
      this.setDoc(info);
      void this.remember(keep);
      if (info.pageCount > 0 && !(await this.engine.pageText(0)).trim()) {
        const scanned = info.pageCount === 1 || !(await this.engine.pageText(Math.min(1, info.pageCount - 1))).trim();
        if (scanned) toast("This looks like a scan: there's no text to select yet.", "info", { label: "Recognize text", run: () => void this.recognize() });
      }
    } catch (e) {
      toast(`Couldn't open ${f.name}: ${friendlyError((e as Error).message)}`, "error");
    }
  }

  private setDoc(info: DocInfo | null): void {
    this.organize?.close();
    this.info = info;
    this.dirty = false;
    this.closeSearch();
    this.sidebar.setDocument(info);
    this.viewer.setDocument(info);
    this.$("#empty").hidden = !!info;
    document.body.classList.toggle("has-doc", !!info);
    this.updateUi({ canUndo: false, canRedo: false, dirty: false, undoName: "", redoName: "" });
  }

  private async save(): Promise<void> {
    if (!this.info || !this.file) return;
    this.viewer.closeEditor(true);
    await this.viewer.closeParagraph(true);
    try {
      if (this.file.handle) {
        const bytes = await this.busy(this.engine.save(false));
        await writeToHandle(this.file.handle, bytes);
        await this.engine.markSaved();
        toast(`Saved ${this.file.name}`);
        void this.remember(bytes);
      } else {
        const bytes = await this.busy(this.engine.save(false));
        await saveAs(bytes, this.file.name);
        await this.engine.markSaved();
        toast(`Downloaded ${this.file.name}`);
        void this.remember(bytes);
      }
      this.updateUi(await this.engine.state());
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, "error");
    }
  }

  private async saveCopy(): Promise<void> {
    if (!this.info || !this.file) return;
    this.viewer.closeEditor(true);
    await this.viewer.closeParagraph(true);
    try {
      const bytes = await this.busy(this.engine.save(false));
      const name = `${baseName(this.file.name)} (copy).pdf`;
      await saveAs(bytes, name);
      toast(`Downloaded ${name}`);
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`, "error");
    }
  }

  // ---------- editing ----------

  private async edited(info: DocInfo | null, pages: number[]): Promise<void> {
    if (info) this.info = info;
    this.sidebar.refresh(pages);
    this.updateUi(await this.engine.state());
  }

  private async undo(): Promise<void> {
    if (!this.info) return;
    this.viewer.closeEditor(true);
    const r = await this.busy(this.engine.undoStep());
    if (r) await this.afterHistory(r.info, `Undid: ${r.name}`);
  }

  private async redo(): Promise<void> {
    if (!this.info) return;
    const r = await this.busy(this.engine.redoStep());
    if (r) await this.afterHistory(r.info, `Redid: ${r.name}`);
  }

  private async afterHistory(info: DocInfo, msg: string): Promise<void> {
    const structural = !this.info || info.pageCount !== this.info.pageCount || info.pages.some((p, i) => p.rotation !== this.info!.pages[i]?.rotation);
    this.info = info;
    this.viewer.refresh(info);
    if (structural) this.sidebar.setDocument(info);
    else this.sidebar.refresh("all");
    this.organize.docChanged(info);
    this.updateUi(await this.engine.state());
    if (msg.trim().endsWith(":")) return;
    toast(msg);
  }

  /** Run a page operation, then rebuild views. */
  private async pageOp(job: Promise<DocInfo>, select: number[] = [], goTo?: number): Promise<void> {
    try {
      const info = await this.busy(job);
      this.info = info;
      this.viewer.refresh(info);
      this.sidebar.setDocument(info, select.filter((i) => i < info.pageCount));
      this.organize.docChanged(info);
      if (goTo !== undefined && !this.organize.isOpen()) this.viewer.scrollToPage(Math.min(goTo, info.pageCount - 1));
      this.updateUi(await this.engine.state());
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  private async removePages(pages: number[]): Promise<void> {
    if (!this.info) return;
    if (pages.length >= this.info.pageCount) return toast("A PDF needs at least one page", "error");
    if (pages.length > 1 && !(await confirmDialog("Delete pages?", `Delete pages ${formatRange(pages)}? You can undo this.`, "Delete", true))) return;
    const next = afterDelete(this.info.pageCount, pages);
    await this.pageOp(this.engine.deletePages(pages), [], next);
  }

  private async extractPages(pages: number[]): Promise<void> {
    if (!this.file) return;
    try {
      const bytes = await this.busy(this.engine.extractPages(pages));
      const name = `${baseName(this.file.name)} (p${formatRange(pages).replace(/\s/g, "")}).pdf`;
      download(bytes, name);
      toast(`Downloaded ${pages.length} page${pages.length > 1 ? "s" : ""} as ${name}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  private async insertPdf(at: number): Promise<void> {
    const files = await pickPdfs(true);
    let pos = at;
    for (const f of files) {
      const n = this.info?.pageCount ?? 0;
      await this.pageOp(this.engine.insertPdf(f.bytes, pos), [], pos);
      pos += (this.info?.pageCount ?? n) - n;
    }
    if (files.length) toast(`Inserted ${files.map((f) => f.name).join(", ")}`);
  }

  // ---------- printing ----------

  /** Print the document as it is now (edits, annotations, signatures, filled forms). */
  async print(): Promise<void> {
    if (!this.info) return toast("Open a PDF first");
    this.viewer.closeEditor(true);
    await this.viewer.closeParagraph(true);
    try {
      if (canPrintPdfNatively()) {
        try {
          const bytes = await this.busy(this.engine.save(false));
          await this.busy(printPdfBytes(bytes));
          return;
        } catch {
          // the PDF viewer is blocked or failed: print page images instead
        }
      }
      await this.busy(printAsImages(this.engine, this.info));
    } catch (e) {
      toast(`Couldn't print: ${(e as Error).message}`, "error");
    }
  }

  // ---------- text recognition ----------

  private ocrRunning = false;

  /** Recognise the text on scanned pages (asks which pages and languages first). */
  async recognize(): Promise<void> {
    if (!this.info || this.ocrRunning) return;
    this.viewer.closeEditor(true);
    const scanned: number[] = [];
    for (let i = 0; i < this.info.pageCount; i++) if (!(await this.engine.pageHasText(i))) scanned.push(i);
    if (!scanned.length) return toast("Every page already has text that can be selected.");
    const choice = await ocrDialog({ pageCount: this.info.pageCount, current: this.viewer.currentPage(), scanned, langs: this.settings.ocrLangs });
    if (!choice) return;
    this.settings.ocrLangs = choice.langs;
    saveSettings(this.settings);
    this.ocrRunning = true;
    try {
      const res = await runOcr(this.engine, choice, document.baseURI);
      if (!res.pages.length) return void toast(res.stopped ? "Stopped. Nothing was added." : "No text was found on these pages.");
      const info = await this.engine.info();
      this.viewer.refresh(info, res.pages);
      await this.edited(info, res.pages);
      const pages = res.pages.length === 1 ? `page ${res.pages[0] + 1}` : `${res.pages.length} pages`;
      toast(`${res.stopped ? "Stopped. " : ""}Recognized ${res.words} words on ${pages}. Select, search or edit them now.`);
    } catch (e) {
      toast(`Text recognition failed: ${(e as Error).message}`, "error");
    } finally {
      this.ocrRunning = false;
    }
  }

  private async flatten(): Promise<void> {
    if (!this.info) return;
    if (!(await confirmDialog("Flatten?", "Annotations and form fields become part of the page and can no longer be edited. You can undo this until you close the file.", "Flatten"))) return;
    await this.pageOp(this.engine.flatten());
  }

  // ---------- search ----------

  private openSearch(): void {
    if (!this.info) return;
    const bar = this.$("#searchbar");
    bar.hidden = false;
    const si = this.$<HTMLInputElement>("#search-input");
    si.focus();
    si.select();
  }

  private closeSearch(): void {
    this.$("#searchbar").hidden = true;
    this.hits = [];
    this.hitIndex = -1;
    this.viewer.setSearchHits([], -1);
    this.$("#search-count").textContent = "";
  }

  private async runSearch(q: string): Promise<void> {
    if (!this.info) return;
    const hits = q.trim().length ? await this.engine.search(q) : [];
    this.hits = hits;
    const cur = this.viewer.currentPage();
    this.hitIndex = hits.length ? Math.max(0, hits.findIndex((h) => h.page >= cur)) : -1;
    this.viewer.setSearchHits(hits, this.hitIndex);
    this.updateSearchCount(q);
  }

  private stepSearch(dir: 1 | -1): void {
    if (!this.hits.length) return;
    this.hitIndex = (this.hitIndex + dir + this.hits.length) % this.hits.length;
    this.viewer.setSearchHits(this.hits, this.hitIndex);
    this.updateSearchCount(this.$<HTMLInputElement>("#search-input").value);
  }

  private updateSearchCount(q: string): void {
    this.$("#search-count").textContent = !q.trim() ? "" : this.hits.length ? `${this.hitIndex + 1} / ${this.hits.length}` : "No results";
  }

  // ---------- status ----------

  private currentChanged(i: number): void {
    const input = this.$<HTMLInputElement>("#page-input");
    if (document.activeElement !== input) input.value = String(i + 1);
    this.sidebar.setCurrent(i);
  }

  private updateUi(st?: { canUndo: boolean; canRedo: boolean; dirty: boolean; undoName: string; redoName: string }): void {
    const has = !!this.info;
    if (st) {
      this.dirty = st.dirty;
      this.$<HTMLButtonElement>("#btn-undo").disabled = !st.canUndo;
      this.$<HTMLButtonElement>("#btn-redo").disabled = !st.canRedo;
      this.$("#btn-undo").title = st.canUndo ? `Undo ${st.undoName} (Ctrl+Z)` : "Undo (Ctrl+Z)";
      this.$("#btn-redo").title = st.canRedo ? `Redo ${st.redoName} (Ctrl+Y)` : "Redo (Ctrl+Y)";
    }
    for (const id of ["#btn-search", "#btn-zoom-in", "#btn-zoom-out", "#zoom-label", "#page-input"]) {
      this.$<HTMLButtonElement>(id).disabled = !has;
    }
    document.querySelectorAll<HTMLButtonElement>(".menu [data-needs-doc]").forEach((b) => (b.disabled = !has));
    if (!has) {
      this.$<HTMLButtonElement>("#btn-undo").disabled = true;
      this.$<HTMLButtonElement>("#btn-redo").disabled = true;
    }
    this.$("#btn-sidebar").classList.toggle("on", this.settings.sidebar);
    document.querySelectorAll<HTMLButtonElement>(".toolstrip [data-tool]").forEach((b) => (b.disabled = !has));
    const name = this.file?.name ?? "";
    this.$("#docname .name").textContent = has ? name : "";
    this.$("#docname").classList.toggle("dirty", has && this.dirty);
    this.$("#page-count").textContent = `/ ${this.info?.pageCount ?? 0}`;
    if (!has) this.$<HTMLInputElement>("#page-input").value = "0";
    document.title = has ? `${this.dirty ? "• " : ""}${name} — papgi` : "papgi";
  }

  /** A new version of the app is ready to use. */
  updateReady(apply: () => void): void {
    if (!this.info) return apply();
    let bar = document.querySelector<HTMLDivElement>(".update-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "update-bar";
      bar.setAttribute("role", "status");
      document.body.append(bar);
    }
    bar.innerHTML = `<span>A new version of papgi is ready.</span><button class="btn small primary" data-act="reload">Reload</button><button class="icon-btn sm" data-act="later" title="Later">${icon("close")}</button>`;
    bar.onclick = async (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
      if (!b) return;
      if (b.dataset.act === "later") return bar!.remove();
      if (this.dirty && !(await confirmDialog("Reload now?", "You have unsaved changes. Save first, or they will be lost.", "Reload anyway", true))) return;
      this.dirty = false;
      apply();
    };
  }

  private async busy<T>(p: Promise<T>): Promise<T> {
    this.busyCount++;
    const timer = setTimeout(() => this.$("#progress").classList.add("on"), 250);
    try {
      return await p;
    } finally {
      clearTimeout(timer);
      if (--this.busyCount === 0) this.$("#progress").classList.remove("on");
    }
  }
}

export { ZOOM_STEPS };

