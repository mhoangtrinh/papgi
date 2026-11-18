// Generates PNG icons from public/favicon.svg.
import sharp from "sharp";
import fs from "node:fs";
const svg = fs.readFileSync(new URL("../public/favicon.svg", import.meta.url));
const out = (n) => new URL(`../public/${n}`, import.meta.url).pathname;
await sharp(svg, { density: 384 }).resize(192, 192).png().toFile(out("pwa-192.png"));
await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(out("pwa-512.png"));
// maskable: icon inside the 80% safe zone on a solid background
const inner = await sharp(svg, { density: 384 }).resize(380, 380).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: "#2f6fed" } }).composite([{ input: inner, gravity: "center" }]).png().toFile(out("pwa-512-maskable.png"));
// apple-touch-icon: solid background, no transparency
const apple = await sharp(svg, { density: 384 }).resize(180, 180).png().toBuffer();
await sharp({ create: { width: 180, height: 180, channels: 3, background: "#2f6fed" } }).composite([{ input: apple }]).png().toFile(out("apple-touch-icon.png"));
console.log("icons written");
