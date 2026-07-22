// END-TO-END browser inference proof on mother's v2 profile (:9242):
//   1. Navigate: profile → ⋮ menu → App settings → On-device models.
//   2. Assert the chooser lists the browser-capable catalog (Gemma first = default).
//   3. Click "Download & use (default)" — Gemma 3 1B Q4 (806 MB, ggml-org on Hugging Face) is
//      downloaded ONCE into the browser cache by wllama with progress, then attached.
//   4. Open the manager DM, send a text message, propose — and assert the MODEL runs: the manual
//      JSON prompt must NOT appear, and the action card must post.
// Exit 1 on any failed assertion.
import { chromium } from "@playwright/test";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9242");
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;

  // ── 1. Navigate to the model screen ─────────────────────────────────────────
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
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

  // ── 2. The chooser ALWAYS lists the catalog now — with the current model marked when attached ──
  const screen = await p.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`);
  const already = /Current|Model: .*Gemma 3 1B.*(attached|loaded)/i.test(screen);
  check(/Gemma 3 1B/.test(screen), "chooser lists Gemma 3 1B (default)");
  check(/Qwen2.5 1.5B/.test(screen), "chooser lists Qwen2.5 1.5B");
  check(/Qwen2.5 0.5B/.test(screen), "chooser lists Qwen2.5 0.5B");
  check(/Pros:.*Cons:/.test(screen), "pros/cons descriptions shown");
  if (already) {
    check(/Current/.test(screen), "attached model is marked 'Current' (list stays visible)");
  }

  // ── 3. Download & use the DEFAULT (Gemma) ──────────────────────────────────
  if (!already) {
    await p.getByText("Download & use (default)", { exact: true }).click({ timeout: 8000 });
    console.log("[e2e] downloading Gemma 3 1B (806 MB) into the browser cache…");
    let attached = false;
    for (let i = 0; i < 240 && !attached; i++) {
      await p.waitForTimeout(5000);
      const t = await p.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`);
      const prog = /Downloading .*?(\d+)%/.exec(t)?.[1];
      if (prog !== undefined && i % 6 === 0) console.log(`[e2e] download ${prog}%`);
      if (/Model: .*(attached|loaded)/i.test(t)) attached = true;
      if (/failed to load|error/i.test(t) && !/Downloading/i.test(t)) break;
    }
    check(attached, "Gemma attached after download");
    if (!attached) throw new Error("download/attach did not complete");
  } else {
    console.log("[e2e] Gemma already attached (cached from a prior run)");
  }

  // ── 4. Propose with the MODEL (no manual-JSON dialog allowed) ──────────────
  let dialogSeen: string | undefined;
  p.on("dialog", (d) => {
    dialogSeen = d.message().slice(0, 60);
    void d.dismiss().catch(() => {});
  });
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  await p.locator(".chat-summary, .chat_summary").filter({ hasText: /manager/i }).first().click({ timeout: 15000 });
  await p.waitForTimeout(2000);

  // Dismiss any leftover sliding-modal overlay (it intercepts ALL pointer events).
  for (let i = 0; i < 3; i++) {
    const blocked = await p.evaluate(
      `(() => { const ov = document.querySelector('#masked_overlay'); return !!ov && ov.className.includes('visible'); })()`,
    );
    if (!blocked) break;
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(500);
    await p.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(500);
  }
  const text = `Web model check ${Date.now() % 100000}: I paid 120 EGP for groceries`;
  const composer = p.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await p.keyboard.type(text);
  await p.keyboard.press("Enter");
  console.log(`[e2e] sent: ${text}`);
  await p.waitForTimeout(4000);

  // v2 propose: long-press (click) the message → AutoFix icon in the sheet.
  const autoFix = p.locator('button:has(path[d^="M7.5,5.6"])').first();
  let sheetOpen = false;
  for (let press = 0; press < 3 && !sheetOpen; press++) {
    const msg = p.locator(".message_text").last();
    await msg.scrollIntoViewIfNeeded().catch(() => {});
    await p.waitForTimeout(800);
    const box = await msg.boundingBox();
    if (!box) throw new Error("no message box");
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p.mouse.down();
    await p.waitForTimeout(900);
    await p.mouse.up();
    sheetOpen = await autoFix.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
    if (!sheetOpen) await p.waitForTimeout(1500);
  }
  if (!sheetOpen) throw new Error("action sheet never opened");
  await autoFix.click({ timeout: 8000 });
  console.log("[e2e] proposed — first inference loads the model into wasm (can take minutes)…");

  // The card posts when the model finishes. NO dialog may appear (that would be the manual path).
  const confirmBtn = p.locator("button").filter({ hasText: /^(Add to IOU|Confirm)$/i }).last();
  const posted = await confirmBtn.waitFor({ timeout: 420000 }).then(() => true).catch(() => false);
  check(dialogSeen === undefined, `no manual-JSON dialog fired${dialogSeen ? ` (got: "${dialogSeen}")` : ""}`);
  check(posted, "action card posted from the BROWSER model's extraction");

  if (failures > 0) {
    console.error(`\nE2E FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 BROWSER INFERENCE E2E PASSED: catalog → download → attach → model propose, no manual prompt");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
