import { defineConfig, devices } from '@playwright/test';

// Independent of the account-backed dev server on :3000. The spec starts only
// its six-asset loopback fixture, with no .env, credentials or backend access.
export default defineConfig({
  testDir: '.', testMatch: 'conversion.ui.spec.ts',
  timeout: 30_000, expect: { timeout: 10_000 },
  workers: 1, fullyParallel: false, retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  outputDir: '../../test-results/conversion',
  use: {
    trace: 'retain-on-failure', headless: !process.env.HEADED,
    serviceWorkers: 'block',
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } }
      : {}),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
