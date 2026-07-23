// AUTOMATED live verification of DEFAULT CURRENCY (Issue 3):
//   a message with NO currency now (a) POSTS a card — previously OpenChat's gate required currency and
//   dropped it (live 2026-07-23: "paid 120 for groceries" → no card) — and (b) imports into IOU using
//   the user's default currency (prefs.defaultCurrency, "USD" unless changed).
//
// Manual seam supplies a deterministic no-currency extraction. Roles: proposer manager (v1 :9241),
// confirmer father (OC :9222, IOU :9231). Prereq: manager↔father paired + the chat linked to a sheet
// (journey-fanout.ts establishes both).  pnpm exec tsx scripts/live/verify-default-currency.ts
import { chromium, type Page } from "@playwright/test";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

const connections = new Map<number, ReturnType<typeof chromium.connectOverCDP>>();
async function attach(port: number, urlPart: string): Promise<Page> {
  if (!connections.has(port)) connections.set(port, chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const ctx = (await connections.get(port)!).contexts()[0];
  return ctx.pages().find((p) => p.url().includes(urlPart)) ?? ctx.pages()[0];
}

async function main() {
  const managerOC = await attach(9241, "localhost:5003");
  const fatherOC = await attach(9222, "localhost:5003");
  const fatherIOU = await attach(9231, "127.0.0.1:3000");

  // Open the manager↔father DM on both OC sides; resolve manager's id (the chat key on father's side).
  await managerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await managerOC.waitForTimeout(3000);
  await managerOC.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 15000 });
  await managerOC.waitForTimeout(2500);
  await fatherOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await fatherOC.waitForTimeout(3000);
  await fatherOC.locator(".chat-summary, .chat_summary").filter({ hasText: /manager/i }).first().click({ timeout: 15000 });
  await fatherOC.waitForTimeout(2500);
  const managerId = /user\/([a-z0-9-]+)/.exec(fatherOC.url())?.[1];
  check(!!managerId, `manager user id resolved on father's side (${managerId})`);

  // Propose a NO-CURRENCY extraction via the manual seam.
  await managerOC.evaluate(`localStorage.setItem("oc:manualExtract","1")`);
  const nonce = Date.now() % 100000;
  const note = `nocur ${nonce}`;
  const extraction = JSON.stringify({ kind: "iou", amount: 120, direction: "credit", note });
  const handler = (d: import("@playwright/test").Dialog) => {
    void d.accept(/JSON/i.test(d.message()) ? extraction : "1").catch(() => {});
  };
  managerOC.on("dialog", handler);
  const composer = managerOC.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 });
  await managerOC.keyboard.type(`${note}: paid 120 for groceries`);
  await managerOC.keyboard.press("Enter");
  await managerOC.waitForTimeout(2500);

  const card = fatherOC.locator(".action-card").filter({ hasText: note }).last();
  const confirmBtn = card.locator("button").filter({ hasText: /^(Add to IOU|Confirm)$/i });
  let posted = false;
  for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
    const bubble = managerOC.locator(".bubble-wrapper").last();
    await bubble.hover().catch(() => {});
    await managerOC.waitForTimeout(400);
    await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(() => {});
    await managerOC.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(() => {});
    posted = await confirmBtn.waitFor({ timeout: 25000 }).then(() => true).catch(() => false);
    if (!posted) await managerOC.keyboard.press("Escape").catch(() => {});
  }
  managerOC.off("dialog", handler);
  check(posted, "a NO-CURRENCY message POSTS a card (currency no longer required at the gate)");
  if (!posted) throw new Error("no-currency card never posted — the manifest gate still blocks it");

  // Confirm on father's OC side (one deposit).
  await card.locator('input[type="checkbox"]').check({ timeout: 15000 }).catch(() => {});
  await confirmBtn.click();
  await fatherOC.waitForTimeout(6000);

  // Father's IOU: open the linked sheet, import the card, and assert the entry defaults to USD.
  const chatKey = `direct:${managerId}`;
  const linkedSheet = (await fatherIOU.evaluate((key: string) => {
    try {
      return (JSON.parse(localStorage.getItem("iou.openchat.chatSheetLinks.v1") || "{}") as Record<string, string>)[key] ?? null;
    } catch {
      return null;
    }
  }, chatKey)) as string | null;
  check(!!linkedSheet, `manager chat linked to a sheet (${linkedSheet})`);
  if (!linkedSheet) throw new Error("link the chat to a sheet first (journey-fanout establishes it)");

  const card2 = fatherIOU.locator("li").filter({ hasText: new RegExp(note) }).first();
  let sawCard = false;
  for (let i = 0; i < 12 && !sawCard; i++) {
    await fatherIOU.goto(`http://127.0.0.1:3000/sheet/${linkedSheet}`, { waitUntil: "domcontentloaded" });
    await fatherIOU.waitForTimeout(4000);
    sawCard = await card2.isVisible().catch(() => false);
  }
  check(sawCard, `the no-currency card reached IOU's pending list ("${note}")`);
  if (sawCard) {
    // Single entry → the EntryForm (openAdd) flow. Its currency field must be pre-filled with the
    // default (USD). Import → confirm → assert the entry lands with USD.
    await card2.getByRole("button", { name: /Review & add/ }).click({ timeout: 10000 });
    await fatherIOU.waitForTimeout(1500);
    const curVal = await fatherIOU.locator('label:has(span:text-is("Currency")) select').first().inputValue().catch(() => "");
    check(/^USD$/i.test(curVal.trim()), `the EntryForm currency defaults to USD (got "${curVal}")`);
    await fatherIOU.getByRole("button", { name: /^Add entry$/ }).click({ timeout: 10000 });
    await fatherIOU.waitForTimeout(4000);
    const hist = (await fatherIOU.locator("section.history, .history").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    check(new RegExp(note).test(hist) && /USD/.test(hist), `the entry landed with USD in history`);
  }

  if (failures > 0) {
    console.error(`\nDEFAULT-CURRENCY VERIFY FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 DEFAULT-CURRENCY LIVE VERIFY PASSED: no-currency message → card posts → imports as USD");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
