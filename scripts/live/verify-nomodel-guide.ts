// Live verification of Issue 1 (no-model guide) for REAL users: with NO on-device model and the test
// seam OFF, proposing must show a "select an on-device model" toast and NEVER a raw JSON prompt.
import { chromium } from "@playwright/test";
let failures = 0;
function check(c: boolean, l: string) { console.log(`${c ? "✅" : "❌"} ${l}`); if (!c) failures++; }
async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9241");
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await p.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 15000 });
  await p.waitForTimeout(2500);
  // Seam OFF + confirm no model.
  const canInfer = await p.evaluate(`(async () => { localStorage.removeItem("oc:manualExtract"); return (await import('/src/utils/onDeviceInference.ts')).canInferOnDevice(); })()`);
  check(canInfer === false, `manager has no on-device model (canInfer=${canInfer})`);
  let dialogFired = false;
  p.on("dialog", (d) => { dialogFired = true; void d.dismiss().catch(() => {}); });
  let toast = false;
  const poll = (async () => { for (let i=0;i<40 && !toast;i++){ await p.waitForTimeout(400); const t = await p.evaluate(`document.body.innerText`); if (/on-device model|select.*model/i.test(t)) toast = true; } })();
  const nonce = Date.now()%100000;
  const composer = p.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 }); await p.keyboard.type(`guide ${nonce}: paid 50 usd`); await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);
  const bubble = p.locator(".bubble-wrapper").last();
  await bubble.hover().catch(() => {}); await p.waitForTimeout(400);
  await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(() => {});
  await p.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(() => {});
  await poll;
  check(!dialogFired, "NO raw JSON prompt appeared (seam off)");
  check(toast, "the 'select an on-device model' guide toast fired");
  if (failures > 0) { console.error(`\nNO-MODEL GUIDE VERIFY FAILED — ${failures}`); process.exit(1); }
  console.log("\n🏁 NO-MODEL GUIDE LIVE VERIFY PASSED: no JSON box, guide toast shown");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
