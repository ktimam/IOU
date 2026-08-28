// Ensure a profile's IOU tab is signed in (dev local identity — persists in the profile, so it's
// durable across restarts; this just (re)establishes it if missing).
//   pnpm exec tsx scripts/live/iou-signin.ts --port 9241
import { chromium, type Page } from "@playwright/test";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error(`missing --${name}`);
}
const PORT = Number(arg("port"));
const IOU = "http://127.0.0.1:3000";
const T = 45000;

async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  let page: Page | undefined = ctx.pages().find((p) => p.url().includes("3000"));
  if (!page) { page = await ctx.newPage(); }

  await page.goto(`${IOU}/pairs`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const alreadyIn = await page.getByRole("heading", { name: "Your accounts" }).isVisible().catch(() => false);
  if (alreadyIn) {
    console.log(`:${PORT} IOU already signed in`);
    await b.close(); // Disconnect this driver; the durable browser stays open.
    return;
  }

  await page.goto(`${IOU}/sign-in`, { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: /Sign in \(dev/ });
  if (!/\/pairs\b/.test(page.url())) await dev.click({ timeout: T }).catch(() => {});
  await page.waitForURL("**/pairs", { timeout: T });
  await page.getByRole("heading", { name: "Your accounts" }).waitFor({ timeout: T });
  const principalPersisted = await page
    .evaluate(`(()=>{try{return !!localStorage.getItem('iou.devPrincipal')}catch(e){return false}})()`)
    .catch(() => false);
  console.log(`:${PORT} IOU signed in (dev identity ${principalPersisted ? "persisted; redacted" : "active"})`);
  await b.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
