// Multi-user UI E2E: drives the real IOU app with THREE distinct users (isolated
// browser contexts = distinct dev identities), THREE pairs/sheets, entries added
// through the real form, cross-user E2E-decryption (a partner opens the shared
// sheet and sees the same net), and chat→sheet links. Every step is a real click
// against the live app + replica.

import { test, expect } from "@playwright/test";
import {
  signInDev,
  createAccount,
  inviteLinkFromSheet,
  acceptInvite,
  openSheet,
  addEntry,
  linkChatToSheet,
  balancesText,
} from "./flows";

test("3 users · 3 sheets · cross-user shared view · chat links", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const carolCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const carol = await carolCtx.newPage();

  await signInDev(alice);
  await signInDev(bob);
  await signInDev(carol);

  // ── Pair 1: Alice & Bob (sheet "Rent 2026") ──────────────────────────────
  const sheetAB = await createAccount(alice, "Alice & Bob", "Rent 2026");
  // Invite-link flow: Alice shares the link, Bob opens it and is IN immediately — no grant step.
  const linkAB = await inviteLinkFromSheet(alice);
  await acceptInvite(bob, linkAB);

  await openSheet(alice, "Alice & Bob");
  // From Alice's view: credit = Bob owes her; debt = she owes Bob. Net = 50 − 20 = 30 USD.
  await addEntry(alice, { currency: "USD", amount: 50, direction: "credit", type: "settlement", note: "Bob repaid lunch" });
  await addEntry(alice, { currency: "USD", amount: 20, direction: "debt", type: "iou", note: "Alice owes Bob (later)" });

  // The balance recomputes asynchronously after add_entry (re-fetch + decrypt), so poll for the
  // net rather than reading once — the second entry can land a beat after the modal closes.
  let aliceAB = await balancesText(alice);
  for (let i = 0; i < 10 && !aliceAB.includes("30.00 USD"); i++) {
    await alice.waitForTimeout(1500);
    aliceAB = await balancesText(alice);
  }
  console.log("[alice AB]", aliceAB);
  expect(aliceAB).toContain("30.00 USD");
  expect(aliceAB).toMatch(/owes you/i); // Alice is owed (she entered credit 50 − debt 20)

  // Bob opens the SAME sheet (his only account) and decrypts it via the granted shared key.
  // A just-granted partner's first query can race the deposit's propagation, so re-open until it lands.
  let bobSheetAB = await openSheet(bob);
  expect(bobSheetAB).toBe(sheetAB);
  let bobAB = await balancesText(bob);
  for (let i = 0; i < 12 && !bobAB.includes("30.00 USD"); i++) {
    await bob.waitForTimeout(2500);
    bobSheetAB = await openSheet(bob); // fresh actor + re-fetch
    bobAB = await balancesText(bob);
  }
  console.log("[bob AB]", bobAB);
  expect(bobAB).toContain("30.00 USD"); // cross-user E2E: same net from the shared sheet
  expect(bobAB).toMatch(/you owe/i); // the MIRROR (fix #2): Bob owes Alice — not "owes you"
  await expect(bob.getByText("Bob repaid lunch")).toBeVisible(); // Bob sees Alice's entry

  // ── Pair 2: Alice & Carol (sheet "Trip") ─────────────────────────────────
  const sheetAC = await createAccount(alice, "Alice & Carol", "Trip");
  const linkAC = await inviteLinkFromSheet(alice);
  await acceptInvite(carol, linkAC);
  await openSheet(alice, "Alice & Carol");
  await addEntry(alice, { currency: "EUR", amount: 100, direction: "credit", type: "iou", note: "Carol owes for flights" });
  console.log("[alice AC]", await balancesText(alice));

  // ── Pair 3: Bob & Carol (sheet "Groceries") ──────────────────────────────
  const sheetBC = await createAccount(bob, "Bob & Carol", "Groceries");
  const linkBC = await inviteLinkFromSheet(bob);
  await acceptInvite(carol, linkBC);
  await openSheet(bob, "Bob & Carol");
  await addEntry(bob, { currency: "GBP", amount: 15, direction: "debt", type: "settlement", note: "Bob owes Carol" });

  // Three distinct sheets across three users.
  expect(new Set([sheetAB, sheetAC, sheetBC]).size).toBe(3);

  // Alice is a member of two accounts (multiple sheets per user).
  await alice.goto("/pairs");
  await expect(alice.getByText("Alice & Bob")).toBeVisible();
  await expect(alice.getByText("Alice & Carol")).toBeVisible();

  // ── Fix #1: a fresh deep-link / refresh of a guarded page must NOT bounce to /pairs ──────
  // (guards now redirect only when definitively anonymous, never during auth "loading").
  await alice.goto(`/sheet/${sheetAB}`);
  await expect(alice).toHaveURL(new RegExp(`/sheet/${sheetAB}$`));
  await expect(alice.getByRole("heading", { name: "Balances" })).toBeVisible();
  await alice.goto("/pair/new"); // a redirect-guarded page
  await expect(alice).toHaveURL(/\/pair\/new$/);
  await expect(alice.getByRole("heading", { name: "New account" })).toBeVisible();

  // ── Multiple chats: Alice links two chats to two different sheets ─────────
  await linkChatToSheet(alice, "group:aaaaa-aa", "Rent 2026");
  await linkChatToSheet(alice, "group:2vxsx-fae", "Trip");

  await aliceCtx.close();
  await bobCtx.close();
  await carolCtx.close();
});
