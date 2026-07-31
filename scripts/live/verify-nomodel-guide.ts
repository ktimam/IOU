// Live verification of the no-model guide, for BOTH ways a propose can find itself without a model:
//
//   A. The seam is OFF — every real user. A guide toast, and never a raw JSON box.
//   B. The seam is ON but its prompt yields nothing — a dev who cancels it, a profile carrying a
//      stale `oc:manualExtract` from an earlier harness run, or a browser suppressing repeat
//      dialogs. Still a toast.
//
// B is the one that was reported ("i choose propose to iou, no error is shown and it does nothing")
// and the one A could never catch: the old code checked the seam FIRST and only showed the guide
// when it was off, so with the seam on a null prompt fell straight through to a bare `return` —
// no card, no toast, nothing. A had passed the whole time.
import { chromium, type Page } from "@playwright/test";

const GUIDE = /on-device model/i;

let failures = 0;
function check(c: boolean, l: string) {
  console.log(`${c ? "✅" : "❌"} ${l}`);
  if (!c) failures++;
}

async function bodyText(p: Page) {
  return (await p.evaluate(() => document.body.innerText)) as string;
}

/** Wait out any toast still on screen, so the next phase can't read the previous one. */
async function waitForToastToClear(p: Page) {
  for (let i = 0; i < 40; i++) {
    if (!GUIDE.test(await bodyText(p))) return;
    await p.waitForTimeout(500);
  }
}

/** Fire "Propose action" on the newest message and report whether the guide toast appeared. */
async function proposeAndWatch(p: Page) {
  const bubble = p.locator(".bubble-wrapper").last();
  await bubble.hover().catch(() => {});
  await p.waitForTimeout(400);
  await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(() => {});
  await p.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await p.waitForTimeout(400);
    if (GUIDE.test(await bodyText(p))) return true;
  }
  return false;
}

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9241");
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await p
    .locator(".chat-summary, .chat_summary")
    .filter({ hasText: /father/i })
    .first()
    .click({ timeout: 15000 });
  await p.waitForTimeout(2500);

  const canInfer = await p.evaluate(
    `(async () => { localStorage.removeItem("oc:manualExtract"); return (await import('/src/utils/onDeviceInference.ts')).canInferOnDevice(); })()`,
  );
  check(canInfer === false, `this profile has no on-device model (canInfer=${canInfer})`);

  // A real dialog would mean a raw JSON box reached a user with the seam off.
  let dialogFired = false;
  p.on("dialog", (d) => {
    dialogFired = true;
    void d.dismiss().catch(() => {});
  });

  const nonce = Date.now() % 100000;
  const composer = p.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 });
  await p.keyboard.type(`guide ${nonce}: paid 50 usd`);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(2500);

  // ---- A. seam OFF: the real-user path.
  check(await proposeAndWatch(p), "[seam off] the guide toast fired");
  check(!dialogFired, "[seam off] NO raw JSON prompt appeared");
  await waitForToastToClear(p);

  // ---- B. seam ON, prompt yields nothing: cancelled, or never shown at all.
  await p.evaluate(() => {
    localStorage.setItem("oc:manualExtract", "1");
    // Returning null is what a Cancel gives back — and what a browser that has stopped showing
    // this page's dialogs gives back without the user seeing anything.
    window.prompt = () => null;
  });
  check(await proposeAndWatch(p), "[seam on, prompt dismissed] the guide toast still fired");

  // Leave the profile as we found it: the seam is a harness tool, not a user setting.
  await p.evaluate(() => localStorage.removeItem("oc:manualExtract"));

  if (failures > 0) {
    console.error(`\nNO-MODEL GUIDE VERIFY FAILED — ${failures}`);
    process.exit(1);
  }
  console.log("\n🏁 NO-MODEL GUIDE LIVE VERIFY PASSED: never silent, never a JSON box");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
