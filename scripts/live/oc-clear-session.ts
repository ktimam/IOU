// Simulate OpenChat session expiry: clear the auth/session state for a profile so oc-restore must
// re-authenticate via the SAVED credential. OpenChat keeps its delegation in localStorage (NOT
// IndexedDB), so we must clear localStorage + sessionStorage as well as the IDBs + service worker.
//   pnpm exec tsx scripts/live/oc-clear-session.ts --port 9241
import { chromium, type Page } from "@playwright/test";
function arg(n: string) { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : ""; }
const PORT = Number(arg("port"));
async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  const oc = ctx.pages().find((p: Page) => p.url().includes("5003")) ?? ctx.pages()[0];
  await oc.goto("http://localhost:5003/communities", { waitUntil: "domcontentloaded" }).catch(() => {});
  await oc.waitForTimeout(1500);
  const res = await oc.evaluate(`new Promise(function(resolve){
    (async () => {
      try {
        const out = { lsCleared: 0, idb: [] };
        // DEVICE CONFIG (not session state) — survives the wipe. Wiping the on-device model
        // selection made every native propose degrade to the manual-JSON prompt ("no on-device
        // model selected") even though the GGUF on disk was fine.
        const KEEP = ["openchat_selected_model_id"];
        const kept = KEEP.map(k => [k, localStorage.getItem(k)]).filter(([,v]) => v !== null);
        try { out.lsCleared = Object.keys(localStorage||{}).length; localStorage.clear(); } catch(e){}
        for (const [k, v] of kept) { try { localStorage.setItem(k, v); } catch(e){} }
        try { sessionStorage.clear(); } catch(e){}
        const dbs = (await indexedDB.databases()) || [];
        for (const d of dbs) { if (d.name) { try { indexedDB.deleteDatabase(d.name); out.idb.push(d.name); } catch(e){} } }
        try { const regs = await navigator.serviceWorker.getRegistrations(); for (const r of regs) r.unregister(); } catch(e){}
        resolve(out);
      } catch(e){ resolve({ error: String(e) }); }
    })();
  })`);
  console.log(`:${PORT} cleared session (ls + idb + sw):`, JSON.stringify(res));
  await oc.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
