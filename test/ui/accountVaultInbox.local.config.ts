import { defineConfig } from "@playwright/test";

// Synthetic, isolated local backend only. Never include this in production smoke runs.
export default defineConfig({
  testDir: ".", testMatch: "accountVaultInbox.local.spec.ts", workers: 1, retries: 0,
  timeout: 180_000, expect: { timeout: 30_000 }, reporter: [["list"]],
  outputDir: "../../output/playwright/account-vault-inbox-local",
  use: { baseURL: "http://localhost:4310", headless: true, trace: "off", screenshot: "off", video: "off",
    actionTimeout: 30_000, navigationTimeout: 30_000,
    launchOptions: { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } },
});
