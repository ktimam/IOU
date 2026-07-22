// Settings simplification (settings-redundancy): the 6-digit "Connect to OpenChat" flow is the
// ONLY OpenChat surface on the default /settings view. The admin "Link to OpenChat" button, the
// debug PEM textarea + "Copy public key" + fingerprint, the auto-derived inbox readout, and the
// legacy relay cards ("Chat import (relay)" setup + "OpenChat link (relay)" pairing) all live
// behind a collapsed "Advanced" disclosure that auto-expands when a relay is already configured,
// so legacy relay users keep access to their URL/token.
//
// SAFE-BY-DESIGN: like openchat.ui.spec.ts, this file NEVER clicks "Link to OpenChat" (that
// register_ai_app upsert would clobber the shared live "iou" registration — the registration loop
// is covered by the api-e2e + Rust tests). It only asserts the button's visibility.

import { test, expect } from "@playwright/test";
import { signInDev, openSettings, openAdvanced, consumerFingerprint } from "./flows";

// FAILING-FIRST 1: the default signed-in view is Connect-only — none of the admin/debug/legacy
// surfaces render until Advanced is expanded.
test("default /settings shows ONLY the Connect flow — no admin, debug, or relay surfaces", async ({ page }) => {
  await signInDev(page);
  await openSettings(page);

  // The surviving end-user flow: 6-digit code + Connect, and the one-sided Disconnect.
  await expect(page.locator('input[placeholder="6-digit code"]')).toBeVisible();
  await expect(page.getByRole("button", { name: /^Connect$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect from OpenChat" })).toBeVisible();

  // Hidden by default: admin registration, debug key surfaces, and BOTH legacy relay cards.
  await expect(page.getByRole("button", { name: "Link to OpenChat" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Copy public key" })).toHaveCount(0);
  await expect(page.locator("textarea")).toHaveCount(0); // the PEM readout is the page's only textarea
  await expect(page.getByText(/fingerprint:/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Chat import (relay)" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "OpenChat link (relay)" })).toHaveCount(0);
});

// FAILING-FIRST 2: expanding Advanced reveals the admin/debug surfaces and the legacy relay setup
// card (the relay PAIRING card additionally needs a saved relay config — see the auto-expand test).
test("Advanced discloses Link/PEM/Copy/fingerprint, the inbox readout, and the relay setup card", async ({ page }) => {
  await signInDev(page);
  await openSettings(page);
  await openAdvanced(page);

  // Admin registration + this account's delivery-key debug surfaces (Link is NOT clicked).
  await expect(page.getByRole("button", { name: "Link to OpenChat" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy public key" })).toBeEnabled();
  await expect(page.locator("textarea")).toBeVisible(); // the PEM readout
  expect(await consumerFingerprint(page)).toMatch(/fingerprint:\s*[0-9a-f]{16}/i);
  // The action_inbox readout is still AUTO-DERIVED from the live OpenChat registration.
  await expect(page.getByText(/@\s*https?:\/\//)).toBeVisible({ timeout: 30_000 });
  // The legacy relay setup card is reachable here…
  await expect(page.getByRole("heading", { name: "Chat import (relay)" })).toBeVisible();
  // …but with NO relay configured there is no pairing card and no "set up relay first" placeholder.
  await expect(page.getByRole("heading", { name: "OpenChat link (relay)" })).toHaveCount(0);
});

// REGRESSION (green today, must stay green): the OpenChat consent-sheet deep link still scrolls to
// and focuses the 6-digit code input after Connect moves to the top of the card.
test("/settings#openchat-connect still focuses the 6-digit code input after the restructure", async ({ page }) => {
  await signInDev(page);
  await page.goto("/settings#openchat-connect", { waitUntil: "domcontentloaded" });
  await expect(page.locator('input[placeholder="6-digit code"]')).toBeFocused({ timeout: 20_000 });
});

// FAILING-FIRST 3: a pre-existing relay config (iou:relay:* keys, as relay.ts setRelayConfig
// writes them) auto-expands Advanced so legacy relay users aren't stranded — both relay cards are
// visible without a click and the saved URL/token remain editable.
test("a saved relay config auto-expands Advanced with both relay cards editable", async ({ page }) => {
  await signInDev(page);
  await page.evaluate(() => {
    localStorage.setItem("iou:relay:url", "http://localhost:8788");
    localStorage.setItem("iou:relay:token", "iou_" + "ab".repeat(24));
  });
  await openSettings(page);

  // The disclosure exists AND starts expanded: both legacy relay cards show without a click.
  await expect(page.getByRole("button", { name: /Advanced/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chat import (relay)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OpenChat link (relay)" })).toBeVisible();

  // The saved relay URL/token stay editable (nothing was "lost" by the simplification).
  const relayCard = page.locator(".card").filter({ hasText: "Chat import (relay)" }).first();
  await expect(relayCard.locator("input").first()).toHaveValue("http://localhost:8788");
  await expect(relayCard.locator('input[placeholder="generate one →"]')).toHaveValue("iou_" + "ab".repeat(24));
});
