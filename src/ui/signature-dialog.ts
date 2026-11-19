// Signature dialog: draw a signature, or turn a photo/scan of one into clean, transparent ink.
import type { Point } from "../core/geometry";
import { simplifyStroke } from "../core/geometry";
import { extractInk, rotate90, fitScale, type RGBAImage, type CropBox } from "../core/signature";
import type { SignatureImage } from "../storage";
import { modal, toast } from "./dialogs";
import { icon } from "./icons";

export type SignatureResult =
  | { kind: "drawn"; strokes: Point[][] }
  | { kind: "image"; image: SignatureImage }
  | { kind: "clear" };

interface Opts {
  color: string; // pen colour for drawing
  strokes: Point[][] | null;
  image: SignatureImage | null;
  start: "drawn" | "image";
}

const INK_COLORS: Record<string, [number, number, number] | null> = {
  original: null,
  black: [24, 24, 28],
  blue: [26, 58, 143],
};
const MAX_SOURCE = 1600; // px, longer side of the photo we work on
const MAX_RESULT = 1000; // px, longer side of the stored signature

export async function signatureDialog(o: Opts): Promise<SignatureResult | null> {
  const wrap = document.createElement("div");
  wrap.className = "sigdlg";
  wrap.innerHTML = `
    <div class="seg sig-tabs" role="tablist">
      <button data-tab="drawn" role="tab">${icon("pen")}<span>Draw</span></button>
      <button data-tab="image" role="tab">${icon("image")}<span>Picture</span></button>
    </div>
    <section data-panel="drawn">
      <p class="muted small">Sign inside the box with your mouse, pen or finger.</p>
      <div class="sigpad"><canvas width="600" height="220" aria-label="Signature pad"></canvas><div class="sig-line"></div></div>
      <button class="btn small" data-act="clear">Clear</button>
    </section>
    <section data-panel="image" hidden>
      <div class="pic-empty">
        <p class="muted small">Sign on white paper with a dark pen and take a photo in good light, or use a scan. The paper is removed automatically.</p>
        <button class="btn primary" data-act="pick">${icon("image")}Choose picture…</button>
      </div>
      <div class="pic-work" hidden>
        <div class="pic-label muted small">Drag over the photo to select just the signature</div>
        <div class="pic-src"><canvas class="src-canvas" aria-label="Photo"></canvas></div>
        <div class="pic-label muted small">Result</div>
        <div class="pic-out checker"><canvas class="out-canvas" aria-label="Extracted signature"></canvas><span class="pic-none muted small" hidden>No ink found — try more sensitivity or a different crop</span></div>
        <div class="pic-controls">
          <label class="range"><span class="muted">Sensitivity</span><input type="range" data-ctl="sens" min="0" max="1" step="0.05" value="0.5"></label>
          <div class="seg" data-ctl="ink">
            <button data-ink="original" class="on">Original</button>
            <button data-ink="black">Black</button>
            <button data-ink="blue">Blue</button>
          </div>
          <button class="btn small" data-act="rotate" title="Rotate 90°">${icon("rotR")}</button>
          <button class="btn small" data-act="pick">Other picture…</button>
        </div>
      </div>
    </section>
    ${o.strokes || o.image ? `<button class="linkish" data-act="forget">Delete my saved signatures</button>` : ""}`;

  let tab: "drawn" | "image" = o.start;
  const setTab = (t: "drawn" | "image") => {
    tab = t;
    wrap.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    wrap.querySelectorAll<HTMLElement>("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t));
  };
  setTab(tab);

  // ---------- draw ----------
  const pad = wrap.querySelector<HTMLCanvasElement>(".sigpad canvas")!;
  const pctx = pad.getContext("2d")!;
  let strokes: Point[][] = o.strokes ? o.strokes.map((s) => s.slice()) : [];
  let current: Point[] | null = null;
  const redraw = () => {
    pctx.clearRect(0, 0, pad.width, pad.height);
    pctx.strokeStyle = o.color;
    pctx.lineWidth = 3;
    pctx.lineCap = pctx.lineJoin = "round";
    for (const s of [...strokes, ...(current ? [current] : [])]) {
      pctx.beginPath();
      s.forEach(([x, y], i) => (i ? pctx.lineTo(x, y) : pctx.moveTo(x, y)));
      if (s.length === 1) pctx.lineTo(s[0][0] + 0.1, s[0][1] + 0.1);
      pctx.stroke();
    }
  };
  const padPos = (e: PointerEvent): Point => {
    const r = pad.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * pad.width, ((e.clientY - r.top) / r.height) * pad.height];
  };
  pad.addEventListener("pointerdown", (e) => {
    pad.setPointerCapture(e.pointerId);
    current = [padPos(e)];
    redraw();
  });
  pad.addEventListener("pointermove", (e) => {
    if (!current) return;
    for (const ce of e.getCoalescedEvents?.() ?? [e]) current.push(padPos(ce));
    redraw();
  });
  const endStroke = () => {
    if (current) strokes.push(simplifyStroke(current, 0.6));
    current = null;
    redraw();
  };
  pad.addEventListener("pointerup", endStroke);
  pad.addEventListener("pointercancel", endStroke);
  redraw();

  // ---------- picture ----------
  const srcCanvas = wrap.querySelector<HTMLCanvasElement>(".src-canvas")!;
  const outCanvas = wrap.querySelector<HTMLCanvasElement>(".out-canvas")!;
  const noneMsg = wrap.querySelector<HTMLElement>(".pic-none")!;
  const sens = wrap.querySelector<HTMLInputElement>('[data-ctl="sens"]')!;
  let photo: RGBAImage | null = null;
  let photoBitmap: HTMLCanvasElement | null = null;
  let crop: CropBox | null = null;
  let ink: keyof typeof INK_COLORS = "original";
  let result: RGBAImage | null = null;
  let timer = 0;

  const showPhoto = () => {
    if (!photo) return;
    const work = wrap.querySelector<HTMLElement>(".pic-work")!;
    const empty = wrap.querySelector<HTMLElement>(".pic-empty")!;
    work.hidden = false;
    empty.hidden = true;
    photoBitmap = document.createElement("canvas");
    photoBitmap.width = photo.width;
    photoBitmap.height = photo.height;
    photoBitmap.getContext("2d")!.putImageData(new ImageData(photo.data as Uint8ClampedArray<ArrayBuffer>, photo.width, photo.height), 0, 0);
    const s = fitScale(photo.width, photo.height, 900);
    srcCanvas.width = Math.round(photo.width * s);
    srcCanvas.height = Math.round(photo.height * s);
    drawSource();
    schedule();
  };

  const drawSource = () => {
    if (!photo || !photoBitmap) return;
    const ctx = srcCanvas.getContext("2d")!;
    const k = srcCanvas.width / photo.width;
    ctx.drawImage(photoBitmap, 0, 0, srcCanvas.width, srcCanvas.height);
    if (crop) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      const [x, y, w, h] = [crop.x * k, crop.y * k, crop.w * k, crop.h * k];
      ctx.fillRect(0, 0, srcCanvas.width, y);
      ctx.fillRect(0, y + h, srcCanvas.width, srcCanvas.height - y - h);
      ctx.fillRect(0, y, x, h);
      ctx.fillRect(x + w, y, srcCanvas.width - x - w, h);
      ctx.strokeStyle = "#2f6fed";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  };

  const process = () => {
    if (!photo) return;
    result = extractInk(photo, { sensitivity: Number(sens.value), color: INK_COLORS[ink], crop });
    noneMsg.hidden = !!result;
    outCanvas.hidden = !result;
    if (!result) return;
    outCanvas.width = result.width;
    outCanvas.height = result.height;
    outCanvas.getContext("2d")!.putImageData(new ImageData(result.data as Uint8ClampedArray<ArrayBuffer>, result.width, result.height), 0, 0);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = window.setTimeout(process, 60);
  };

  // drag a crop box on the photo
  let dragStart: [number, number] | null = null;
  const srcPos = (e: PointerEvent): [number, number] => {
    const r = srcCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(0, (e.clientX - r.left) / r.width), 1) * photo!.width;
    const y = Math.min(Math.max(0, (e.clientY - r.top) / r.height), 1) * photo!.height;
    return [x, y];
  };
  srcCanvas.addEventListener("pointerdown", (e) => {
    if (!photo) return;
    srcCanvas.setPointerCapture(e.pointerId);
    dragStart = srcPos(e);
  });
  srcCanvas.addEventListener("pointermove", (e) => {
    if (!dragStart || !photo) return;
    const [x, y] = srcPos(e);
    crop = { x: Math.min(x, dragStart[0]), y: Math.min(y, dragStart[1]), w: Math.abs(x - dragStart[0]), h: Math.abs(y - dragStart[1]) };
    drawSource();
  });
  srcCanvas.addEventListener("pointerup", () => {
    if (!dragStart || !photo) return;
    dragStart = null;
    // a click (tiny box) resets to the whole photo
    if (!crop || crop.w < photo.width * 0.02 || crop.h < photo.height * 0.02) crop = null;
    drawSource();
    schedule();
  });

  const pick = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        photo = await loadPhoto(file);
        crop = null;
        showPhoto();
      } catch {
        toast("Couldn't read that picture", "error");
      }
    };
    input.click();
  };

  sens.addEventListener("input", schedule);

  wrap.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!b) return;
    if (b.dataset.tab) setTab(b.dataset.tab as "drawn" | "image");
    else if (b.dataset.ink) {
      ink = b.dataset.ink as keyof typeof INK_COLORS;
      wrap.querySelectorAll<HTMLButtonElement>("[data-ink]").forEach((x) => x.classList.toggle("on", x === b));
      schedule();
    } else if (b.dataset.act === "clear") {
      strokes = [];
      redraw();
    } else if (b.dataset.act === "pick") pick();
    else if (b.dataset.act === "rotate" && photo) {
      photo = rotate90(photo);
      crop = null;
      showPhoto();
    }
  });

  let forget = false;
  const v = await modal(
    {
      title: "Your signature",
      body: wrap,
      wide: true,
      actions: [
        { label: "Cancel", value: "" },
        { label: "Save signature", value: "ok", primary: true },
      ],
    },
    (root) => {
      root.querySelector('[data-act="forget"]')?.addEventListener("click", () => {
        forget = true;
        root.querySelector<HTMLButtonElement>('.modal-actions [data-v=""]')!.click();
      });
      // show the picture saved earlier as a starting point
      if (o.image && o.start === "image") {
        loadPhotoUrl(o.image.src)
          .then((img) => {
            if (photo) return;
            photo = img;
            showPhoto();
          })
          .catch(() => {});
      }
    },
  );
  clearTimeout(timer);
  if (forget) return { kind: "clear" };
  if (v !== "ok") return null;
  if (tab === "drawn") {
    const s = strokes.filter((x) => x.length > 0);
    if (!s.length) {
      toast("Draw your signature first", "error");
      return null;
    }
    return { kind: "drawn", strokes: s };
  }
  process();
  if (!result) {
    toast(photo ? "No signature found in the picture" : "Choose a picture first", "error");
    return null;
  }
  return { kind: "image", image: encodeResult(result) };
}

