// UI E2E for two features the user asked to cover:
//   1. USERNAME (global, auto-published): a user sets one username in Settings and it
//      publishes EAGERLY as their member name to every EXISTING account — the partner
//      immediately sees "manager" instead of a principal prefix. This drives the real
//      Settings → publishUsernameToAllPairs → set_member_name → decryptName path.
//   2. CLOSE & START NEW SHEET: archive a sheet, carry the outstanding balance forward
//      to a fresh sheet, and confirm it PERSISTS across a full page reload (close & restart).
//
// Two isolated contexts = two dev identities (owner, manager), one shared account.

import { test, expect } from "@playwright/test";
import {
  signInDev,
  createAccount,
  inviteLinkFromSheet,
  acceptInvite,
  openSheet,
  addEntry,
  balancesText,
  setUsername,
  closeAndStartNewSheet,
} from "./flows";

test("username eager-publishes to an existing account · close & start carries balance forward + persists", async ({
  browser,
}) => {
  const ownerCtx = await browser.newContext();
  const managerCtx = await browser.newContext();
  const owner = await ownerCtx.newPage();
  const manager = await managerCtx.newPage();

  await signInDev(owner);
  await signInDev(manager);
  await setUsername(owner, "owner"); // owner names himself up front (0 pairs yet)

  // ── Shared account: owner creates "Owner & Manager", manager accepts the invite link ──
  const sheet1 = await createAccount(owner, "Owner & Manager", "August 2026");
  const link = await inviteLinkFromSheet(owner);
  await acceptInvite(manager, link); // manager is IN immediately — no owner grant step

  // Manager (still UNNAMED) posts rent the owner is owed. Accepting the invite already gave
  // the manager key access. The manager JOINED, so their card isn't labeled with the
  // owner-set account name — open their sole account with no filter.
  await openSheet(manager);
  await addEntry(manager, {
    currency: "EGP",
    amount: 25000,
    direction: "debt", // manager holds the owner's money → manager owes owner
    type: "iou",
    note: "Reservation collected",
  });

  // Owner opens the shared sheet: sees the 25000 net. The manager is still unnamed here,
  // so the balance line shows a principal prefix (…) — capture it to prove the name later.
  let owned = await openSheet(owner, "Owner & Manager");
  expect(owned).toBe(sheet1);
  let owed = await balancesText(owner);
  for (let i = 0; i < 12 && !/25000\.00 EGP/.test(owed); i++) {
    await owner.waitForTimeout(2500);
    await openSheet(owner, "Owner & Manager");
    owed = await balancesText(owner);
  }
  expect(owed).toContain("25000.00 EGP");
  expect(owed).toMatch(/owes you/i); // owner is owed
  console.log("[owner, manager unnamed]", owed);

  // ── Feature 1: manager sets a global username AFTER the account exists ──
  // This is the eager path: publishUsernameToAllPairs loops the manager's pairs and
  // set_member_name's "manager" onto THIS already-existing sheet.
  await setUsername(manager, "manager");
  // Belt-and-suspenders: re-opening the sheet also ensures the member_name is published
  // (SheetPage lazily publishes prefs.profileName if not yet set) — so the name is on the
  // pair even if the eager publish raced the just-granted key propagation.
  await openSheet(manager);

  // Owner re-opens: the partner name now resolves to "manager" (decrypted member_name),
  // not a principal prefix. This only holds if the name reached the existing pair. Keep
  // re-opening (fresh decrypt) until BOTH the amount and the name appear — a re-opened
  // sheet can momentarily render its pre-decrypt empty state, so don't latch onto that.
  let named = "";
  for (let i = 0; i < 20; i++) {
    await openSheet(owner, "Owner & Manager");
    await owner.waitForTimeout(600); // let entries + names decrypt before reading
    named = await balancesText(owner);
    if (/manager owes you/i.test(named) && /25000\.00 EGP/.test(named)) break;
    await owner.waitForTimeout(2000);
  }
  console.log("[owner, manager named]", named);
  expect(named).toMatch(/manager owes you/i);
  expect(named).toContain("25000.00 EGP");

  // ── Feature 2: owner closes the sheet & starts a new one ──
  const sheet2 = await closeAndStartNewSheet(owner);
  expect(sheet2).not.toBe(sheet1);

  // The outstanding 25000 EGP is carried forward as an opening entry on the new sheet —
  // and CRUCIALLY in the same DIRECTION: the owner was owed, so the owner is STILL owed
  // ("… owes you"), never "You owe". (Before the fix, close-&-start computed the closing
  // balance from raw author-relative payloads and flipped the sign for partner-authored
  // entries, so the owner wrongly became the debtor.) The manager hasn't opened the new
  // sheet yet, so their name isn't published there — match the orientation, not the name.
  let carried = await balancesText(owner);
  for (let i = 0; i < 8 && !/25000\.00 EGP/.test(carried); i++) {
    await owner.waitForTimeout(2000);
    carried = await balancesText(owner);
  }
  console.log("[owner, new sheet carried-forward]", carried);
  expect(carried).toContain("25000.00 EGP");
  expect(carried).toMatch(/owes you/i); // owner still OWED
  expect(carried).not.toMatch(/You owe/i); // …never flipped to owner owing
  await expect(owner.getByText(/Carried forward/i)).toBeVisible();

  // ── Close & restart: a full reload of the new sheet keeps the carried-forward balance ──
  // A fresh reload has an empty in-memory key cache, so SheetPage must unwrapFor(sheet2) and
  // decrypt before the balance renders — the "Balances" heading paints first, so poll.
  await owner.goto(`/sheet/${sheet2}`, { waitUntil: "domcontentloaded" });
  await expect(owner.getByRole("heading", { name: "Balances" })).toBeVisible();
  let persisted = "";
  for (let i = 0; i < 15; i++) {
    persisted = await balancesText(owner);
    if (/25000\.00 EGP/.test(persisted)) break;
    await owner.waitForTimeout(2000);
  }
  console.log("[owner, after reload of new sheet]", persisted);
  expect(persisted).toContain("25000.00 EGP"); // carried-forward balance survives a full reload
  expect(persisted).toMatch(/owes you/i); // …and keeps the correct direction after reload
  expect(persisted).not.toMatch(/You owe/i);

  // The old sheet is archived, not gone — the account still lists (now pointing at sheet2).
  await owner.goto("/pairs");
  await expect(owner.getByText("Owner & Manager")).toBeVisible();

  await ownerCtx.close();
  await managerCtx.close();
});
