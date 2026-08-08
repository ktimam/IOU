// Reload the desktop exe's WebView page (after a resize) so main.ts re-picks the UI tree, then
// report which tree rendered. v1 marker = `.chat-summary` (hyphen); v2 = `.chat_summary`/bottom bar.
//   pnpm exec tsx scripts/live/oc-exe-reload.ts
import { chromium } from "@playwright/test";
import { CDP_PORTS } from "./cdpPorts";
async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORTS.fatherOpenChat}`);
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await p.waitForTimeout(5000);
  const state = await p.evaluate(`(() => ({
    w: window.innerWidth,
    v1rows: document.querySelectorAll('.chat-summary').length,
    v2rows: document.querySelectorAll('.chat_summary').length,
    bottomBar: document.querySelectorAll('[class*="bottom_bar"]').length,
  }))()`);
  console.log(JSON.stringify(state));
  const v1 = state.v1rows > 0 || (state.v2rows === 0 && state.bottomBar === 0 && state.w >= 768);
  console.log(v1 ? "UI TREE: v1 (classic)" : "UI TREE: v2 (mobile)");
  process.exit(v1 ? 0 : 1);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
