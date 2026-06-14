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
        theme_color: "#3B5BFF",
        background_color: "#FAFAF7",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});
