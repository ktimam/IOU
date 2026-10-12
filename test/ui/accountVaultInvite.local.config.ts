import { defineConfig } from "@playwright/test";

// Synthetic, isolated local backend only. No traces containing invite capabilities.
export default defineConfig({
  testDir: ".", testMatch: "accountVaultInvite.local.spec.ts", workers: 1, retries: 0,
  timeout: 240_000, expect: { timeout: 30_000 }, reporter: [["list"]],
  outputDir: "../../output/playwright/account-vault-invite-local",
  use: { baseURL: "http://localhost:4310", headless: true, trace: "off", screenshot: "off", video: "off",
    actionTimeout: 30_000, navigationTimeout: 30_000,
    launchOptions: { executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" } },
});
