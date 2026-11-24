// The start screen (tools + recent files) and the stand-alone tool pages.
// It sits over the editor; the app shows it for the routes "" (home) and the flow tools' ids.
import { t } from "../i18n";
import type { Engine } from "../engine/client";
import type { OutFile } from "../engine/tools";
import type { OpenedFile } from "../files";
import { saveFile, friendlyError } from "../files";
import { icon } from "../ui/icons";
import { askPassword, confirmDialog, toast } from "../ui/dialogs";
import { zip } from "../core/zip";
import {
  ago,
  forgetAll,
  forgetFile,
  formatSize,
  listRecent,
  readRecent,
  type RecentFile,
} from "../recent";
import { TOOL_LIST, tool, type ToolDef, type ToolId } from "./registry";
import {
  FLOWS,
  type FlowDef,
  type Item,
  type Option,
  type PageSlot,
} from "./flows";
import { FILE_COLORS, PageGrid, type GridFile } from "./pagegrid";
import { everyN, parseGroups, splitNames } from "../core/pages";
import { openViewer } from "./viewer";
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
  /** Search all of papgi's functions. */
  findFunction(): void;
}

export const SAMPLES = [
  { file: "paper.pdf", label: "Paper" },
  { file: "form.pdf", label: "Form" },
  { file: "report.pdf", label: "Word report" },
  { file: "scan.pdf", label: "Scan" },
  { file: "pages.pdf", label: "5 pages" },
];

