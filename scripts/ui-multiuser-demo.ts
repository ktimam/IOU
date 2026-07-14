// Persistent multi-user demo: opens one real Chromium WINDOW per user (Alice, Bob,
// Carol), signs each in as a distinct dev identity, and sets up multiple pairs /
// sheets / entries + chat links through the real UI — then LEAVES the windows open
// so you can click around as each user. Ctrl-C to close.
//
//   pnpm ui:demo        (dev server must be running: pnpm dev → http://127.0.0.1:3000)
//
// Each user gets a persistent Chromium profile under .pw-profiles/<user> (gitignored),
// wiped at start for a clean run. Reuses the shared flow helpers the UI spec uses.

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  signInDev,
  createAccount,
  readInviteFromSheet,
  joinAccount,
  grantPartnerAccess,
  openSheet,
  addEntry,
  linkChatToSheet,
  balancesText,
} from "../test/ui/flows";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILES = path.resolve(HERE, "..", ".pw-profiles");
const BASE = "http://127.0.0.1:3000";

async function windowFor(user: string, x: number): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await chromium.launchPersistentContext(path.join(PROFILES, user), {
    headless: false,
    baseURL: BASE,
    viewport: { width: 720, height: 900 },
    args: [`--window-position=${x},0`, "--window-size=730,940"],
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  return { ctx, page };
}

/** Open a partner's shared sheet, retrying until the just-granted deposit propagates. */
async function openSharedSheet(page: Page, expectAmount: string): Promise<void> {
  await openSheet(page);
  for (let i = 0; i < 5 && !(await balancesText(page)).includes(expectAmount); i++) {
    await page.waitForTimeout(2500);
    await openSheet(page);
  }
}

async function main() {
  rmSync(PROFILES, { recursive: true, force: true });
  const alice = await windowFor("alice", 0);
  const bob = await windowFor("bob", 740);
  const carol = await windowFor("carol", 1480);

  console.log("Signing in Alice, Bob, Carol…");
  await signInDev(alice.page);
  await signInDev(bob.page);
  await signInDev(carol.page);

  // Pair 1: Alice & Bob
  console.log("Pair 1: Alice & Bob (Rent 2026)…");
  await createAccount(alice.page, "Alice & Bob", "Rent 2026");
  const { code: codeAB } = await readInviteFromSheet(alice.page);
  await joinAccount(bob.page, codeAB);
  await grantPartnerAccess(alice.page, "Alice & Bob");
  await openSheet(alice.page, "Alice & Bob");
  await addEntry(alice.page, { currency: "USD", amount: 50, direction: "credit", type: "settlement", note: "Bob repaid lunch" });
  await addEntry(alice.page, { currency: "USD", amount: 20, direction: "debt", type: "iou", note: "Alice owes Bob (later)" });
  await openSharedSheet(bob.page, "USD"); // Bob decrypts the shared sheet

  // Pair 2: Alice & Carol
  console.log("Pair 2: Alice & Carol (Trip)…");
  await createAccount(alice.page, "Alice & Carol", "Trip");
  const { code: codeAC } = await readInviteFromSheet(alice.page);
  await joinAccount(carol.page, codeAC);
  await grantPartnerAccess(alice.page, "Alice & Carol");
  await openSheet(alice.page, "Alice & Carol");
  await addEntry(alice.page, { currency: "EUR", amount: 100, direction: "credit", type: "iou", note: "Carol owes for flights" });

  // Pair 3: Bob & Carol
  console.log("Pair 3: Bob & Carol (Groceries)…");
  await createAccount(bob.page, "Bob & Carol", "Groceries");
  const { code: codeBC } = await readInviteFromSheet(bob.page);
  await joinAccount(carol.page, codeBC);
  await grantPartnerAccess(bob.page, "Bob & Carol");
  await openSheet(bob.page, "Bob & Carol");
  await addEntry(bob.page, { currency: "GBP", amount: 15, direction: "debt", type: "settlement", note: "Bob owes Carol" });

  // Multiple chats: Alice links two chats to two sheets.
  console.log("Linking chats…");
  await linkChatToSheet(alice.page, "group:aaaaa-aa", "Rent 2026");
  await linkChatToSheet(alice.page, "group:2vxsx-fae", "Trip");

  // Leave each window on an interesting page for inspection.
  await openSheet(alice.page, "Alice & Bob"); // Alice: the shared AB sheet
  await bob.page.goto("/pairs"); // Bob: his two accounts (AB, BC)
  await carol.page.goto("/pairs"); // Carol: her two accounts (AC, BC)

  console.log(
    "\n✅ Demo ready — 3 users, 3 sheets, entries, 2 chat links.\n" +
      "   Windows: Alice (left), Bob (middle), Carol (right). Click around as each user.\n" +
      "   Press Ctrl-C in this terminal to close the windows.\n",
  );
  await new Promise<void>(() => {}); // keep the process (and windows) alive
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
