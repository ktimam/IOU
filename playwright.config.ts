import { defineConfig, devices } from "@playwright/test";

// UI E2E: drives the real IOU app in a browser with MULTIPLE users (isolated
// browser contexts, each a distinct dev identity), multiple pairs/sheets, and
// chat→sheet links. Separate from the vitest layers (unit = src, api-e2e =
// test/e2e); Playwright only looks in test/ui.
//
//   pnpm test:ui            # headless
//   HEADED=1 pnpm test:ui   # watch it drive
//
// The dev server (http://127.0.0.1:3000) is reused if already running, else
// started. Run `pnpm ui:demo` (scripts/ui-multiuser-demo.mjs) to set up the
// same multi-user state in PERSISTENT windows that stay open for inspection.
export default defineConfig({
  testDir: "./test/ui",
  testMatch: "**/*.ui.spec.ts",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  // The cross-user flows depend on canister propagation between users; under heavy machine load a
  // single attempt can exhaust its in-test re-fetch budget. One retry absorbs that transient flake.
  retries: process.env.CI ? 2 : 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    headless: !process.env.HEADED,
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 90_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
