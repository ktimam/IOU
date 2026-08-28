import { readFileSync } from "node:fs";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import {
  resolveDevLanQcTlsPaths,
  resolveOpenChatDevAllowedHosts,
  resolveOpenChatDevOrigin,
} from "./vite.devLanQc";

// OpenChat's local dev origins, allowed to frame IOU's embeddable documents (the /openchat/card and
// "home" sheet surfaces — see actionManifest.ts). The live harnesses drive OpenChat's native/mobile
// dev server on :5003; :5001 is the web dev server. Both localhost and 127.0.0.1 are listed because
// OpenChat's vite runs with host:true and can be reached under either. This is the dev-only mirror of
// the prod https://oc.app allowlist in public/.ic-assets.json5 — same posture (OpenChat-only framing,
// every other origin denied), different embedder.
const OPENCHAT_LOOPBACK_DEV_FRAME_ANCESTORS = [
  "http://tauri.localhost",
  "http://localhost:5003",
  "http://localhost:5001",
  "http://127.0.0.1:5003",
  "http://127.0.0.1:5001",
];

// Vite watches the project root recursively. Keep generated canister/build state and durable browser
// profiles out of that graph: Chromium updates cache and SQLite files continuously, which otherwise
// turns an idle dev server into a permanent hot-reload loop. Do not replace this with polling; that
// would trade the event storm for a constant directory scan.
const DEV_WATCH_IGNORES = [
  "**/target/**",
  "**/.dfx/**",
  "**/.openchat-iou/**",
  "**/.openchat-inbox/**",
  "**/.pw-profiles/**",
  "**/.pw-profiles-scenarios/**",
  "**/coverage/**",
  "**/playwright-report/**",
  "**/android/**",
  "**/ii/**",
];

// Mirror the prod asset-canister framing posture on the dev server, which otherwise sets NO framing
// headers at all (frameable by ANY origin — the hole this closes). Prod locks everything to
// `frame-ancestors 'none'` and relaxes ONLY the index.html document to the OpenChat allowlist; here we
// reproduce that per response: an HTML navigation (the card/home documents OpenChat embeds) gets the
// OpenChat dev allowlist, every other request (static assets, HMR) gets 'none'. frame-ancestors is an
// allowlist, so unlisted origins are denied; no X-Frame-Options is emitted because XFO cannot express
// an allowlist (and would only get in the way).
function devFramingHeaders(frameAncestors: readonly string[]): Plugin {
  return {
    name: "iou-dev-framing",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const isDocument = (req.headers.accept ?? "").includes("text/html");
        const ancestors = isDocument ? frameAncestors.join(" ") : "'none'";
        res.setHeader(
          "Content-Security-Policy",
          `frame-ancestors ${ancestors}`,
        );
        // The card iframe intentionally omits allow-same-origin, so its active origin is opaque
        // (`null`). ES modules are consequently CORS fetches even though their URLs share the IOU
        // server origin. These are public build assets and carry no credentials; wildcard ACAO lets
        // the credentialless sandbox load them without widening frame-ancestors or API access.
        res.setHeader("Access-Control-Allow-Origin", "*");
        next();
      });
    },
  };
}

// https://vitejs.dev/config/
//
// The production PWA is served by the iou_assets canister via
// `pnpm build && dfx deploy iou_assets`. The dev server (this
// config) is only used for hot-reload while developing the UI —
// canister calls during dev go to the local dfx replica at
// http://127.0.0.1:4943 directly, so no proxy is needed.
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, ".", "");
  const context = {
    // `vite build` deliberately ignores this setting, even if a developer's shell still has it.
    isDevelopment: command === "serve",
    dfxNetwork: env.VITE_DFX_NETWORK ?? "local",
  };
  const configuredOpenChatOrigin = resolveOpenChatDevOrigin(
    env.VITE_IOU_LAN_QC_OPENCHAT_ORIGIN,
    context,
  );
  const openChatDevAllowedHosts = resolveOpenChatDevAllowedHosts(
    env.VITE_IOU_LAN_QC_OPENCHAT_ORIGIN,
    context,
  );
  const tlsPaths = resolveDevLanQcTlsPaths(
    env.IOU_LAN_QC_HTTPS_CERT_PATH,
    env.IOU_LAN_QC_HTTPS_KEY_PATH,
    context,
  );
  const lanQcHttps = tlsPaths
    ? {
        cert: readFileSync(tlsPaths.certPath),
        key: readFileSync(tlsPaths.keyPath),
      }
    : undefined;
  const openChatDevFrameAncestors = Array.from(
    new Set([
      ...OPENCHAT_LOOPBACK_DEV_FRAME_ANCESTORS,
      ...(configuredOpenChatOrigin ? [configuredOpenChatOrigin] : []),
    ]),
  );

  return {
    plugins: [
      devFramingHeaders(openChatDevFrameAncestors),
      react(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.svg"],
        manifest: {
          name: "IOU",
          short_name: "IOU",
          description:
            "Encrypted 2-person IOU tracker on the Internet Computer",
          theme_color: "#0f1216",
          background_color: "#0f1216",
          display: "standalone",
          orientation: "portrait",
          start_url: "/",
          icons: [
            {
              src: "pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any",
            },
            {
              src: "pwa-maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
      }),
    ],
    build: {
      outDir: "dist",
      // Production maps previously shipped full sourcesContent, including removed code.
      // Keep debugging maps private and generate them only in a separately controlled job.
      sourcemap: false,
    },
    server: {
      // 127.0.0.1:3000 is IOU's canonical dev origin. It must match the origin baked into the
      // OpenChat surface URL (see actionManifest.ts resolvePublicOrigin, default
      // http://127.0.0.1:3000): OpenChat opens the chat-link page in the system browser, and that
      // page relies on the user's already-signed-in IOU session. Browser storage (II delegation /
      // dev identity, and therefore the user's sheets) is origin-scoped, and "localhost" ≠
      // "127.0.0.1" — so host and port here are load-bearing, not cosmetic. Change both together.
      port: 3000,
      // Listening on every interface requires an explicit certificate/key pair in local development.
      // A production build ignores these envs and therefore cannot enter this branch.
      host: lanQcHttps ? "0.0.0.0" : "127.0.0.1",
      https: lanQcHttps,
      // Derive the exact forwarding host from the validated OpenChat development origin. An absent
      // setting produces an empty list; never use a wildcard, which would weaken DNS-rebinding
      // protection for the dev server.
      allowedHosts: openChatDevAllowedHosts,
      strictPort: true,
      watch: {
        ignored: DEV_WATCH_IGNORES,
      },
      // Vite's built-in CORS middleware runs after plugin middleware and owns the final ACAO header.
      // This serves public frontend assets only; the explicit LAN-QC mode is still constrained by the
      // exact frame ancestor above. Wildcard ACAO is required for credentialless opaque-origin frames.
      cors: true,
      // Keep phone/Tailscale development same-origin: the public HTTPS endpoint terminates at this
      // loopback Vite server, while PocketIC remains private on 127.0.0.1. PocketIC routes by Host,
      // so changeOrigin must replace the browser-facing ts.net hostname.
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${env.VITE_DFX_PORT ?? "4943"}`,
          changeOrigin: true,
          headers: {
            "x-forwarded-host": `127.0.0.1:${env.VITE_DFX_PORT ?? "4943"}`,
          },
        },
      },
    },
  };
});
