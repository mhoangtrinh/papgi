import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },
  optimizeDeps: { exclude: ["mupdf"] },
  plugins: [
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "papgi",
        short_name: "papgi",
        description: "Edit, sign, merge, split, compress and convert PDFs. Files stay on your device.",
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
        // right-click the installed app (Windows) / long-press (Android) to jump to a tool
        shortcuts: [
          { name: "Merge PDFs", url: "./#merge" },
          { name: "Split PDF", url: "./#split" },
          { name: "Compress PDF", url: "./#compress" },
          { name: "Images to PDF", url: "./#images-to-pdf" },
          { name: "PDF to images", url: "./#pdf-to-images" },
          { name: "PDF to Word", url: "./#pdf-to-word" },
        ],
        launch_handler: { client_mode: "focus-existing" },
      } as Record<string, unknown>,
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,wasm,woff2}"],
        globIgnores: ["samples/**", "fonts/**", "ocr/**"],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        runtimeCaching: [
          { urlPattern: /\/samples\/.*\.pdf$/, handler: "CacheFirst", options: { cacheName: "samples" } },
          // fonts for text editing are fetched the first time they're needed, then kept offline
          { urlPattern: /\/fonts\/.*\.(otf|ttf)$/, handler: "CacheFirst", options: { cacheName: "fonts" } },
          // text recognition engine and language data: fetched on first use, then offline
          { urlPattern: /\/ocr\/.*\.(js|gz)$/, handler: "CacheFirst", options: { cacheName: "ocr" } },
        ],
      },
    }),
  ],
});
