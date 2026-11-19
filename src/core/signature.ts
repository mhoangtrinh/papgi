// Turn a photo or scan of a signature into a transparent, cropped ink image.
// Pure functions on RGBA pixel buffers (no DOM), so they are unit-tested.

export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InkOptions {
  /** 0 = only the darkest ink, 1 = also faint strokes. Default 0.5. */
  sensitivity?: number;
  /** Recolour the ink (0..255 RGB); null keeps the original ink colour. */
  color?: [number, number, number] | null;
  /** Only look inside this part of the picture. */
  crop?: CropBox | null;
  /** Blobs smaller than this fraction of the area are treated as dust. */
  minSpeck?: number;
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

/** Copy a rectangle out of an image (clamped to its bounds). */
export function cropImage(img: RGBAImage, c: CropBox): RGBAImage {
  const x0 = Math.max(0, Math.floor(c.x));
  const y0 = Math.max(0, Math.floor(c.y));
  const x1 = Math.min(img.width, Math.ceil(c.x + c.w));
  const y1 = Math.min(img.height, Math.ceil(c.y + c.h));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const s = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(s, s + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/** Rotate by 90° clockwise. */
export function rotate90(img: RGBAImage): RGBAImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (x * h + (h - 1 - y)) * 4;
      out[d] = data[s];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s + 2];
      out[d + 3] = data[s + 3];
    }
  return { width: h, height: w, data: out };
}

/**
 * Paper brightness at every pixel. Phone photos are lit unevenly, so we take a bright
 * percentile per block (the paper, not the ink) and interpolate between blocks.
 */
export function estimatePaper(lumas: Float32Array, w: number, h: number): Float32Array {
  const block = Math.max(12, Math.round(Math.min(w, h) / 10));
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const grid = new Float32Array(bw * bh);
  const hist = new Uint32Array(256);
  for (let by = 0; by < bh; by++)
    for (let bx = 0; bx < bw; bx++) {
      hist.fill(0);
      let n = 0;
      for (let y = by * block; y < Math.min(h, (by + 1) * block); y++)
        for (let x = bx * block; x < Math.min(w, (bx + 1) * block); x++) {
          hist[Math.min(255, Math.round(lumas[y * w + x]))]++;
          n++;
        }
      // 90th percentile: robust to ink covering a good part of the block
      let acc = 0;
      let v = 255;
      for (let i = 0; i < 256; i++) {
        acc += hist[i];
        if (acc >= n * 0.9) {
          v = i;
          break;
        }
      }
      grid[by * bw + bx] = v;
    }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(Math.max((y + 0.5) / block - 0.5, 0), bh - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(bh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(Math.max((x + 0.5) / block - 0.5, 0), bw - 1);
      const x0 = Math.floor(gx);
      const x1 = Math.min(bw - 1, x0 + 1);
      const fx = gx - x0;
      const top = grid[y0 * bw + x0] * (1 - fx) + grid[y0 * bw + x1] * fx;
      const bot = grid[y1 * bw + x0] * (1 - fx) + grid[y1 * bw + x1] * fx;
      out[y * w + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

/** Remove connected blobs smaller than minArea pixels from an alpha mask (in place). */
export function removeSpecks(alpha: Uint8ClampedArray, w: number, h: number, minArea: number): void {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  const blob: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || alpha[i] < 60) continue;
    blob.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      blob.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1], [x - 1, y - 1], [x + 1, y + 1], [x - 1, y + 1], [x + 1, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!seen[q] && alpha[q] >= 60) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    if (blob.length < minArea) for (const p of blob) alpha[p] = 0;
  }
  // faint pixels not attached to any kept stroke go too
  for (let i = 0; i < w * h; i++) if (alpha[i] < 60 && !hasStrongNeighbour(alpha, w, h, i)) alpha[i] = 0;
}

function hasStrongNeighbour(alpha: Uint8ClampedArray, w: number, h: number, i: number): boolean {
  const x = i % w;
  const y = (i - x) / w;
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && alpha[ny * w + nx] >= 60) return true;
    }
  return false;
}

/**
 * Extract the ink: paper becomes transparent, the result is cropped to the strokes
 * (plus a small margin). Returns null if no ink was found.
 */
export function extractInk(src: RGBAImage, opts: InkOptions = {}): RGBAImage | null {
  const img = opts.crop ? cropImage(src, opts.crop) : src;
  const { width: w, height: h, data } = img;
  if (w < 4 || h < 4) return null;
  const s = Math.min(1, Math.max(0, opts.sensitivity ?? 0.5));

  const lumas = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lumas[i] = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const paper = estimatePaper(lumas, w, h);

  // darkness relative to the local paper: 0 = paper, 1 = black
  const lo = 0.3 - 0.22 * s; // where ink starts to show
  const hi = lo + 0.25; // fully opaque from here
  const alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = 1 - lumas[i] / Math.max(paper[i], 24);
    alpha[i] = Math.round(Math.min(1, Math.max(0, (d - lo) / (hi - lo))) * 255);
  }
  removeSpecks(alpha, w, h, Math.max(6, Math.round(w * h * (opts.minSpeck ?? 0.00004))));

  // bounding box of the ink
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha[y * w + x] > 12) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  const pad = Math.max(2, Math.round(Math.max(x1 - x0, y1 - y0) * 0.02));
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(w - 1, x1 + pad);
  y1 = Math.min(h - 1, y1 + pad);

  const ow = x1 - x0 + 1;
  const oh = y1 - y0 + 1;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const col = opts.color ?? null;
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const si = (y + y0) * w + (x + x0);
      const d = (y * ow + x) * 4;
      const a = alpha[si];
      if (a === 0) continue;
      if (col) {
        out[d] = col[0];
        out[d + 1] = col[1];
        out[d + 2] = col[2];
      } else {
        // original colour, corrected for the paper tint and deepened a little
        const k = (255 / Math.max(paper[si], 24)) * 0.85;
        out[d] = data[si * 4] * k;
        out[d + 1] = data[si * 4 + 1] * k;
        out[d + 2] = data[si * 4 + 2] * k;
      }
      out[d + 3] = a;
    }
  return { width: ow, height: oh, data: out };
}

/** Scale factor so the longer side is at most maxSide. */
export function fitScale(w: number, h: number, maxSide: number): number {
  return Math.min(1, maxSide / Math.max(w, h));
}
