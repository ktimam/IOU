// Restore the exe's on-device model SELECTION after a localStorage wipe (the GGUF files on disk
// survive; only the `openchat_selected_model_id` key is lost, which makes every propose degrade to
// the manual-JSON prompt with "no on-device model selected").
//   pnpm exec tsx scripts/live/oc-exe-restore-model.ts [--model gemma-4-e2b-it-q4]
import { chromium } from "@playwright/test";
function arg(n: string, d = "") { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const MODEL = arg("model", "gemma-4-e2b-it-q4");
async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  const before = await p.evaluate(`localStorage.getItem("openchat_selected_model_id")`);
  // createLocalStorageStore stores the RAW string (no JSON wrapping).
  await p.evaluate(`localStorage.setItem("openchat_selected_model_id", ${JSON.stringify(MODEL)})`);
  const after = await p.evaluate(`localStorage.getItem("openchat_selected_model_id")`);
  console.log(`selected model: ${before} → ${after}`);
  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForTimeout(5000);
  const live = await p.evaluate(`localStorage.getItem("openchat_selected_model_id")`);
  console.log("after reload:", live);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
