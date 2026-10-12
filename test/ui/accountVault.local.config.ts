import { defineConfig } from "@playwright/test";

// Explicitly separate from the existing 3000 app and all production endpoints.
export default defineConfig({
  testDir: ".", testMatch: "accountVault.local.spec.ts", workers: 1, retries: 0,
  timeout: 360_000, expect: { timeout: 25_000 }, reporter: [["list"]],
  outputDir: "../../output/playwright/account-vault-local",
  use: { baseURL: "http://localhost:4310", headless: true, trace: "off", screenshot: "off", actionTimeout: 25_000, navigationTimeout: 30_000,
    launchOptions: { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } },
});
