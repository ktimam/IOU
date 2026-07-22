// Live verification of the batch-7 OpenChat fixes against the running dev browsers:
//   A. v1 (manager :9241): the "On-device models" section is reachable in a BROWSER profile
//      (the stale isNativeClient gate is gone) and lists the 3 web-capable catalog models.
//   B. v2 (mother :9242): the model chooser stays visible even while a model is attached,
//      with the current model marked and the others switchable.
//   C. v2 (mother :9242): with the window resized to DESKTOP width, back-from-DM lands on the
//      chat list and stays there (no auto-reselect), and the bottom bar spans the full width.
//   D. v2 (mother :9242): "/ai" routes to the local-AI path — no bot CommandSelector, and a
//      bare "/ai" produces the "prompt required" toast instead of sending literal text.
// Exit 1 on any failed assertion.
import { chromium, type Page } from "@playwright/test";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function ocPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"));
  if (!p) throw new Error(`no :5003 tab on :${port}`);
  return p;
}

async function bodyText(p: Page): Promise<string> {
  return (await p.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`)) as string;
}

async function dismissOverlay(p: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const blocked = await p.evaluate(
      `(() => { const ov = document.querySelector('#masked_overlay'); return !!ov && ov.className.includes('visible'); })()`,
    );
    if (!blocked) break;
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(400);
    await p.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(400);
  }
}

// CDP window resize (raw mouse/layout math depends on real window size, not just the viewport).
async function setWindowWidth(p: Page, width: number, height: number): Promise<void> {
  const cdp = await p.context().newCDPSession(p);
  const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as { windowId: number };
  // Two-step: Chrome ignores width/height when combined with a state change (e.g. un-maximizing),
  // so normalize first, then size. Note Windows enforces a ~500px minimum window width.
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await cdp.send("Browser.setWindowBounds", { windowId, bounds: { width, height } });
  await cdp.detach().catch(() => {});
  await p.waitForTimeout(1200); // let the resize listeners + ResizeObserver settle
}

async function stageA_v1ModelsEntry(): Promise<void> {
  console.log("\n── A. v1 On-device models entry (manager :9241) ──");
  const p = await ocPage(9241);
  await p.goto("http://localhost:5003/communities", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  // LeftNav rail: clicking your own avatar publishes "profile" → UserProfile in the right panel.
  const avatar = p.locator(".left-nav .avatar, .nav .avatar, [class*='left'] .avatar").first();
  await avatar.click({ timeout: 10000 });
  await p.waitForTimeout(2000);
  let txt = await bodyText(p);
  check(/On-device models/i.test(txt), "v1 profile shows the 'On-device models' section (gate removed)");
  // The section is a CollapsibleCard whose open state persists — click only until the chooser shows.
  for (let i = 0; i < 2 && !/Gemma 3 1B/.test(txt); i++) {
    const section = p.getByText("On-device models", { exact: true }).first();
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await section.click({ timeout: 8000 }).catch(() => {});
    await p.waitForTimeout(1500);
    txt = await bodyText(p);
  }
  check(/Gemma 3 1B/.test(txt), "v1 chooser lists Gemma 3 1B");
  check(/Qwen2.5 1.5B/.test(txt), "v1 chooser lists Qwen2.5 1.5B");
  check(/Qwen2.5 0.5B/.test(txt), "v1 chooser lists Qwen2.5 0.5B");
  check(/Download & use \(default\)|Use this model|Current/.test(txt), "v1 chooser has actionable entries");
}

async function stageB_v2ChooserWithAttached(): Promise<void> {
  console.log("\n── B. v2 chooser stays visible with a model attached (mother :9242) ──");
  const p = await ocPage(9242);
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3500);
  await dismissOverlay(p);
  await p.locator(".bottom_bar_icon").nth(4).click({ timeout: 10000 });
  await p.waitForTimeout(1500);
  await p.locator('button:has(path[d^="M12,16A2,2"])').first().click({ timeout: 10000 }); // ⋮ menu
  await p.waitForTimeout(800);
  await p.getByText("App settings", { exact: true }).click({ timeout: 8000 });
  await p.waitForTimeout(1500);
  const models = p.getByText("On-device models", { exact: true }).first();
  await models.scrollIntoViewIfNeeded().catch(() => {});
  await models.click({ timeout: 8000 });
  await p.waitForTimeout(2000);
  const txt = await bodyText(p);
  const attached = /attached|loaded|Current/i.test(txt);
  console.log(`[B] attached-state detected: ${attached}`);
  check(/Gemma 3 1B/.test(txt), "v2 chooser lists Gemma 3 1B");
  check(/Qwen2.5 1.5B/.test(txt), "v2 chooser lists Qwen2.5 1.5B (list visible even when a model is attached)");
  check(/Qwen2.5 0.5B/.test(txt), "v2 chooser lists Qwen2.5 0.5B");
  if (attached) {
    check(/Current/.test(txt), "current model is marked with a 'Current' chip");
    check(/Use this model/.test(txt), "other models offer 'Use this model'");
    check(/Remove model/i.test(txt), "'Remove model' available for the current model");
  } else {
    check(/Download & use \(default\)/.test(txt), "no model attached → Gemma offers 'Download & use (default)'");
  }
}

async function stageC_v2BackTabsAtDesktopWidth(): Promise<void> {
  console.log("\n── C. v2 back + bottom bar after resizing to desktop width (mother :9242) ──");
  const p = await ocPage(9242);
  try {
    // Boot NARROW so the v2 tree mounts (goto = full reload = tree re-chosen from live width)…
    await setWindowWidth(p, 390, 844);
    await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(3500);
    await dismissOverlay(p);
    const bootBars = (await p.evaluate(`document.querySelectorAll('.bottom_bar_icon').length`)) as number;
    check(bootBars > 0, `v2 mounted at narrow boot (${bootBars} bottom-bar icons)`);

    // …then RESIZE to desktop width WITHOUT reloading — the user's exact scenario. The mounted v2
    // tree must keep the mobile layout branch instead of falling into the desktop one.
    await setWindowWidth(p, 1100, 844);
    await p.waitForTimeout(1500);
    const widths = (await p.evaluate(`(() => {
      const bar = document.querySelector('.bottom_nav_bar');
      return { bar: bar ? bar.getBoundingClientRect().width : 0, win: window.innerWidth };
    })()`)) as { bar: number; win: number };
    console.log(`[C] bottom nav bar ${Math.round(widths.bar)}px of ${widths.win}px window`);
    check(widths.bar > 0, "bottom bar still rendered after resizing wide");
    check(widths.bar / widths.win > 0.9, "bottom bar spans the full width (not squished left)");

    // Enter a DM, then go back — we must land on the list AND STAY there.
    const dmRow = p.locator(".chat_summary").filter({ hasText: /father|manager/i }).first();
    if (await dmRow.isVisible().catch(() => false)) {
      await dmRow.click({ timeout: 15000 });
    } else {
      await p.locator(".chat_summary").first().click({ timeout: 15000 });
    }
    await p.waitForTimeout(2500);
    const inChat = await p.locator(".ProseMirror").first().isVisible().catch(() => false);
    check(inChat, "opened a DM at desktop width");
    await dismissOverlay(p); // a sliding modal can trap pointer events over the header

    // v2 header back button (arrow-left icon) — fall back to history.back().
    const backBtn = p.locator('button:has(path[d^="M20,11V13H8"])').first(); // mdi arrow-left
    if (await backBtn.isVisible().catch(() => false)) {
      await backBtn.click();
    } else {
      await p.goBack();
    }
    await p.waitForTimeout(2500); // selectDefaultChat used to re-enter here — give it time to misbehave
    const outOnce = !(await p.locator(".ProseMirror").first().isVisible().catch(() => false));
    check(outOnce, `back leaves the DM (url: ${p.url()})`);
    await p.waitForTimeout(1500);
    const stillOut = !(await p.locator(".ProseMirror").first().isVisible().catch(() => false));
    check(stillOut, "no delayed auto-reselect bounced us back into the chat");
    const rowsVisible = (await p.locator(".chat_summary").count()) > 0;
    check(rowsVisible, "chat list visible after back");
  } finally {
    await setWindowWidth(p, 390, 844); // restore the phone-sized window
  }
}

async function stageD_v2AiCommand(): Promise<void> {
  console.log("\n── D. /ai routing in the v2 composer (mother :9242) ──");
  const p = await ocPage(9242);
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await dismissOverlay(p);
  const dmRow = p.locator(".chat_summary").filter({ hasText: /father|manager/i }).first();
  if (await dmRow.isVisible().catch(() => false)) {
    await dmRow.click({ timeout: 15000 });
  } else {
    await p.locator(".chat_summary").first().click({ timeout: 15000 });
  }
  await p.waitForTimeout(2000);
  await dismissOverlay(p);
  const composer = p.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await p.keyboard.type("/ai");
  await p.waitForTimeout(1200);
  // The bot CommandSelector must NOT open for /ai (it would list matching bot commands / dismiss).
  const selectorOpen = await p
    .locator("[class*='command']")
    .filter({ hasText: /\// })
    .first()
    .isVisible()
    .catch(() => false);
  check(!selectorOpen, "typing '/ai' does not open the bot command selector");
  // Bare /ai + Enter → toast, and no literal "/ai" message is sent.
  await p.keyboard.press("Enter");
  await p.waitForTimeout(1500);
  const txt = await bodyText(p);
  check(/Type a prompt after \/ai/i.test(txt), "bare '/ai' shows the 'Type a prompt after /ai' toast");
  const literalSent = await p
    .locator(".message_text")
    .filter({ hasText: /^\/ai$/ })
    .last()
    .isVisible()
    .catch(() => false);
  check(!literalSent, "no literal '/ai' text message was sent");
  // Clean the composer for the next run.
  await composer.click().catch(() => {});
  await p.keyboard.press("Control+A").catch(() => {});
  await p.keyboard.press("Delete").catch(() => {});
}

async function main() {
  // Fresh transforms: reload the OC tab in both browsers first. Mother must reboot NARROW —
  // the v2 tree is chosen at boot from the live width, so a wide window would mount v1.
  const pm = await ocPage(9241);
  await pm.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await pm.waitForTimeout(2500);
  const p2 = await ocPage(9242);
  await setWindowWidth(p2, 390, 844);
  await p2.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await p2.waitForTimeout(3000);
  await stageA_v1ModelsEntry();
  await stageB_v2ChooserWithAttached();
  await stageC_v2BackTabsAtDesktopWidth();
  await stageD_v2AiCommand();

  if (failures > 0) {
    console.error(`\nVERIFY FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 BATCH-7 OPENCHAT LIVE VERIFY PASSED (v1 entry, v2 chooser, v2 back/tabs, /ai)");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
