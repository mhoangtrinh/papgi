import { describe, it, expect } from "vitest";
import { extractInk, cropImage, rotate90, fitScale, type RGBAImage } from "../src/core/signature";

/** A fake phone photo: paper lit unevenly (bright left, grey right), a blue-black stroke, some dust. */
function photo(): RGBAImage {
  const w = 400;
  const h = 200;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const paper = 245 - (x / w) * 85; // shadow: 245 -> 160
      let r = paper, g = paper, b = paper * 0.97;
      // signature stroke: thick wavy line from x=60..340 around y=100
      const yc = 100 + Math.sin(x / 18) * 25;
      if (x >= 60 && x <= 340 && Math.abs(y - yc) < 3) {
        r = 25;
        g = 30;
        b = 70;
      }
      // dust specks
      if ((x === 20 && y === 20) || (x === 380 && y === 180) || (x === 200 && y === 15)) r = g = b = 40;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  return { width: w, height: h, data };
}

const alphaAt = (img: RGBAImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];

describe("signature extraction", () => {
  it("crops to the stroke and ignores shading and dust", () => {
    const out = extractInk(photo())!;
    expect(out).not.toBeNull();
    // stroke spans 280 px wide and ~56 px tall, plus a small margin
    expect(out.width).toBeGreaterThan(280);
    expect(out.width).toBeLessThan(300);
    expect(out.height).toBeGreaterThan(54);
    expect(out.height).toBeLessThan(75);
  });

  it("makes paper transparent and ink opaque", () => {
    const out = extractInk(photo())!;
    // corners are paper
    expect(alphaAt(out, 0, 0)).toBe(0);
    expect(alphaAt(out, out.width - 1, out.height - 1)).toBe(0);
    // the stroke is fully opaque somewhere in every column of the middle
    let opaqueCols = 0;
    for (let x = 10; x < out.width - 10; x++) {
      let max = 0;
      for (let y = 0; y < out.height; y++) max = Math.max(max, alphaAt(out, x, y));
      if (max === 255) opaqueCols++;
    }
    expect(opaqueCols).toBeGreaterThan((out.width - 20) * 0.95);
  });

  it("recolours ink when asked, keeps it otherwise", () => {
    const blue = extractInk(photo(), { color: [26, 58, 143] })!;
    const i = blue.data.findIndex((_, k) => k % 4 === 3 && blue.data[k] === 255) - 3;
    expect([blue.data[i], blue.data[i + 1], blue.data[i + 2]]).toEqual([26, 58, 143]);
    const orig = extractInk(photo(), { color: null })!;
    const j = orig.data.findIndex((_, k) => k % 4 === 3 && orig.data[k] === 255) - 3;
    // still dark blue-ish
    expect(orig.data[j + 2]).toBeGreaterThan(orig.data[j]);
    expect(orig.data[j]).toBeLessThan(80);
  });

  it("respects a crop box", () => {
    const out = extractInk(photo(), { crop: { x: 50, y: 40, w: 150, h: 120 } })!;
    expect(out.width).toBeLessThanOrEqual(150);
    expect(out.width).toBeGreaterThan(130);
  });

  it("returns null for a blank page", () => {
    const blank: RGBAImage = { width: 50, height: 50, data: new Uint8ClampedArray(50 * 50 * 4).fill(240) };
    expect(extractInk(blank)).toBeNull();
  });

  it("higher sensitivity picks up fainter ink", () => {
    const img = photo();
    // add a faint grey stroke at y=170
    for (let x = 100; x < 300; x++)
      for (let y = 168; y < 172; y++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = img.data[i] * 0.8;
      }
    const low = extractInk(img, { sensitivity: 0 })!;
    const high = extractInk(img, { sensitivity: 1 })!;
    expect(high.height).toBeGreaterThan(low.height + 30);
  });

  it("crops, rotates and fits", () => {
    const img = photo();
    const c = cropImage(img, { x: -10, y: 190, w: 30, h: 50 });
    expect([c.width, c.height]).toEqual([20, 10]);
    const r = rotate90({ width: 2, height: 1, data: new Uint8ClampedArray([1, 1, 1, 1, 2, 2, 2, 2]) });
    expect([r.width, r.height]).toEqual([1, 2]);
    expect(Array.from(r.data)).toEqual([1, 1, 1, 1, 2, 2, 2, 2]);
    expect(fitScale(3200, 1600, 1600)).toBe(0.5);
    expect(fitScale(100, 50, 1600)).toBe(1);
  });
});
