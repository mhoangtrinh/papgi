// The camera orientation stored in a JPEG photo (EXIF tag 0x0112): 1 = upright,
// 3 = upside down, 6 = turned 90° clockwise, 8 = 90° counter-clockwise, 2/4/5/7 = mirrored.
// Phones save photos sideways and set this tag instead of turning the pixels.

export function jpegOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1];
    if (marker === 0xd9 || marker === 0xda) return 1; // end of image / start of picture data
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xe1 && len >= 8 && i + 4 + len - 2 <= b.length) {
      const o = exifOrientation(b.subarray(i + 4, i + 2 + len));
      if (o) return o;
    }
    i += 2 + len;
  }
  return 1;
}

function exifOrientation(seg: Uint8Array): number {
  // "Exif\0\0" then a TIFF header
  if (seg.length < 14 || String.fromCharCode(...seg.subarray(0, 4)) !== "Exif") return 0;
  const t = seg.subarray(6);
  const le = t[0] === 0x49 && t[1] === 0x49; // "II" little-endian, "MM" big-endian
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return 0;
  const u16 = (p: number) => (p + 2 > t.length ? 0 : le ? t[p] | (t[p + 1] << 8) : (t[p] << 8) | t[p + 1]);
  const u32 = (p: number) => (p + 4 > t.length ? 0 : le ? (t[p] | (t[p + 1] << 8) | (t[p + 2] << 16) | (t[p + 3] << 24)) >>> 0 : ((t[p] << 24) | (t[p + 1] << 16) | (t[p + 2] << 8) | t[p + 3]) >>> 0);
  const ifd = u32(4);
  const count = u16(ifd);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 0;
    }
  }
  return 0;
}
