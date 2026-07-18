// UI E2E for the v1.10.0 membership lifecycle (invite link → accept → leave /
// archive / unarchive / delete), driving the real app + replica with two
// isolated contexts (= two dev identities: alice the creator, bob the invitee).
//
// Proves the whole redesign through the actual UI:
//   1. Invite LINK → Accept → bob is IN immediately, both read/write (no grant).
//   2. Archive → the account moves to the "📦 Archived" section; Unarchive → back.
//   3. Bob Leaves → bob is locked out; alice retains the account solo.
//   4. Alice archives the now-solo account and Deletes it forever → it's gone.

import { test, expect } from "@playwright/test";
import {
  signInDev,
  createAccount,
  inviteLinkFromSheet,
  acceptInvite,
  openSheet,
  addEntry,
  balancesText,
  archiveAccount,
  unarchiveAccount,
  leaveAccount,
  deleteAccount,
} from "./flows";

const ACCT = "Shared Acct";

test("invite link → accept → both access; leave; archive/unarchive; solo delete", async ({
  browser,
}) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await signInDev(alice);
  await signInDev(bob);

  // ── 1. Invite link → Accept: bob joins instantly, both read/write ────────────
  const sheetId = await createAccount(alice, ACCT, "Ledger");
  const link = await inviteLinkFromSheet(alice);
  const bobSheet = await acceptInvite(bob, link);
  expect(bobSheet).toBe(sheetId); // bob landed on the SAME shared sheet, no grant

  // Bob writes; alice reads the decrypted result (cross-user E2E via self-wrapped key).
  await openSheet(bob);
  await addEntry(bob, {
    currency: "EGP",
    amount: 100,
    direction: "debt", // bob owes alice
    type: "iou",
    note: "bob's line",
  });
  await openSheet(alice, ACCT);
  let owed = await balancesText(alice);
  for (let i = 0; i < 12 && !/100\.00 EGP/.test(owed); i++) {
    await alice.waitForTimeout(2000);
    await openSheet(alice, ACCT);
    owed = await balancesText(alice);
  }
  expect(owed).toContain("100.00 EGP");
  expect(owed).toMatch(/owes you/i); // alice is owed
  await expect(alice.getByText("bob's line")).toBeVisible();

  // ── 2. Archive → account moves to the Archived section; Unarchive → back ──────
  await archiveAccount(alice, ACCT); // lands on /pairs
  await expect(alice.getByRole("heading", { name: /Archived/ })).toBeVisible();
  await expect(alice.getByText(ACCT)).toBeVisible(); // still listed (in Archived)
  await unarchiveAccount(alice, ACCT);
  await alice.goto("/pairs");
  // Back in the active list: no Archived heading (this is alice's only account).
  await expect(alice.getByRole("heading", { name: /Archived/ })).toHaveCount(0);
  await expect(alice.getByText(ACCT)).toBeVisible();

  // ── 3. Bob leaves → bob is locked out; alice keeps the account solo ───────────
  await leaveAccount(bob); // bob's only account → no name filter
  await bob.goto("/pairs");
  await expect(bob.getByText(ACCT)).toHaveCount(0); // bob no longer sees it
  // Alice still has it and still reads the data (now solo).
  await openSheet(alice, ACCT);
  await expect(alice.getByText("bob's line")).toBeVisible();

  // ── 4. Alice archives the solo account, then Deletes it forever ───────────────
  await archiveAccount(alice, ACCT);
  await deleteAccount(alice, ACCT); // typed-confirm DELETE; lands on /pairs
  await alice.goto("/pairs");
  await expect(alice.getByText(ACCT)).toHaveCount(0); // gone for good

  await aliceCtx.close();
  await bobCtx.close();
});
