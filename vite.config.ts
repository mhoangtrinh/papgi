import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "PDF Studio",
        short_name: "PDF Studio",
        description: "Annotate, fill, sign and rearrange PDFs. Files stay on your device.",
        theme_color: "#2f6fed",
        background_color: "#f6f7f9",
        display: "standalone",
        start_url: "./",
        scope: "./",
        icons: [
          { src: "pwa-192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        file_handlers: [{ action: "./", accept: { "application/pdf": [".pdf"] } }],
        launch_handler: { client_mode: "focus-existing" },
      } as Record<string, unknown>,
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,woff2}"],
        globIgnores: ["samples/**"],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: /\/samples\/.*\.pdf$/, handler: "CacheFirst", options: { cacheName: "samples" } },
        ],
      },
    }),
  ],
});
