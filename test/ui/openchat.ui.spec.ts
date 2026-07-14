// OpenChat / chat-bridge UI E2E — the IOU-app side of the confirmable-action feature, driven in the
// browser with multiple users. Covers: the OpenChat action-inbox settings card (per-user consumer
// key, auto-derived inbox, connect-code validation against the live user_index), chat→sheet linking
// (link / current / unlink / per-user isolation), and the ✨ Import chat-draft flow.
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
  // A per-account consumer keypair is generated (canister-backed) and shown.
  await expect(alice.getByRole("button", { name: "Copy public key" })).toBeEnabled();
  const aFp = await consumerFingerprint(alice);
  expect(aFp).toMatch(/fingerprint:\s*[0-9a-f]{16}/i);
  // The action_inbox is AUTO-DERIVED from the OpenChat registration (resolves to "<id> @ <host>").
  await expect(alice.getByText(/@\s*https?:\/\//)).toBeVisible({ timeout: 30_000 });

  // Connect-code validation: a non-6-digit code is rejected client-side …
  await connectWithCode(alice, "12345");
  await expect(alice.getByText(/6-digit code shown in OpenChat/i)).toBeVisible();
  // … and a well-formed but unknown code is rejected by the LIVE user_index (CodeNotFound).
  await connectWithCode(alice, "000000");
  await expect(alice.getByText(/does(n't| not) recognise this code/i)).toBeVisible({ timeout: 30_000 });

  // Bob has his OWN distinct consumer key (per-user keypair isolation).
  await openSettings(bob);
  const bFp = await consumerFingerprint(bob);
  expect(bFp).not.toBe(aFp);

  await aCtx.close();
  await bCtx.close();
});

test("OpenChat chat→sheet link: link, (current), unlink, and per-user isolation", async ({ browser }) => {
  const aCtx = await browser.newContext();
  const bCtx = await browser.newContext();
  const alice = await aCtx.newPage();
  const bob = await bCtx.newPage();
  await signInDev(alice);
  await signInDev(bob);
  await createAccount(alice, "OC Alice", "Alice Sheet");
  await createAccount(bob, "OC Bob", "Bob Sheet");

  const chat = "group:oc-shared-chat";

  // Re-open the link page for `chat` until the "(current)" marker matches `present` (a just-saved
  // mapping can race the page's one-shot fetch on mount).
  const expectCurrent = async (page: import("@playwright/test").Page, present: boolean) => {
    for (let i = 0; i < 6; i++) {
      await page.goto(`/openchat/link-chat?chat=${encodeURIComponent(chat)}`);
      await page.getByRole("heading", { name: "Link this chat to a sheet" }).waitFor();
      if ((await page.getByText("(current)").count()) > 0 === present) return;
      await page.waitForTimeout(1500);
    }
    expect((await page.getByText("(current)").count()) > 0).toBe(present);
  };

  // Alice links the chat to her sheet, then re-opens and sees it marked "(current)".
  await linkChatToSheet(alice, chat, "Alice Sheet");
  await expectCurrent(alice, true);

  // Bob opens the SAME chat's link page — chat→sheet links are caller-scoped, so Alice's mapping is
  // invisible to him. He links it to HIS OWN sheet independently.
  await bob.goto(`/openchat/link-chat?chat=${encodeURIComponent(chat)}`);
  await expect(bob.getByRole("heading", { name: "Link this chat to a sheet" })).toBeVisible();
  await expect(bob.getByText("(current)")).toHaveCount(0);
  await linkChatToSheet(bob, chat, "Bob Sheet");

  // Alice unlinks; her mapping is gone but Bob's is untouched (isolation).
  await unlinkChat(alice, chat);
  await expectCurrent(alice, false);
  await expectCurrent(bob, true);

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
