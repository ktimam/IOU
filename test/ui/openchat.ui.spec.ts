// OpenChat / chat-bridge UI E2E — the IOU-app side of the confirmable-action feature, driven in the
// browser with multiple users. Covers: the OpenChat action-inbox settings card (per-user consumer
// key, auto-derived inbox, connect-code validation against the live user_index), chat→sheet linking
// (link / current import target / unlink / per-user isolation), and the ✨ Import chat-draft flow.
//
// SAFE-BY-DESIGN: never clicks "Link to OpenChat" (that register_ai_app upsert would clobber the
// shared live "iou" registration — the full registration loop is covered by the api-e2e + Rust
// integration tests). Only read-only / per-user / negative interactions here.

import { test, expect } from "@playwright/test";
import {
  signInDev,
  createAccount,
  openSheet,
  linkChatToSheet,
  unlinkChat,
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

  // Connect-code validation stays on the DEFAULT (non-advanced) view: a non-6-digit code is
  // rejected client-side …
  await connectWithCode(alice, "12345");
  await expect(alice.getByText(/6-digit code shown in OpenChat/i)).toBeVisible();
  // … and a well-formed but unknown code is rejected by the LIVE user_index (CodeNotFound).
  await connectWithCode(alice, "000000");
  await expect(alice.getByText(/does(n't| not) recognise this code/i)).toBeVisible({ timeout: 30_000 });

  // Bob has his OWN distinct consumer key (per-user keypair isolation).
  await openSettings(bob);
  await openAdvanced(bob);
  const bFp = await consumerFingerprint(bob);
  expect(bFp).not.toBe(aFp);

  await aCtx.close();
  await bCtx.close();
});

test("OpenChat chat→sheet link: link, current target, unlink, and per-user isolation", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const alice = await aCtx.newPage();
  const bob = await bCtx.newPage();
  await signInDev(alice);
  await signInDev(bob);
  await createAccount(alice, "OC Alice", "Alice Sheet");
  await createAccount(bob, "OC Bob", "Bob Sheet");

  const chat = "group:oc-shared-chat";

  type P = import("@playwright/test").Page; // inline: survives an organize-imports pass
  const linkRow = (page: P, sheetName: string) =>
    page.locator("label").filter({ hasText: sheetName }).first();
  const markedRows = (page: P) => page.locator('input[name="link-chat-sheet"]:checked');
  // Role + loose name, so the control that drops the link is found however it ends up worded.
  const unlinkBtn = (page: P) => page.getByRole("button", { name: /unlink/i });

  // Assert WHICH SHEET this user's page reports as the chat's import target, by structure rather
  // than by copy: the preselected radio, and whether an unlink control is offered. Both are driven
  // straight off the fetched link map (LinkChatPage.tsx:156 `setSelected(mapped …)` and :328
  // `existing && <Unlink>`), so together they state "this chat imports into <sheet>" / "into
  // nothing" without depending on the wording of the row marker. That marker has already been
  // renamed once — "(current)" → "— this chat imports here" in 365d659, LinkChatPage.tsx:287-292 —
  // and matching on it verbatim is what broke this test then. Copy is not the contract; the link is.
  //
  // Reading the ABSENCE of a link is only meaningful once the list has rendered, and it is: the
  // sheet rows and the mapping land in the SAME state batch (LinkChatPage.tsx:152-156), so a
  // visible row means the link map has already been applied — no "asserted too early" false pass.
  const expectImportTarget = async (page: P, sheetName: string, linked: boolean) => {
    for (let i = 0; i < 6; i++) {
      await page.goto(`/openchat/link-chat?chat=${encodeURIComponent(chat)}`);
      await page.getByRole("heading", { name: "Link this chat to a sheet" }).waitFor();
      await linkRow(page, sheetName).waitFor();
      // A just-saved mapping can lose the race with the page's one-shot fetch on mount — retry.
      if ((await markedRows(page).count()) === (linked ? 1 : 0)) break;
      await page.waitForTimeout(1500);
    }
    // Exactly one sheet is marked as the import target — or none at all when unlinked …
    await expect(markedRows(page), `sheets marked as ${chat}'s import target`).toHaveCount(linked ? 1 : 0);
    // … and it is THIS sheet, not some other one that quietly captured the chat.
    await expect(
      linkRow(page, sheetName).locator('input[name="link-chat-sheet"]'),
      `"${sheetName}" is the import target`,
    ).toBeChecked({ checked: linked });
    // Only a chat that imports somewhere offers a way to stop.
    await expect(unlinkBtn(page), "unlink control offered").toHaveCount(linked ? 1 : 0);
  };

  // Alice links the chat to her sheet, then re-opens and sees her sheet as the import target.
  await linkChatToSheet(alice, chat, "Alice Sheet");
  await expectImportTarget(alice, "Alice Sheet", true);

  // Bob opens the SAME chat's link page — chat→sheet links are caller-scoped, so Alice's mapping is
  // invisible to him. He links it to HIS OWN sheet independently.
  await expectImportTarget(bob, "Bob Sheet", false);
  await linkChatToSheet(bob, chat, "Bob Sheet");

  // Alice unlinks; her mapping is gone but Bob's is untouched (isolation).
  await unlinkChat(alice, chat);
  await expectImportTarget(alice, "Alice Sheet", false);
  await expectImportTarget(bob, "Bob Sheet", true);

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

// P1 (P4): a SIGNED-IN visit to /settings#openchat-connect scrolls to + focuses the 6-digit code
// input (the deep link's landing target) — the signed-in half of the inline-sign-in guard tests.
test("/settings#openchat-connect (signed in) focuses the 6-digit code input", async ({ page }) => {
  await signInDev(page);
  await page.goto("/settings#openchat-connect", { waitUntil: "domcontentloaded" });
  await expect(page.locator('input[placeholder="6-digit code"]')).toBeFocused({ timeout: 20_000 });
});
