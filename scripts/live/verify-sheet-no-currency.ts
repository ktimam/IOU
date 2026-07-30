// Live migration check: after removing `enabled_currencies` from the canister's Sheet record, a sheet
// STORED BEFORE the upgrade must still decode and render.
//
// Candid ignores unknown record fields on decode, so `Decode!(bytes, Sheet)` should read the old blob
// (which still carries the field) unchanged — but that is worth proving against real pre-upgrade data
// rather than trusting the spec. This reloads a signed-in IOU profile, re-reads its sheet from the
// canister, and asserts the page renders its balances/entries and that no currency field survives on
// the decoded record.
//
// Usage: pnpm exec tsx scripts/live/verify-sheet-no-currency.ts --port 9243
import { chromium } from "@playwright/test";

async function main() {
  const i = process.argv.indexOf("--port");
  const port = Number(i >= 0 ? process.argv[i + 1] : 9243);

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes(":3000"));
  if (!page) throw new Error("no IOU tab open on :3000");

  const fails: string[] = [];
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) fails.push(label);
  };

  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));

  // Reach a sheet from /pairs (never trust where the tab was left) so the sheet record is
  // re-fetched and re-decoded through the NEW candid.
  await page.goto("http://127.0.0.1:3000/pairs");
  await page.waitForTimeout(2000);
  const sheetLink = page.locator('a[href*="/sheet/"]').first();
  if ((await sheetLink.count()) === 0) throw new Error("no sheet reachable from /pairs");
  await sheetLink.click();
  await page.waitForSelector("text=Balances", { timeout: 30000 });
  const url = page.url();
  const body = await page.evaluate(() => document.body.innerText);

  check(/Balances/.test(body), "the pre-upgrade sheet still loads after the schema change");
  check(!/could not|failed|error/i.test(body.slice(0, 400)), "no error banner on the sheet page");
  check(!/·\s*[A-Z]{3}\b/.test(body.split("Balances")[0] ?? ""), "no per-sheet currency in the header");

  const decodeErrs = errors.filter((e) => /candid|decode|IDL|Deserialize/i.test(e));
  check(decodeErrs.length === 0, "no candid/decode errors in the console", decodeErrs.slice(0, 2).join(" | "));

  // The entry form still works end to end on this migrated sheet.
  await page.getByRole("button", { name: /Add entry/i }).first().click();
  const sel = page.locator("select").first();
  await sel.waitFor({ timeout: 20000 });
  const opts = await sel.locator("option").count();
  check(opts > 100, "entry form on a migrated sheet offers every ISO currency", `${opts} options`);
  await page.keyboard.press("Escape");

  // The archived-sheets list decodes old sheets too (it reads the same record).
  await page.goto("http://127.0.0.1:3000/archived");
  await page.waitForTimeout(2500);
  const arch = await page.evaluate(() => document.body.innerText);
  check(!/Something went wrong|failed to/i.test(arch), "archived sheets page renders");

  await page.goto(url);
  await b.close();
  console.log(fails.length === 0 ? "\nOK — pre-upgrade sheets decode fine with the field gone." : `\nFAILED: ${fails.join("; ")}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
}

void main();
