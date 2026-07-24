// AUTOMATED live verification of DEFAULT CURRENCY (Issue 3) under the APP-RENDERED card:
//   a message with NO currency (a) still POSTS a card — the gate no longer requires currency — and
//   (b) the app card DEFERS the currency to the user's IOU default instead of inventing one. The
//   card iframe is storage-partitioned and cannot read prefs.defaultCurrency, so it must show the
//   "Default currency" option ("") and DEPOSIT a draft with NO currency; the real IOU app fills the
//   default (baseWithDefaultCurrency) at import. This proves the app-card migration did not regress
//   Issue 3 for non-USD users (a hardcoded USD in the card would).
//
// Manual seam supplies a deterministic no-currency extraction. Proposer+confirmer manager (v1 :9241);
// deposit read on father IOU :9231 (fan-out gives both members the envelope). Exit 1 on any failure.
//   pnpm exec tsx scripts/live/verify-default-currency.ts
import { chromium, type Page } from "@playwright/test";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function ocPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
}
async function iouPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return b.contexts()[0].pages().find((x) => x.url().includes("3000"))!;
}
async function inboxDrafts(p: Page): Promise<Record<string, unknown>[]> {
  await p.goto("http://127.0.0.1:3000/pairs", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2000);
  return (await p.evaluate(`(async () => {
    const inbox = await import('/src/features/openchat/actionInboxClient.ts');
    const cfg = await inbox.getActionInboxConfig();
    return (await inbox.pollActionInbox({ config: cfg, maxResults: 80 })).map(d => d.draft);
  })()`)) as Record<string, unknown>[];
}

async function main() {
  const oc = await ocPage(9241);
  const fatherIou = await iouPage(9231);

  // Fresh code + no model + manual seam.
  await oc.evaluate(`(async () => { try { const w = await import('/src/utils/webInference.ts'); if (w.clearWebModel) await w.clearWebModel(); } catch {} localStorage.removeItem('openchat_web_model_url'); try{indexedDB.deleteDatabase('openchat_web_model');}catch{} localStorage.setItem('oc:manualExtract','1'); })()`).catch(() => {});
  await oc.reload({ waitUntil: "domcontentloaded" }); await oc.waitForTimeout(3000);
  await oc.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }); await oc.waitForTimeout(2500);
  await oc.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 12000 });
  await oc.waitForTimeout(2500);
  await oc.evaluate(`localStorage.setItem("oc:manualExtract","1")`);

  // 1. Propose a NO-CURRENCY extraction with a run-unique amount so the deposit is identifiable.
  const n = Date.now() % 100000;
  const uniqAmt = 130000 + n;
  const note = `nocur ${n}`;
  const ex = JSON.stringify({ kind: "iou", amount: uniqAmt, direction: "credit", note });
  const h = (d: import("@playwright/test").Dialog) => { void d.accept(/JSON/i.test(d.message()) ? ex : "1").catch(() => {}); };
  oc.on("dialog", h);
  const composer = oc.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 }); await oc.keyboard.type(`${note}: paid for groceries`); await oc.keyboard.press("Enter");
  await oc.waitForTimeout(2500);
  const bubble = oc.locator(".bubble-wrapper").last();
  await bubble.hover().catch(() => {}); await oc.waitForTimeout(400);
  await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(() => {});
  await oc.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(() => {});
  await oc.waitForTimeout(4000);
  oc.off("dialog", h);

  // 2. The no-currency message STILL posts a card (gate passes). Find THIS run's card among any stale
  //    ones by matching our unique note+amount in the iframe's input VALUES (notes/amounts live in
  //    editable inputs, not innerText) — and assert we actually found it, so a stale no-currency card
  //    can't pass the currency check by coincidence.
  await oc.waitForTimeout(2500);
  const candidates = await oc.locator(".action-card:not(.collapsed):has(iframe)").all();
  check(candidates.length > 0, "a NO-CURRENCY message POSTS a card (currency no longer required at the gate)");
  let frame: ReturnType<typeof oc.frameLocator> | null = null;
  for (const c of candidates) {
    const f = c.frameLocator("iframe");
    const inputs = f.locator("input");
    const cnt = await inputs.count().catch(() => 0);
    const vals: string[] = [];
    for (let i = 0; i < cnt; i++) vals.push(await inputs.nth(i).inputValue().catch(() => ""));
    if (vals.some((v) => v.includes(note)) && vals.some((v) => v === String(uniqAmt))) { frame = f; break; }
  }
  check(!!frame, `this run's app-card iframe found (note "${note}" + amount ${uniqAmt} in inputs)`);
  if (!frame) { process.exit(1); }

  // 3. The card DEFERS currency: its currency <select> is on "Default" ("") — it did NOT invent USD.
  const currencySelect = frame.locator("select").first();
  const curVal = await currencySelect.inputValue().catch(() => "?");
  check(curVal === "", `the card's currency defaults to "Default currency" ("") — got "${curVal}" (no invented USD)`);

  // 4. Confirm leaving currency on Default → the deposit omits currency.
  await frame.getByRole("button", { name: /Add to IOU/i }).click({ timeout: 10000 });
  await oc.waitForTimeout(6000);

  // 5. The deposited draft carries our unique amount and NO currency field (deferred to import).
  let mine: Record<string, unknown> | undefined;
  for (let i = 0; i < 8 && !mine; i++) {
    await oc.waitForTimeout(2000);
    const drafts = await inboxDrafts(fatherIou);
    mine = drafts.find((d) => Number((d as any).amount) === uniqAmt);
  }
  check(!!mine, `a deposit with amount ${uniqAmt} exists`);
  if (mine) {
    const hasCur = "currency" in mine && String((mine as any).currency ?? "").trim() !== "";
    console.log("   [deposit]", JSON.stringify(mine));
    check(!hasCur, "the deposited draft OMITS currency (the IOU app fills prefs.defaultCurrency at import)");
  }

  if (failures > 0) { console.error(`\nDEFAULT-CURRENCY VERIFY FAILED — ${failures} assertion(s)`); process.exit(1); }
  console.log("\n🏁 DEFAULT-CURRENCY (app-card): no-currency message → card posts, defers currency to the IOU default → deposit omits currency");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
