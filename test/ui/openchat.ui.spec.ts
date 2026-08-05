// OpenChat / chat-bridge UI E2E — the IOU-app side of the confirmable-action feature, driven in the
// browser with multiple users. Covers: the OpenChat action-inbox settings card (per-user consumer
// key, auto-derived inbox, connect-code validation against the live user_index), and the ✨ Import
// chat-draft flow. Chat-to-sheet routing is learned from encrypted inbox context, not a URL surface.
//
// SAFE-BY-DESIGN: never clicks "Link to OpenChat" (that register_ai_app upsert would clobber the
// shared live "iou" registration — the full registration loop is covered by the api-e2e + Rust
// integration tests). Only read-only / per-user / negative interactions here.

import { test, expect } from "@playwright/test";
import {
  signInDev,
  createAccount,
  openSheet,
  importDraft,
  openSettings,
  openAdvanced,
  consumerFingerprint,
  connectWithCode,
  balancesText,
} from "./flows";

test("OpenChat settings: per-user consumer key, inbox resolution, connect-code validation", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const alice = await aCtx.newPage();
  const bob = await bCtx.newPage();
  await signInDev(alice);
  await signInDev(bob);

  await openSettings(alice);
  // The key/fingerprint/inbox debug surfaces live under the "Advanced" disclosure now.
  await openAdvanced(alice);
  // A per-account consumer keypair is generated (canister-backed) and shown.
  await expect(alice.getByRole("button", { name: "Copy public key" })).toBeEnabled();
  const aFp = await consumerFingerprint(alice);
  expect(aFp).toMatch(/fingerprint:\s*[0-9a-f]{16}/i);
  // The action_inbox is AUTO-DERIVED from the OpenChat registration (resolves to "<id> @ <host>").
  await expect(alice.getByText(/@\s*https?:\/\//)).toBeVisible({ timeout: 30_000 });

  // Claim-token validation stays on the DEFAULT (non-advanced) view: a malformed token is
  // rejected client-side …
  await connectWithCode(alice, "12345");
  await expect(alice.getByText(/64-character claim token shown in OpenChat/i)).toBeVisible();
  // … and a well-formed but unknown token is rejected by the LIVE user_index (CodeNotFound).
  await connectWithCode(alice, "0".repeat(64));
  await expect(alice.getByText(/does(n't| not) recognise this claim token/i)).toBeVisible({ timeout: 30_000 });

  // Bob has his OWN distinct consumer key (per-user keypair isolation).
  await openSettings(bob);
  await openAdvanced(bob);
  const bFp = await consumerFingerprint(bob);
  expect(bFp).not.toBe(aFp);

  await aCtx.close();
  await bCtx.close();
});

test("✨ Import a chat-bridge draft into a sheet", async ({ browser }) => {
  const ctx = await browser.newContext();
  const alice = await ctx.newPage();
  await signInDev(alice);
  await createAccount(alice, "OC Import", "Import Sheet"); // lands on the new sheet
  await openSheet(alice, "OC Import");

  // The exact shape an assistant / OpenChat draft produces (docs/chat-agent.md).
  const draft = JSON.stringify({
    kind: "settlement",
    amount: 25,
    currency: "USD",
    direction: "credit",
    note: "coffee (from chat)",
  });
  await importDraft(alice, draft);

  // Parsed → confirmed → written: the entry lands and shows in the balance + history (re-open to
  // dodge the render race between the add's reload and reading the balance).
  let bal = await balancesText(alice);
  for (let i = 0; i < 6 && !bal.includes("25.00 USD"); i++) {
    await alice.waitForTimeout(1500);
    await openSheet(alice, "OC Import");
    bal = await balancesText(alice);
  }
  expect(bal).toContain("25.00 USD");
  await expect(alice.getByText("coffee (from chat)")).toBeVisible();

  await ctx.close();
});

// P1 (P4): a SIGNED-IN visit to /settings#openchat-connect scrolls to + focuses the claim-token
// input (the deep link's landing target) — the signed-in half of the inline-sign-in guard tests.
test("/settings#openchat-connect (signed in) focuses the claim-token input", async ({ page }) => {
  await signInDev(page);
  await page.goto("/settings#openchat-connect", { waitUntil: "domcontentloaded" });
  await expect(page.locator('input[placeholder="64-character claim token"]')).toBeFocused({ timeout: 20_000 });
});