/** Load an image file into RGBA pixels, scaled down to a workable size. */
async function loadPhoto(file: Blob): Promise<RGBAImage> {
  const bmp = await createImageBitmap(file);
  try {
    return bitmapToRGBA(bmp, bmp.width, bmp.height);
  } finally {
    bmp.close();
  }
}

async function loadPhotoUrl(url: string): Promise<RGBAImage> {
  const blob = await (await fetch(url)).blob();
  // saved signatures are transparent: put them on white so they look like paper again
  const bmp = await createImageBitmap(blob);
  try {
    return bitmapToRGBA(bmp, bmp.width, bmp.height, "#ffffff");
  } finally {
    bmp.close();
  }
}

function bitmapToRGBA(src: CanvasImageSource, w: number, h: number, background?: string): RGBAImage {
  const s = fitScale(w, h, MAX_SOURCE);
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  return { width: c.width, height: c.height, data: d.data };
}

/** Scale down and encode the extracted ink as a PNG data URL. */
function encodeResult(img: RGBAImage): SignatureImage {
  const full = document.createElement("canvas");
  full.width = img.width;
  full.height = img.height;
  full.getContext("2d")!.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  const s = fitScale(img.width, img.height, MAX_RESULT);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(img.width * s));
  out.height = Math.max(1, Math.round(img.height * s));
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, out.width, out.height);
  return { src: out.toDataURL("image/png"), w: out.width, h: out.height };
}

/** Bytes of a data: URL (for handing the PNG to the PDF engine). */
export function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
