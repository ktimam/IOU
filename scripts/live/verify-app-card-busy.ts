// Live proof of the processing/busy state: while a confirm round-trips (deposit + fan-out), the
// app-card's in-frame buttons LOCK and show progress ("Adding…" + spinner), driven by OpenChat's
// generic oc:card:busy relay; then the card settles (leaves the pending set).
//
// Drives an EXISTING pending app-card in the manager↔father chat (no fresh propose needed — the busy
// relay is card-agnostic): click its confirm button → within the round-trip window assert the primary
// button reads "Adding…" and BOTH buttons are disabled → the actionable-card count drops by one
// (the confirm completed and the card is consumed). Manager OC :9241. Exit 1 on any failure.
import { chromium, type Page, type FrameLocator } from "@playwright/test";

let failures = 0;
function check(c: boolean, l: string): void { console.log(`${c ? "✅" : "❌"} ${l}`); if (!c) failures++; }

async function ocPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
}

const CONFIRM_RE = /Add to IOU|Add all \d+ entries/i;

// Every open app-card iframe whose confirm button is present AND enabled (i.e. pending + actionable).
async function actionableFrames(p: Page): Promise<FrameLocator[]> {
  const out: FrameLocator[] = [];
  for (const c of await p.locator(".action-card:not(.collapsed):has(iframe)").all()) {
    const f = c.frameLocator("iframe");
    const btn = f.getByRole("button", { name: CONFIRM_RE });
    if (!(await btn.count().catch(() => 0))) continue;
    if (await btn.first().isDisabled().catch(() => true)) continue;
    out.push(f);
  }
  return out;
}

async function main() {
  const oc = await ocPage(9241);
  // Reload so every card re-renders with the current ActionCardContent bundle (the oc:card:busy relay).
  await oc.reload({ waitUntil: "domcontentloaded" }); await oc.waitForTimeout(3000);
  await oc.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }); await oc.waitForTimeout(2500);
  await oc.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 12000 });
  await oc.waitForTimeout(2500);

  const beforePending = (await actionableFrames(oc)).length;
  check(beforePending > 0, `at least one pending actionable app-card exists to drive (${beforePending})`);
  if (beforePending === 0) { process.exit(1); }

  // Target the first pending card's frame + its confirm/cancel buttons.
  const frame = (await actionableFrames(oc))[0];
  const confirmBtn = frame.getByRole("button", { name: CONFIRM_RE });
  const cancelBtn = frame.getByRole("button", { name: /^Cancel$/i });
  check(!(await confirmBtn.isDisabled().catch(() => true)), "the confirm button is enabled before the click");

  // Click, then IMMEDIATELY poll the round-trip window: the primary button reads "Adding…" and BOTH
  // buttons are disabled (the press is acknowledged and can't be double-fired).
  await confirmBtn.click({ timeout: 10000 });
  let sawAdding = false, sawLocked = false;
  for (let i = 0; i < 25 && !(sawAdding && sawLocked); i++) {
    const body = await frame.locator("body").innerText().catch(() => "");
    if (/Adding/i.test(body)) sawAdding = true;
    const addingDisabled = await frame.getByRole("button", { name: /Adding/i }).isDisabled().catch(() => false);
    const cancelDisabled = await cancelBtn.isDisabled().catch(() => false);
    if (addingDisabled && cancelDisabled) sawLocked = true;
    if (sawAdding && sawLocked) break;
    await oc.waitForTimeout(100);
  }
  check(sawAdding, "the primary button shows 'Adding…' while the confirm round-trips");
  check(sawLocked, "BOTH buttons are disabled during processing (no double-fire)");

  // Completion: the confirmed card leaves the actionable set (consumed → readonly), so the count drops.
  let afterPending = beforePending;
  for (let i = 0; i < 12 && afterPending >= beforePending; i++) {
    await oc.waitForTimeout(1500);
    afterPending = (await actionableFrames(oc)).length;
  }
  check(afterPending === beforePending - 1, `the confirm completed — actionable cards ${beforePending} → ${afterPending} (card consumed)`);

  if (failures > 0) { console.error(`\nBUSY-STATE VERIFY FAILED — ${failures}`); process.exit(1); }
  console.log(`\n🏁 PROCESSING STATE: click → buttons lock + 'Adding…' spinner during the round-trip → card consumed`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
