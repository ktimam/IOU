// Unregister service workers + clear CacheStorage for the OC origin (WITHOUT touching localStorage/
// sessions). Needed once after enabling cross-origin isolation: a cached worker.js response predates
// the COEP header and gets ERR_BLOCKED_BY_RESPONSE under the isolated document.
//   pnpm exec tsx scripts/live/clear-sw-cache.ts --port 9241
import { chromium } from "@playwright/test";
function arg(n: string, d = "") { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const PORT = Number(arg("port", "9241"));
async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  const res = await p.evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
    for (const r of regs) await r.unregister();
    const keys = await caches.keys().catch(() => []);
    for (const k of keys) await caches.delete(k);
    return { sw: regs.length, caches: keys.length };
  })()`);
  console.log(`:${PORT} cleared`, JSON.stringify(res));
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(8000);
  const state = await p.evaluate(`({ isolated: crossOriginIsolated, head: document.body.innerText.replace(/\\s+/g,' ').slice(0, 120) })`);
  console.log(JSON.stringify(state));
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
