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

  // P1 (P7): the landing route while anonymous shows the sign-in CTA and does NOT redirect.
  test("/ (landing) while anonymous shows the sign-in CTA without redirect", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: /Sign in with Internet Identity/ })).toBeVisible({ timeout: 20_000 });
    expect(new URL(page.url()).pathname).toBe("/");
  });

  // P1 (P8): /me redirects to /settings (which renders inline sign-in when anonymous).
  test("/me redirects to /settings", async ({ page }) => {
    await page.goto("/me", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/settings$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Sign in with Internet Identity/ })).toBeVisible();
  });

  // P1 (P9): an unknown route redirects to the landing page.
  test("an unknown route redirects to /", async ({ page }) => {
    await page.goto("/does-not-exist", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  });

  // P1 (P5): after inline sign-in on /openchat/link-chat, the SAME page renders the sheet picker
  // (?chat kept) — the destination survives, no bounce to /pairs.
  test("signed-out link-chat returns to the picker after inline sign-in (?chat kept)", async ({ page }) => {
    await page.goto("/openchat/link-chat?chat=group:xyz", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Sign in with Internet Identity/ }).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: /Sign in \(dev/ }).click();
    await expect(page.getByRole("heading", { name: "Link this chat to a sheet" })).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe("/openchat/link-chat");
    expect(new URL(page.url()).searchParams.get("chat")).toBe("group:xyz");
  });
});
