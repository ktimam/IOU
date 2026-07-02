import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
//
// The production PWA is served by the iou_assets canister via
// `pnpm build && dfx deploy iou_assets`. The dev server (this
// config) is only used for hot-reload while developing the UI —
// canister calls during dev go to the local dfx replica at
// http://127.0.0.1:4943 directly, so no proxy is needed.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "IOU",
        short_name: "IOU",
        description: "Encrypted 2-person IOU tracker on the Internet Computer",
        theme_color: "#0f1216",
        background_color: "#0f1216",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "pwa-maskable-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    // 127.0.0.1:3000 is IOU's canonical dev origin. It must match the origin baked into the
    // OpenChat surface URL (see actionManifest.ts resolvePublicOrigin, default
    // http://127.0.0.1:3000): OpenChat opens the chat-link page in the system browser, and that
    // page relies on the user's already-signed-in IOU session. Browser storage (II delegation /
    // dev identity, and therefore the user's sheets) is origin-scoped, and "localhost" ≠
    // "127.0.0.1" — so host and port here are load-bearing, not cosmetic. Change both together.
    port: 3000,
    host: "127.0.0.1",
  },
});
