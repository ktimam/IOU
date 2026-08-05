// Persistent multi-user demo: opens one real Chromium WINDOW per user (Alice, Bob,
// Carol), signs each in as a distinct dev identity, and gives each user their own
// accounts / sheets / entries through the real UI — then
// LEAVES the windows open so you can click around as each user. Ctrl-C to close.
//
//   pnpm ui:demo        (dev server must be running: pnpm dev → http://127.0.0.1:3000)
//
// Each user gets a persistent Chromium profile under .pw-profiles/<user> (gitignored),
// wiped at start for a clean run. Setup is per-user (solo sheets), so it's robust and
// doesn't depend on cross-user grant propagation — the shared-sheet / cross-user view
// is covered by the reliable UI test (pnpm test:ui). Reuses the shared flow helpers.

import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signInDev, createAccount, addEntry, importDraft } from "../test/ui/flows";

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

async function main() {
  rmSync(PROFILES, { recursive: true, force: true });
  const alice = await windowFor("alice", 0);
  const bob = await windowFor("bob", 740);
  const carol = await windowFor("carol", 1480);

  try {
    await setup(alice, bob, carol);
    console.log(
      "\n✅ Demo ready — 3 users, multiple sheets, entries, 2 chat links.\n" +
        "   Windows: Alice (left), Bob (middle), Carol (right). Click around as each user.\n" +
        "   Press Ctrl-C in this terminal to close the windows.\n",
    );
  } catch (e) {
    console.error("\n⚠ Setup hit an error — leaving the windows open anyway so you can inspect:\n", e);
    await Promise.allSettled([alice.page.goto("/pairs"), bob.page.goto("/pairs"), carol.page.goto("/pairs")]);
  }
  await new Promise<void>(() => {}); // keep the process (and windows) alive
}

async function setup(
  alice: { page: Page },
  bob: { page: Page },
  carol: { page: Page },
) {
  console.log("Signing in Alice, Bob, Carol…");
  await signInDev(alice.page);
  await signInDev(bob.page);
  await signInDev(carol.page);

  // Each user builds their own accounts + sheets + entries. createAccount auto-creates a solo sheet
  // the creator can post to immediately, so this needs no cross-user grant.
  console.log("Alice: Rent 2026 + Trip…");
  await createAccount(alice.page, "Rent (Alice)", "Rent 2026");
  await addEntry(alice.page, { currency: "USD", amount: 50, direction: "credit", type: "settlement", note: "Roommate repaid lunch" });
  await addEntry(alice.page, { currency: "USD", amount: 20, direction: "debt", type: "iou", note: "I owe for utilities" });
  // OpenChat chat-bridge: import a draft "from chat" into the Rent sheet.
  await importDraft(alice.page, JSON.stringify({ kind: "settlement", amount: 25, currency: "USD", direction: "credit", note: "coffee (from chat)" }));
  await createAccount(alice.page, "Trip (Alice)", "Trip");
  await addEntry(alice.page, { currency: "EUR", amount: 100, direction: "credit", type: "iou", note: "Owed for flights" });

  console.log("Bob: Groceries…");
  await createAccount(bob.page, "Groceries (Bob)", "Groceries");
  await addEntry(bob.page, { currency: "GBP", amount: 15, direction: "debt", type: "settlement", note: "I owe for groceries" });
  await addEntry(bob.page, { currency: "GBP", amount: 40, direction: "credit", type: "iou", note: "Owed for concert tickets" });

  console.log("Carol: Weekend…");
  await createAccount(carol.page, "Weekend (Carol)", "Weekend");
  await addEntry(carol.page, { currency: "CHF", amount: 75, direction: "credit", type: "settlement", note: "Split the hotel" });

  // Leave each window on their accounts overview.
  await alice.page.goto("/pairs");
  await bob.page.goto("/pairs");
  await carol.page.goto("/pairs");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
