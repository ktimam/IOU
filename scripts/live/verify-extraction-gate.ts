// Live verification of the extraction-viability gate (manual-JSON path, manager v1 :9241):
//   1. Propose on a fresh message answering the manual dialog with amount 0 — the app-declared
//      schema (required amount, exclusiveMinimum 0) must yield no_extraction: NO card posts and
//      the "found no action" toast fires.
//   2. Positive control: same flow with amount 350 → the card DOES post.
// Exit 1 on any failed assertion. Requires the live env + the enriched manifest registered.
import { chromium, type Page } from "@playwright/test";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function propose(p: Page, text: string, extraction: string): Promise<void> {
  const handler = (d: import("@playwright/test").Dialog) => {
    const reply = /JSON/i.test(d.message()) ? extraction : "1";
    void d.accept(reply).catch(() => {});
  };
  p.on("dialog", handler);
  const composer = p.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 });
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  // v1 propose (proven journey pattern): hover the just-sent bubble (it is the LAST one), then the
  // revealed .menu-icon, then the "Propose action" menu item.
  const bubble = p.locator(".bubble-wrapper").last();
  await bubble.scrollIntoViewIfNeeded().catch(() => {});
  await bubble.hover();
  await p.waitForTimeout(400);
  await bubble.locator(".menu-icon").first().click({ timeout: 12000 });
  await p.waitForTimeout(800);
  await p.getByText("Propose action", { exact: true }).click({ timeout: 12000 });
  await p.waitForTimeout(4000); // extraction dialog answered by the handler above
  p.off("dialog", handler);
}

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9241");
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); // fresh manifest fetch
  await p.waitForTimeout(3000);
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await p.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 15000 });
  await p.waitForTimeout(2500);

  // Issue 1 test seam: opt into the deterministic manual-JSON prompt (real users with no on-device
  // model are guided to model setup instead). Must be set before the first propose.
  await p.evaluate(`localStorage.setItem("oc:manualExtract","1")`);

  const cards = () => p.locator(".action-card").count();
  const nonce = Date.now() % 100000;

  // ── 1. Degenerate manual extraction: amount 0 → no card, "found no action" toast ─────────
  const before = await cards();
  let sawToast = false;
  const pollToast = async (iterations: number) => {
    for (let i = 0; i < iterations && !sawToast; i++) {
      await p.waitForTimeout(400);
      const t = (await p.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`)) as string;
      if (/found no action/i.test(t)) sawToast = true;
    }
  };
  const during = pollToast(60); // concurrent with the ~11s propose flow
  await propose(
    p,
    `gate check ${nonce}: hello there`,
    JSON.stringify({ kind: "settlement", amount: 0, currency: "USD", note: "gate" }),
  );
  await during;
  await pollToast(10); // and a beat after, in case the toast lags the dialog answer
  const afterZero = await cards();
  check(afterZero === before, `amount-0 manual extraction posts NO card (${before} → ${afterZero})`);
  check(sawToast, "the 'found no action' toast fired for the rejected extraction");

  // ── 2. Positive control: amount 350 → the card posts ─────────────────────────────────────
  await propose(
    p,
    `gate check pos ${nonce}: cleaning fee 350 EGP`,
    JSON.stringify({ kind: "iou", amount: 350, currency: "EGP", direction: "credit", note: `gatecheck-pos ${nonce}` }),
  );
  let afterPos = await cards();
  for (let i = 0; i < 10 && afterPos <= before; i++) {
    await p.waitForTimeout(1500);
    afterPos = await cards();
  }
  check(afterPos > before, `amount-350 manual extraction posts the card (${before} → ${afterPos})`);

  if (failures > 0) {
    console.error(`\nGATE VERIFY FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 EXTRACTION-VIABILITY GATE LIVE VERIFY PASSED (0 blocked, 350 posted)");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
