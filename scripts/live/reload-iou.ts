// Hard-reload the IOU tab (:3000) in a durable profile so its running SPA re-fetches the
// latest modules from the vite dev server (e.g. after a code change).
//   pnpm exec tsx scripts/live/reload-iou.ts --port 9241
import { chromium } from "@playwright/test";
function arg(n: string, d = "") { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const PORT = Number(arg("port"));
async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes("3000"));
  if (!page) { page = await ctx.newPage(); await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" }); }
  else { await page.goto("http://127.0.0.1:3000/", { waitUntil: "domcontentloaded" }); } // full nav = fresh module graph
  await page.waitForTimeout(2500);
  // Confirm the fixed crypto module is what the tab now pulls from vite.
  const served = await page.evaluate(`fetch('/src/features/crypto/devVetkd.ts').then(r=>r.text()).then(t=>/wrapSheetKeyTagged/.test(t)).catch(()=>false)`);
  const title = await page.evaluate(`document.title`).catch(() => "");
  console.log(`:${PORT} reloaded IOU tab — tagged-wrap served=${served} title="${title}"`);
  process.exit(0);
}
main().catch((e) => { console.error(`:${PORT} FAILED:`, e.message ?? e); process.exit(1); });
