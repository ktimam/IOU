// Capacitor configuration for the IOU PWA.
//
// The web build lives in `dist/`; Capacitor syncs it into the
// native shell on `cap sync android` / `cap sync ios`. The
// PWA's own service worker (vite-plugin-pwa) handles offline
// mode inside the WebView; Capacitor's local server / file
// loading is just a transport.

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.iou.app",
  appName: "IOU",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 0,
    },
  },
  // Android debug builds remain developer-signable. Gradle release tasks
  // fail closed unless the gitignored release keystore configuration exists.
};

export default config;