const OPTS_KEY = "papgi.tools.v1";
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
  /** Page view (merge): the order of pages, their thumbnails, and each file's colour/letter. */
  private order: PageSlot[] = [];
  private thumbs = new Map<string, string>();
  private files = new Map<string, GridFile>();
  private grid: PageGrid | null = null;
  private fileCount = 0;
  /** Split: the files to make, each with its pages (edited in the preview). */
  private parts: PageSlot[][] = [];

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
      if (
        (e.key === "Enter" || e.key === " ") &&
        t.getAttribute("role") === "button"
      ) {
        e.preventDefault();
        t.click();
      }
    });
    this.el.addEventListener("change", (e) => this.onInput(e));
  }

  visible(): boolean {
    return !this.el.hidden;
  }

  /** Files picked or made in a tool, which reloading the page would lose. */
  hasWork(): boolean {
    return this.items.length > 0 || this.results.length > 0 || this.running;
  }

  /** Show the start screen or a tool page. */
  show(route: "home" | ToolId): void {
    const changed = route !== this.route || this.el.hidden;
    this.el.hidden = false;
    document.body.classList.add("hub-open");
    if (!changed) return;
    if (route !== this.route) this.reset();
    this.route = route;
    this.flow =
      route === "home" || route === "open" ? null : (FLOWS[route] ?? null);
    if (this.flow)
      this.opts = {
        ...Object.fromEntries(this.flow.options.map((o) => [o.key, o.value])),
        ...loadOpts(route),
      };
    this.render();
    this.el.scrollTop = 0;
    document.title = this.flow
      ? `${t(this.flow.title)} · papgi`
      : route === "open"
        ? `${t("Open PDF")} · papgi`
        : "papgi";
  }

  /** Switch now (the address changes too, for back/forward and bookmarks). */
  go(route: "home" | ToolId): void {
    const hash = route === "home" ? "" : `#${route}`;
    if (location.hash !== hash)
      history.pushState(null, "", hash || location.pathname + location.search);
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
      return toast(
        looksLikeImage(files[0].name, files[0].bytes)
          ? "That's a picture: use Images to PDF to make a PDF from it"
          : "That isn't a PDF",
        "error",
      );
    }
    // start screen: pick the tool that fits
    const pdfs = files.filter((f) => isPdf(f.bytes));
    const images = files.filter(
      (f) => !isPdf(f.bytes) && looksLikeImage(f.name, f.bytes),
    );
    if (pdfs.length === 1 && files.length === 1)
      return void this.host.openInEditor(pdfs[0]);
    if (pdfs.length > 1 && !images.length) {
      this.go("merge");
      return this.addFiles(pdfs);
    }
    if (images.length && !pdfs.length) {
      this.go("images-to-pdf");
      return this.addFiles(images);
    }
    if (files.length === 1)
      return toast(`${files[0].name} isn't a PDF, or it is too damaged to open.`, "error");
    toast("Drop PDFs (to edit or merge) or pictures (to make a PDF)", "error");
  }

  private reset(): void {
    for (const it of this.items) URL.revokeObjectURL(it.thumb);
    for (const u of this.thumbs.values()) URL.revokeObjectURL(u);
    this.items = [];
    this.order = [];
    this.thumbs.clear();
    this.files.clear();
    this.fileCount = 0;
    this.parts = [];
    this.grid = null;
    this.results = [];
    this.cancel = true;
  }

  // ---------- rendering ----------

  private header(): string {
    const doc = this.host.editorDoc();
    const t = this.flow
      ? tool(this.flow.id)
      : this.route === "open"
        ? tool("open")
        : undefined;
    const title = t
      ? `<div class="hub-title">${icon(t.icon)}<span>${t.name}</span></div>`
      : "";
    return `
      <header class="hub-top">
        <button class="hub-brand" data-go="home" title="All tools"><span class="logo">${icon("file")}</span><span>papgi</span></button>
        ${t ? `<button class="btn flat hub-back" data-go="home">${icon("back")}<span>All tools</span></button>` : ""}
        ${title}
        <div class="hub-actions">
          ${doc ? `<button class="btn flat to-editor" data-go="edit" title="Back to ${esc(doc)}">${icon("textEdit")}<span class="lbl">Editor: </span><span class="docn" translate="no">${esc(doc)}</span></button>` : ""}
          <button class="btn flat hub-find" data-act="find" title="Find a function (Ctrl+K)">${icon("findFn")}<span class="lbl">Find a function</span></button>
          <button class="icon-btn" data-act="theme" title="Theme">${icon(this.host.themeIcon())}</button>
        </div>
      </header>`;
  }

  private render(): void {
    this.el.innerHTML =
      this.header() +
      (this.flow
        ? this.flowHtml(this.flow)
        : this.route === "open"
          ? this.openHtml()
          : this.homeHtml());
    if (this.flow?.pageView) {
      this.grid = new PageGrid({
        order: () => this.order,
        setOrder: (o) => {
          this.order = o;
          this.results = [];
          this.renderResult();
          this.renderPagesHead();
          this.renderAction();
        },
        file: (id) => this.files.get(id),
        thumb: (s) => this.thumbs.get(`${s.item}:${s.page}`) ?? "",
        scroller: this.el,
        open: (i) => this.view(i),
      });
      this.el.querySelector(".grid-host")!.append(this.grid.el);
    }
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
          <p class="muted hero-tip">${icon("open")}<span><b>Tip:</b> drop files anywhere on this page. One PDF opens to edit, several get merged, pictures become a PDF.</span></p>
        </section>
        <section class="tool-grid" aria-label="Tools">${TOOL_LIST.map(card).join("")}</section>
        <section class="recent" hidden>
          <div class="sec-head"><h2>${icon("clock")}Recent files</h2><button class="btn flat small" data-act="clear-recent">Clear</button></div>
          <div class="recent-list"></div>
        </section>
        <p class="samples"><span class="muted small">Try a sample:</span>
          ${SAMPLES.map((s) => `<button class="chip" data-sample="${s.file}">${s.label}</button>`).join("")}
        </p>
        <p class="hub-foot muted small">Works offline · your files stay on this device, nothing is uploaded · <button class="link-btn" data-act="about">About &amp; feedback</button></p>
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
          <div class="recent-text"><b translate="no">${esc(r.name)}</b><span class="muted small">${ago(r.opened)} · ${r.pages} ${r.pages === 1 ? "page" : "pages"} · ${formatSize(r.size)}</span></div>
          <button class="icon-btn sm recent-x" data-forget="${r.id}" title="Remove from recent files">${icon("close")}</button>
        </div>`,
      )
      .join("");
  }

  private flowHtml(f: FlowDef): string {
    const what =
      f.takes === "pdf" ? (f.multiple ? "PDFs" : "a PDF") : "pictures";
    return `
      <main class="hub-main flow${f.pageView && f.takes === "image" ? " files-as-pages" : ""}" data-flow="${f.id}">
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
        ${
          f.pageView
            ? `<section class="flow-pages" hidden>
          <div class="sec-head"><h2>${f.takes === "image" ? "Pictures" : "Pages"} <span class="muted page-count"></span></h2>${this.sizeHtml()}<button class="btn flat small" data-act="view" title="See every page full size, in this order">${icon("eye")}View</button><button class="btn flat small" data-act="reset-order" title="Everything back, in the original order">Reset</button></div>
          <p class="muted small pages-hint">Preview: drag to reorder (on a phone: press and hold, then drag). Hover to turn or remove; double-click to see a page full size.</p>
          <div class="grid-host"></div>
        </section>`
            : ""
        }
        <section class="flow-options">${f.options.map((o) => this.optionHtml(o)).join("")}</section>
        ${
          f.splitView
            ? `<section class="split-view" hidden>
          <div class="sec-head"><h2>Preview <span class="muted split-count"></span></h2>${this.sizeHtml()}<button class="btn flat small" data-act="view" title="See every page full size, file by file">${icon("eye")}View</button><button class="btn flat small" data-act="reset-parts" title="Back to what the options above give">Reset</button></div>
          <p class="muted small pages-hint">Each row becomes one file. Click ✂ between two pages to cut there, “Join” to put a file together with the one before; hover a page to turn or remove it.</p>
          <div class="split-rows"></div>
        </section>`
            : ""
        }
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
    const show =
      !("showIf" in o) || !o.showIf || this.opts[o.showIf[0]] === o.showIf[1];
    const wrap = (inner: string, hint = "") =>
      `<div class="opt" data-opt="${o.key}" ${show ? "" : "hidden"}><span class="opt-label">${o.label}</span><div class="opt-body">${inner}${hint ? `<p class="muted small opt-hint">${hint}</p>` : ""}</div></div>`;
    if (o.kind === "choice") {
      const cur = o.choices.find((c) => c[0] === v) ?? o.choices[0];
      return wrap(
        `<div class="choice" role="radiogroup" aria-label="${o.label}">${o.choices.map(([val, label]) => `<button role="radio" aria-checked="${val === cur[0]}" class="${val === cur[0] ? "on" : ""}" data-choose="${o.key}" data-value="${val}">${label}${this.flow?.estimate?.key === o.key ? `<small class="est" data-est="${val}"></small>` : ""}</button>`).join("")}</div>`,
        cur[2] ?? "",
      );
    }
    if (o.kind === "range")
      return wrap(
        `<label class="range"><input type="range" data-input="${o.key}" min="${o.min}" max="${o.max}" step="${o.step}" value="${esc(v)}"><output>${esc(v)}${o.unit}</output></label>`,
      );
    return wrap(
      `<input class="field" type="text" data-input="${o.key}" placeholder="${esc(o.placeholder)}" value="${esc(v)}" autocomplete="off">`,
      o.hint ?? "",
    );
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
          ${f.pageView && this.files.get(it.id) ? `<span class="file-badge" style="--file:${this.files.get(it.id)!.color}">${this.files.get(it.id)!.letter}</span>` : ""}
          <span class="file-thumb">${it.thumb ? `<img src="${it.thumb}" alt="">` : icon(it.kind === "pdf" ? "file" : "image")}</span>
          <span class="file-text"><b translate="no">${esc(it.name)}</b><span class="muted small">${it.kind === "pdf" ? `${it.pages} ${it.pages === 1 ? "page" : "pages"} · ` : ""}${formatSize(it.bytes.length)}${it.password ? " · unlocked" : ""}</span></span>
          ${f.reorder ? `<button class="icon-btn sm" data-move="${i}" data-dir="-1" title="Move up" ${i === 0 ? "disabled" : ""}>${icon("up")}</button><button class="icon-btn sm" data-move="${i}" data-dir="1" title="Move down" ${i === this.items.length - 1 ? "disabled" : ""}>${icon("down")}</button>` : ""}
          <button class="icon-btn sm" data-remove="${i}" title="Remove">${icon("close")}</button>
        </li>`,
      )
      .join("");
    const drop = this.el.querySelector<HTMLElement>(".drop-area")!;
    drop.classList.toggle("compact", this.items.length > 0);
    drop.hidden = !f.multiple && this.items.length > 0;
    const add = drop.querySelector("b")!;
    add.textContent = this.items.length
      ? f.takes === "pdf"
        ? "Add more PDFs"
        : "Add more pictures"
      : `Choose ${f.takes === "pdf" ? (f.multiple ? "PDFs" : "a PDF") : "pictures"}`;
    if (f.pageView) {
      this.renderPagesHead();
      this.grid?.render();
    }
    if (f.splitView) this.renderSplit();
    this.renderAction();
    const estKey = `${f.id}|${this.items.map((it) => it.id).join()}`;
    if (estKey !== this.estKey) {
      this.estKey = estKey;
      void this.estimate();
    }
  }
  private estKey = "";

  private renderPagesHead(): void {
    const sec = this.el.querySelector<HTMLElement>(".flow-pages");
    if (!sec) return;
    sec.hidden = !this.items.length;
    const total = this.items.reduce((n, it) => n + it.pages, 0);
    const n = this.order.length;
    sec.querySelector(".page-count")!.textContent =
      n === total ? `(${n})` : `(${n} of ${total})`;
  }

  // ---------- split preview ----------

  /** The files the split options give (each part: its pages). Keeps the old preview if the ranges don't parse. */
  private buildParts(): void {
    const it = this.items[0];
    if (!it) return void (this.parts = []);
    const o = this.opts;
    const groups =
      o.mode === "every"
        ? everyN(it.pages, Number(o.n) || 1)
        : o.mode === "ranges"
          ? parseGroups(o.ranges ?? "", it.pages)
          : everyN(it.pages, 1);
    if (!groups) return;
    this.parts = groups.map((g) =>
      g.map((page) => ({ item: it.id, page, rotate: 0 })),
    );
  }

  private renderSplit(): void {
    const sec = this.el.querySelector<HTMLElement>(".split-view");
    if (!sec) return;
    sec.hidden = !this.items.length;
    if (!this.items.length) return;
    const files = this.parts.filter((p) => p.length).length;
    sec.querySelector(".split-count")!.textContent =
      `(${files} ${files === 1 ? "file" : "files"})`;
    const color = this.files.get(this.items[0].id)?.color ?? "var(--accent)";
    const stemName = this.items[0].name.replace(/\.[^.]+$/, "");
    const kept = this.parts.filter((p) => p.length);
    const names = splitNames(
      stemName,
      kept.map((p) => p.map((s) => s.page)),
      this.items[0].pages,
    );
    sec.querySelector(".split-rows")!.innerHTML = this.parts
      .map((part, r) => {
        if (!part.length) return "";
        const pages = part.map((s) => s.page + 1);
        const run = pages.every((v, i) => i === 0 || v === pages[i - 1] + 1);
        const label =
          pages.length === 1
            ? `page ${pages[0]}`
            : run
              ? `pages ${pages[0]}–${pages[pages.length - 1]}`
              : `${pages.length} pages`;
        const tiles = part
          .map((s, c) => {
            const src = this.thumbs.get(`${s.item}:${s.page}`) ?? "";
            const turned = s.rotate % 180 !== 0;
            const cut =
              c < part.length - 1
                ? `<button class="scut" data-scut="${r},${c}" title="Cut here: pages after this become a new file">✂</button>`
                : "";
            return `<div class="ptile stile" style="--file:${color}">
                <div class="pthumb${turned ? " turned" : ""}">${src ? `<img src="${src}" alt="" draggable="false" style="transform: rotate(${s.rotate}deg)">` : `<span class="pload"></span>`}</div>
                <div class="pmeta"><span class="pnum">${s.page + 1}</span></div>
                <div class="ptools"><button class="icon-btn sm" data-sturn="${r},${c}" title="Turn right">${icon("rotR")}</button><button class="icon-btn sm" data-sdel="${r},${c}" title="Leave this page out">${icon("close")}</button></div>
              </div>${cut}`;
          })
          .join("");
        return `<div class="split-row">
            <div class="split-head"><span class="file-badge" style="--file:${color}">${r + 1}</span><b>${esc(names[kept.indexOf(part)])}</b><span class="muted small">${label}</span>
              ${r > 0 ? `<button class="btn flat small" data-sjoin="${r}" title="Put these pages at the end of the file before">Join with file ${r}</button>` : ""}</div>
            <div class="split-pages">${tiles}</div>
          </div>`;
      })
      .join("");
  }

  /** Tile size of the page views (a slider; remembered). */
  private sizeHtml(): string {
    return `<label class="tile-size" title="Size of the pages">${icon("zoomOut")}<input type="range" min="90" max="300" step="10" value="${tileSize()}" data-size aria-label="Size of the pages">${icon("zoomIn")}</label>`;
  }

  /** Full-size look at the pages in their current order (split: file by file). */
  private bigPics = new Map<string, Promise<string>>();
  private view(at: number): void {
    const split = !!this.flow?.splitView;
    const slots = split ? this.parts.flat() : this.order;
    if (!slots.length) return;
    let fileNo = 0;
    const fileOf = split
      ? this.parts.flatMap((p) =>
          p.length ? (fileNo++, p.map(() => fileNo)) : [],
        )
      : [];
    const big = (s: PageSlot): Promise<string> => {
      const key = `${s.item}:${s.page}`;
      let p = this.bigPics.get(key);
      if (!p) {
        const it = this.items.find((x) => x.id === s.item);
        if (!it) return Promise.reject(new Error("gone"));
        if (it.kind === "image")
          p = Promise.resolve(
            URL.createObjectURL(
              new Blob([it.bytes as Uint8Array<ArrayBuffer>]),
            ),
          );
        else {
          // sharp at the column's width (pages assumed about Letter/A4 wide)
          const px =
            Math.min(880, innerWidth - 32) * Math.min(2, devicePixelRatio || 1);
          const dpi = Math.round(Math.max(72, Math.min(200, (px * 72) / 600)));
          p = this.host.engine
            .toolPagesToImages(
              { name: it.name, bytes: it.bytes, password: it.password },
              [s.page],
              { format: "jpeg", dpi, quality: 85 },
            )
            .then(([b]) =>
              URL.createObjectURL(
                new Blob([b as Uint8Array<ArrayBuffer>], {
                  type: "image/jpeg",
                }),
              ),
            );
        }
        this.bigPics.set(key, p);
        p.catch(() => this.bigPics.delete(key));
      }
      return p;
    };
    const many = this.items.length > 1;
    const pages = slots.map((s, i) => {
      const it = this.items.find((x) => x.id === s.item);
      const gf = this.files.get(s.item);
      const label = split
        ? `file ${fileOf[i]}, page ${s.page + 1}`
        : it?.kind === "image"
          ? (it?.name ?? "")
          : `${many && gf?.letter ? `${gf.letter} · ` : ""}page ${s.page + 1}${many && it ? ` of ${it.name}` : ""}`;
      return {
        rotate: s.rotate,
        label,
        color: gf?.color,
        thumb:
          it?.kind === "image"
            ? it.thumb
            : this.thumbs.get(`${s.item}:${s.page}`),
        load: () => big(s),
      };
    });
    openViewer(
      pages,
      Math.max(0, Math.min(at, pages.length - 1)),
      split ? "Split preview" : (this.flow?.title ?? "Pages"),
      () => {
        // the big pictures take memory: let them go
        for (const p of this.bigPics.values())
          void p.then(
            (u) => URL.revokeObjectURL(u),
            () => {},
          );
        this.bigPics.clear();
      },
    );
  }

  private editParts(d: DOMStringMap): void {
    const [r, c] = (d.scut ?? d.sturn ?? d.sdel ?? `${d.sjoin},0`)
      .split(",")
      .map(Number);
    const parts = this.parts.filter((p) => p.length).map((p) => p.slice());
    if (d.scut !== undefined) parts.splice(r + 1, 0, parts[r].splice(c + 1));
    if (d.sjoin !== undefined && r > 0)
      parts.splice(r - 1, 2, [...parts[r - 1], ...parts[r]]);
    if (d.sturn !== undefined)
      parts[r][c] = { ...parts[r][c], rotate: (parts[r][c].rotate + 90) % 360 };
    if (d.sdel !== undefined) parts[r].splice(c, 1);
    this.parts = parts.filter((p) => p.length);
    this.results = [];
    this.renderResult();
    this.renderSplit();
    this.renderAction();
  }

  /** Page thumbnails for the page view, a few at a time. */
  private async loadThumbs(it: Item): Promise<void> {
    for (let k = 0; k < it.pages; k += 6) {
      if (!this.files.has(it.id)) return;
      const batch = [...Array(Math.min(6, it.pages - k)).keys()].map(
        (j) => k + j,
      );
      let imgs: Uint8Array[];
      try {
        imgs = await this.host.engine.toolPagesToImages(
          { name: it.name, bytes: it.bytes, password: it.password },
          batch,
          { format: "jpeg", dpi: 48, quality: 70 },
        );
      } catch {
        return;
      }
      if (!this.files.has(it.id)) return;
      imgs.forEach((b, j) => {
        const key = `${it.id}:${batch[j]}`;
        const url = URL.createObjectURL(
          new Blob([b as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
        );
        this.thumbs.set(key, url);
        this.grid?.setThumb(key, url);
        const box = this.el.querySelectorAll(".split-view .stile .pthumb");
        if (box.length && this.flow?.splitView) this.renderSplit();
      });
    }
  }

  private renderAction(): void {
    const f = this.flow;
    if (!f) return;
    const run = this.el.querySelector<HTMLButtonElement>("[data-act=run]")!;
    const err = this.el.querySelector<HTMLElement>(".flow-error")!;
    const problem =
      this.items.length >= f.min
        ? (f.check?.(
            this.items,
            this.opts,
            f.pageView ? this.order : undefined,
          ) ?? null)
        : null;
    run.innerHTML = `${icon(tool(f.id)!.icon)}${f.action(this.items, this.order)}`;
    run.disabled = this.running || this.items.length < f.min || !!problem;
    err.textContent = problem ?? "";
    run.hidden = this.running;
  }

  /** Result size of each choice (Compress), worked out in the background. */
  private estSeq = 0;
  private estimates = new Map<
    string,
    { before: number; after: number } | null
  >();
  private async estimate(): Promise<void> {
    const f = this.flow;
    const seq = ++this.estSeq;
    this.estimates.clear();
    this.showEstimates();
    if (!f?.estimate || !this.items.length) return;
    const o = f.options.find((x) => x.key === f.estimate!.key);
    if (o?.kind !== "choice") return;
    const items = this.items.slice();
    // the chosen level first, then the others
    const values = o.choices
      .map((c) => c[0])
      .sort(
        (a, b) =>
          Number(b === this.opts[o.key]) - Number(a === this.opts[o.key]),
      );
    for (const v of values) {
      let r: { before: number; after: number } | null = null;
      try {
        r = await f.estimate.size(this.host.engine, items, v);
      } catch {
        /* (a password or a broken file: the run explains it) */
      }
      if (seq !== this.estSeq) return;
      this.estimates.set(v, r);
      this.showEstimates();
    }
  }

  private showEstimates(): void {
    const f = this.flow;
    if (!f?.estimate) return;
    const row = this.el.querySelector<HTMLElement>(
      `[data-opt="${f.estimate.key}"]`,
    );
    if (!row) return;
    const pending = this.items.length > 0;
    row.querySelectorAll<HTMLElement>("[data-est]").forEach((el) => {
      const r = this.estimates.get(el.dataset.est!);
      el.textContent = r
        ? formatSize(r.after)
        : pending && !this.estimates.has(el.dataset.est!)
          ? "…"
          : "";
    });
    let line = row.querySelector<HTMLElement>(".est-line");
    if (!line) {
      line = document.createElement("div");
      line.className = "est-line";
      row.querySelector(".opt-hint")?.after(line);
    }
    const r = this.estimates.get(this.opts[f.estimate.key]);
    line.hidden = !pending;
    line.innerHTML = !pending
      ? ""
      : r === undefined
        ? `<span class="spin"></span> Working out the new size…`
        : r === null
          ? ""
          : r.after < r.before * 0.98
            ? `<b>${formatSize(r.before)} → ${formatSize(r.after)}</b> <span class="est-save">${Math.round((1 - r.after / r.before) * 100)}% smaller</span>`
            : `<b>${formatSize(r.before)}</b>: already about as small as it gets at this level`;
  }

  private syncOptions(): void {
    const f = this.flow;
    if (!f) return;
    for (const o of f.options) {
      const row = this.el.querySelector<HTMLElement>(`[data-opt="${o.key}"]`);
      if (!row) continue;
      if ("showIf" in o && o.showIf)
        row.hidden = this.opts[o.showIf[0]] !== o.showIf[1];
      if (o.kind === "choice") {
        const cur =
          o.choices.find((c) => c[0] === this.opts[o.key]) ?? o.choices[0];
        row
          .querySelectorAll<HTMLButtonElement>("[data-choose]")
          .forEach((b) => {
            const on = b.dataset.value === cur[0];
            b.classList.toggle("on", on);
            b.setAttribute("aria-checked", String(on));
          });
        const hint = row.querySelector(".opt-hint");
        if (hint) hint.textContent = cur[2] ?? "";
        if (f.estimate?.key === o.key) this.showEstimates();
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
    if (d.act === "find") return this.host.findFunction();
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
      if (
        await confirmDialog(
          "Clear recent files?",
          "papgi forgets the list (and any copies it kept). Your files themselves aren't touched.",
          "Clear",
          true,
        )
      ) {
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
      this.order = this.order.filter((o) => o.item !== it.id);
      this.files.delete(it.id);
      for (const [k, u] of this.thumbs)
        if (k.startsWith(`${it.id}:`))
          (URL.revokeObjectURL(u), this.thumbs.delete(k));
      this.results = [];
      this.renderResult();
      return this.renderFiles();
    }
    if (d.move !== undefined)
      return this.moveItem(Number(d.move), Number(d.move) + Number(d.dir));
    if (d.choose) {
      this.opts[d.choose] = d.value!;
      saveOpts(this.flow!.id, this.opts);
      if (this.flow?.splitView) {
        this.buildParts();
        this.renderSplit();
      }
      return this.syncOptions();
    }
    if (d.act === "run") return this.run();
    if (d.act === "view") return this.view(0);
    if (d.act === "about") return void window.dispatchEvent(new CustomEvent("papgi-about"));
    if (d.scut || d.sjoin || d.sturn || d.sdel) return this.editParts(d);
    if (d.act === "reset-order") {
      this.order = this.items.flatMap((it) =>
        [...Array(it.pages).keys()].map((page) => ({
          item: it.id,
          page,
          rotate: 0,
        })),
      );
      this.results = [];
      this.renderResult();
      return this.renderFiles();
    }
    if (d.act === "reset-parts") {
      this.buildParts();
      this.results = [];
      this.renderResult();
      return this.renderFiles();
    }
    if (d.act === "stop") {
      this.cancel = true;
      return;
    }
    if (d.out !== undefined) return this.saveOne(Number(d.out));
    if (d.act === "save-all") return this.saveAll();
    if (d.act === "share") return this.share();
    // (a copy: the engine takes over the bytes it is given, and the result stays downloadable)
    if (d.act === "open-result")
      return void this.host.openInEditor({
        name: this.results[0].name,
        bytes: this.results[0].bytes.slice(),
        handle: null,
      });
    if (d.act === "again") {
      this.reset();
      this.cancel = false;
      return this.render();
    }
  }

  private onInput(e: Event): void {
    const t = e.target as HTMLInputElement;
    if (t.dataset.size !== undefined) {
      setTileSize(Number(t.value));
      this.el
        .querySelectorAll<HTMLInputElement>("[data-size]")
        .forEach((x) => x !== t && (x.value = t.value));
      return;
    }
    const key = t.dataset.input;
    if (!key || !this.flow) return;
    // ("change" after "input" carries the same value: don't throw away edits made in the preview)
    if (e.type === "change" && this.opts[key] === t.value) return;
    this.opts[key] = t.value;
    const out = t.parentElement?.querySelector("output");
    const o = this.flow.options.find((x) => x.key === key);
    if (out && o?.kind === "range") out.textContent = `${t.value}${o.unit}`;
    saveOpts(this.flow.id, this.opts);
    if (this.flow.splitView) {
      this.buildParts();
      this.renderSplit();
    }
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
    input.accept =
      f.takes === "pdf" ? "application/pdf,.pdf" : "image/*,.heic,.heif";
    input.onchange = async () => {
      const files = await Promise.all(
        [...(input.files ?? [])].map(async (file) => ({
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
          handle: null,
        })),
      );
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
      for (const u of this.thumbs.values()) URL.revokeObjectURL(u);
      this.items = [];
      this.order = [];
      this.thumbs.clear();
      this.files.clear();
      this.parts = [];
    }
    this.results = [];
    this.renderResult();
    const skipped: string[] = [];
    for (const file of files) {
      try {
        const item =
          f.takes === "pdf"
            ? await this.pdfItem(file)
            : await this.imageItem(file);
        if (item) {
          this.items.push(item);
          if (f.pageView || f.splitView) {
            const k = this.fileCount++;
            // (pictures and single-file tools need no letters to tell files apart)
            const letter =
              f.takes === "pdf" && f.multiple
                ? String.fromCharCode(65 + (k % 26))
                : "";
            this.files.set(item.id, {
              id: item.id,
              name: f.takes === "image" ? item.name : "",
              color: FILE_COLORS[k % FILE_COLORS.length],
              letter,
            });
            for (let page = 0; page < item.pages; page++)
              this.order.push({ item: item.id, page, rotate: 0 });
            if (item.kind === "image")
              this.thumbs.set(`${item.id}:0`, item.thumb);
            else void this.loadThumbs(item);
          }
          if (f.splitView) this.buildParts();
        }
      } catch (err) {
        skipped.push(`${file.name}: ${friendlyError((err as Error).message)}`);
      }
      this.renderFiles();
    }
    if (skipped.length)
      toast(
        skipped.length === 1
          ? skipped[0]
          : `${skipped.length} files couldn't be added. ${skipped[0]}`,
        "error",
      );
  }

  private async pdfItem(file: OpenedFile): Promise<Item | null> {
    if (!isPdf(file.bytes)) {
      throw new Error(
        looksLikeImage(file.name, file.bytes)
          ? "that's a picture; use Images to PDF"
          : "not a PDF",
      );
    }
    let password: string | undefined;
    let pages = 0;
    for (let wrong = false; ; wrong = true) {
      try {
        pages = await this.host.engine.toolPageCount({
          name: file.name,
          bytes: file.bytes,
          password,
        });
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
      const [jpg] = await this.host.engine.toolPagesToImages(
        { name: file.name, bytes: file.bytes, password },
        [0],
        { format: "jpeg", dpi: 24, quality: 70 },
      );
      thumb = URL.createObjectURL(
        new Blob([jpg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
      );
    } catch {
      /* no thumbnail */
    }
    return {
      id: `i${++seq}`,
      name: file.name,
      bytes: file.bytes,
      kind: "pdf",
      pages,
      password,
      thumb,
    };
  }

  private async imageItem(file: OpenedFile): Promise<Item> {
    if (isPdf(file.bytes))
      throw new Error("that's a PDF; use Merge PDFs to combine PDFs");
    const img = await normalizeImage(file.name, file.bytes);
    const thumb = URL.createObjectURL(
      new Blob([img.bytes as Uint8Array<ArrayBuffer>], { type: img.type }),
    );
    return {
      id: `i${++seq}`,
      name: img.name,
      bytes: img.bytes,
      kind: "image",
      pages: 1,
      thumb,
    };
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
      this.el
        .querySelectorAll(".drop-before, .drop-after")
        .forEach((x) => x.classList.remove("drop-before", "drop-after"));
      const r = row.getBoundingClientRect();
      row.classList.add(
        e.clientY < r.top + r.height / 2 ? "drop-before" : "drop-after",
      );
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
      this.el
        .querySelectorAll(".dragging, .drop-before, .drop-after")
        .forEach((x) =>
          x.classList.remove("dragging", "drop-before", "drop-after"),
        );
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
        order: this.order,
        parts: this.parts,
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
      toast(`${f.title} didn't work: ${friendlyError((err as Error).message)}`, "error");
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
      ${many ? `<ul class="out-list">${this.results.map((r, i) => `<li><span class="file-text"><b translate="no">${esc(r.name)}</b><span class="muted small">${formatSize(r.bytes.length)}</span></span><button class="icon-btn sm" data-out="${i}" title="Download ${esc(r.name)}">${icon("download")}</button></li>`).join("")}</ul>` : ""}`;
    sec.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private canShare(): boolean {
    const nav = navigator as Navigator & { canShare?: (d: unknown) => boolean };
    if (!nav.canShare || !navigator.share || !this.results.length) return false;
    try {
      return nav.canShare({
        files: [new File([], "x.pdf", { type: "application/pdf" })],
      });
    } catch {
      return false;
    }
  }

  private async saveOne(i: number): Promise<void> {
    const r = this.results[i];
    if (r)
      await saveFile(r.bytes, r.name, r.type).catch((e) =>
        toast(`Couldn't save: ${(e as Error).message}`, "error"),
      );
  }

  private async saveAll(): Promise<void> {
    if (this.results.length === 1) return this.saveOne(0);
    const name = `${this.items[0]?.name.replace(/\.[^.]+$/, "") ?? "papgi"} (${this.flow?.id === "split" ? "split" : "pages"}).zip`;
    await saveFile(zip(this.results), name, "application/zip").catch((e) =>
      toast(`Couldn't save: ${(e as Error).message}`, "error"),
    );
  }

  private async share(): Promise<void> {
    const files = this.results.map(
      (r) =>
        new File([r.bytes as Uint8Array<ArrayBuffer>], r.name, {
          type: r.type,
        }),
    );
    try {
      await navigator.share({ files });
    } catch (e) {
      if ((e as Error).name !== "AbortError")
        toast(`Couldn't share: ${(e as Error).message}`, "error");
    }
  }
}

// ---------- tile size ----------

const SIZE_KEY = "papgi.tileSize";
function tileSize(): number {
  try {
    const v = Number(localStorage.getItem(SIZE_KEY));
    if (v >= 90 && v <= 300) return v;
  } catch {
    /* (private mode) */
  }
  return 124;
}
function setTileSize(px: number, save = true): void {
  document.documentElement.style.setProperty("--tile", `${px}px`);
  if (save)
    try {
      localStorage.setItem(SIZE_KEY, String(px));
    } catch {
      /* (private mode) */
    }
}
setTileSize(tileSize(), false);
