// Route auth-guards for a signed-OUT (anonymous) visitor (P0-23/24/25). Each test starts in a fresh
// Playwright context = empty localStorage = anonymous (no signInDev). Guarded pages must redirect to
// /sign-in; the OpenChat surfaces (/settings, /openchat/link-chat) must instead render sign-in INLINE
// so the URL + hash/query survive (the deep-link destination isn't dropped).

import { test, expect } from "@playwright/test";

test.describe("route auth guards — anonymous visitor", () => {
  // P0-23: guarded pages bounce an anonymous visitor to /sign-in.
  for (const path of ["/pairs", "/pair/new", "/sheet/new", "/set-name", "/pair/abc123def45678"]) {
    test(`${path} redirects an anonymous visitor to /sign-in`, async ({ page }) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await page.waitForURL("**/sign-in", { timeout: 30_000 });
      expect(new URL(page.url()).pathname).toBe("/sign-in");
    });
  }

  // P0-24: /settings#openchat-connect renders inline sign-in (NO redirect) and keeps the hash, so the
  // OpenChat "Open the code page in IOU" deep link scrolls to Connect after the user signs in.
  test("/settings#openchat-connect renders inline sign-in without redirect (hash preserved)", async ({ page }) => {
    await page.goto("/settings#openchat-connect", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Sign in with Internet Identity/ }).waitFor({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/settings");
    expect(new URL(page.url()).hash).toBe("#openchat-connect");
  });

  // P0-25: /openchat/link-chat renders inline sign-in (NO redirect) and keeps ?chat.
  test("/openchat/link-chat renders inline sign-in without redirect (?chat preserved)", async ({ page }) => {
    await page.goto("/openchat/link-chat?chat=group:xyz", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Sign in with Internet Identity/ }).waitFor({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/openchat/link-chat");
    expect(new URL(page.url()).searchParams.get("chat")).toBe("group:xyz");
  });
});
