// P2: the JOINER (member_b) — not the account creator — closes & rotates the sheet. CloseSheetButton
// renders for ANY authenticated member on an active sheet with >=1 entry, so a joiner can rotate too.
// When member_b creates the new sheet, their own slot is a SELF-wrap and the creator's slot is a
// TAGGED cross-wrap — so both members read the carried-forward balance, each in the correct direction.

import { test, expect } from "@playwright/test";
import {
  signInDev,
  createAccount,
  inviteLinkFromSheet,
  acceptInvite,
  openSheet,
  addEntry,
  balancesText,
  closeAndStartNewSheet,
} from "./flows";

test("the JOINER (member_b) can close & rotate; carry-forward mirrors on both sides", async ({ browser }) => {
  const ownerCtx = await browser.newContext();
  const managerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const manager = await managerCtx.newPage();
  await signInDev(owner);
  await signInDev(manager);

  const sheet1 = await createAccount(owner, "Owner & Joiner", "Aug 2026");
  const link = await inviteLinkFromSheet(owner);
  await acceptInvite(manager, link);

  // The JOINER adds an entry: the manager owes the owner.
  await openSheet(manager);
  await addEntry(manager, { currency: "EGP", amount: 25000, direction: "debt", type: "iou", note: "collected" });

  // Owner opens once so their side registers the balance.
  await openSheet(owner, "Owner & Joiner");

  // ── The JOINER closes & starts a new sheet (member_b initiates the rotation) ──
  const managerSheet = await openSheet(manager);
  expect(managerSheet).toBe(sheet1);
  // Wait for the entry to load/decrypt — "Close & start new" is disabled on an empty sheet, so
  // clicking before entries render would no-op.
  let preBal = "";
  for (let i = 0; i < 12 && !/25000\.00 EGP/.test(preBal); i++) {
    await manager.waitForTimeout(2000);
    preBal = await balancesText(manager);
  }
  expect(preBal).toContain("25000.00 EGP");
  const sheet2 = await closeAndStartNewSheet(manager);
  expect(sheet2).not.toBe(sheet1);

  // The joiner-closer reads the carry-forward on the new sheet (their slot is a self-wrap).
  let carried = "";
  for (let i = 0; i < 12 && !/25000\.00 EGP/.test(carried); i++) {
    await manager.waitForTimeout(2000);
    carried = await balancesText(manager);
  }
  console.log("[joiner-closer, new sheet]", carried);
  expect(carried).toContain("25000.00 EGP");
  expect(carried).toMatch(/you owe/i); // manager still owes
  await expect(manager.getByText(/Carried forward/i)).toBeVisible();

  // The OWNER (member_a) reads the SAME new sheet via the tagged cross-wrap the joiner sealed for
  // them — the exact mirror ("owes you").
  let ownerMirror = "";
  for (let i = 0; i < 15; i++) {
    await openSheet(owner, "Owner & Joiner");
    await owner.waitForTimeout(600);
    ownerMirror = await balancesText(owner);
    if (/25000\.00 EGP/.test(ownerMirror) && /owes you/i.test(ownerMirror)) break;
    await owner.waitForTimeout(2000);
  }
  console.log("[owner, mirror after joiner close]", ownerMirror);
  expect(ownerMirror).toContain("25000.00 EGP");
  expect(ownerMirror).toMatch(/owes you/i); // owner is owed

  await ownerCtx.close();
  await managerCtx.close();
});
